//go:build !windows

package mediamtx

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// writeStub writes an executable shell script standing in for mediamtx: it
// appends its PID to pidLog and idles. graceful=true exits 0 on SIGINT (the
// well-behaved child); graceful=false ignores SIGINT so only the Kill
// escalation can end it.
func writeStub(t *testing.T, dir, name, pidLog string, graceful bool) string {
	t.Helper()
	trap := "trap 'exit 0' INT TERM"
	if !graceful {
		trap = "trap '' INT TERM"
	}
	script := fmt.Sprintf("#!/bin/sh\necho $$ >> %q\n%s\nwhile :; do sleep 0.1; done\n", pidLog, trap)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func readPIDs(pidLog string) []int {
	data, err := os.ReadFile(pidLog)
	if err != nil {
		return nil
	}
	var pids []int
	for _, f := range strings.Fields(string(data)) {
		if n, err := strconv.Atoi(f); err == nil {
			pids = append(pids, n)
		}
	}
	return pids
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, d time.Duration, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v: %s", d, msg)
}

// blackholeAddr sits in TEST-NET-1 (RFC 5737): reserved, never routed, so a
// dial there can only run out its timeout.
const blackholeAddr = "192.0.2.1:9"

func freePort(t *testing.T) int {
	t.Helper()
	ln := listenLocalTCP(t)
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func listenLocalTCP(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		if strings.Contains(err.Error(), "operation not permitted") {
			t.Skipf("local TCP bind is not permitted in this environment: %v", err)
		}
		t.Fatal(err)
	}
	return ln
}

func TestStartIdempotent(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, true), "cfg.yml", nil)
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.StopWait()
	if err := s.Start(); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if !s.Running() {
		t.Fatal("Running() = false after Start")
	}
	waitFor(t, 2*time.Second, "stub logged its pid", func() bool { return len(readPIDs(pidLog)) >= 1 })
	// A (wrong) second spawn would log its own PID within a beat - give it one.
	time.Sleep(150 * time.Millisecond)
	if n := len(readPIDs(pidLog)); n != 1 {
		t.Fatalf("expected exactly 1 spawned process, got %d", n)
	}
}

func TestStopReturnsImmediately(t *testing.T) {
	// Stubborn stub: SIGINT is ignored, so a synchronous stop would eat the
	// full kill-escalation delay. Stop() must not.
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, false), "cfg.yml", nil)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "stub logged its pid", func() bool { return len(readPIDs(pidLog)) == 1 })
	pid := readPIDs(pidLog)[0]

	begin := time.Now()
	s.Stop()
	if el := time.Since(begin); el > 500*time.Millisecond {
		t.Fatalf("Stop() blocked for %v", el)
	}
	if s.Running() {
		t.Fatal("Running() = true after Stop")
	}
	// The async escalation (SIGINT grace, then Kill) must still reap it.
	waitFor(t, 4*time.Second, "process killed by escalation", func() bool { return !alive(pid) })
}

func TestStopWaitGraceful(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, true), "cfg.yml", nil)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "stub logged its pid", func() bool { return len(readPIDs(pidLog)) == 1 })
	pid := readPIDs(pidLog)[0]

	begin := time.Now()
	s.StopWait()
	el := time.Since(begin)
	if alive(pid) {
		t.Fatal("process still alive after StopWait")
	}
	if el >= 1400*time.Millisecond {
		t.Fatalf("graceful SIGINT path took %v - kill escalation fired", el)
	}
	if s.Running() {
		t.Fatal("Running() = true after StopWait")
	}
}

func TestStopWaitKillEscalation(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, false), "cfg.yml", nil)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "stub logged its pid", func() bool { return len(readPIDs(pidLog)) == 1 })
	pid := readPIDs(pidLog)[0]

	begin := time.Now()
	s.StopWait()
	el := time.Since(begin)
	if el < 1400*time.Millisecond {
		t.Fatalf("StopWait returned in %v - SIGINT-ignoring child cannot die before the grace period", el)
	}
	waitFor(t, 2*time.Second, "process reaped after Kill", func() bool { return !alive(pid) })
}

func TestStartAfterStopWait(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, true), "cfg.yml", nil)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "first pid", func() bool { return len(readPIDs(pidLog)) == 1 })
	s.StopWait()
	if err := s.Start(); err != nil {
		t.Fatalf("Start after StopWait: %v", err)
	}
	if !s.Running() {
		t.Fatal("Running() = false after restart")
	}
	waitFor(t, 2*time.Second, "second pid", func() bool { return len(readPIDs(pidLog)) == 2 })
	pids := readPIDs(pidLog)
	if alive(pids[0]) {
		t.Fatal("first instance survived StopWait")
	}
	if !alive(pids[1]) {
		t.Fatal("restarted instance is not running")
	}
	s.StopWait()
	if alive(pids[1]) {
		t.Fatal("second instance survived StopWait")
	}
}

func TestDoubleStopSafe(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, true), "cfg.yml", nil)

	// Never started: both stop flavors are no-ops, no panic.
	s.Stop()
	s.StopWait()

	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "pid logged", func() bool { return len(readPIDs(pidLog)) == 1 })
	pid := readPIDs(pidLog)[0]
	s.Stop()
	s.Stop()
	s.StopWait()
	waitFor(t, 4*time.Second, "process gone", func() bool { return !alive(pid) })
}

func TestStartErrorMissingBinary(t *testing.T) {
	s := NewServer(filepath.Join(t.TempDir(), "no-such-binary"), "cfg.yml", nil)
	if err := s.Start(); err == nil {
		t.Fatal("Start with a nonexistent binary should error")
	}
	if s.Running() {
		t.Fatal("Running() = true after failed Start")
	}
}

func TestWaitReady(t *testing.T) {
	t.Run("success against a live listener", func(t *testing.T) {
		ln := listenLocalTCP(t)
		defer ln.Close()
		if err := WaitReady(ln.Addr().String(), 2*time.Second); err != nil {
			t.Fatalf("WaitReady: %v", err)
		}
	})
	t.Run("times out when nothing answers", func(t *testing.T) {
		// TEST-NET-1 is reserved documentation space, so nothing can ever
		// accept there. A "closed" loopback port is not hermetic: the WSL
		// merge-gate runner shares its network stack with Windows, where a
		// service accepted the freshly-freed port and WaitReady returned nil.
		addr := blackholeAddr
		begin := time.Now()
		err := WaitReady(addr, 400*time.Millisecond)
		if err == nil {
			t.Fatal("expected timeout error")
		}
		if !strings.Contains(err.Error(), addr) {
			t.Fatalf("error should name the address, got: %v", err)
		}
		if time.Since(begin) < 400*time.Millisecond {
			t.Fatal("WaitReady returned before the timeout elapsed")
		}
	})
}

func TestWaitHTTPSReady(t *testing.T) {
	t.Run("success against a TLS HTTP listener", func(t *testing.T) {
		ln := listenLocalTCP(t)
		certPath := filepath.Join(t.TempDir(), "cert.pem")
		keyPath := filepath.Join(t.TempDir(), "key.pem")
		if err := GenerateSelfSignedCert(certPath, keyPath, []string{"127.0.0.1"}, nil); err != nil {
			t.Fatal(err)
		}
		pair, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.NotFound(w, r)
			}),
		}
		go func() {
			_ = srv.Serve(tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{pair}}))
		}()
		defer srv.Close()
		if err := WaitHTTPSReady(ln.Addr().String(), 2*time.Second); err != nil {
			t.Fatalf("WaitHTTPSReady: %v", err)
		}
	})
	t.Run("times out when nothing answers", func(t *testing.T) {
		addr := blackholeAddr
		err := WaitHTTPSReady(addr, 400*time.Millisecond)
		if err == nil {
			t.Fatal("expected timeout error")
		}
		if !strings.Contains(err.Error(), addr) {
			t.Fatalf("error should name the address, got: %v", err)
		}
	})
}

func TestEnsureReadyFailsWhenPortNeverOpens(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	s := NewServer(writeStub(t, dir, "mtx", pidLog, true), "cfg.yml", nil)
	defer s.StopWait()
	// The stub never listens on anything, so EnsureReady must report a hard
	// error (this is the port-conflict / bad-config detection path).
	if err := s.EnsureReady(freePort(t), freePort(t), 400*time.Millisecond); err == nil {
		t.Fatal("EnsureReady should fail when the ingest port never opens")
	}
	if !s.Running() {
		t.Fatal("process should still be running (EnsureReady does not kill it)")
	}
}

func TestWriteConfig(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mediamtx.yml")
	err := WriteConfig(p, ConfigOpts{
		RTSPPort: 8554, HLSPort: 8888, Path: "party",
		CertPath: "/tmp/c.pem", KeyPath: "/tmp/k.pem",
		SegDur: "1s", PartDur: "200ms", SegCount: 7,
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	for _, want := range []string{
		"rtspAddress: 127.0.0.1:8554",
		"hlsAddress: 127.0.0.1:8888",
		"hlsSegmentCount: 7",
		"hlsSegmentDuration: 1s",
		"hlsPartDuration: 200ms",
		"hlsServerCert: /tmp/c.pem",
		"hlsServerKey: /tmp/k.pem",
		"  party:",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config missing %q:\n%s", want, got)
		}
	}
}

func TestParseHLSMediaPlaylistIgnoresInitialGaps(t *testing.T) {
	body := `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=2.50700,CAN-SKIP-UNTIL=12.00000
#EXT-X-PART-INF:PART-TARGET=1.00300
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-GAP
#EXTINF:2.00000,synthetic gap
gap.mp4
#EXT-X-GAP
#EXTINF:2.00000,
gap.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-07-10T00:00:00.000Z
#EXTINF:2.00000,
real_seg0.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-07-10T00:00:02.000Z
#EXT-X-PART:DURATION=1.00300,URI="real_part0.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.50150,URI="real_part1.mp4"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="real_part2.mp4"
`
	state := parseHLSMediaPlaylist(body)
	if state.GapHistory != 4 {
		t.Fatalf("gap history = %v, want 4", state.GapHistory)
	}
	if math.Abs(state.RealHistory-3.5045) > 0.000001 {
		t.Fatalf("real history = %v, want 3.5045", state.RealHistory)
	}
	if state.PartHoldBack != 2.507 || state.PartTarget != 1.003 {
		t.Fatalf("hold-back/part-target = %v/%v", state.PartHoldBack, state.PartTarget)
	}
}

func TestParseHLSMediaPlaylistUsesContiguousEdgeHistory(t *testing.T) {
	body := `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:9
#EXTINF:2.0,
old-real.mp4
#EXT-X-GAP
#EXTINF:2.0,
gap.mp4
#EXTINF:2.0,
new-real.mp4
`
	state := parseHLSMediaPlaylist(body)
	if state.RealHistory != 2 || state.GapHistory != 2 {
		t.Fatalf("real/gap history = %v/%v, want 2/2", state.RealHistory, state.GapHistory)
	}
}

func TestPlaylistVariantURI(t *testing.T) {
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000\nabc_stream.m3u8?token=x\n"
	if got := playlistVariantURI(master); got != "abc_stream.m3u8?token=x" {
		t.Fatalf("variant URI = %q", got)
	}
	media := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\na.mp4\n"
	if got := playlistVariantURI(media); got != "" {
		t.Fatalf("media playlist variant = %q, want empty", got)
	}
}

func TestInspectHLSFollowsVariantAndReportsReadiness(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/party/index.m3u8", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000\nroom_audio.m3u8\n")
	})
	mux.HandleFunc("/party/room_audio.m3u8", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `#EXTM3U
#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=2.5
#EXT-X-PART-INF:PART-TARGET=1.0
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-GAP
#EXTINF:2.0,
gap.mp4
#EXTINF:2.0,
real0.mp4
#EXT-X-PART:DURATION=1.0,URI="real1.mp4"
`)
	})
	ts := httptest.NewUnstartedServer(mux)
	ts.StartTLS()
	defer ts.Close()
	_, portText, err := net.SplitHostPort(ts.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}

	state := InspectHLS(port, "party")
	if !state.Publishing || state.Generation != "room_audio.m3u8" {
		t.Fatalf("publishing/generation = %v/%q", state.Publishing, state.Generation)
	}
	if state.RealHistory != 3 || state.GapHistory != 2 {
		t.Fatalf("real/gap history = %v/%v, want 3/2", state.RealHistory, state.GapHistory)
	}
	if state.PartHoldBack != 2.5 || state.PartTarget != 1 {
		t.Fatalf("hold-back/part-target = %v/%v", state.PartHoldBack, state.PartTarget)
	}
}

func TestGenerateSelfSignedCert(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	err := GenerateSelfSignedCert(certPath, keyPath,
		[]string{"192.168.1.10", "not-an-ip"}, []string{"party.local", ""})
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("generated cert/key don't load as a TLS pair: %v", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := leaf.VerifyHostname("party.local"); err != nil {
		t.Errorf("cert should cover party.local: %v", err)
	}
	if err := leaf.VerifyHostname("192.168.1.10"); err != nil {
		t.Errorf("cert should cover 192.168.1.10: %v", err)
	}
	if err := leaf.VerifyHostname("other.example"); err == nil {
		t.Error("cert should NOT cover other.example")
	}
	if time.Now().After(leaf.NotAfter) || time.Now().Before(leaf.NotBefore) {
		t.Error("cert validity window doesn't include now")
	}
}
