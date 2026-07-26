package server

import (
	"net/http/httptest"
	"strings"
	"testing"

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
)

func TestParseDurSeconds(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"500ms", 0.5},
		{"350ms", 0.35},
		{"1000ms", 1},
		{"1s", 1},
		{"2s", 2},
		{"2.5", 2.5},
		{" 1s ", 1},
		{"", 0},
		{"abc", 0},
	}
	for _, c := range cases {
		if got := parseDurSeconds(c.in); got != c.want {
			t.Errorf("parseDurSeconds(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRewriteLivePlaylistPinsMultivariant(t *testing.T) {
	in := []byte("#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-STREAM-INF:BANDWIDTH=328000,CODECS=\"mp4a.40.2\"\nstream.m3u8\n")
	got := string(rewriteLivePlaylist(in, 3))
	want := "#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES"
	if !strings.Contains(got, want) {
		t.Fatalf("playlist missing %q:\n%s", want, got)
	}
	if strings.Count(got, "#EXT-X-START:") != 1 {
		t.Fatalf("playlist contains duplicate start pins:\n%s", got)
	}
	if again := string(rewriteLivePlaylist([]byte(got), 3)); again != got {
		t.Fatalf("playlist rewrite is not idempotent:\n%s", again)
	}
}

func TestRewriteLivePlaylistRaisesPartHoldBack(t *testing.T) {
	in := []byte("#EXTM3U\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.42750,CAN-SKIP-UNTIL=6.000\n#EXT-X-PART-INF:PART-TARGET=0.17100\n")
	got := string(rewriteLivePlaylist(in, 3))
	if !strings.Contains(got, "PART-HOLD-BACK=0.513000") {
		t.Fatalf("playlist holdback was not raised to 3x part target:\n%s", got)
	}
	if strings.Contains(got, "#EXT-X-START:") {
		t.Fatalf("media playlist must not receive EXT-X-START:\n%s", got)
	}
}

func TestRewriteLivePlaylistKeepsLargerPartHoldBack(t *testing.T) {
	in := []byte("#EXTM3U\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.600\n#EXT-X-PART-INF:PART-TARGET=0.171\n")
	if got := string(rewriteLivePlaylist(in, 3)); got != string(in) {
		t.Fatalf("larger holdback changed:\n%s", got)
	}
}

func TestRewriteLivePlaylistAddsMissingPartHoldBack(t *testing.T) {
	in := []byte("#EXTM3U\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n#EXT-X-PART-INF:PART-TARGET=0.171\n")
	got := string(rewriteLivePlaylist(in, 3))
	if !strings.Contains(got, "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.513000") {
		t.Fatalf("missing holdback was not added:\n%s", got)
	}
}

func TestCleanHostname(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Ramines-iPhone.local.", "Ramines iPhone"},
		{"Ramines-iPhone.local", "Ramines iPhone"},
		{"my_device.lan", "my device"},
		{"box.home.arpa", "box"},
		{"plainhost", "plainhost"},
		{"host.example.com", ""}, // still an FQDN — not a friendly name
		{"", ""},
	}
	for _, c := range cases {
		if got := cleanHostname(c.in); got != c.want {
			t.Errorf("cleanHostname(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDeviceName(t *testing.T) {
	cases := []struct {
		ua, want string
	}{
		{"", "Browser"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"},
		{"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1", "iPad · Safari"},
		{"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36", "Android · Chrome"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "Mac · Chrome"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0", "Windows · Edge"},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0", "Linux · Firefox"},
		{"curl/8.4.0", "Computer"},
	}
	for _, c := range cases {
		if got := deviceName(c.ua); got != c.want {
			t.Errorf("deviceName(%q) = %q, want %q", c.ua, got, c.want)
		}
	}
}

func TestKbps(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{{"320k", 320}, {"64k", 64}, {"", 0}, {"abc", 0}}
	for _, c := range cases {
		if got := kbps(c.in); got != c.want {
			t.Errorf("kbps(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		remote, want string
	}{
		{"192.168.1.5:1234", "192.168.1.5"},
		{"[::1]:8080", "::1"},
		{"127.0.0.1", "127.0.0.1"},      // no port
		{"::ffff:10.0.0.1", "10.0.0.1"}, // mapped v4, no port
		{"[::ffff:10.0.0.1]:80", "10.0.0.1"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		if got := clientIP(r); got != c.want {
			t.Errorf("clientIP(%q) = %q, want %q", c.remote, got, c.want)
		}
	}
}

func TestMimeFor(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"listener.html", "text/html; charset=utf-8"},
		{"app.js", "text/javascript; charset=utf-8"},
		{"style.css", "text/css; charset=utf-8"},
		{"art-512.png", "image/png"},
		{"data.bin", "application/octet-stream"},
	}
	for _, c := range cases {
		if got := mimeFor(c.in); got != c.want {
			t.Errorf("mimeFor(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestLastN(t *testing.T) {
	in := []string{"a", "b", "c", "d"}
	if got := lastN(in, 2); len(got) != 2 || got[0] != "c" || got[1] != "d" {
		t.Errorf("lastN(4 items, 2) = %v", got)
	}
	if got := lastN(in, 4); len(got) != 4 {
		t.Errorf("lastN(4 items, 4) = %v", got)
	}
	if got := lastN(in, 10); len(got) != 4 {
		t.Errorf("lastN(4 items, 10) = %v", got)
	}
}

func TestSuggest(t *testing.T) {
	stereoHigh := broadcast.Status{Channels: 2, Bitrate: "320k"}
	if got := suggest("good", stereoHigh); got != "" {
		t.Errorf("no suggestion expected when good, got %q", got)
	}
	if got := suggest("idle", stereoHigh); got != "" {
		t.Errorf("no suggestion expected when idle, got %q", got)
	}
	for _, status := range []string{"strain", "congested"} {
		if got := suggest(status, stereoHigh); got == "" {
			t.Errorf("suggest(%q) = empty, want venue Wi-Fi guidance", status)
		}
	}
}

// ---- latencyTarget: fixed room contract ----

func bareSrv(cfg config.Config) *srv { return &srv{Deps: Deps{Config: cfg}} }
