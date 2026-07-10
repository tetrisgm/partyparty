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

func TestMediaOffsetUsesActiveMedian(t *testing.T) {
	l := New(time.Minute)
	for i, off := range []float64{12100, 12500, 12300} {
		key := string(rune('a' + i))
		l.Heartbeat(key, false, false, 0, false, "native")
		l.SyncOffset(key, off, true, 99)
	}
	got := l.MediaOffset(99)
	if got.Count != 3 || got.MedMs != 12300 {
		t.Fatalf("MediaOffset() = %+v, want count=3 median=12300", got)
	}
}
