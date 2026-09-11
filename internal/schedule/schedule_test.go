package schedule

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// This file exists because the package comment above says two properties "are
// enforced by tests" and, until 2026-09-11, `go test ./internal/schedule/...`
// answered "[no test files]". Every assertion anywhere else in the repository
// compared a value to schedule.Delay, so changing the constant left go test and
// npm test entirely green while the emitted pin, the correction target and the
// guest page's fallback quietly disagreed.

const sampleMultivariant = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=330000,CODECS="mp4a.40.2"
stream.m3u8
`

const sampleMedia = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.45000,CAN-SKIP-UNTIL=6.00000
#EXT-X-PART-INF:PART-TARGET=0.15000
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-09-11T02:00:00.000Z
#EXT-X-PART:DURATION=0.15000,URI="seg7.0.mp4"
#EXT-X-PART:DURATION=0.15000,URI="seg7.1.mp4"
#EXTINF:0.50000,
seg7.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-09-11T02:00:00.500Z
#EXT-X-PART:DURATION=0.15000,URI="seg8.0.mp4"
`

func TestMultivariantCarriesTheDeclaredPin(t *testing.T) {
	out := string(RewritePlaylist([]byte(sampleMultivariant)))
	want := fmt.Sprintf("#EXT-X-START:TIME-OFFSET=-%.3f,PRECISE=YES", Delay)
	if !strings.Contains(out, want) {
		t.Fatalf("multivariant is missing %q:\n%s", want, out)
	}
	// PRECISE=YES and the multivariant tier are both load-bearing. The two
	// failed forms are on the record: the tag in the MEDIA playlist without
	// PRECISE measured 25.00s from the edge, because the offset applied from
	// the wrong end.
	if !strings.Contains(out, "PRECISE=YES") {
		t.Fatalf("the pin must be PRECISE:\n%s", out)
	}
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-START:") {
			if i == 0 || !strings.HasPrefix(lines[i-1], "#EXT-X-VERSION:") {
				t.Fatalf("the pin must follow EXT-X-VERSION, found after %q", lines[i-1])
			}
		}
	}
}

// Ours is authoritative: a muxer that grew its own opinion must not win.
func TestAnUpstreamPinIsReplacedNotDuplicated(t *testing.T) {
	upstream := strings.Replace(sampleMultivariant,
		"#EXT-X-VERSION:9",
		"#EXT-X-VERSION:9\n#EXT-X-START:TIME-OFFSET=-0.500", 1)
	out := string(RewritePlaylist([]byte(upstream)))
	if n := strings.Count(out, "#EXT-X-START:"); n != 1 {
		t.Fatalf("expected exactly one start tag, got %d:\n%s", n, out)
	}
	if strings.Contains(out, "-0.500") {
		t.Fatalf("the upstream pin survived:\n%s", out)
	}
}

func TestMediaPlaylistGetsTheHoldBackFloorAndNoPin(t *testing.T) {
	out := string(RewritePlaylist([]byte(sampleMedia)))
	want := fmt.Sprintf("PART-HOLD-BACK=%.5f", PartHoldBack)
	if !strings.Contains(out, want) {
		t.Fatalf("media playlist is missing %q:\n%s", want, out)
	}
	// The attachment point is authored once, in the multivariant. A pin here is
	// one of the two never-again forms.
	if strings.Contains(out, "#EXT-X-START:") {
		t.Fatalf("the media playlist must not be pinned:\n%s", out)
	}
}

// Declaring a longer distance is always safe; declaring a shorter one is a
// promise the stream cannot keep, because the parts do not exist that close to
// the edge.
func TestAHigherUpstreamHoldBackIsNeverLowered(t *testing.T) {
	upstream := strings.Replace(sampleMedia, "PART-HOLD-BACK=0.45000", "PART-HOLD-BACK=2.00000", 1)
	out := string(RewritePlaylist([]byte(upstream)))
	if !strings.Contains(out, "PART-HOLD-BACK=2.00000") {
		t.Fatalf("a hold-back above the floor must survive untouched:\n%s", out)
	}
}

// Everything that is not the schedule passes through byte for byte. This is the
// property the whole room rests on: PROGRAM-DATE-TIME is the stamp the delay is
// measured against, and a rewrite that disturbed a duration or a URI would move
// every listener without anyone noticing.
func TestOnlyTheScheduleIsTouched(t *testing.T) {
	out := string(RewritePlaylist([]byte(sampleMedia)))
	for _, line := range strings.Split(sampleMedia, "\n") {
		if line == "" || strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:") {
			continue
		}
		if !strings.Contains(out, line) {
			t.Fatalf("rewrite lost %q:\n%s", line, out)
		}
	}
	// And the server-control line keeps every attribute it arrived with.
	for _, attr := range []string{"CAN-BLOCK-RELOAD=YES", "CAN-SKIP-UNTIL=6.00000"} {
		if !strings.Contains(out, attr) {
			t.Fatalf("rewrite dropped %q:\n%s", attr, out)
		}
	}
}

func TestRewriteIsIdempotent(t *testing.T) {
	for name, in := range map[string]string{"multivariant": sampleMultivariant, "media": sampleMedia} {
		once := RewritePlaylist([]byte(in))
		twice := RewritePlaylist(once)
		if string(once) != string(twice) {
			t.Fatalf("%s: rewriting twice differs from rewriting once:\n--- once ---\n%s\n--- twice ---\n%s", name, once, twice)
		}
	}
}

// A body that is neither tier is not ours to edit. Media bytes and error pages
// alike must come back exactly as they arrived.
func TestUnrecognisedBodiesPassThrough(t *testing.T) {
	for _, in := range []string{"", "not a playlist at all", "#EXTM3U\n#EXT-X-ENDLIST\n"} {
		if out := string(RewritePlaylist([]byte(in))); out != in {
			t.Fatalf("body %q came back as %q", in, out)
		}
	}
}

// The last-resort branch: a multivariant with neither EXT-X-VERSION nor a
// leading EXTM3U still gets pinned, at the top.
func TestAHeaderlessMultivariantStillGetsPinned(t *testing.T) {
	in := "#EXT-X-STREAM-INF:BANDWIDTH=330000\nstream.m3u8\n"
	out := string(RewritePlaylist([]byte(in)))
	if !strings.HasPrefix(out, "#EXT-X-START:") {
		t.Fatalf("a headerless multivariant should be pinned at the top, got:\n%s", out)
	}
	if !strings.Contains(out, "stream.m3u8") {
		t.Fatalf("the variant URI was lost:\n%s", out)
	}
}

// THE BINDING TEST.
//
// The guest page carries its own copy of the room target, used when an older
// server does not report one. Nothing connected the two, so changing Delay here
// left every Go and browser test green while a guest on the fallback path aimed
// at a different number from every other guest in the room. The schedule's
// first invariant is that one declared target reaches every phone on every
// path; two constants that can drift apart is that invariant with a hole in it.
func TestTheGuestPageFallbackMatchesTheDeclaredDelay(t *testing.T) {
	path := filepath.Join("..", "..", "web", "listener.html")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v", path, err)
	}
	re := regexp.MustCompile(`ROOM_TARGET_FALLBACK\s*=\s*([0-9.]+)`)
	m := re.FindSubmatch(body)
	if m == nil {
		t.Fatalf("web/listener.html no longer declares ROOM_TARGET_FALLBACK; " +
			"if it was renamed, point this test at the new name rather than deleting it")
	}
	got := string(m[1])
	if want := fmt.Sprintf("%.1f", Delay); got != want {
		t.Fatalf("web/listener.html ROOM_TARGET_FALLBACK = %s, schedule.Delay = %s. "+
			"They are the same number and must be changed together.", got, want)
	}
}
