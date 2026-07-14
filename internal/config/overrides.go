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
}

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
	if s.PartDur != nil && validDurRange(*s.PartDur, 200*time.Millisecond, 2000*time.Millisecond) {
		o.PartDur = s.PartDur
	}
	if s.SegDur != nil && validDurRange(*s.SegDur, 1*time.Second, 6*time.Second) {
		o.SegDur = s.SegDur
	}
	// Upper bound 32 = the shipped window (32 x 1s segments = 32s of recovery
	// history — a smaller count with short segments would silently halve it).
	if s.SegCount != nil && *s.SegCount >= 3 && *s.SegCount <= 32 {
		o.SegCount = s.SegCount
	}
	if s.LatencyTargetSec != nil && *s.LatencyTargetSec >= 0 && *s.LatencyTargetSec <= 15 {
		o.LatencyTarget = s.LatencyTargetSec
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
	return c
}

// validLLPair holds when the LL-HLS part duration is a positive, parseable
// duration strictly shorter than the segment duration — MediaMTX's requirement.
func validLLPair(part, seg string) bool {
	p, err1 := time.ParseDuration(part)
	s, err2 := time.ParseDuration(seg)
	return err1 == nil && err2 == nil && p > 0 && p < s
}
