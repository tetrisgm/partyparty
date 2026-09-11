// Package diag writes the per-session diagnostics log - the "send us your
// logs" file every real service has. One file per app run, verbose on
// purpose: hardware, network, activation attempts, capture formats, every
// broadcast transition, who connected and how their playback went.
//
// THE LOG NEVER LEAVES THE MAC. This package imports no network package and
// has no transport; TestDiagHasNoNetworkTransport enforces that. The file sits
// under the app's own directory until prune() drops it after fourteen days.
//
// The comments here used to say the file was "gzipped and shipped to the cloud
// periodically, keyed by install id", and MarkUrgent, Urgent and TailIfDirty
// were all documented as parts of that upload loop. No uploader has ever
// existed: TailIfDirty has no caller anywhere in the repository and the Worker
// exposes no ingest route. That fiction was dangerous rather than merely
// untidy. This log contains guest IP addresses, reverse-DNS device names and
// guest cids, so a future session that read those comments, concluded the
// uploader had regressed, and reinstated it from the documented API would have
// turned an on-device diagnostic into a third-party transfer of guest personal
// data, contradicting the published privacy policy, with nothing in the build
// to catch it.
//
// If an uploader is ever wanted, it is a product and privacy decision first: it
// needs the owner's ask, a policy that describes it, and a deliberate deletion
// of the test below.
package diag

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Logger struct {
	mu      sync.Mutex
	f       *os.File
	path    string
	session string
	dirty   bool
	urgent  chan struct{} // signalled when something went wrong; see MarkUrgent
}

// Open creates ~/Library/Logs/PartyParty/session-<ts>.log (Console.app finds
// it there) and prunes logs older than 14 days.
func Open(dir string) (*Logger, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	session := "session-" + time.Now().Format("20060102-150405")
	path := filepath.Join(dir, session+".log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	prune(dir, 14*24*time.Hour)
	return &Logger{f: f, path: path, session: session, urgent: make(chan struct{}, 1)}, nil
}

// MarkUrgent records that something went wrong (a client reported an
// error/stall) by signalling Urgent. Non-blocking; coalesces bursts.
//
// NOTHING CONSUMES THIS TODAY. It is called from main.go and the server, and no
// reader waits on the channel, so it is currently a no-op with a name. It is
// kept rather than deleted because the call sites mark genuinely interesting
// moments, but do not read it as evidence that a shipping mechanism exists.
func (l *Logger) MarkUrgent() {
	if l == nil {
		return
	}
	select {
	case l.urgent <- struct{}{}:
	default:
	}
}

// Urgent is the channel MarkUrgent signals. It has no consumer; see MarkUrgent.
func (l *Logger) Urgent() <-chan struct{} {
	if l == nil {
		return nil
	}
	return l.urgent
}

func prune(dir string, maxAge time.Duration) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "session-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > maxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func (l *Logger) Path() string    { return l.path }
func (l *Logger) Session() string { return l.session }

// Printf writes one timestamped line.
func (l *Logger) Printf(format string, args ...any) {
	if l == nil {
		return
	}
	line := fmt.Sprintf(format, args...)
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = fmt.Fprintf(l.f, "%s | %s\n", time.Now().Format("15:04:05.000"), strings.TrimRight(line, "\n"))
	l.dirty = true
}

// Write lets the logger sit inside io.MultiWriter (the stdlib log package,
// ffmpeg/helper output tees). Chunks may hold several lines; each gets the
// timestamp so interleaved sources stay readable.
func (l *Logger) Write(p []byte) (int, error) {
	if l == nil {
		return len(p), nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := time.Now().Format("15:04:05.000")
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		_, _ = fmt.Fprintf(l.f, "%s | %s\n", ts, line)
	}
	l.dirty = true
	return len(p), nil
}

// TailIfDirty returns up to max bytes from the file's end when new content
// arrived since the last call (nil = nothing new).
//
// IT HAS NO CALLER. It was written as an uploader's fuel and the uploader was
// never built. Anything that starts calling this is moving guest IP addresses,
// device names and cids somewhere, so treat a new caller as a privacy change
// rather than a plumbing one.
func (l *Logger) TailIfDirty(max int64) []byte {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	dirty := l.dirty
	l.dirty = false
	l.mu.Unlock()
	if !dirty {
		return nil
	}
	data, err := os.ReadFile(l.path)
	if err != nil {
		return nil
	}
	if int64(len(data)) > max {
		data = data[int64(len(data))-max:]
	}
	return data
}
