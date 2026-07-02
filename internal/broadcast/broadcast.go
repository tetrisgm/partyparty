package broadcast

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"partyparty/internal/config"
)

type Status struct {
	State      string  `json:"state"` // idle | starting | live | error | stopping
	Device     string  `json:"device"`
	DeviceName string  `json:"deviceName"`
	Since      int64   `json:"since"`
	Bitrate    string  `json:"bitrate"`
	Channels   int     `json:"channels"` // 1 = mono, 2 = stereo
	SegDur     float64 `json:"segDur"`   // HLS segment length in seconds (latency lever)
	Delivery   string  `json:"delivery"` // llhls | hls
	SampleRate int     `json:"sampleRate"`
	LastError  string  `json:"lastError"`
	Note       string  `json:"note,omitempty"` // non-fatal hint, e.g. capture produces no audio yet
}

// Options are per-broadcast overrides; zero values fall back to config defaults.
type Options struct {
	Bitrate  string  // e.g. "256k"; "" = config default
	Channels int     // 1 = mono, 2 = stereo; 0 = config default
	HLSTime  float64 // segment length in seconds; 0 = config default
}

// Broadcaster manages the capture pipeline: an FFmpeg process writing a live
// HLS playlist + segments into runDir. For the "mac" source it also runs the
// ScreenCaptureKit helper whose PCM output is piped into FFmpeg.
type Broadcaster struct {
	cfg        config.Config
	runDir     string
	helperPath string // path to the extracted ppcapture binary ("" if unavailable)
	ingestURL  string // RTSP push target for MediaMTX (llhls delivery)
	playlist   string

	mu         sync.Mutex
	cmd        *exec.Cmd // ffmpeg
	helper     *exec.Cmd // ppcapture (system audio), when device == "mac"
	state      string
	device     string
	deviceName string
	bitrate    string  // active AAC bitrate (e.g. "256k")
	channels   int     // active channel count (1 mono, 2 stereo)
	hlsTime    float64 // active segment length in seconds
	delivery   string  // active delivery mode: llhls | hls
	startedAt  time.Time
	lastError  string

	logMu    sync.Mutex
	logLines []string
}

func New(cfg config.Config, runDir, helperPath, ingestURL string) *Broadcaster {
	return &Broadcaster{
		cfg:        cfg,
		runDir:     runDir,
		helperPath: helperPath,
		ingestURL:  ingestURL,
		playlist:   filepath.Join(runDir, "stream.m3u8"),
		state:      "idle",
		bitrate:    cfg.Bitrate,
		channels:   cfg.Channels,
		hlsTime:    float64(cfg.HLSTime),
		delivery:   cfg.Delivery,
	}
}

// SetDelivery switches the delivery mode (llhls/hls). Stops any current
// broadcast so the next Start uses the new mode.
func (b *Broadcaster) SetDelivery(mode string) {
	b.Stop()
	b.mu.Lock()
	b.delivery = mode
	b.mu.Unlock()
}

// Delivery returns the active delivery mode.
func (b *Broadcaster) Delivery() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.delivery
}

// SystemAudioAvailable reports whether the "mac" source can be used.
func (b *Broadcaster) SystemAudioAvailable() bool { return b.helperPath != "" }

// ExternalWriter lets another subprocess (MediaMTX) log into our log ring.
func (b *Broadcaster) ExternalWriter() io.Writer { return logWriter{b} }

type logWriter struct{ b *Broadcaster }

func (w logWriter) Write(p []byte) (int, error) { w.b.pushLog(string(p)); return len(p), nil }

func (b *Broadcaster) pushLog(chunk string) {
	ts := time.Now().Format("15:04:05")
	b.logMu.Lock()
	defer b.logMu.Unlock()
	for _, line := range strings.Split(chunk, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		b.logLines = append(b.logLines, ts+"  "+line)
	}
	if len(b.logLines) > 250 {
		b.logLines = b.logLines[len(b.logLines)-250:]
	}
}

func (b *Broadcaster) Log() []string {
	b.logMu.Lock()
	defer b.logMu.Unlock()
	out := make([]string, len(b.logLines))
	copy(out, b.logLines)
	return out
}

func (b *Broadcaster) cleanRunDir() {
	entries, _ := os.ReadDir(b.runDir)
	for _, e := range entries {
		n := e.Name()
		switch {
		case strings.HasSuffix(n, ".m3u8"):
			_ = os.Remove(filepath.Join(b.runDir, n))
		case strings.HasSuffix(n, ".ts") || strings.HasSuffix(n, ".m4s"):
			// Keep very recent segments so guests mid-download during a source
			// switch don't 404; epoch sequence numbering means new segments
			// never collide with these, and the next clean sweeps them.
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < 60*time.Second {
				continue
			}
			_ = os.Remove(filepath.Join(b.runDir, n))
		}
	}
}

func (b *Broadcaster) buildArgs(device string) []string {
	c := b.cfg
	var input []string
	switch device {
	case "test":
		// -re paces the tone at realtime so a test run rehearses the actual
		// go-live behavior (segment fill, playlist cadence) instead of encoding
		// at CPU speed.
		input = []string{"-re", "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:beep_factor=4:sample_rate=%d", c.SampleRate)}
	case "mac":
		// PCM piped in from the ScreenCaptureKit helper on stdin. The helper
		// hardcodes 48 kHz/2ch (ppcapture.swift); raw f32le has no header, so
		// declaring any other rate here would silently pitch-shift the whole
		// stream — the input rate is therefore pinned, and c.SampleRate is only
		// applied on the OUTPUT side (resample) below. nobuffer/low_delay/
		// probesize keep ffmpeg from sitting on input before the encoder sees it.
		input = []string{
			"-fflags", "+nobuffer", "-flags", "+low_delay", "-probesize", "32", "-analyzeduration", "0",
			"-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-",
		}
	default:
		input = []string{"-fflags", "+nobuffer", "-f", "avfoundation", "-thread_queue_size", "1024", "-i", ":" + device}
	}
	args := []string{"-hide_banner", "-loglevel", "warning"}
	args = append(args, input...)
	args = append(args,
		"-vn",
		"-ac", strconv.Itoa(b.channels),
		"-ar", strconv.Itoa(c.SampleRate),
		"-c:a", c.Codec, "-b:a", b.bitrate,
	)
	// The plain-HLS output ALWAYS exists — it's the delivery every device can
	// play. Flags: muxdelay/muxpreload 0 + flush_packets keep PROGRAM-DATE-TIME
	// honest; temp_file = atomic playlist publish (no truncated m3u8 under
	// polling load); discont_start marks restarts; delete_threshold keeps
	// just-rotated segments for laggard phones; epoch sequence numbers never
	// rewind under a guest across restarts.
	hlsOpts := strings.Join([]string{
		"hls_time=" + strconv.FormatFloat(b.hlsTime, 'g', -1, 64),
		"hls_list_size=" + strconv.Itoa(c.HLSList),
		"hls_flags=delete_segments+omit_endlist+append_list+independent_segments+program_date_time+temp_file+discont_start",
		"hls_delete_threshold=10",
		"hls_start_number_source=epoch",
		"hls_segment_type=mpegts",
		"hls_segment_filename=" + filepath.Join(b.runDir, "seg_%05d.ts"),
		// NOTE: muxdelay/muxpreload are ffmpeg CLI options, not AVOptions — they
		// don't exist inside a tee slave (and this build's hls muxer lacks
		// hls_ts_options). Their absence adds a small CONSTANT mux delay that
		// shifts every listener equally, so room sync is unaffected.
		"flush_packets=1",
	}, ":")

	if b.delivery == "llhls" {
		// BOTH flavors from one encode (tee muxer): the plain playlist for
		// everyone, plus an RTSP push that MediaMTX repackages into LL-HLS over
		// HTTPS. Guests probe the LL URL themselves and fall back to plain
		// per-device (rebind-protecting routers, hostile resolvers) — engaging
		// LL can never hand anyone a dead stream. use_fifo + onfail=ignore: a
		// dying MediaMTX must never stall or kill the plain output.
		args = append(args,
			"-f", "tee", "-map", "0:a",
			"["+hlsOpts+"]"+b.playlist+
				"|[f=rtsp:rtsp_transport=tcp:onfail=ignore:use_fifo=1]"+b.ingestURL,
		)
	} else {
		args = append(args,
			"-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1",
			"-f", "hls",
			"-hls_time", strconv.FormatFloat(b.hlsTime, 'g', -1, 64),
			"-hls_list_size", strconv.Itoa(c.HLSList),
			"-hls_flags", "delete_segments+omit_endlist+append_list+independent_segments+program_date_time+temp_file+discont_start",
			"-hls_delete_threshold", "10",
			"-hls_start_number_source", "epoch",
			"-hls_segment_type", "mpegts",
			"-hls_segment_filename", filepath.Join(b.runDir, "seg_%05d.ts"),
			b.playlist,
		)
	}
	return args
}

// Start stops any current broadcast, then captures `device` and republishes as
// HLS. device is "test", "mac", or an avfoundation device index. Zero-valued
// Options fields fall back to the configured defaults.
func (b *Broadcaster) Start(device, deviceName string, opts Options) {
	b.Stop()

	b.mu.Lock()
	b.cleanRunDir()
	if opts.Bitrate == "" {
		opts.Bitrate = b.cfg.Bitrate
	}
	if opts.Channels == 0 {
		opts.Channels = b.cfg.Channels
	}
	if opts.HLSTime <= 0 {
		opts.HLSTime = float64(b.cfg.HLSTime)
	}
	b.bitrate = opts.Bitrate
	b.channels = opts.Channels
	b.hlsTime = opts.HLSTime
	if deviceName == "" {
		switch device {
		case "test":
			deviceName = "Test tone (440 Hz)"
		case "mac":
			deviceName = "Mac output (system audio)"
		default:
			deviceName = "device " + device
		}
	}
	b.device = device
	b.deviceName = deviceName
	b.state = "starting"
	b.lastError = ""
	b.startedAt = time.Now()

	if device == "mac" && b.helperPath == "" {
		b.state = "error"
		b.lastError = "system-audio helper not built — run `make` to compile it"
		b.mu.Unlock()
		b.pushLog("[partyparty] " + b.lastError)
		return
	}

	ff := exec.Command(b.cfg.FFmpeg, b.buildArgs(device)...)
	ff.Stderr = logWriter{b}

	var helper *exec.Cmd
	var pr, pw *os.File
	if device == "mac" {
		var err error
		if pr, pw, err = os.Pipe(); err != nil {
			b.state = "error"
			b.lastError = err.Error()
			b.mu.Unlock()
			return
		}
		helper = exec.Command(b.helperPath)
		helper.Stdout = pw
		helper.Stderr = logWriter{b}
		ff.Stdin = pr
		b.helper = helper
	}
	b.cmd = ff
	b.mu.Unlock()

	b.pushLog("[partyparty] starting capture: " + deviceName)

	if helper != nil {
		if err := helper.Start(); err != nil {
			pr.Close()
			pw.Close()
			b.fail("system-audio helper failed: " + err.Error())
			return
		}
	}
	if err := ff.Start(); err != nil {
		if helper != nil {
			_ = helper.Process.Kill()
			pr.Close()
			pw.Close()
		}
		b.fail("ffmpeg failed to launch: " + err.Error())
		return
	}
	// Children hold their own dups of the pipe; the parent must close its copies
	// so EOF propagates when the helper exits.
	if pr != nil {
		pr.Close()
		pw.Close()
	}

	go func(c, h *exec.Cmd) {
		werr := c.Wait()
		if h != nil {
			_ = h.Process.Kill()
			_ = h.Wait()
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.cmd != c {
			return // superseded by a newer broadcast
		}
		if b.state == "stopping" {
			b.state = "idle"
			b.pushLog("[partyparty] broadcast stopped")
		} else {
			b.state = "error"
			if werr != nil {
				b.lastError = "ffmpeg exited: " + werr.Error()
			} else {
				b.lastError = "ffmpeg exited"
			}
			if b.device == "mac" {
				b.lastError += " — did you grant Screen Recording permission?"
			}
			b.pushLog("[partyparty] " + b.lastError)
		}
		b.cmd = nil
		b.helper = nil
	}(ff, helper)
}

func (b *Broadcaster) fail(msg string) {
	b.mu.Lock()
	b.state = "error"
	b.lastError = msg
	b.cmd = nil
	b.helper = nil
	b.mu.Unlock()
	b.pushLog("[partyparty] " + msg)
}

func (b *Broadcaster) Stop() {
	b.mu.Lock()
	cmd, helper := b.cmd, b.helper
	if cmd == nil && helper == nil {
		b.state = "idle"
		b.mu.Unlock()
		return
	}
	b.state = "stopping"
	b.mu.Unlock()

	if cmd != nil {
		_ = cmd.Process.Signal(syscall.SIGINT)
	}
	if helper != nil {
		_ = helper.Process.Signal(syscall.SIGINT)
	}
	go func(c, h *exec.Cmd) {
		time.Sleep(1500 * time.Millisecond)
		b.mu.Lock()
		if c != nil && b.cmd == c {
			_ = c.Process.Kill()
		}
		if h != nil && b.helper == h {
			_ = h.Process.Kill()
		}
		b.mu.Unlock()
	}(cmd, helper)
}

func (b *Broadcaster) hasSegments() bool {
	data, err := os.ReadFile(b.playlist)
	if err != nil {
		return false
	}
	s := string(data)
	return strings.Contains(s, ".ts") || strings.Contains(s, ".m4s")
}

func (b *Broadcaster) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == "starting" && b.hasSegments() {
		// Both modes write the plain playlist (llhls tees it alongside the
		// RTSP push), so segments-on-disk is the truthful liveness signal.
		b.state = "live"
	}
	var since int64
	if !b.startedAt.IsZero() {
		since = b.startedAt.UnixMilli()
	}
	note := ""
	if b.state == "starting" && !b.startedAt.IsZero() && time.Since(b.startedAt) > 6*time.Second {
		switch b.device {
		case "test":
			note = "No audio yet — ffmpeg is still starting."
		case "mac":
			note = "No audio yet. Grant Screen Recording permission (System Settings → Privacy & Security → Screen Recording), then Stop and Start again — and make sure something is playing."
		default:
			note = "No audio yet. Grant microphone permission (System Settings → Privacy & Security → Microphone) and check that your source is routed to this device."
		}
	}
	return Status{
		State:      b.state,
		Device:     b.device,
		DeviceName: b.deviceName,
		Since:      since,
		Bitrate:    b.bitrate,
		Channels:   b.channels,
		SegDur:     b.hlsTime,
		Delivery:   b.delivery,
		SampleRate: b.cfg.SampleRate,
		LastError:  b.lastError,
		Note:       note,
	}
}
