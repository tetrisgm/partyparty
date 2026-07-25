package server

import (
	"encoding/json"
	"os"
	"path/filepath"

	"partyparty/internal/activate"
)

// The room's sync behavior. One production design — "Precise" — won the
// experiment era (2026-07): natural native starts against an EXT-X-START pin on
// a fine stream shape (1s segments / 500ms parts, config defaults), one silent
// muted re-roll when the first native draw verifies badly, hls.js keeps its
// muted seek loop, and recovery is always a re-attach (passive playback: no
// rate control, no audible seeks). Two DJ toggles now gate it: "room sync delay"
// (the park/EXT-X-START pin) and "drift correction" (the late-drift re-pull),
// both OFF by default so guests ride the live edge unless unison is turned on.

// syncTarget is the room's wall-clock target behind the DJ — the single source
// of truth read by /api/status latencyTarget, the EXT-X-START pin offset, and
// the streamSync readiness math, so they can never disagree.
func (s *srv) syncTarget() float64 {
	if !s.roomSyncEnabled() {
		return 0 // Room sync delay OFF (default): ride the live edge — no EXT-X-START pin.
	}
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

// --- Room-sync toggles: park (room sync delay) + drift correction. Per-DJ,
// persisted to stateDir/room-settings.json, lazily loaded once. Both OFF by
// default: guests ride the live edge and no drift re-pull runs. ---

func (s *srv) roomSyncFile() (string, error) {
	dir, err := activate.StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "room-settings.json"), nil
}

func (s *srv) ensureRoomSyncLoaded() {
	s.roomSyncOnce.Do(func() {
		// STABLE SETTINGS defaults ON (generous buffers + governor on the guest
		// side). roomSyncDelay/driftCorrection default OFF. Set the defaults first
		// so a persisted file that predates "stable" still resolves stable=ON.
		s.roomSyncMu.Lock()
		s.stable = true
		s.roomSyncMu.Unlock()
		path, err := s.roomSyncFile()
		if err != nil {
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return
		}
		var p struct {
			RoomSyncDelay   bool  `json:"roomSyncDelay"`
			DriftCorrection bool  `json:"driftCorrection"`
			Stable          *bool `json:"stable"` // pointer: absent in an old file keeps the ON default
		}
		if json.Unmarshal(data, &p) == nil {
			s.roomSyncMu.Lock()
			s.roomSyncDelay, s.driftCorrection = p.RoomSyncDelay, p.DriftCorrection
			if p.Stable != nil {
				s.stable = *p.Stable
			}
			s.roomSyncMu.Unlock()
		}
	})
}

func (s *srv) roomSyncEnabled() bool {
	s.ensureRoomSyncLoaded()
	s.roomSyncMu.Lock()
	defer s.roomSyncMu.Unlock()
	return s.roomSyncDelay
}

func (s *srv) roomSyncState() (delay, drift bool) {
	s.ensureRoomSyncLoaded()
	s.roomSyncMu.Lock()
	defer s.roomSyncMu.Unlock()
	return s.roomSyncDelay, s.driftCorrection
}

// stableEnabled reports the STABLE SETTINGS toggle (default ON): generous guest
// buffers + governor. OFF trades margin for the tightest latency.
func (s *srv) stableEnabled() bool {
	s.ensureRoomSyncLoaded()
	s.roomSyncMu.Lock()
	defer s.roomSyncMu.Unlock()
	return s.stable
}

// persistRoomSync writes all three toggles (called under no lock).
func (s *srv) persistRoomSync() {
	s.roomSyncMu.Lock()
	delay, drift, stable := s.roomSyncDelay, s.driftCorrection, s.stable
	s.roomSyncMu.Unlock()
	if path, err := s.roomSyncFile(); err == nil {
		data, _ := json.Marshal(map[string]any{"roomSyncDelay": delay, "driftCorrection": drift, "stable": stable})
		_ = os.WriteFile(path, data, 0o600)
	}
}

func (s *srv) setRoomSync(delay, drift bool) {
	s.ensureRoomSyncLoaded()
	s.roomSyncMu.Lock()
	s.roomSyncDelay, s.driftCorrection = delay, drift
	s.roomSyncMu.Unlock()
	s.persistRoomSync()
}

func (s *srv) setStable(stable bool) {
	s.ensureRoomSyncLoaded()
	s.roomSyncMu.Lock()
	s.stable = stable
	s.roomSyncMu.Unlock()
	s.persistRoomSync()
}

// roomSyncStatePayload is the /api/status view the listener + DJ console read.
func (s *srv) roomSyncStatePayload() map[string]any {
	delay, drift := s.roomSyncState()
	return map[string]any{"delay": delay, "drift": drift, "stable": s.stableEnabled()}
}
