package stats

import (
	"testing"
	"time"
)

func TestActiveCountsAndPrunesWithinWindow(t *testing.T) {
	l := New(25 * time.Millisecond)
	if got := l.Active(); got != 0 {
		t.Fatalf("empty Active() = %d, want 0", got)
	}

	l.Heartbeat("guest-1", false, false, 0, false, "hls")
	l.Heartbeat("guest-2", false, false, 0, false, "hls")
	if got := l.Active(); got != 2 {
		t.Fatalf("fresh Active() = %d, want 2", got)
	}

	time.Sleep(40 * time.Millisecond)
	if got := l.Active(); got != 0 {
		t.Fatalf("expired Active() = %d, want 0", got)
	}
}
