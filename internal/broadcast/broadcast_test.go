package broadcast

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"partyparty/internal/config"
)

// writeFFmpegStub writes an executable shell script standing in for ffmpeg: it
// appends its PID to pidLog and idles until SIGINT (which it handles cleanly,
// like real ffmpeg). Kill still works for the escalation paths.
func writeFFmpegStub(t *testing.T, dir, name, pidLog string) string {
	t.Helper()
	script := fmt.Sprintf("#!/bin/sh\necho $$ >> %q\ntrap 'exit 0' INT TERM\nwhile :; do sleep 0.1; done\n", pidLog)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func testCfg(ffmpeg string) config.Config {
	return config.Config{
		FFmpeg:     ffmpeg,
		Bitrate:    "320k",
		Codec:      "aac",
		Channels:   2,
		SampleRate: 48000,
		HLSTime:    1,
		HLSList:    24,
		Delivery:   "hls",
	}
}

// newTestBroadcaster wires a Broadcaster to a stub ffmpeg and a temp run dir.
func newTestBroadcaster(t *testing.T) (b *Broadcaster, pidLog, runDir string) {
	t.Helper()
	dir := t.TempDir()
	pidLog = filepath.Join(dir, "pids")
	stub := writeFFmpegStub(t, dir, "pp-ffmpeg-stub", pidLog)
	runDir = filepath.Join(dir, "run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	b = New(testCfg(stub), runDir, "", "rtsp://127.0.0.1:8554/party")
	t.Cleanup(func() {
		b.Stop()
		waitAllDead(t, pidLog, 5*time.Second)
	})
	return b, pidLog, runDir
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

func waitForState(t *testing.T, b *Broadcaster, want string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if b.Status().State == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("state never became %q (still %q)", want, b.Status().State)
}

// waitAllDead asserts that every stub ffmpeg ever spawned is gone — the
// no-orphans invariant.
func waitAllDead(t *testing.T, pidLog string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		survivors := 0
		for _, p := range readPIDs(pidLog) {
			if alive(p) {
				survivors++
			}
		}
		if survivors == 0 {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	var left []int
	for _, p := range readPIDs(pidLog) {
		if alive(p) {
			left = append(left, p)
		}
	}
	t.Fatalf("orphaned stub ffmpeg processes still alive: %v", left)
}

func TestStartShowsStartingAndStopReturnsToIdle(t *testing.T) {
	b, pidLog, _ := newTestBroadcaster(t)

	if st := b.Status(); st.State != "idle" {
		t.Fatalf("fresh broadcaster state = %q, want idle", st.State)
	}

	b.Start("test", "", Options{})
	st := b.Status()
	if st.State != "starting" {
		t.Fatalf("state after Start = %q, want starting", st.State)
	}
	if st.Device != "test" || st.DeviceName != "Test tone (440 Hz)" {
		t.Fatalf("device = %q/%q", st.Device, st.DeviceName)
	}
	if st.Bitrate != "320k" || st.Channels != 2 || st.SegDur != 1 || st.Delivery != "hls" {
		t.Fatalf("defaults not applied: %+v", st)
	}
	if st.Since == 0 {
		t.Fatal("Since should be set while starting")
	}
	found := false
	for _, l := range b.Log() {
		if strings.Contains(l, "starting capture: Test tone (440 Hz)") {
			found = true
		}
	}
	if !found {
		t.Fatal("log ring missing the 'starting capture' line")
	}
	waitFor(t, 2*time.Second, "ffmpeg stub spawned", func() bool { return len(readPIDs(pidLog)) == 1 })

	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
	waitAllDead(t, pidLog, 4*time.Second)
}

func TestStatusFlipsToLiveOnSegments(t *testing.T) {
	b, _, runDir := newTestBroadcaster(t)
	b.Start("test", "", Options{})
	if st := b.Status(); st.State != "starting" {
		t.Fatalf("state = %q, want starting", st.State)
	}
	// Segments-on-disk is the liveness signal: fake the playlist the encoder
	// would write.
	playlist := filepath.Join(runDir, "stream.m3u8")
	if err := os.WriteFile(playlist, []byte("#EXTM3U\n#EXTINF:1.0,\nseg_00001.ts\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := b.Status(); st.State != "live" {
		t.Fatalf("state with segments = %q, want live", st.State)
	}
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
}

func TestSetDeliveryIfIdle(t *testing.T) {
	b, _, runDir := newTestBroadcaster(t)

	if !b.SetDeliveryIfIdle("llhls") {
		t.Fatal("idle broadcaster should accept a delivery switch")
	}
	if b.Delivery() != "llhls" {
		t.Fatalf("delivery = %q, want llhls", b.Delivery())
	}
	if !b.SetDeliveryIfIdle("hls") {
		t.Fatal("switch back while idle should succeed")
	}

	b.Start("test", "", Options{})
	if b.SetDeliveryIfIdle("llhls") {
		t.Fatal("must refuse while starting")
	}
	if err := os.WriteFile(filepath.Join(runDir, "stream.m3u8"), []byte("#EXTM3U\nseg_00001.ts\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := b.Status(); st.State != "live" {
		t.Fatalf("state = %q, want live", st.State)
	}
	if b.SetDeliveryIfIdle("llhls") {
		t.Fatal("must refuse while live")
	}
	if b.Delivery() != "hls" {
		t.Fatalf("delivery changed while busy: %q", b.Delivery())
	}

	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
	if !b.SetDeliveryIfIdle("llhls") {
		t.Fatal("idle again — switch should succeed")
	}
}

func TestSecondStartSupersedesFirst(t *testing.T) {
	b, pidLog, _ := newTestBroadcaster(t)

	b.Start("test", "", Options{})
	waitFor(t, 2*time.Second, "first ffmpeg spawned", func() bool { return len(readPIDs(pidLog)) == 1 })

	b.Start("test", "", Options{})
	waitFor(t, 2*time.Second, "second ffmpeg spawned", func() bool { return len(readPIDs(pidLog)) == 2 })
	pids := readPIDs(pidLog)
	first, second := pids[0], pids[1]

	// The superseded encoder must die; the new one must be running.
	waitFor(t, 4*time.Second, "first ffmpeg killed", func() bool { return !alive(first) })
	if !alive(second) {
		t.Fatal("current broadcast's ffmpeg is not running")
	}
	if st := b.Status(); st.State != "starting" {
		t.Fatalf("state = %q, want starting", st.State)
	}

	// Stop must leave NO stub processes at all — the orphan check.
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
	waitAllDead(t, pidLog, 4*time.Second)
}

func TestConcurrentStartStopNoPanic(t *testing.T) {
	b, pidLog, _ := newTestBroadcaster(t)
	for i := 0; i < 50; i++ {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			b.Start("test", "", Options{})
		}()
		go func() {
			defer wg.Done()
			b.Stop()
		}()
		wg.Wait()
	}
	b.Stop()
	waitForState(t, b, "idle", 5*time.Second)
	// Every stub ever spawned across the 50 races must be gone.
	waitAllDead(t, pidLog, 8*time.Second)
}

func TestStartFailureThenRecovery(t *testing.T) {
	dir := t.TempDir()
	pidLog := filepath.Join(dir, "pids")
	writeFFmpegStub(t, dir, "pp-ffmpeg-stub", pidLog)
	runDir := filepath.Join(dir, "run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A bare binary name is resolved via PATH at each Start — point PATH at an
	// empty dir first so the launch fails, then at the stub so it recovers.
	b := New(testCfg("pp-ffmpeg-stub"), runDir, "", "")
	t.Setenv("PATH", filepath.Join(dir, "definitely-empty"))

	b.Start("test", "", Options{})
	st := b.Status()
	if st.State != "error" {
		t.Fatalf("state = %q, want error", st.State)
	}
	if !strings.Contains(st.LastError, "ffmpeg failed to launch") {
		t.Fatalf("lastError = %q", st.LastError)
	}

	// Start AFTER an error must succeed and clear the error.
	t.Setenv("PATH", dir)
	b.Start("test", "", Options{})
	st = b.Status()
	if st.State != "starting" {
		t.Fatalf("state after recovery Start = %q, want starting (lastError %q)", st.State, st.LastError)
	}
	if st.LastError != "" {
		t.Fatalf("lastError not cleared: %q", st.LastError)
	}

	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
	waitAllDead(t, pidLog, 4*time.Second)
}

func TestMacDeviceWithoutHelperErrors(t *testing.T) {
	b, _, _ := newTestBroadcaster(t) // helperPath == ""
	if b.SystemAudioAvailable() {
		t.Fatal("SystemAudioAvailable should be false without a helper")
	}
	b.Start("mac", "", Options{})
	st := b.Status()
	if st.State != "error" {
		t.Fatalf("state = %q, want error", st.State)
	}
	if !strings.Contains(st.LastError, "system-audio helper") {
		t.Fatalf("lastError = %q", st.LastError)
	}
}

func TestOptionsOverridesAndDefaults(t *testing.T) {
	b, _, _ := newTestBroadcaster(t)

	b.Start("test", "Custom Name", Options{Bitrate: "64k", Channels: 1, HLSTime: 0.5})
	st := b.Status()
	if st.Bitrate != "64k" || st.Channels != 1 || st.SegDur != 0.5 {
		t.Fatalf("overrides not applied: %+v", st)
	}
	if st.DeviceName != "Custom Name" {
		t.Fatalf("deviceName = %q", st.DeviceName)
	}
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)

	// Zero-valued Options fall back to config defaults on the next Start.
	b.Start("test", "", Options{})
	st = b.Status()
	if st.Bitrate != "320k" || st.Channels != 2 || st.SegDur != 1 {
		t.Fatalf("defaults not restored: %+v", st)
	}
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
}

func TestCleanRunDir(t *testing.T) {
	dir := t.TempDir()
	b := New(testCfg("ffmpeg"), dir, "", "")

	old := filepath.Join(dir, "seg_00001.ts")
	fresh := filepath.Join(dir, "seg_00002.ts")
	playlist := filepath.Join(dir, "stream.m3u8")
	for _, p := range []string{old, fresh, playlist} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	stale := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(old, stale, stale); err != nil {
		t.Fatal(err)
	}

	b.cleanRunDir()

	if _, err := os.Stat(playlist); !os.IsNotExist(err) {
		t.Error("stale playlist should be removed")
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("old segment should be removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("recent segment should be kept (mid-download guests)")
	}
}

// TestCaptureNote verifies the helper's hogged-output markers flow through the
// formatScanner into Status().Note (the Roon Exclusive-Mode field failure).
func TestCaptureNote(t *testing.T) {
	dir := t.TempDir()
	runDir := filepath.Join(dir, "run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	b := New(testCfg("ffmpeg"), runDir, "", "rtsp://127.0.0.1:8554/party")
	fs := newFormatScanner(b)

	if n := b.Status().Note; n != "" {
		t.Fatalf("fresh broadcaster note = %q, want empty", n)
	}
	fs.Write([]byte("ppcapture: CAPTURE-BLOCKED exclusive-mode pid=742\n"))
	if n := b.Status().Note; !strings.Contains(n, "EXCLUSIVE") {
		t.Fatalf("after CAPTURE-BLOCKED note = %q, want exclusive-control warning", n)
	}
	fs.Write([]byte("ppcapture: CAPTURE-OK\n"))
	if n := b.Status().Note; n != "" {
		t.Fatalf("after CAPTURE-OK note = %q, want cleared", n)
	}
	fs.Write([]byte("ppcapture: CAPTURE-STALLED no-frames\n"))
	if n := b.Status().Note; !strings.Contains(n, "stalled") {
		t.Fatalf("after CAPTURE-STALLED note = %q, want stall warning", n)
	}
}
