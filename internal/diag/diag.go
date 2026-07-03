// Package diag writes the per-session diagnostics log — the "send us your
// logs" file every real service has. One file per app run, verbose on
// purpose: hardware, network, activation attempts, capture formats, every
// broadcast transition, who connected and how their playback went. The file
// is gzipped and shipped to the cloud periodically (and on quit), keyed by
// install id, so a field problem can be diagnosed without asking anyone to
// screenshot a console.
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
	urgent  chan struct{} // nudges the uploader to ship NOW (a problem happened)
}

// Open creates ~/Library/Logs/partyparty/session-<ts>.log (Console.app finds
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

// MarkUrgent nudges the upload loop to ship the log promptly (a client
// reported an error/stall/etc). Non-blocking; coalesces bursts.
func (l *Logger) MarkUrgent() {
	if l == nil {
		return
	}
	select {
	case l.urgent <- struct{}{}:
	default:
	}
}

// Urgent is the channel the upload loop waits on for prompt-upload nudges.
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
// arrived since the last call ("" = nothing new). The upload loop's fuel.
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
