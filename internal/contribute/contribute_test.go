package contribute

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestArgsNeverReEncode is the invariant the whole relay design rests on: the
// AAC bytes this Mac produced are what listeners receive. A re-encode would add
// delay, cost quality, and break the promise that direct and relayed guests hear
// the same stream.
func TestArgsNeverReEncode(t *testing.T) {
	args, err := Config{FFmpeg: "/bin/ffmpeg", Source: "rtsp://127.0.0.1:8554/party", Target: "rtsp://origin/room"}.args()
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-c copy") {
		t.Fatalf("contribution must stream-copy, got: %s", joined)
	}
	for _, forbidden := range []string{"-c:a aac", "libfdk", "aac_at", "-b:a", "-ar ", "-ac "} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("contribution must not re-encode or resample (%q): %s", forbidden, joined)
		}
	}
	// Venue networks routinely drop UDP, so RTSP must be pinned to TCP on both
	// the read and the write side.
	if strings.Count(joined, "-rtsp_transport tcp") != 2 {
		t.Fatalf("both RTSP legs must be TCP: %s", joined)
	}
	// A live path must not add buffering.
	for _, want := range []string{"-fflags +nobuffer", "-flags +low_delay", "-muxdelay 0", "-muxpreload 0"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing low-latency flag %q: %s", want, joined)
		}
	}
}

func TestArgsRejectIncompleteConfig(t *testing.T) {
	for _, c := range []Config{
		{Source: "rtsp://a", Target: "rtsp://b"},
		{FFmpeg: "/bin/ffmpeg", Target: "rtsp://b"},
		{FFmpeg: "/bin/ffmpeg", Source: "rtsp://a"},
	} {
		if _, err := c.args(); err == nil {
			t.Fatalf("expected an error for %+v", c)
		}
	}
}

// TestRedactHidesCredentials: contribution URLs can carry a secret, and the
// status object is rendered in the console and written to logs.
func TestRedactHidesCredentials(t *testing.T) {
	got := redact("rtsp://room:sup3rsecret@origin.example:8554/abc")
	if strings.Contains(got, "sup3rsecret") {
		t.Fatalf("credentials leaked: %s", got)
	}
	if !strings.HasPrefix(got, "rtsp://") || !strings.Contains(got, "origin.example:8554/abc") {
		t.Fatalf("redaction lost the useful part: %s", got)
	}
	if plain := redact("rtsp://origin.example/abc"); plain != "rtsp://origin.example/abc" {
		t.Fatalf("a URL without credentials must be unchanged: %s", plain)
	}
}

// TestDisabledContributionNeverRuns: pushing a copy of the stream to the
// internet in LOCAL or DIRECT mode would waste the DJ's uplink for nothing.
func TestDisabledContributionNeverRuns(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran")
	m := New(Config{
		FFmpeg: fakeFFmpeg(t, marker, 0),
		Source: "rtsp://127.0.0.1:8554/party",
		Target: "rtsp://origin/room",
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)

	time.Sleep(150 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("contribution ran while disabled")
	}
	if m.Snapshot().Running {
		t.Fatal("status claims running while disabled")
	}
}

// TestEnabledContributionRunsAndReportsFailure covers the supervision contract:
// it starts when enabled, reports honestly when the push dies, and keeps
// retrying rather than giving up on a network blip.
func TestEnabledContributionRunsAndReportsFailure(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran")
	m := New(Config{
		FFmpeg: fakeFFmpeg(t, marker, 1), // exits non-zero immediately
		Source: "rtsp://127.0.0.1:8554/party",
		Target: "rtsp://user:secret@origin/room",
		Logf:   func(string, ...any) {},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)
	m.SetEnabled(true)

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if s := m.Snapshot(); s.Restarts > 0 && s.LastError != "" {
			if strings.Contains(s.Target, "secret") {
				t.Fatalf("status leaked credentials: %+v", s)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("a failing contribution never reported an error: %+v", m.Snapshot())
}

// fakeFFmpeg writes a script that records that it ran and exits with the given
// code, so supervision is testable without touching the real encoder.
func fakeFFmpeg(t *testing.T, marker string, exitCode int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-ffmpeg")
	script := "#!/bin/sh\ntouch " + marker + "\necho 'connection refused' >&2\nexit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	return string(rune('0' + v))
}
