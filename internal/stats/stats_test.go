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

func TestRosterKeepsSelectedDJWhilePaused(t *testing.T) {
	l := New(time.Minute)
	l.Heartbeat("guest-1", false, true, 0, false, "native")
	l.Selection("guest-1", "seth")

	roster := l.Roster()
	if len(roster) != 1 || !roster[0].Paused || roster[0].DJID != "seth" {
		t.Fatalf("paused roster = %#v, want selected DJ seth", roster)
	}
}

// TestStallHistoryAnswersWhichPhone: the room's stream can be clean while one
// phone hears gaps. A per-phone count and worst-latency make that visible
// without reading logs for an hour, which is what it cost at Shack15.
func TestStallHistoryAnswersWhichPhone(t *testing.T) {
	l := New(30 * time.Second)
	// One phone stalls twice, minutes apart, and once falls a long way behind.
	l.Heartbeat("phone-a", true, false, 1200, true, "native")
	l.Heartbeat("phone-a", true, false, 1300, true, "native") // same stall, still one event
	l.clients["phone-a"].lastStall = time.Now().Add(-time.Minute)
	l.Heartbeat("phone-a", true, false, 9000, true, "native")
	// The other phone is fine throughout.
	l.Heartbeat("phone-b", false, false, 1100, true, "native")

	byID := map[string]Listener{}
	for _, row := range l.Roster() {
		byID[row.ID] = row
	}
	a, b := byID["phone-a"], byID["phone-b"]
	if a.Stalls != 2 {
		t.Fatalf("phone-a stalls = %d, want 2 (repeat beats inside one stall are one event)", a.Stalls)
	}
	if a.WorstLatencyMs != 9000 {
		t.Fatalf("phone-a worst latency = %v, want 9000", a.WorstLatencyMs)
	}
	if b.Stalls != 0 || b.WorstLatencyMs != 1100 {
		t.Fatalf("phone-b should be clean: %#v", b)
	}
}
