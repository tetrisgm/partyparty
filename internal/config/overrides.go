package config

import (
	"encoding/json"
	"regexp"
	"strconv"
	"time"
)

// Overrides are OTA-delivered server tunables — the "server" section of the
// payload's config.json — so the streaming pipeline can be tuned in the field
// without an app update. Every field is optional (nil = keep the built-in
// default) and STRICTLY validated on parse: an out-of-range or malformed value
// is dropped, not clamped and not applied. That is the safety model — an
// accepted override is always a value the encoder/MediaMTX can run, so a bad
// config can never break a live stream (prevention, not after-the-fact
// recovery). A whole-document parse failure yields an empty Overrides (all
// defaults), so malformed config is inert.
type Overrides struct {
	Bitrate       *string  // AAC bitrate, e.g. "256k" (ffmpeg, per-broadcast)
	Channels      *int     // 1 or 2 (ffmpeg, per-broadcast)
	HLSTime       *int     // plain-HLS segment seconds (ffmpeg, per-broadcast)
	HLSList       *int     // plain-HLS playlist length (ffmpeg, per-broadcast)
	PartDur       *string  // LL-HLS part duration (MediaMTX, applied at startup)
	SegDur        *string  // LL-HLS segment duration (MediaMTX, applied at startup)
	SegCount      *int     // LL-HLS playlist length (MediaMTX, applied at startup)
	LatencyTarget *float64 // room delay seconds, 0 = auto (applied at startup)
	Codec         *string  // audio encoder (ffmpeg -c:a, per-broadcast)
}

// codecs is the allowlist of audio encoders the bundled ffmpeg has AND MediaMTX
// can repackage into LL-HLS. aac_at (Apple AAC, default) and aac are the safe,
// universally-playable AAC-LC path. libopus is the low-DELAY option (~5-20ms
// algorithmic latency vs AAC-LC's ~130ms) — a real encoder-latency win, gated on
// the mediamtx->iOS Opus-in-HLS path actually playing (test before defaulting;
// the adts recording + mpegts mirror legs are AAC-only and degrade via
// onfail=ignore while the live LL-HLS leg carries Opus).
var codecs = map[string]bool{"aac_at": true, "aac": true, "libopus": true}

var bitrateRE = regexp.MustCompile(`^([0-9]{2,4})k$`)

// ParseOverrides reads and validates the "server" section of a config.json
// document. Bounds are chosen so any accepted value is a safe, runnable
// pipeline setting; anything outside them is silently ignored.
func ParseOverrides(raw []byte) Overrides {
	var o Overrides
	if len(raw) == 0 {
		return o
	}
	var doc struct {
		Server *struct {
			Bitrate          *string  `json:"bitrate"`
			Channels         *int     `json:"channels"`
			HLSTimeSec       *int     `json:"hlsTimeSec"`
			HLSListLen       *int     `json:"hlsListLen"`
			PartDur          *string  `json:"partDur"`
			SegDur           *string  `json:"segDur"`
			SegCount         *int     `json:"segCount"`
			LatencyTargetSec *float64 `json:"latencyTargetSec"`
			Codec            *string  `json:"codec"`
		} `json:"server"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Server == nil {
		return o
	}
	s := doc.Server
	if s.Bitrate != nil && validBitrate(*s.Bitrate) {
		o.Bitrate = s.Bitrate
	}
	if s.Channels != nil && (*s.Channels == 1 || *s.Channels == 2) {
		o.Channels = s.Channels
	}
	if s.HLSTimeSec != nil && *s.HLSTimeSec >= 1 && *s.HLSTimeSec <= 6 {
		o.HLSTime = s.HLSTimeSec
	}
	if s.HLSListLen != nil && *s.HLSListLen >= 6 && *s.HLSListLen <= 60 {
		o.HLSList = s.HLSListLen
	}
	// partDur is THE latency lever: player rest ≈ encoder + part + PART-HOLD-BACK
	// (~3×part) + iOS's own output buffer (~300ms fixed). Floor is 80ms so the
	// field can push toward the LL-HLS/iOS practical limit (~0.8s) over the air;
	// below ~100ms returns diminish (PART-HOLD-BACK < the fixed iOS buffer) and
	// request rate climbs, so smaller is validated-allowed but tune by measurement.
	if s.PartDur != nil && validDurRange(*s.PartDur, 80*time.Millisecond, 2000*time.Millisecond) {
		o.PartDur = s.PartDur
	}
	// Floor is 500ms (not 1s): LL-HLS derives HOLD-BACK = 3 × segment, and on the
	// live-edge default (no EXT-X-START pin) HOLD-BACK is the depth iOS AVPlayer
	// falls back to when it drops part-level tracking — so 1s segments park guests
	// ~3s behind live over time (field-observed, needs a manual refresh). 500ms
	// halves that to ~1.5s. The old 1s floor existed to place the -3s room pin on
	// the RFC 8216 three-target-duration boundary, which only matters when the
	// park is on; the live-edge default has no pin.
	if s.SegDur != nil && validDurRange(*s.SegDur, 200*time.Millisecond, 6*time.Second) {
		o.SegDur = s.SegDur
	}
	// The real safety bound is the WINDOW (segCount × segDur), not the raw count:
	// too small a window let deep-starting guests fall off the back edge and go
	// silent (2026-07-15 field). The 24s default window is 24×1s OR 48×0.5s — so
	// the ceiling is 48, high enough to keep a 24s window at 500ms segments while
	// still bounding worst-case desync.
	if s.SegCount != nil && *s.SegCount >= 3 && *s.SegCount <= 48 {
		o.SegCount = s.SegCount
	}
	if s.LatencyTargetSec != nil && *s.LatencyTargetSec >= 0 && *s.LatencyTargetSec <= 15 {
		o.LatencyTarget = s.LatencyTargetSec
	}
	if s.Codec != nil && codecs[*s.Codec] {
		o.Codec = s.Codec
	}
	return o
}

func validBitrate(s string) bool {
	m := bitrateRE.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	n, err := strconv.Atoi(m[1])
	return err == nil && n >= 96 && n <= 512
}

func validDurRange(s string, lo, hi time.Duration) bool {
	d, err := time.ParseDuration(s)
	return err == nil && d >= lo && d <= hi
}

// WithOverrides returns a copy of c with every present, validated override
// applied. Used at startup so the whole config (including MediaMTX LL-timing) is
// OTA-tunable from launch.
func (c Config) WithOverrides(o Overrides) Config {
	if o.Bitrate != nil {
		c.Bitrate = *o.Bitrate
	}
	if o.Channels != nil {
		c.Channels = *o.Channels
	}
	if o.HLSTime != nil {
		c.HLSTime = *o.HLSTime
	}
	if o.HLSList != nil {
		c.HLSList = *o.HLSList
	}
	// LL-HLS part/segment durations are validated in isolation, but MediaMTX
	// requires the part to be SHORTER than the segment (parts subdivide a
	// segment). A partial override can satisfy both bounds yet invert the pair
	// (e.g. partDur 2000ms over the default 2s segment), which MediaMTX rejects
	// and the low-latency muxer never starts. Enforce the cross-field invariant
	// on the RESULTING pair and, if violated, keep BOTH previous known-good
	// values rather than shipping an unrunnable config.
	origPart, origSeg := c.PartDur, c.SegDur
	if o.PartDur != nil {
		c.PartDur = *o.PartDur
	}
	if o.SegDur != nil {
		c.SegDur = *o.SegDur
	}
	if !validLLPair(c.PartDur, c.SegDur) {
		c.PartDur, c.SegDur = origPart, origSeg
	}
	if o.SegCount != nil {
		c.SegCount = *o.SegCount
	}
	if o.LatencyTarget != nil {
		c.LatencyTarget = *o.LatencyTarget
	}
	if o.Codec != nil {
		c.Codec = *o.Codec
	}
	return c
}

// validLLPair holds when the LL-HLS part duration is a positive, parseable
// duration strictly shorter than the segment duration — MediaMTX's requirement.
func validLLPair(part, seg string) bool {
	p, err1 := time.ParseDuration(part)
	s, err2 := time.ParseDuration(seg)
	return err1 == nil && err2 == nil && p > 0 && p < s
}
