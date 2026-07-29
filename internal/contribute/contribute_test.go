package contribute

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// samplePlaylist is shaped like MediaMTX's low-latency output: a wall-clock
// stamp, full segments, and partial segments carried in URI attributes.
const samplePlaylist = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.90000
#EXT-X-PART-INF:PART-TARGET=0.15000
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z
#EXT-X-PART:DURATION=0.15000,URI="seg7_part0.mp4"
#EXT-X-PART:DURATION=0.15000,URI="seg7_part1.mp4"
#EXTINF:0.50000,
seg7.mp4
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg8_part0.mp4"
`

type originStub struct {
	mu     sync.Mutex
	order  []string
	bodies map[string][]byte
	auth   map[string]string
	fail   bool
}

func newOriginStub() *originStub {
	return &originStub{bodies: map[string][]byte{}, auth: map[string]string{}}
}

func (o *originStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.fail {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/room/")
		body := make([]byte, r.ContentLength)
		if r.ContentLength > 0 {
			_, _ = r.Body.Read(body)
		} else {
			buf := new(strings.Builder)
			_, _ = copyTo(buf, r)
			body = []byte(buf.String())
		}
		o.order = append(o.order, name)
		o.bodies[name] = body
		o.auth[name] = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	})
}

func copyTo(dst *strings.Builder, r *http.Request) (int64, error) {
	buf := make([]byte, 4096)
	var total int64
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			dst.Write(buf[:n])
			total += int64(n)
		}
		if err != nil {
			return total, nil
		}
	}
}

func (o *originStub) snapshot() ([]string, map[string][]byte, map[string]string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	order := append([]string(nil), o.order...)
	bodies := map[string][]byte{}
	for k, v := range o.bodies {
		bodies[k] = append([]byte(nil), v...)
	}
	auth := map[string]string{}
	for k, v := range o.auth {
		auth[k] = v
	}
	return order, bodies, auth
}

// localStub serves what this Mac's MediaMTX would serve on loopback.
func localStub() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".m3u8") {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(samplePlaylist))
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("media:" + strings.TrimPrefix(r.URL.Path, "/party/")))
	}))
}

func runOneCycle(t *testing.T, m *Manager) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return m.cycle(ctx)
}

// TestPlaylistIsForwardedByteForByte is THE test of this package. The room's
// whole sync contract rides on PROGRAM-DATE-TIME reaching relayed guests
// unchanged. If the playlist were re-generated anywhere in this path, direct and
// relayed guests would each look correct alone and disagree with each other.
func TestPlaylistIsForwardedByteForByte(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{
		SourceURL:  local.URL + "/party/stream.m3u8",
		TargetBase: originSrv.URL + "/room/",
	})
	if err := runOneCycle(t, m); err != nil {
		t.Fatal(err)
	}

	_, bodies, _ := origin.snapshot()
	got, ok := bodies["stream.m3u8"]
	if !ok {
		t.Fatalf("playlist was never uploaded; got %v", bodies)
	}
	if string(got) != samplePlaylist {
		t.Fatalf("playlist was altered in transit.\n--- got ---\n%s\n--- want ---\n%s", got, samplePlaylist)
	}
	if !strings.Contains(string(got), "#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z") {
		t.Fatal("the capture stamp did not survive, so the schedule cannot")
	}
}

// TestMediaUploadsBeforeThePlaylistThatNamesIt: a guest fetching a playlist that
// references a part the origin does not have gets a 404 mid-stream, which native
// players treat as fatal rather than as something to retry.
func TestMediaUploadsBeforeThePlaylistThatNamesIt(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{SourceURL: local.URL + "/party/stream.m3u8", TargetBase: originSrv.URL + "/room/"})
	if err := runOneCycle(t, m); err != nil {
		t.Fatal(err)
	}

	order, _, _ := origin.snapshot()
	playlistAt := -1
	for i, name := range order {
		if name == "stream.m3u8" {
			playlistAt = i
		}
	}
	if playlistAt < 0 {
		t.Fatalf("playlist never uploaded: %v", order)
	}
	if playlistAt != len(order)-1 {
		t.Fatalf("playlist must be uploaded last, got order %v", order)
	}
	for _, want := range []string{"init.mp4", "seg7_part0.mp4", "seg7_part1.mp4", "seg7.mp4"} {
		found := false
		for _, name := range order[:playlistAt] {
			if name == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s was not uploaded before the playlist: %v", want, order)
		}
	}
}

// TestEachMediaFileUploadsOnce: re-uploading every part on every 50ms cycle would
// multiply the DJ's uplink by the poll rate, defeating the point of the design.
func TestEachMediaFileUploadsOnce(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{SourceURL: local.URL + "/party/stream.m3u8", TargetBase: originSrv.URL + "/room/"})
	for i := 0; i < 4; i++ {
		if err := runOneCycle(t, m); err != nil {
			t.Fatal(err)
		}
	}

	order, _, _ := origin.snapshot()
	counts := map[string]int{}
	for _, name := range order {
		counts[name]++
	}
	if counts["seg7.mp4"] != 1 {
		t.Fatalf("seg7.mp4 uploaded %d times, want 1: %v", counts["seg7.mp4"], counts)
	}
	// The playlist DOES re-upload every cycle: it is what advances the live edge.
	if counts["stream.m3u8"] != 4 {
		t.Fatalf("playlist uploaded %d times, want 4 (one per cycle)", counts["stream.m3u8"])
	}
}

// TestPublishCredentialIsSent: only this Mac may publish to its room.
func TestPublishCredentialIsSent(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{
		SourceURL:  local.URL + "/party/stream.m3u8",
		TargetBase: originSrv.URL + "/room/",
		Token:      "room-token",
	})
	if err := runOneCycle(t, m); err != nil {
		t.Fatal(err)
	}
	_, _, auth := origin.snapshot()
	if auth["stream.m3u8"] != "Bearer room-token" {
		t.Fatalf("playlist upload was unauthenticated: %q", auth["stream.m3u8"])
	}
}

// TestUnsafeMediaNamesAreRefused: media names come out of a playlist, so they are
// data. Data must never be able to aim an upload somewhere else.
func TestUnsafeMediaNamesAreRefused(t *testing.T) {
	for _, bad := range []string{
		"../../etc/passwd",
		"/absolute",
		"https://evil.example/x.mp4",
	} {
		if _, err := joinURL("https://origin.example/room/", bad); err == nil {
			t.Fatalf("joinURL accepted unsafe name %q", bad)
		}
	}
	got, err := joinURL("https://origin.example/room", "seg7.mp4")
	if err != nil || got != "https://origin.example/room/seg7.mp4" {
		t.Fatalf("joinURL(%q) = %q, %v", "seg7.mp4", got, err)
	}
}

// TestMediaNamesFindsPartsAndSegments covers the parser against a real
// low-latency playlist shape, including the quoted URI attributes.
func TestMediaNamesFindsPartsAndSegments(t *testing.T) {
	got := mediaNames([]byte(samplePlaylist))
	want := []string{"init.mp4", "seg7_part0.mp4", "seg7_part1.mp4", "seg7.mp4", "seg8_part0.mp4"}
	if len(got) != len(want) {
		t.Fatalf("mediaNames = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mediaNames = %v, want %v", got, want)
		}
	}
	// Comment lines that are not media must never be treated as media.
	for _, name := range got {
		if strings.HasPrefix(name, "#") {
			t.Fatalf("parsed a tag as media: %q", name)
		}
	}
}

// TestDisabledContributionNeverPushes: pushing a copy to the internet in LOCAL or
// DIRECT mode would waste the DJ's uplink for nothing.
func TestDisabledContributionNeverPushes(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{SourceURL: local.URL + "/party/stream.m3u8", TargetBase: originSrv.URL + "/room/"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)

	time.Sleep(200 * time.Millisecond)
	if order, _, _ := origin.snapshot(); len(order) != 0 {
		t.Fatalf("pushed %v while disabled", order)
	}
	if m.Snapshot().Running {
		t.Fatal("status claims running while disabled")
	}
}

// TestFailingOriginIsReportedAndRetried: an unreachable origin must be visible in
// the console rather than silently producing a party nobody can hear.
func TestFailingOriginIsReportedAndRetried(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	origin.fail = true
	originSrv := httptest.NewServer(origin.handler())
	defer originSrv.Close()

	m := New(Config{
		SourceURL:  local.URL + "/party/stream.m3u8",
		TargetBase: originSrv.URL + "/room/",
		Logf:       func(string, ...any) {},
	})
	if err := runOneCycle(t, m); err == nil {
		t.Fatal("a failing origin must return an error")
	}
}

// TestCredentialsNeverReachTheConsole: the status object is rendered in the UI
// and written to logs.
func TestCredentialsNeverReachTheConsole(t *testing.T) {
	got := redact("https://room:sup3rsecret@origin.example/room/")
	if strings.Contains(got, "sup3rsecret") {
		t.Fatalf("credentials leaked: %s", got)
	}
	if !strings.Contains(got, "origin.example/room/") {
		t.Fatalf("redaction lost the useful part: %s", got)
	}
}

// TestSentTrackingIsPruned: a long set must not grow the dedupe map without
// bound as parts age out of the live window.
func TestSentTrackingIsPruned(t *testing.T) {
	m := New(Config{SourceURL: "https://x/party/stream.m3u8", TargetBase: "https://y/room/"})
	m.sent["old_part.mp4"] = true
	m.sent["seg7.mp4"] = true

	m.pruneSent([]string{"seg7.mp4"})

	if m.sent["old_part.mp4"] {
		t.Fatal("a part that left the playlist is still tracked")
	}
	if !m.sent["seg7.mp4"] {
		t.Fatal("a part still in the playlist was forgotten and will re-upload")
	}
}
