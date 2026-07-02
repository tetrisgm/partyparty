package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestValidBitrate(t *testing.T) {
	for _, ok := range []string{"64k", "96k", "128k", "160k", "192k", "256k", "320k"} {
		if got := validBitrate(ok); got != ok {
			t.Errorf("validBitrate(%q) = %q, want it passed through", ok, got)
		}
	}
	for _, bad := range []string{"", "999k", "128", "320", "banana", "64K"} {
		if got := validBitrate(bad); got != "" {
			t.Errorf("validBitrate(%q) = %q, want empty", bad, got)
		}
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
	cases := []struct {
		bc   broadcast.Status
		want string
	}{
		{broadcast.Status{Channels: 2, Bitrate: "320k"}, "Network strain — turn on Mono and/or lower the audio quality."},
		{broadcast.Status{Channels: 2, Bitrate: "96k"}, "Network strain — turn on Mono."},
		{broadcast.Status{Channels: 1, Bitrate: "320k"}, "Network strain — lower the audio quality."},
		{broadcast.Status{Channels: 1, Bitrate: "64k"}, "Network strain — already near the floor; the Wi-Fi/access point is likely the limit."},
	}
	for _, c := range cases {
		for _, status := range []string{"strain", "congested"} {
			if got := suggest(status, c.bc); got != c.want {
				t.Errorf("suggest(%q, ch=%d br=%s) = %q, want %q", status, c.bc.Channels, c.bc.Bitrate, got, c.want)
			}
		}
	}
}

// ---- latencyTarget: base math + adaptive raise/decay ----

func bareSrv(cfg config.Config) *srv { return &srv{Deps: Deps{Config: cfg}} }

func TestLatencyTargetPinned(t *testing.T) {
	s := bareSrv(config.Config{LatencyTarget: 4.2})
	if got := s.latencyTarget(broadcast.Status{Delivery: "llhls"}, "good"); got != 4.2 {
		t.Errorf("pinned llhls target = %v, want 4.2", got)
	}
	if got := s.latencyTarget(broadcast.Status{Delivery: "hls", SegDur: 2}, "congested"); got != 4.2 {
		t.Errorf("pinned hls target = %v, want 4.2", got)
	}
}

func TestLatencyTargetBase(t *testing.T) {
	cases := []struct {
		bc   broadcast.Status
		want float64
	}{
		{broadcast.Status{Delivery: "llhls"}, 5.0},            // fixed LL room profile
		{broadcast.Status{Delivery: "llhls", SegDur: 3}, 5.0}, // segdur irrelevant for llhls
		{broadcast.Status{Delivery: "hls", SegDur: 1}, 10},    // 3*1+7
		{broadcast.Status{Delivery: "hls", SegDur: 2}, 13},    // 3*2+7
		{broadcast.Status{Delivery: "hls", SegDur: 3}, 16},    // 3*3+7
		{broadcast.Status{Delivery: "hls", SegDur: 0}, 10},    // 0 → seg defaults to 1
	}
	for _, c := range cases {
		s := bareSrv(config.Config{})
		if got := s.latencyTarget(c.bc, "good"); got != c.want {
			t.Errorf("latencyTarget(%s seg=%v) = %v, want %v", c.bc.Delivery, c.bc.SegDur, got, c.want)
		}
	}
}

func TestLatencyTargetRaiseOnStrain(t *testing.T) {
	s := bareSrv(config.Config{})
	bc := broadcast.Status{Delivery: "llhls"}

	// Fresh srv: lastAdj is zero → adjustment window open → first strain raises.
	if got := s.latencyTarget(bc, "strain"); got != 5.5 {
		t.Fatalf("first strain target = %v, want 5.5", got)
	}
	// Immediately again: the 90s cooldown holds the delta.
	if got := s.latencyTarget(bc, "strain"); got != 5.5 {
		t.Fatalf("second strain (within cooldown) = %v, want 5.5", got)
	}
	// Force the window open repeatedly: delta climbs by 0.5 and caps at +3.
	for i := 0; i < 10; i++ {
		s.adaptMu.Lock()
		s.lastAdj = time.Now().Add(-2 * time.Minute)
		s.adaptMu.Unlock()
		s.latencyTarget(bc, "congested")
	}
	if got := s.latencyTarget(bc, "strain"); got != 8.0 {
		t.Fatalf("delta should cap at +3 (target 8.0), got %v", got)
	}
}

func TestLatencyTargetDecayWhenClean(t *testing.T) {
	bc := broadcast.Status{Delivery: "hls", SegDur: 1} // base 10

	s := bareSrv(config.Config{})
	s.adaptMu.Lock()
	s.adaptDelta = 1.0
	s.lastAdj = time.Now().Add(-2 * time.Minute)
	s.lastRaise = time.Now().Add(-6 * time.Minute) // quiet long enough to decay
	s.adaptMu.Unlock()
	if got := s.latencyTarget(bc, "good"); got != 10.75 {
		t.Errorf("decayed target = %v, want 10.75", got)
	}

	// A recent raise blocks decay even when currently clean.
	s = bareSrv(config.Config{})
	s.adaptMu.Lock()
	s.adaptDelta = 1.0
	s.lastAdj = time.Now().Add(-2 * time.Minute)
	s.lastRaise = time.Now().Add(-1 * time.Minute)
	s.adaptMu.Unlock()
	if got := s.latencyTarget(bc, "good"); got != 11.0 {
		t.Errorf("recent-raise target = %v, want 11.0 (no decay)", got)
	}

	// Idle health never adjusts.
	s = bareSrv(config.Config{})
	s.adaptMu.Lock()
	s.adaptDelta = 1.5
	s.lastAdj = time.Now().Add(-2 * time.Minute)
	s.lastRaise = time.Now().Add(-10 * time.Minute)
	s.adaptMu.Unlock()
	if got := s.latencyTarget(bc, "idle"); got != 11.5 {
		t.Errorf("idle target = %v, want 11.5 (unchanged)", got)
	}
}

// ---- bonjour parsers, against a stub dns-sd on PATH ----

const dnssdStub = `#!/bin/sh
case "$1" in
-B)
	printf '%s\n' \
		"Browsing for _companion-link._tcp" \
		"DATE: ---Wed 01 Jul 2026---" \
		"Timestamp     A/R    Flags  if Domain               Service Type          Instance Name" \
		"14:20:01.123  Add        3  10 local.               _companion-link._tcp. Ramine's iPhone" \
		"14:20:01.124  Add        2  10 local.               _companion-link._tcp. Living Room TV" \
		"14:20:01.125  Add        2  10 local.               _companion-link._tcp. Ramine's iPhone" \
		"14:20:01.126  Rmv        0  10 local.               _companion-link._tcp. Gone Device"
	;;
-L)
	if [ "$2" = "Truncated" ]; then
		echo "iPad._companion-link._tcp.local. can be reached at "
	elif [ "$2" = "Silent" ]; then
		:
	else
		echo "iPad-Mini._companion-link._tcp.local. can be reached at iPad-Mini.local.:49153 (interface 10)"
	fi
	;;
esac
exit 0
`

func installDNSSDStub(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "dns-sd"), []byte(dnssdStub), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
}

func TestBrowseInstances(t *testing.T) {
	installDNSSDStub(t)
	names := browseInstances("_companion-link._tcp", 2*time.Second)
	want := []string{"Ramine's iPhone", "Living Room TV"}
	if len(names) != len(want) {
		t.Fatalf("browseInstances = %q, want %q (dedup + Add-only)", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("names[%d] = %q, want %q", i, names[i], want[i])
		}
	}
}

func TestResolveInstanceHost(t *testing.T) {
	installDNSSDStub(t)
	if got := resolveInstanceHost("iPad-Mini", "_companion-link._tcp", 2*time.Second); got != "iPad-Mini.local" {
		t.Errorf("resolveInstanceHost = %q, want iPad-Mini.local", got)
	}
	// dns-sd killed mid-line at the timeout: marker present, host missing.
	if got := resolveInstanceHost("Truncated", "_companion-link._tcp", 2*time.Second); got != "" {
		t.Errorf("truncated output should resolve to \"\", got %q", got)
	}
	if got := resolveInstanceHost("Silent", "_companion-link._tcp", 2*time.Second); got != "" {
		t.Errorf("empty output should resolve to \"\", got %q", got)
	}
}
