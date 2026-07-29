package server

import "partyparty/internal/schedule"

// The room schedule as the direct path applies it. The schedule itself lives in
// internal/schedule because relayed guests must receive exactly the same one,
// and the contribution pusher authors their playlist from a different source.
// See that package for the design and its invariants.

// scheduleDelay is the room's published D.
func scheduleDelay() float64 { return schedule.Delay }

// rewriteLivePlaylist authors the schedule into a media playlist on its way to a
// direct guest.
func rewriteLivePlaylist(body []byte) []byte { return schedule.RewritePlaylist(body) }

// scheduleState is the room's declared schedule plus how well the room is
// holding it, for the DJ console and the session analyzer.
//
// deviationMs is how far the worst listener is from the declared delay, and
// spreadMs is how far apart the listeners are from each other. Both are
// TELEMETRY ONLY. Neither is an input to delaySec or holdBackSec, and nothing
// in this payload may ever become one: the moment a room-wide value tracks a
// listener, one slow phone starts lengthening the delay for everyone.
func (s *srv) scheduleState() map[string]any {
	latency := s.Listeners.LatencySpread()
	deviationMs := 0.0
	if latency.Count > 0 {
		deviationMs = latency.MaxMs - scheduleDelay()*1000
		if deviationMs < 0 {
			deviationMs = 0
		}
	}
	return map[string]any{
		"delaySec":    scheduleDelay(),
		"holdBackSec": schedule.PartHoldBack,
		"listeners":   latency.Count,
		"spreadMs":    latency.SpreadMs,
		"deviationMs": deviationMs,
	}
}
