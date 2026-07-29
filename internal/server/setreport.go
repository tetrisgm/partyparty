package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The post-set report.
//
// The room publishes real numbers all night: listener counts, latency spread,
// deviation from the declared schedule, mode changes. Until this file, nobody
// read them. Every "how did it actually go" question was answered by memory or
// not at all, and the architecture doc's standing item, run a party and read
// the numbers, silently depended on a human remembering to watch a dashboard
// during a party they were DJing.
//
// So the room writes its own report. While a set is live, a sampler folds the
// telemetry into running maxima and a mode timeline; when the set ends, one
// JSON file lands in the event folder next to the recordings, and the session
// log gets a one-line summary. Nothing here feeds back into playback, the
// schedule, or anything else: it is a record, not a control loop.

const (
	setSampleInterval = 5 * time.Second

	// setReportMinimum is the shortest set worth a report. Going live for a
	// sound check and stopping produces nothing, so a report always means a set.
	setReportMinimum = 2 * time.Minute
)

// setSample is one observation of the live room.
type setSample struct {
	At              time.Time
	DirectListeners int
	RelayListeners  int
	Struggling      int
	SpreadMs        float64
	RelaySpreadMs   float64
	DeviationMs     float64
	Mode            string
	Reason          string
}

// setModeChange is one entry in the report's connection timeline.
type setModeChange struct {
	At     time.Time `json:"at"`
	Mode   string    `json:"mode"`
	Reason string    `json:"reason,omitempty"`
}

// setReport is what lands in the event folder.
type setReport struct {
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
	Minutes   float64   `json:"minutes"`

	MaxDirectListeners int `json:"maxDirectListeners"`
	MaxRelayListeners  int `json:"maxRelayListeners"`
	MaxListeners       int `json:"maxListeners"`
	MaxStruggling      int `json:"maxStruggling"`

	DeclaredDelaySec float64 `json:"declaredDelaySec"`
	MaxSpreadMs      float64 `json:"maxSpreadMs"`
	MaxRelaySpreadMs float64 `json:"maxRelaySpreadMs"`
	MaxDeviationMs   float64 `json:"maxDeviationMs"`

	Modes []setModeChange `json:"modes"`
}

// setRecorder folds samples into a report. Pure accumulation, so it is testable
// without a clock, a server, or a party.
type setRecorder struct {
	report  setReport
	started bool
}

func (r *setRecorder) observe(s setSample) {
	if !r.started {
		r.started = true
		r.report.StartedAt = s.At
	}
	r.report.EndedAt = s.At
	max := func(dst *int, v int) {
		if v > *dst {
			*dst = v
		}
	}
	maxF := func(dst *float64, v float64) {
		if v > *dst {
			*dst = v
		}
	}
	max(&r.report.MaxDirectListeners, s.DirectListeners)
	max(&r.report.MaxRelayListeners, s.RelayListeners)
	max(&r.report.MaxListeners, s.DirectListeners+s.RelayListeners)
	max(&r.report.MaxStruggling, s.Struggling)
	maxF(&r.report.MaxSpreadMs, s.SpreadMs)
	maxF(&r.report.MaxRelaySpreadMs, s.RelaySpreadMs)
	maxF(&r.report.MaxDeviationMs, s.DeviationMs)
	if n := len(r.report.Modes); n == 0 || r.report.Modes[n-1].Mode != s.Mode {
		r.report.Modes = append(r.report.Modes, setModeChange{At: s.At, Mode: s.Mode, Reason: s.Reason})
	}
}

// finish closes the report, or returns false for a set too short to matter.
func (r *setRecorder) finish() (setReport, bool) {
	if !r.started {
		return setReport{}, false
	}
	r.report.Minutes = r.report.EndedAt.Sub(r.report.StartedAt).Minutes()
	if r.report.EndedAt.Sub(r.report.StartedAt) < setReportMinimum {
		return setReport{}, false
	}
	r.report.DeclaredDelaySec = scheduleDelay()
	return r.report, true
}

// sampleNow reads the live room's telemetry. Everything here already exists for
// the console; this is the same data being remembered instead of only shown.
func (s *srv) sampleNow(now time.Time) setSample {
	bc := s.Broadcaster.Status()
	health := s.Listeners.Health(bc.State == "live", kbps(bc.Bitrate))
	latency := s.Listeners.LatencySpread()
	relayListeners, relaySpread, fresh := s.RelayPresence()
	if !fresh {
		relayListeners, relaySpread = 0, 0
	}
	connection := s.connectionState()
	deviation := 0.0
	if latency.Count > 0 {
		if d := latency.MaxMs - scheduleDelay()*1000; d > 0 {
			deviation = d
		}
	}
	return setSample{
		At:              now,
		DirectListeners: health.Listeners,
		RelayListeners:  relayListeners,
		Struggling:      health.Struggling,
		SpreadMs:        latency.SpreadMs,
		RelaySpreadMs:   relaySpread,
		DeviationMs:     deviation,
		Mode:            connection.Mode,
		Reason:          connection.Reason,
	}
}

// RunSetReports samples while live and writes the report when the set ends.
// Runs for the life of the process; costs one in-process read every five
// seconds while live and nothing at all while idle.
func (s *Srv) RunSetReports(ctx context.Context) {
	ticker := time.NewTicker(setSampleInterval)
	defer ticker.Stop()
	var recorder *setRecorder
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			live := s.Broadcaster.Status().State == "live"
			switch {
			case live:
				if recorder == nil {
					recorder = &setRecorder{}
				}
				recorder.observe(s.sampleNow(now))
			case recorder != nil:
				if report, ok := recorder.finish(); ok {
					s.writeSetReport(report)
				}
				recorder = nil
			}
		}
	}
}

func (s *srv) writeSetReport(report setReport) {
	if s.Events == nil {
		return
	}
	dir := s.Events.Dir()
	if dir == "" {
		return
	}
	data, err := json.MarshalIndent(report, "", " ")
	if err != nil {
		return
	}
	name := fmt.Sprintf("set-report-%s.json", report.StartedAt.Format("20060102-150405"))
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		if s.Diag != nil {
			s.Diag.Printf("set report: %v", err)
		}
		return
	}
	if s.Diag != nil {
		s.Diag.Printf("set report: %.0f min, %d listeners peak (%d relay), spread %.0fms peak, deviation %.0fms peak -> %s",
			report.Minutes, report.MaxListeners, report.MaxRelayListeners,
			report.MaxSpreadMs, report.MaxDeviationMs, name)
	}
}
