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

func TestStatusFlipsToLiveOnProgress(t *testing.T) {
	b, _, runDir := newTestBroadcaster(t)
	b.Start("test", "", Options{})
	if st := b.Status(); st.State != "starting" {
		t.Fatalf("state = %q, want starting", st.State)
	}
	// Liveness is ffmpeg's -progress output: fake the progress block it writes
	// ~1s after real frames start flowing.
	if err := os.WriteFile(filepath.Join(runDir, "progress.txt"), []byte("frame=42\nout_time_us=1000000\nprogress=continue\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := b.Status(); st.State != "live" {
		t.Fatalf("state after progress = %q, want live", st.State)
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
	if err := os.WriteFile(filepath.Join(runDir, "progress.txt"), []byte("progress=continue\n"), 0o644); err != nil {
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

func TestOTAEncodeOverridesAppliedOnStart(t *testing.T) {
	b, _, _ := newTestBroadcaster(t)
	// The provider advertises OTA encode overrides (as a pushed config.json would).
	b.SetOverrides(func() config.Overrides {
		br, ch := "128k", 1
		return config.Overrides{Bitrate: &br, Channels: &ch}
	})
	// Empty caller opts -> the OTA override fills them on this Go Live.
	b.Start("test", "", Options{})
	if st := b.Status(); st.Bitrate != "128k" || st.Channels != 1 {
		t.Fatalf("OTA override not applied on Start: %+v", st)
	}
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)

	// An explicit caller value must still win over the OTA override.
	b.Start("test", "", Options{Bitrate: "96k"})
	if st := b.Status(); st.Bitrate != "96k" {
		t.Fatalf("explicit opts should beat the OTA override, got %q", st.Bitrate)
	}
	b.Stop()
	waitForState(t, b, "idle", 3*time.Second)
}

func TestSegmentedRecordPath(t *testing.T) {
	if got := segmentedRecordPath("/e/set.aac", 1); got != "/e/set-2.aac" {
		t.Fatalf("first rebuild segment = %q, want /e/set-2.aac", got)
	}
	if got := segmentedRecordPath("/e/set.aac", 2); got != "/e/set-3.aac" {
		t.Fatalf("second rebuild segment = %q, want /e/set-3.aac", got)
	}
	if got := segmentedRecordPath("", 1); got != "" {
		t.Fatalf("no recording -> empty, got %q", got)
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

// teeArg returns the single "-f tee" output-spec string buildArgs produced (it
// is always the final arg, right after "-map 0:a").
func teeArg(t *testing.T, args []string) string {
	t.Helper()
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "tee" && args[i-1] == "-f" {
			return args[len(args)-1]
		}
	}
	t.Fatalf("no -f tee leg in args: %v", args)
	return ""
}

const rtspLeg = "[f=rtsp:rtsp_transport=tcp:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]rtsp://127.0.0.1:8554/party"

// TestBuildArgsMirrorLeg pins the critical-safety contract: the cloud-mirror
// tee leg is present ONLY when a mirror dir is configured, it never alters the
// LAN RTSP leg or the record leg, and every leg carries the exact isolation
// flags (onfail=ignore + use_fifo=1 + drop_pkts_on_overflow=1) that keep a
// slow/dead cloud upload OR record disk from ever back-pressuring the live LAN
// stream — the drop-on-overflow is what makes "slow" (not just "failed to open")
// non-blocking, closing the one-way latency ratchet.
func TestBuildArgsMirrorLeg(t *testing.T) {
	b := New(testCfg("ffmpeg"), t.TempDir(), "", "rtsp://127.0.0.1:8554/party")
	base := argSnap{bitrate: "320k", channels: 2, hlsTime: 1, delivery: "llhls"}

	// Mirror OFF: exactly the RTSP leg, no HLS leg — byte-for-byte as today.
	off := teeArg(t, b.buildArgs("test", 48000, 2, base))
	if off != rtspLeg {
		t.Fatalf("mirror-off tee = %q, want exactly the RTSP leg %q", off, rtspLeg)
	}
	if strings.Contains(off, "f=hls") {
		t.Fatalf("mirror-off tee must not contain an HLS leg: %q", off)
	}

	// Mirror OFF + record: RTSP leg then the ADTS record leg, still no HLS leg.
	rec := base
	rec.recordPath = "/tmp/set.aac"
	offRec := teeArg(t, b.buildArgs("test", 48000, 2, rec))
	if offRec != rtspLeg+"|[f=adts:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]/tmp/set.aac" {
		t.Fatalf("mirror-off record tee = %q", offRec)
	}

	// Mirror ON: RTSP leg UNCHANGED, plus the isolated HLS leg → <dir>/live.m3u8.
	on := base
	on.mirrorDir = "/scratch/livemirror"
	got := teeArg(t, b.buildArgs("test", 48000, 2, on))
	wantHLS := "[f=hls:hls_time=3:hls_list_size=8:hls_flags=delete_segments+omit_endlist:hls_segment_type=mpegts:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]/scratch/livemirror/live.m3u8"
	if got != rtspLeg+"|"+wantHLS {
		t.Fatalf("mirror-on tee = %q, want RTSP leg + %q", got, wantHLS)
	}
	if !strings.HasPrefix(got, rtspLeg+"|") {
		t.Fatalf("mirror-on tee must keep the RTSP leg first and unchanged: %q", got)
	}

	// Mirror ON + record: legs stay in order rtsp | adts | hls.
	both := rec
	both.mirrorDir = "/scratch/livemirror"
	gotBoth := teeArg(t, b.buildArgs("test", 48000, 2, both))
	wantBoth := rtspLeg + "|[f=adts:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]/tmp/set.aac|" + wantHLS
	if gotBoth != wantBoth {
		t.Fatalf("mirror-on+record tee = %q, want %q", gotBoth, wantBoth)
	}
}

// TestSetMirrorDirFlowsToArgs verifies SetMirrorDir is what the live Start path
// snapshots into the tee — the on/off toggle the --cloud-mirror flag drives.
func TestSetMirrorDirFlowsToArgs(t *testing.T) {
	b, _, _ := newTestBroadcaster(t)
	if b.MirrorDir() != "" {
		t.Fatalf("fresh broadcaster mirror dir = %q, want empty", b.MirrorDir())
	}
	b.SetMirrorDir("/scratch/live")
	if b.MirrorDir() != "/scratch/live" {
		t.Fatalf("mirror dir = %q, want /scratch/live", b.MirrorDir())
	}
	snap := argSnap{bitrate: "320k", channels: 2, hlsTime: 1, delivery: "llhls", mirrorDir: b.MirrorDir()}
	if tee := teeArg(t, b.buildArgs("test", 48000, 2, snap)); !strings.Contains(tee, "/scratch/live/live.m3u8") {
		t.Fatalf("tee missing the configured mirror playlist: %q", tee)
	}
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
	if st := b.Status(); !strings.Contains(st.Note, "EXCLUSIVE") || !st.CaptureBad {
		t.Fatalf("after CAPTURE-BLOCKED note=%q captureBad=%v, want warning + true", st.Note, st.CaptureBad)
	}
	fs.Write([]byte("ppcapture: CAPTURE-OK\n"))
	if st := b.Status(); st.Note != "" || st.CaptureBad {
		t.Fatalf("after CAPTURE-OK note=%q captureBad=%v, want cleared + false", st.Note, st.CaptureBad)
	}
	// CAPTURE-OK clears the exclusive-output warning.
	fs.Write([]byte("ppcapture: CAPTURE-BLOCKED exclusive-mode pid=742\n"))
	fs.Write([]byte("ppcapture: CAPTURE-OK\n"))
	if st := b.Status(); st.Note != "" || st.CaptureBad {
		t.Fatalf("after CAPTURE-OK note=%q captureBad=%v, want cleared + false", st.Note, st.CaptureBad)
	}
}
