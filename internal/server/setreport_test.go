package server

import (
	"testing"
	"time"
)

// The recorder's whole job is to remember the worst moment of the night, so a
// spike that lasts one sample must survive to the report.
func TestSetRecorderKeepsPeaksAndModeTimeline(t *testing.T) {
	r := &setRecorder{}
	start := time.Date(2026, 7, 29, 22, 0, 0, 0, time.UTC)
	r.observe(setSample{At: start, DirectListeners: 3, Mode: "direct", Reason: "probe_direct"})
	r.observe(setSample{At: start.Add(5 * time.Second), DirectListeners: 40, RelayListeners: 200,
		SpreadMs: 480, DeviationMs: 120, Struggling: 2, Mode: "relay", Reason: "probe_isolated"})
	r.observe(setSample{At: start.Add(3 * time.Minute), DirectListeners: 5, Mode: "relay", Reason: "probe_isolated"})

	report, ok := r.finish()
	if !ok {
		t.Fatal("a three-minute set produced no report")
	}
	if report.MaxListeners != 240 || report.MaxRelayListeners != 200 {
		t.Fatalf("peaks lost: %+v", report)
	}
	if report.MaxSpreadMs != 480 || report.MaxDeviationMs != 120 || report.MaxStruggling != 2 {
		t.Fatalf("worst-moment stats lost: %+v", report)
	}
	if len(report.Modes) != 2 || report.Modes[0].Mode != "direct" || report.Modes[1].Mode != "relay" {
		t.Fatalf("mode timeline wrong: %+v", report.Modes)
	}
	if report.Minutes < 2.9 || report.Minutes > 3.1 {
		t.Fatalf("duration wrong: %v", report.Minutes)
	}
}

// A sound check is not a set. Reports only exist for real sets, so their
// presence in the event folder always means something happened.
func TestSetRecorderSkipsSoundChecks(t *testing.T) {
	r := &setRecorder{}
	start := time.Now()
	r.observe(setSample{At: start, Mode: "direct"})
	r.observe(setSample{At: start.Add(30 * time.Second), Mode: "direct"})
	if _, ok := r.finish(); ok {
		t.Fatal("a 30-second sound check produced a report")
	}
}
