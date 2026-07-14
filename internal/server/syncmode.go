package server

// The global sync approach — the DJ-facing "which sync scheme is the room using
// right now" switch. The DJ picks one preset in the console; it applies to the
// WHOLE room, every guest reads it from /api/status and re-aligns on it, and the
// DJ can flip to the next preset to A/B them on the real phones in one party
// (instead of shipping one scheme at a time and physically retesting each).
//
// A preset bundles the three startup dials we learned matter: whether native
// AVPlayer does the muted startup seek (the pre-fix behavior that hung iOS 27),
// whether the server pins the room start with EXT-X-START, and the wall-clock
// target behind the DJ. It is the server-side, room-wide form of the per-device
// ?seek/?pin/?d URL params (which stay as an override/escape hatch).

type syncPreset struct {
	ID     string
	Label  string
	Hint   string
	Seek   bool
	Pin    bool
	Target float64 // seconds behind the DJ; 0 = inherit the configured default

	// Stream geometry (LL-HLS shape). Zero values inherit the configured
	// defaults, so most presets share the running engine. A preset whose
	// effective geometry differs from the current one cannot be applied
	// in-memory: /api/sync-mode performs a controlled engine rebuild
	// (publisher stop -> mediamtx.yml rewrite -> MediaMTX restart -> publisher
	// restart) with rollback — the room restarts briefly, exactly like the
	// field-proven capture-devicechange rebuilds.
	PartDur  string // e.g. "500ms"; "" = inherit Config.PartDur
	SegDur   string // e.g. "1s"; "" = inherit Config.SegDur
	SegCount int    // playlist window in segments; 0 = inherit Config.SegCount

	// Reroll: native no-seek clients may take ONE additional muted draw when
	// the first natural start verifies >1s off target (re-attach, never a
	// seek). Pushed to guests via the sync status payload.
	Reroll bool
}

const defaultSyncMode = "balanced"

// syncModeOrder is the console's radio order. syncModes indexes it as the
// server-side allowlist the mutation endpoint validates against. Presets whose
// Target is 0 inherit the configured latency (Config.LatencyTarget, else the
// LL-HLS default), so latency-agnostic presets track the OTA latency knob rather
// than hardcoding a number that would silently drift from it.
var syncModeOrder = []syncPreset{
	{ID: "balanced", Label: "Balanced", Hint: "Natural start + start-position pin. Today's shipped default.", Seek: false, Pin: true, Target: 0},
	{ID: "precise", Label: "Precise", Hint: "Finer stream shape (1s segments, 500ms parts) + one silent start re-roll for the tightest starts. Switching briefly restarts the stream.", Seek: false, Pin: true, Target: 0, PartDur: "500ms", SegDur: "1s", SegCount: 32, Reroll: true},
	{ID: "seek", Label: "Seek to align", Hint: "Muted startup seek (the pre-fix behavior). Tests whether the iOS-27 silent hang returns.", Seek: true, Pin: true, Target: 0},
	{ID: "nopin", Label: "No pin", Hint: "Natural start, no EXT-X-START pin. Isolates whether the pin actually helps native.", Seek: false, Pin: false, Target: 0},
	{ID: "deep", Label: "Deep buffer", Hint: "More cushion (6s behind the DJ) against gross gaps, at the cost of latency.", Seek: false, Pin: true, Target: 6},
	{ID: "tight", Label: "Tight", Hint: "Push latency down to 2s to find where it starts to break.", Seek: false, Pin: true, Target: 2},
}

var syncModes = func() map[string]syncPreset {
	m := make(map[string]syncPreset, len(syncModeOrder))
	for _, p := range syncModeOrder {
		m[p.ID] = p
	}
	return m
}()

func (s *srv) setSyncMode(id string) {
	s.syncMu.Lock()
	s.syncMode = id
	s.syncMu.Unlock()
}

func (s *srv) currentSyncMode() string {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	if s.syncMode == "" {
		return defaultSyncMode
	}
	return s.syncMode
}

func (s *srv) currentSyncPreset() syncPreset {
	if p, ok := syncModes[s.currentSyncMode()]; ok {
		return p
	}
	return syncModes[defaultSyncMode]
}

// presetTarget resolves a preset's effective wall-clock target WITHOUT re-reading
// the current mode, so a caller that already holds a consistent preset snapshot
// derives its target from that same snapshot (no tear if the DJ flips mid-read).
func (s *srv) presetTarget(p syncPreset) float64 {
	if p.Target > 0 {
		return p.Target
	}
	if s.Config.LatencyTarget > 0 {
		return s.Config.LatencyTarget
	}
	return defaultLLHLSLatencyTarget
}

// syncTarget is the effective wall-clock target for the current preset. It is the
// single source of truth for the room target: /api/status latencyTarget, the
// EXT-X-START pin offset, and the streamSync readiness math all read it, so they
// can never disagree (the comment in New() requires the pin to equal the reported
// target).
func (s *srv) syncTarget() float64 {
	return s.presetTarget(s.currentSyncPreset())
}

// syncPinEnabled reports whether the /live proxy should inject the EXT-X-START
// room-start pin for the current approach. Read at request time so a DJ flip
// takes effect on the next playlist fetch with no rebuild.
func (s *srv) syncPinEnabled() bool {
	return s.currentSyncPreset().Pin
}

// presetGeometry resolves a preset's effective LL-HLS shape, inheriting the
// configured defaults for unset fields. Two presets with equal effective
// geometry share the running engine; unequal geometry demands a rebuild.
func (s *srv) presetGeometry(p syncPreset) (partDur, segDur string, segCount int) {
	partDur, segDur, segCount = p.PartDur, p.SegDur, p.SegCount
	if partDur == "" {
		partDur = s.Config.PartDur
	}
	if segDur == "" {
		segDur = s.Config.SegDur
	}
	if segCount == 0 {
		segCount = s.Config.SegCount
	}
	return partDur, segDur, segCount
}

func (s *srv) beginSyncSwitch() bool {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	if s.syncSwitching {
		return false
	}
	s.syncSwitching = true
	return true
}

func (s *srv) endSyncSwitch() {
	s.syncMu.Lock()
	s.syncSwitching = false
	s.syncMu.Unlock()
}

func (s *srv) isSyncSwitching() bool {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	return s.syncSwitching
}

// syncModeState is the compact payload every guest reads each poll to apply the
// room's current approach and to detect a change (→ re-align). It resolves the
// preset ONCE so mode/seek/pin/target are always a single consistent snapshot,
// even if the DJ flips the approach concurrently with this read.
func (s *srv) syncModeState() map[string]any {
	p := s.currentSyncPreset()
	return map[string]any{
		"mode":      p.ID,
		"seek":      p.Seek,
		"pin":       p.Pin,
		"target":    s.presetTarget(p),
		"reroll":    p.Reroll,
		"switching": s.isSyncSwitching(),
	}
}

// syncModeList is the DJ-only radio menu (id + label + hint). It is attached to
// /api/status only for the localhost DJ, so this static list never bloats the
// guest join-path poll.
func syncModeList() []map[string]any {
	out := make([]map[string]any, 0, len(syncModeOrder))
	for _, p := range syncModeOrder {
		out = append(out, map[string]any{"id": p.ID, "label": p.Label, "hint": p.Hint})
	}
	return out
}
