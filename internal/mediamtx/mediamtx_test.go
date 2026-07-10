package mediamtx

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
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
	// A (wrong) second spawn would log its own PID within a beat — give it one.
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
		t.Fatalf("graceful SIGINT path took %v — kill escalation fired", el)
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
		t.Fatalf("StopWait returned in %v — SIGINT-ignoring child cannot die before the grace period", el)
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
	t.Run("times out against a closed port", func(t *testing.T) {
		addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
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
	t.Run("times out against a closed port", func(t *testing.T) {
		addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
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
