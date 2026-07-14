package server

// The room's sync behavior. One production design — "Precise" — won the
// experiment era (2026-07): natural native starts against an EXT-X-START pin on
// a fine stream shape (1s segments / 500ms parts, config defaults), one silent
// muted re-roll when the first native draw verifies badly, hls.js keeps its
// muted seek loop, and recovery is always a re-attach (passive playback: no
// rate control, no audible seeks). The multi-preset switch, per-device URL
// dials, and /live-plain experiment route are gone; field rollback, if ever
// needed, is the OTA config overrides (segDur/partDur/segCount/latencyTargetSec),
// applied at app start.

// syncTarget is the room's wall-clock target behind the DJ — the single source
// of truth read by /api/status latencyTarget, the EXT-X-START pin offset, and
// the streamSync readiness math, so they can never disagree.
func (s *srv) syncTarget() float64 {
	if s.Config.LatencyTarget > 0 {
		return s.Config.LatencyTarget
	}
	return defaultLLHLSLatencyTarget
}

// syncModeState is the compact payload guests read each poll. The shape is kept
// stable for deployed player pages (they key re-alignment and telemetry off
// these fields); the values are now constants of the one production design.
func (s *srv) syncModeState() map[string]any {
	return map[string]any{
		"mode":   "precise",
		"seek":   false,
		"pin":    true,
		"target": s.syncTarget(),
		"reroll": true,
	}
}
