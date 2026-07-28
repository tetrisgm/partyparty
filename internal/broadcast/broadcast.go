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
	Note       string  `json:"note,omitempty"`       // non-fatal hint, e.g. capture produces no audio yet
	CaptureBad bool    `json:"captureBad,omitempty"` // a real capture failure (hogged/stalled output) - menu-bar alarm
}

// Options are per-broadcast overrides; zero values fall back to config defaults.
type Options struct {
	Bitrate  string  // e.g. "256k"; "" = config default
	Channels int     // 1 = mono, 2 = stereo; 0 = config default
	HLSTime  float64 // segment length in seconds; 0 = config default
	// RecordPath: also write the encoded set to this file (ADTS/AAC - raw and
	// unkillable: no finalization step, so a crash mid-set loses nothing).
	// "" = no recording. llhls delivery only (it rides the tee).
	RecordPath string
}

// Broadcaster manages the capture pipeline: an FFmpeg process writing a live
// HLS playlist + segments into runDir. For the "mac" source it also runs the
// Core Audio process-tap helper whose PCM output is piped into FFmpeg.
type Broadcaster struct {
	cfg        config.Config
	runDir     string
	helperPath string // path to the extracted ppcapture binary ("" if unavailable)
	ingestURL  string // RTSP push target for MediaMTX (llhls delivery)

	mu  sync.Mutex
	gen uint64 // bumped by every Start/Stop; an in-flight Start whose
	// generation is stale aborts instead of clobbering its successor
	cmd        *exec.Cmd // ffmpeg
	helper     *exec.Cmd // ppcapture (system audio), when device == "mac"
	inRate     int       // capture sample rate actually in use (mac source; 0 otherwise)
	inCh       int
	state      string
	device     string
	deviceName string
	bitrate    string  // active AAC bitrate (e.g. "256k")
	channels   int     // active channel count (1 mono, 2 stereo)
	hlsTime    float64 // active segment length in seconds
	delivery   string  // active delivery mode: llhls | hls
	mirrorDir  string  // cloud-mirror scratch dir; "" = mirror off (no third tee leg)
	startedAt  time.Time
	lastError  string
	captureUp  bool // this generation's tap actually announced a FORMAT (capture works - so an ffmpeg death is NOT a permission problem)

	// Last Start params + a throttle, so a tap wedged by a released exclusive
	// device (Roon Exclusive Mode) can be auto-rebuilt without the DJ acting.
	lastDevice      string
	lastName        string
	lastOpts        Options
	lastAutoRestart time.Time
	overridesFn     func() config.Overrides // OTA encode overrides, re-read on each Start (nil = none)
	recordBase      string                  // the user-requested recording path; rebuilds record to fresh segments off this so a device-yank never truncates it
	recordSeg       int                     // recording segment counter, bumped per auto-restart

	logMu       sync.Mutex
	logLines    []string
	diag        io.Writer // session diagnostics tee (nil = off)
	captureNote string    // non-fatal capture warning (hogged output device), surfaced in Status
}

func New(cfg config.Config, runDir, helperPath, ingestURL string) *Broadcaster {
	return &Broadcaster{
		cfg:        cfg,
		runDir:     runDir,
		helperPath: helperPath,
		ingestURL:  ingestURL,
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

// SetDeliveryIfIdle switches the delivery mode only when nothing is running -
// atomically, under the lock. The activation auto-engage path uses this so a
// set that starts while activation is checking is never yanked ("never
// restart a live set" - check-then-act with a 6s gap was exactly that bug).
func (b *Broadcaster) SetDeliveryIfIdle(mode string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == "live" || b.state == "starting" || b.state == "stopping" {
		return false
	}
	b.delivery = mode
	return true
}

// Delivery returns the active delivery mode.
func (b *Broadcaster) Delivery() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.delivery
}

// SetMirrorDir configures (or clears) the cloud-mirror scratch directory. When
// set, every subsequent Start adds an ISOLATED third HLS tee leg (stream-copy
// of the already-encoded AAC, onfail=ignore+use_fifo=1) writing live.m3u8 +
// segments into dir - the source internal/livemirror ships to the cloud. "" (the
// default) means no mirror leg, so the pipeline is byte-for-byte what it is
// today. Set once at startup, before any broadcast. The mirror leg's failure is
// fully non-fatal: onfail=ignore isolates it exactly like the recording leg, so
// a slow or dead cloud upload can never back-pressure or kill the LAN RTSP leg.
func (b *Broadcaster) SetMirrorDir(dir string) {
	b.mu.Lock()
	b.mirrorDir = dir
	b.mu.Unlock()
}

// MirrorDir reports the configured cloud-mirror scratch directory ("" = off).
func (b *Broadcaster) MirrorDir() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.mirrorDir
}

// SystemAudioAvailable reports whether the "mac" source can be used.
func (b *Broadcaster) SystemAudioAvailable() bool { return b.helperPath != "" }

// SetDiag tees every log-ring line into the session diagnostics file.
func (b *Broadcaster) SetDiag(w io.Writer) {
	b.logMu.Lock()
	b.diag = w
	b.logMu.Unlock()
}

// SetOverrides installs a provider for OTA encode overrides, re-read on each
// Start so a config pushed mid-session applies on the next Go Live. Set once at
// startup, before any broadcast.
func (b *Broadcaster) SetOverrides(fn func() config.Overrides) {
	b.mu.Lock()
	b.overridesFn = fn
	b.mu.Unlock()
}

// ExternalWriter lets another subprocess (MediaMTX) log into our log ring.
func (b *Broadcaster) ExternalWriter() io.Writer { return logWriter{b} }

type logWriter struct{ b *Broadcaster }

func (w logWriter) Write(p []byte) (int, error) { w.b.pushLog(string(p)); return len(p), nil }

// formatScanner tees helper stderr into the log ring while watching for the
// one-time "FORMAT <rate> <channels>" announcement (the Core Audio tap's
// stream format follows the output device, so ffmpeg's input args depend on it).
type formatScanner struct {
	b    *Broadcaster
	mu   sync.Mutex
	buf  []byte
	done bool
	ch   chan [2]int
}

func newFormatScanner(b *Broadcaster) *formatScanner {
	return &formatScanner{b: b, ch: make(chan [2]int, 1)}
}

func (w *formatScanner) Write(p []byte) (int, error) {
	w.b.pushLog(string(p))
	// Capture-health markers from the helper (a hogged/exclusive output device
	// silently kills the tap; the helper detects the frame stall and says so).
	if s := string(p); strings.Contains(s, "ppcapture: CAPTURE-") {
		switch {
		case strings.Contains(s, "CAPTURE-BLOCKED"):
			w.b.setCaptureNote("Another app has taken EXCLUSIVE control of your Mac's audio output (e.g. Roon or Audirvana in Exclusive Mode) - partyparty can't capture it, so guests hear nothing. Turn OFF Exclusive/Hog Mode for this output in that app (or point it at a different device, or route it through BlackHole). It recovers on its own once released; if not, Stop and Go Live again.")
		case strings.Contains(s, "CAPTURE-OK"):
			w.b.captureRecovered()
		case strings.Contains(s, "CAPTURE-UNHOGGED"):
			w.b.tryAutoRestart() // exclusive app released the device but tap wedged - rebuild
		case strings.Contains(s, "CAPTURE-DEVICECHANGE"):
			// The default output changed (AirPods grabbed the Mac, a display with
			// speakers plugged in, monitor↔interface switch). The global tap's
			// aggregate is bound to the OLD device and stops delivering usable
			// frames, so rebuild against the new default - the fast path that
			// front-runs the 4s stall detector. Throttled (15s) + debounced in
			// the helper. This no longer wrongly reports a permission error on
			// teardown (the gen-guard + captureUp fix), which was the real field
			// bug - the rebuild itself is correct and necessary.
			w.b.tryAutoRestart()
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.done {
		w.buf = append(w.buf, p...)
		if i := strings.Index(string(w.buf), "FORMAT "); i >= 0 {
			var r, c int
			if n, _ := fmt.Sscanf(string(w.buf[i:]), "FORMAT %d %d", &r, &c); n == 2 && r > 0 && c > 0 {
				w.done = true
				w.ch <- [2]int{r, c}
			}
		}
		if len(w.buf) > 8192 {
			w.buf = w.buf[len(w.buf)-1024:]
		}
	}
	return len(p), nil
}

func (b *Broadcaster) pushLog(chunk string) {
	ts := time.Now().Format("15:04:05")
	b.logMu.Lock()
	defer b.logMu.Unlock()
	if b.diag != nil {
		_, _ = b.diag.Write([]byte(chunk))
	}
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

// tryAutoRestart rebuilds a mac capture whose tap wedged - an exclusive app
// (Roon) released the output device, or the default output changed under it.
// Throttled to once per 15s so a flapping device can't thrash the room, and only
// for a live mac broadcast (test/device sources don't wedge this way). Returns
// true only when it actually kicked off a rebuild.
func (b *Broadcaster) tryAutoRestart() bool {
	b.mu.Lock()
	live := b.state == "live" || b.state == "starting"
	mac := b.device == "mac"
	throttled := time.Since(b.lastAutoRestart) < 15*time.Second
	dev, name, opts := b.lastDevice, b.lastName, b.lastOpts
	if live && mac && !throttled {
		b.lastAutoRestart = time.Now()
	}
	b.mu.Unlock()
	if !live || !mac || throttled {
		return false
	}
	b.pushLog("[partyparty] capture stalled (device yanked or exclusive-mode release) - rebuilding the tap")
	go b.startInternal(dev, name, opts, true)
	return true
}

// segmentedRecordPath inserts "-<n+1>" before the extension so each rebuild's
// recording lands in its own file ("set.aac" -> "set-2.aac"), never truncating
// the prior one. A mid-set device yank then costs at most a brief audio gap, not
// the whole recording.
func segmentedRecordPath(base string, n int) string {
	if base == "" {
		return ""
	}
	ext := filepath.Ext(base)
	return strings.TrimSuffix(base, ext) + "-" + strconv.Itoa(n+1) + ext
}

// captureRecovered clears an exclusive-output warning when frames resume.
func (b *Broadcaster) captureRecovered() {
	b.setCaptureNote("")
}

// setCaptureNote records/clears the non-fatal capture warning (guarded by
// logMu, like the log ring - the formatScanner that calls it never holds b.mu).
func (b *Broadcaster) setCaptureNote(s string) {
	b.logMu.Lock()
	b.captureNote = s
	b.logMu.Unlock()
}

func (b *Broadcaster) getCaptureNote() string {
	b.logMu.Lock()
	defer b.logMu.Unlock()
	return b.captureNote
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
		case n == "progress.txt" || strings.HasSuffix(n, ".m3u8"):
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

// argSnap freezes the mutable encode settings for one Start - buildArgs runs
// outside the lock and must not read live fields.
type argSnap struct {
	bitrate    string
	channels   int
	hlsTime    float64
	delivery   string
	recordPath string
	mirrorDir  string // cloud-mirror scratch dir; "" = no third tee leg
}

func (b *Broadcaster) buildArgs(device string, inRate, inCh int, snap argSnap) []string {
	c := b.cfg
	var input []string
	switch device {
	case "test":
		// -re paces the tone at realtime so a test run rehearses the actual
		// go-live behavior (segment fill, playlist cadence) instead of encoding
		// at CPU speed.
		input = []string{"-re", "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:beep_factor=4:sample_rate=%d", c.SampleRate)}
	case "mac":
		// PCM piped in from the Core Audio tap helper on stdin. The tap's rate
		// follows the OUTPUT device (44.1k or 48k) - the helper announces it
		// via a "FORMAT <rate> <ch>" stderr line before audio flows, and we
		// declare exactly that here (raw f32le has no header; a wrong rate
		// would silently pitch-shift the whole stream). c.SampleRate is only
		// applied on the OUTPUT side (resample) below.
		input = []string{
			"-fflags", "+nobuffer", "-flags", "+low_delay", "-probesize", "32", "-analyzeduration", "0",
			"-f", "f32le", "-ar", strconv.Itoa(inRate), "-ac", strconv.Itoa(inCh), "-i", "-",
		}
	default:
		input = []string{"-fflags", "+nobuffer", "-f", "avfoundation", "-thread_queue_size", "1024", "-i", ":" + device}
	}
	// -progress writes a "progress=" block ~1s after real frames start flowing -
	// a delivery-independent liveness signal (see producingOutput) that replaces
	// the old "plain-HLS segments on disk" check now that we don't tee plain HLS.
	args := []string{"-hide_banner", "-loglevel", "warning", "-progress", b.progressFile()}
	args = append(args, input...)
	// Encode at the CAPTURE rate for the mac tap (its rate follows the output
	// device - 44.1k or 48k), so ffmpeg never resamples: a resample is an extra
	// filter + delay for zero benefit, and AAC/HLS play either rate natively.
	outRate := c.SampleRate
	if device == "mac" && inRate > 0 {
		outRate = inRate
	}
	args = append(args,
		"-vn",
		"-ac", strconv.Itoa(snap.channels),
		"-ar", strconv.Itoa(outRate),
		"-c:a", c.Codec, "-b:a", snap.bitrate,
		"-flush_packets", "1", // low-latency: emit each packet immediately instead of buffering
		// Kill the muxer's startup/interleave buffering - with a single audio
		// stream there's nothing to interleave, and muxpreload/muxdelay otherwise
		// hold ~0.5-0.7s before the first packets leave. max_delay 0 keeps muxing
		// delay minimal on the RTSP leg.
		"-max_delay", "0", "-muxdelay", "0", "-muxpreload", "0", "-max_interleave_delta", "0",
	)
	// HTTPS-only: guests are LL-HLS only (the client no longer offers a plain
	// fallback), so we push a single RTSP stream MediaMTX repackages into LL-HLS
	// over HTTPS, plus the optional recording - no plain-HLS playlist at all.
	//
	// Each leg drains through its OWN fifo that DROPS on overflow instead of
	// blocking - load-bearing for latency STABILITY. The default fifo (and a leg
	// with no fifo at all, as the record leg used to be) BLOCKS when its consumer
	// is slow, which back-pressures the shared tee -> ffmpeg stops draining stdin
	// -> PCM piles up in the capture ring -> the live edge falls PERMANENTLY
	// behind real time (a one-way latency ratchet - the field-observed 4.5->5.6s
	// creep). onfail=ignore only survives a leg that fails to OPEN, not one that
	// is merely SLOW; drop_pkts_on_overflow is what actually decouples a slow
	// record disk or cloud upload from the live RTSP leg. It drops only after the
	// fifo's default ~1.3s (60-packet) queue fills, so normal write bursts never
	// drop; a real stall costs a brief per-leg gap instead of ratcheting everyone.
	// (fifo_options carries a single option deliberately: an internal ':' needs
	// tee-level escaping that this bundled ffmpeg mis-parses - verified - leaking
	// the option to the slave muxer; the default queue depth is the right
	// threshold for every leg anyway.)
	const dropFifo = ":use_fifo=1:fifo_options=drop_pkts_on_overflow=1"
	tee := "[f=rtsp:rtsp_transport=tcp:onfail=ignore" + dropFifo + "]" + b.ingestURL
	if snap.recordPath != "" {
		tee += "|[f=adts:onfail=ignore" + dropFifo + "]" + snap.recordPath
	}
	// Optional THIRD leg - the cloud mirror for remote guests. Stream-copies the
	// SAME already-encoded AAC (no second encode) into a plain-HLS playlist in a
	// scratch dir that internal/livemirror ships to R2. With drop-on-overflow it is
	// fully decoupled: a slow or failing cloud upload draining this FIFO can never
	// back-pressure the LAN RTSP leg above. Only present when a mirror dir is
	// configured; with the mirror off the tee is just the RTSP (+ record) legs.
	if snap.mirrorDir != "" {
		tee += "|[f=hls:hls_time=3:hls_list_size=8:hls_flags=delete_segments+omit_endlist:hls_segment_type=mpegts:onfail=ignore" + dropFifo + "]" + filepath.Join(snap.mirrorDir, "live.m3u8")
	}
	args = append(args, "-f", "tee", "-map", "0:a", tee)
	return args
}

// Start stops any current broadcast, then captures `device` and republishes as
// HLS. device is "test", "mac", or an avfoundation device index. Zero-valued
// Options fields fall back to the configured defaults.
func (b *Broadcaster) Start(device, deviceName string, opts Options) {
	b.startInternal(device, deviceName, opts, false)
}

func (b *Broadcaster) startInternal(device, deviceName string, opts Options, rebuild bool) {
	b.Stop()

	b.setCaptureNote("") // fresh start: drop any stale hogged-output warning

	// The caller's ORIGINAL sparse opts - stashed as lastOpts for auto-restart to
	// replay, so a rebuild re-reads OTA overrides (not the frozen resolved values)
	// and re-derives the recording segment from the un-mutated base path.
	callerOpts := opts

	// Apply OTA encode overrides the caller didn't set explicitly, re-read now so
	// a config pushed mid-session lands on this Go Live. Done before the lock -
	// it reads config.json. Each value is already strictly validated; anything
	// unset here falls back to the (also OTA-adjusted at startup) cfg defaults.
	b.mu.Lock()
	ovFn := b.overridesFn
	b.mu.Unlock()
	if ovFn != nil {
		ov := ovFn()
		if opts.Bitrate == "" && ov.Bitrate != nil {
			opts.Bitrate = *ov.Bitrate
		}
		if opts.Channels == 0 && ov.Channels != nil {
			opts.Channels = *ov.Channels
		}
		if opts.HLSTime <= 0 && ov.HLSTime != nil {
			opts.HLSTime = float64(*ov.HLSTime)
		}
	}

	b.mu.Lock()
	b.gen++
	myGen := b.gen
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
	// Recording continuity: a fresh (user) Start owns the base path; a rebuild
	// records to a NEW segment file off that base so it never truncates what was
	// captured before the device got yanked out from under the tap.
	if opts.RecordPath != "" {
		if rebuild {
			b.recordSeg++
			opts.RecordPath = segmentedRecordPath(b.recordBase, b.recordSeg)
		} else {
			b.recordBase = opts.RecordPath
			b.recordSeg = 0
		}
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
	b.lastDevice, b.lastName, b.lastOpts = device, deviceName, callerOpts // sparse: auto-restart re-resolves overrides + record segment
	b.state = "starting"
	b.lastError = ""
	b.captureUp = false // set true once this generation's tap announces a FORMAT
	b.startedAt = time.Now()

	if device == "mac" && b.helperPath == "" {
		b.state = "error"
		b.lastError = "system-audio helper not built - run `make` to compile it"
		b.mu.Unlock()
		b.pushLog("[partyparty] " + b.lastError)
		return
	}

	// Snapshot the mutable encode settings while we still hold the lock -
	// buildArgs runs later, outside it, and must not race SetDelivery/Start.
	snap := argSnap{bitrate: b.bitrate, channels: b.channels, hlsTime: b.hlsTime, delivery: b.delivery, recordPath: opts.RecordPath, mirrorDir: b.mirrorDir}

	var helper *exec.Cmd
	var pr, pw *os.File
	var fscan *formatScanner
	if device == "mac" {
		var err error
		if pr, pw, err = os.Pipe(); err != nil {
			b.state = "error"
			b.lastError = err.Error()
			b.mu.Unlock()
			return
		}
		fscan = newFormatScanner(b)
		helper = exec.Command(b.helperPath)
		helper.Stdout = pw
		helper.Stderr = fscan
	}
	b.mu.Unlock()

	b.pushLog("[partyparty] starting capture: " + deviceName)

	// The helper starts FIRST and announces the tap's stream format (it
	// follows the output device); ffmpeg's input args are built from it. The
	// permission prompt (first use) can delay the announcement - wait
	// generously, then fall back to 48k/2ch (ffmpeg just exits fast if wrong,
	// surfacing the error note).
	inRate, inCh := 48000, 2
	formatAssumed := false
	if helper != nil {
		if err := helper.Start(); err != nil {
			pr.Close()
			pw.Close()
			b.fail(myGen, "system-audio helper failed: "+err.Error())
			return
		}
		// Publish the RUNNING helper (Process exists now, so a concurrent
		// Stop can safely signal it during the possibly-long format wait).
		// If a Stop/newer Start already superseded us, ours dies instead.
		b.mu.Lock()
		if b.gen != myGen {
			b.mu.Unlock()
			_ = helper.Process.Kill()
			_ = helper.Wait()
			pr.Close()
			pw.Close()
			return
		}
		b.helper = helper
		b.mu.Unlock()
		select {
		case f := <-fscan.ch:
			inRate, inCh = f[0], f[1]
			b.mu.Lock()
			if b.gen == myGen {
				b.captureUp = true // tap works - never blame permissions on a later ffmpeg death
			}
			b.mu.Unlock()
			b.pushLog(fmt.Sprintf("[partyparty] capturing at %d Hz, %d channel(s)", inRate, inCh))
		case <-time.After(15 * time.Second):
			formatAssumed = true
			b.pushLog("[partyparty] helper never announced its format (permission prompt still up?) - assuming 48000/2 for now")
		}
	}

	ff := exec.Command(b.cfg.FFmpeg, b.buildArgs(device, inRate, inCh, snap)...)
	ff.Stderr = logWriter{b}
	if pr != nil {
		ff.Stdin = pr
	}

	if err := ff.Start(); err != nil {
		if helper != nil {
			_ = helper.Process.Kill()
			_ = helper.Wait()
			pr.Close()
			pw.Close()
		}
		b.fail(myGen, "ffmpeg failed to launch: "+err.Error())
		return
	}
	// Children hold their own dups of the pipe; the parent must close its copies
	// so EOF propagates when the helper exits.
	if pr != nil {
		pr.Close()
		pw.Close()
	}

	// Publish ffmpeg - but ONLY if nothing superseded us while we waited on
	// the format handshake (a 15s window when the permission prompt is up).
	// A stale publish here used to clobber the successor broadcast's handle
	// and orphan its ffmpeg: two encoders writing one playlist, forever.
	b.mu.Lock()
	if b.gen != myGen {
		if b.helper == helper {
			b.helper = nil
		}
		b.mu.Unlock()
		_ = ff.Process.Kill()
		_ = ff.Wait()
		if helper != nil {
			_ = helper.Process.Kill()
			_ = helper.Wait()
		}
		return
	}
	b.cmd = ff
	b.inRate, b.inCh = 0, 0
	if device == "mac" {
		b.inRate, b.inCh = inRate, inCh
	}
	b.mu.Unlock()

	// FIRST-RUN RESCUE: when the permission prompt delayed the FORMAT
	// announcement past the wait, ffmpeg is now running on an assumed
	// 48000/2. If the tap later reports something else (a 44.1 kHz output
	// device is common), raw PCM decoded at the wrong rate is pitch-warped
	// mush for the WHOLE set unless someone thinks to restart - the field
	// report was "scrubby and dropping". Restart automatically instead.
	if formatAssumed && device == "mac" {
		go func() {
			select {
			case f := <-fscan.ch:
				b.mu.Lock()
				if b.gen == myGen {
					b.captureUp = true // the late FORMAT arrived - capture is up
				}
				b.mu.Unlock()
				if f[0] == inRate && f[1] == inCh {
					return // assumed right - leave the broadcast alone
				}
				b.mu.Lock()
				stale := b.gen != myGen
				b.mu.Unlock()
				if stale {
					return
				}
				b.pushLog(fmt.Sprintf("[partyparty] capture is actually %d Hz / %dch - restarting with the right settings", f[0], f[1]))
				b.Start(device, deviceName, opts)
			case <-time.After(90 * time.Second):
			}
		}()
	}

	go func(c, h *exec.Cmd, gen uint64) {
		werr := c.Wait()
		if h != nil {
			_ = h.Process.Kill()
			_ = h.Wait()
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.cmd != c {
			return // a newer broadcast already took over - its handles, not ours
		}
		if b.state == "stopping" {
			b.state = "idle"
			b.pushLog("[partyparty] broadcast stopped")
			b.cmd = nil
			b.helper = nil
			return
		}
		// A rebuild bumps gen at its very top (Stop's gen++) but publishes its new
		// ffmpeg only after the format handshake, so for a moment b.cmd is still
		// this dying one while gen has already moved on. That teardown is EXPECTED
		// - don't flip to error. This was the field bug: a self-initiated rebuild
		// looked like a crash and got mislabeled a permission error even though
		// capture was healthy the whole time.
		if b.gen != gen {
			// Still drop OUR now-dead handles so a later Stop can't latch onto a
			// reaped ffmpeg and lose its stopping->idle transition (wedging state
			// at "stopping"). b.cmd==c here (top guard), but only clear b.helper
			// if it's still ours - the successor may already own it.
			b.cmd = nil
			if b.helper == h {
				b.helper = nil
			}
			return
		}
		b.state = "error"
		if werr != nil {
			b.lastError = "ffmpeg exited: " + werr.Error()
		} else {
			b.lastError = "ffmpeg exited"
		}
		// Only blame the System Audio Recording permission when the tap never came
		// up (its real signature). If capture was working - a FORMAT was announced
		// - a later ffmpeg death is a transient encoder problem, not a permission
		// one; don't send the DJ chasing a settings toggle that isn't the issue.
		if b.device == "mac" && !b.captureUp {
			b.lastError += " - allow System Audio Recording for partyparty, then Start again."
		}
		b.pushLog("[partyparty] " + b.lastError)
		b.cmd = nil
		b.helper = nil
	}(ff, helper, myGen)
}

// fail records an error outcome - but only for the broadcast generation that
// produced it: a superseded Start's failure must not clobber its successor.
func (b *Broadcaster) fail(gen uint64, msg string) {
	b.mu.Lock()
	if b.gen != gen {
		b.mu.Unlock()
		return
	}
	b.state = "error"
	b.lastError = msg
	b.cmd = nil
	b.helper = nil
	b.mu.Unlock()
	b.pushLog("[partyparty] " + msg)
}

func (b *Broadcaster) Stop() {
	b.mu.Lock()
	b.gen++ // supersede any in-flight Start - it sees the bump and aborts
	cmd, helper := b.cmd, b.helper
	if cmd == nil && helper == nil {
		b.state = "idle"
		b.mu.Unlock()
		return
	}
	if cmd == nil {
		// Only the capture helper is up (a Start parked on the permission
		// prompt): nothing is live, so there's nothing to wind down - the
		// signal below kills the helper and the aborting Start stays hands-off.
		b.state = "idle"
	} else {
		b.state = "stopping"
	}
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

// progressFile is where ffmpeg's -progress output goes, and the liveness source.
func (b *Broadcaster) progressFile() string { return filepath.Join(b.runDir, "progress.txt") }

// producingOutput reports whether ffmpeg has actually started encoding this set
// - the delivery-independent liveness signal that replaces the old plain-HLS
// "segments on disk" check now that we no longer tee plain HLS. ffmpeg's
// -progress file gets its first "progress=" block ~1s after real frames flow,
// so starting->live flips exactly when audio is going out. cleanRunDir clears
// it every Start, so any content is the current set.
func (b *Broadcaster) producingOutput() bool {
	data, err := os.ReadFile(b.progressFile())
	if err != nil {
		return false
	}
	return strings.Contains(string(data), "progress=")
}

// ProgressSnapshot reads the current out_time_us and total_size from ffmpeg's
// -progress file - a read-only sibling of producingOutput(). The go-live health
// check samples it twice to tell whether the encoder is actually ADVANCING
// (capture is flowing) vs frozen (tap wedged / no input), independent of whether
// the guest RTSP leg ever published. Do NOT fold this into producingOutput - that
// function's presence-of-"progress=" check drives the live transition and must
// keep its exact semantics.
func (b *Broadcaster) ProgressSnapshot() (outTimeUs int64, totalSize int64) {
	data, err := os.ReadFile(b.progressFile())
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "out_time_us="); ok {
			if n, e := strconv.ParseInt(v, 10, 64); e == nil {
				outTimeUs = n
			}
		} else if v, ok := strings.CutPrefix(line, "total_size="); ok {
			if n, e := strconv.ParseInt(v, 10, 64); e == nil {
				totalSize = n
			}
		}
	}
	return outTimeUs, totalSize
}

func (b *Broadcaster) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == "starting" && b.producingOutput() {
		// ffmpeg is actually encoding (its -progress file has a progress block) -
		// the truthful, delivery-independent liveness signal.
		b.state = "live"
	}
	var since int64
	if !b.startedAt.IsZero() {
		since = b.startedAt.UnixMilli()
	}
	captureNote := b.getCaptureNote() // hogged/exclusive output device - highest priority
	note := captureNote
	// A capture rate this low means the OUTPUT device is a Bluetooth headset
	// in call (HFP) mode - guests would hear telephone-grade audio all night.
	if note == "" && (b.state == "live" || b.state == "starting") && b.device == "mac" && b.inRate > 0 && b.inRate < 44100 {
		note = fmt.Sprintf("Your Mac's audio output is running at %d kHz - that's Bluetooth-headset (call) quality, and guests hear it too. Switch the Mac's output to speakers or wired, then Stop and Go Live again.", b.inRate/1000)
	}
	if note == "" && b.state == "starting" && !b.startedAt.IsZero() && time.Since(b.startedAt) > 6*time.Second {
		switch b.device {
		case "test":
			note = "No audio yet - ffmpeg is still starting."
		case "mac":
			note = "No audio yet. If macOS asked to record system audio, click Allow, then Stop and Start again - and make sure something is playing. If you denied it, open System Settings → Privacy & Security → System Audio Recording Only and allow partyparty."
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
		CaptureBad: captureNote != "",
	}
}
