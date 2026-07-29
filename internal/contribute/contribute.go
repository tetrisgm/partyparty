// Package contribute pushes this Mac's already-encoded live audio to a remote
// origin, so guests on a client-isolated network fetch from that origin instead
// of reaching back through a tunnel to this laptop.
//
// This is the ordinary shape for live streaming: contribution, then origin, then
// fan-out. The Mac sends ONE copy out, about 0.32 Mbps, whether five people or
// five hundred are listening, and the origin does the fan-out. The alternative
// the product used before, proxying every guest request back to the Mac, put the
// laptop in the request path of every listener and could not scale past a few
// dozen no matter what was paid for it.
//
// Three constraints shape the whole package:
//
//  1. The audio is NEVER re-encoded. ffmpeg runs with "-c copy", so the exact
//     AAC bytes this Mac produced are what listeners receive. Re-encoding would
//     add delay, cost quality, and break the promise that direct and relayed
//     guests hear the same stream.
//  2. internal/broadcast is off-limits, so this reads the stream that package
//     already publishes on loopback rather than adding a leg to its ffmpeg tee.
//     Capture and encode are untouched; this is a second reader of a stream that
//     already exists.
//  3. The capture timestamp must survive, and this is the open item.
//
// On (3): contribution currently pushes RTSP, which means the origin
// re-packages and stamps PROGRAM-DATE-TIME at its OWN ingest. That breaks the
// one-timeline contract in the worst possible way, because direct and relayed
// guests each look correct alone and only disagree when compared, so it does not
// show up in single-mode testing.
//
// The decided fix is to forward this Mac's own LL-HLS playlists and parts over
// plain HTTP instead, PROGRAM-DATE-TIME included, so the capture stamp survives
// by construction rather than by hoping the origin propagates absolute time. It
// also removes the origin's need for a raw TCP port, which is what lets it deploy
// anywhere rather than on a VPS someone administers.
//
// Until that lands, this package is correct about everything except which bytes
// it hands the origin, and RELAY must not be cut over to it.
package contribute

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// restartDelay bounds how fast a failing contribution retries. The origin
	// being briefly unreachable is normal (venue uplink hiccup, origin restart),
	// so this reconnects steadily without hammering.
	restartDelay = 2 * time.Second

	// startupGrace is how long a run must survive before its failure counter is
	// forgiven. A process that dies instantly is misconfigured; one that ran for
	// a while and then dropped hit a network problem, which is not the same thing.
	startupGrace = 30 * time.Second
)

// Status is what the console needs to say honestly whether relayed guests are
// actually being served.
type Status struct {
	// Running is true while a contribution process is alive. It does NOT by
	// itself prove guests can hear anything; it proves this Mac is sending.
	Running bool `json:"running"`
	// Target is the origin being pushed to, without credentials.
	Target string `json:"target,omitempty"`
	// LastError is why the most recent attempt ended, empty when healthy.
	LastError string `json:"lastError,omitempty"`
	// Restarts counts consecutive failed attempts, reset once a run survives
	// startupGrace. A climbing number is the signal that something is actually
	// wrong rather than flapping.
	Restarts int `json:"restarts"`
}

// Config describes one contribution.
type Config struct {
	// FFmpeg is the absolute path to the bundled binary. Never resolved from
	// PATH: a headless launch has no useful PATH and must not pick up a stranger's
	// ffmpeg.
	FFmpeg string
	// Source is the loopback RTSP URL internal/broadcast already publishes to.
	Source string
	// Target is the remote origin's RTSP ingest URL.
	Target string
	Logf   func(format string, args ...any)
}

// Manager supervises one contribution process for as long as it is enabled.
type Manager struct {
	cfg Config

	mu      sync.RWMutex
	status  Status
	enabled bool
	wake    chan struct{}
}

func New(cfg Config) *Manager {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Manager{cfg: cfg, wake: make(chan struct{}, 1)}
}

// SetEnabled turns contribution on or off. It is driven by the room mode: only
// RELAY needs it, and pushing a copy of the stream to the internet in any other
// mode would waste the DJ's uplink for nothing.
func (m *Manager) SetEnabled(on bool) {
	m.mu.Lock()
	if m.enabled == on {
		m.mu.Unlock()
		return
	}
	m.enabled = on
	if !on {
		m.status.Running = false
	}
	m.mu.Unlock()
	m.signal()
}

// Snapshot returns a consistent copy for /api/status.
func (m *Manager) Snapshot() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) signal() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) isEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled
}

// Run supervises contribution until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		if !m.isEnabled() {
			if !m.waitForChange(ctx, time.Minute) {
				return
			}
			continue
		}

		startedAt := time.Now()
		err := m.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}

		m.mu.Lock()
		m.status.Running = false
		if time.Since(startedAt) >= startupGrace {
			// This run worked for a while; a drop after that is a network event,
			// not a broken configuration.
			m.status.Restarts = 0
		} else {
			m.status.Restarts++
		}
		if err != nil {
			m.status.LastError = err.Error()
		}
		restarts := m.status.Restarts
		m.mu.Unlock()

		if err != nil {
			m.cfg.Logf("contribute: push ended (attempt %d): %v", restarts, err)
		}
		if !m.waitForChange(ctx, restartDelay) {
			return
		}
	}
}

// waitForChange sleeps until the deadline, an enable/disable, or shutdown.
// Reports false only when the context is done.
func (m *Manager) waitForChange(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-m.wake:
		return true
	case <-timer.C:
		return true
	}
}

func (m *Manager) runOnce(ctx context.Context) error {
	args, err := m.cfg.args()
	if err != nil {
		return err
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(runCtx, m.cfg.FFmpeg, args...)
	// Closed stdin, always. A spawned process that inherits an open stdin can sit
	// forever waiting on input that never arrives, which is the single most
	// common way background work silently wedges.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = &tailWriter{limit: 2048}
	// Own the process group so cancelling kills ffmpeg's children too, rather
	// than orphaning them.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	m.mu.Lock()
	m.status.Running = true
	m.status.Target = redact(m.cfg.Target)
	m.status.LastError = ""
	m.mu.Unlock()
	m.cfg.Logf("contribute: pushing the live stream to %s", redact(m.cfg.Target))

	waitErr := cmd.Wait()

	// Stop the whole process group; ffmpeg can leave a child behind on a hard
	// failure and a stray encoder holding the source would block the next run.
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

	if ctx.Err() != nil {
		return nil // deliberate shutdown, not a failure
	}
	if waitErr != nil {
		if tail, ok := cmd.Stderr.(*tailWriter); ok && tail.String() != "" {
			return fmt.Errorf("%w: %s", waitErr, tail.String())
		}
		return waitErr
	}
	return errors.New("contribution ended unexpectedly")
}

// args builds the ffmpeg invocation. The shape matters more than it looks:
//
//	-c copy       the AAC bytes are forwarded untouched. No re-encode, ever.
//	-rtsp_transport tcp   venue networks routinely drop UDP; TCP just works.
//	-fflags +nobuffer / -flags +low_delay   do not add buffering on a live path.
//	-muxdelay 0 -muxpreload 0   no startup hold in the muxer.
func (c Config) args() ([]string, error) {
	if strings.TrimSpace(c.FFmpeg) == "" {
		return nil, errors.New("no ffmpeg path")
	}
	if strings.TrimSpace(c.Source) == "" {
		return nil, errors.New("no source URL")
	}
	if strings.TrimSpace(c.Target) == "" {
		return nil, errors.New("no target URL")
	}
	return []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-fflags", "+nobuffer", "-flags", "+low_delay",
		"-rtsp_transport", "tcp",
		"-i", c.Source,
		"-c", "copy",
		"-muxdelay", "0", "-muxpreload", "0",
		"-rtsp_transport", "tcp",
		"-f", "rtsp", c.Target,
	}, nil
}

// redact strips any userinfo from a URL before it reaches a log or the console.
// Contribution credentials must never be printed.
func redact(raw string) string {
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return raw
	}
	scheme := ""
	if i := strings.Index(raw, "://"); i >= 0 {
		scheme = raw[:i+3]
	}
	return scheme + "***@" + raw[at+1:]
}

// tailWriter keeps only the last bytes written, so a failing ffmpeg's final
// complaint is reportable without letting an unbounded log grow in memory.
type tailWriter struct {
	mu    sync.Mutex
	limit int
	buf   []byte
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > w.limit {
		w.buf = w.buf[len(w.buf)-w.limit:]
	}
	return len(p), nil
}

func (w *tailWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return strings.TrimSpace(string(w.buf))
}
