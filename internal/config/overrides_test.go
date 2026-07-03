package config

import "testing"

func TestParseOverridesValid(t *testing.T) {
	raw := []byte(`{"server":{"bitrate":"256k","channels":1,"hlsTimeSec":2,"hlsListLen":30,"partDur":"500ms","segDur":"3s","segCount":10,"latencyTargetSec":5}}`)
	o := ParseOverrides(raw)
	if o.Bitrate == nil || *o.Bitrate != "256k" {
		t.Errorf("bitrate = %v", o.Bitrate)
	}
	if o.Channels == nil || *o.Channels != 1 {
		t.Errorf("channels = %v", o.Channels)
	}
	if o.PartDur == nil || *o.PartDur != "500ms" {
		t.Errorf("partDur = %v", o.PartDur)
	}
	if o.SegCount == nil || *o.SegCount != 10 {
		t.Errorf("segCount = %v", o.SegCount)
	}
	if o.LatencyTarget == nil || *o.LatencyTarget != 5 {
		t.Errorf("latencyTarget = %v", o.LatencyTarget)
	}

	base := Config{Bitrate: "320k", Channels: 2, PartDur: "1000ms", SegCount: 16, LatencyTarget: 0}
	got := base.WithOverrides(o)
	if got.Bitrate != "256k" || got.Channels != 1 || got.PartDur != "500ms" || got.SegCount != 10 || got.LatencyTarget != 5 {
		t.Errorf("WithOverrides applied wrong: %+v", got)
	}
}

func TestParseOverridesRejectsUnsafe(t *testing.T) {
	// Every value here is out of bounds or malformed — NONE may be accepted, so a
	// bad OTA config can never reach the pipeline.
	cases := []string{
		`{"server":{"bitrate":"9999k"}}`,     // too high
		`{"server":{"bitrate":"10k"}}`,       // too low
		`{"server":{"bitrate":"lots"}}`,      // malformed
		`{"server":{"bitrate":"320"}}`,       // missing k
		`{"server":{"channels":5}}`,          // not 1/2
		`{"server":{"channels":0}}`,          // not 1/2
		`{"server":{"hlsTimeSec":0}}`,        // < 1
		`{"server":{"hlsTimeSec":99}}`,       // > 6
		`{"server":{"hlsListLen":2}}`,        // < 6
		`{"server":{"partDur":"5s"}}`,        // > 2000ms
		`{"server":{"partDur":"10ms"}}`,      // < 200ms
		`{"server":{"partDur":"nope"}}`,      // malformed
		`{"server":{"segDur":"30s"}}`,        // > 6s
		`{"server":{"segCount":1}}`,          // < 3
		`{"server":{"segCount":999}}`,        // > 30
		`{"server":{"latencyTargetSec":99}}`, // > 15
		`{"server":{"latencyTargetSec":-1}}`, // < 0
		`not json at all`,                    // malformed doc
		`{}`,                                 // no server section
		`{"server":null}`,                    // null server
		``,                                   // empty
	}
	for _, raw := range cases {
		o := ParseOverrides([]byte(raw))
		if o.Bitrate != nil || o.Channels != nil || o.HLSTime != nil || o.HLSList != nil ||
			o.PartDur != nil || o.SegDur != nil || o.SegCount != nil || o.LatencyTarget != nil {
			t.Errorf("unsafe/absent config %q produced an override: %+v", raw, o)
		}
	}

	// A malformed config must leave the base Config exactly unchanged.
	base := Config{Bitrate: "320k", Channels: 2, PartDur: "1000ms", SegCount: 16}
	if got := base.WithOverrides(ParseOverrides([]byte(`garbage`))); got != base {
		t.Errorf("malformed config altered base: %+v", got)
	}
}

func TestWithOverridesEnforcesLLPairInvariant(t *testing.T) {
	base := Config{PartDur: "1000ms", SegDur: "2s"}

	// A partial override that inverts the pair (part 2000ms over the default 2s
	// segment) passes per-field validation but MediaMTX would reject it — both
	// LL-timing values must revert to the known-good defaults.
	got := base.WithOverrides(ParseOverrides([]byte(`{"server":{"partDur":"2000ms"}}`)))
	if got.PartDur != "1000ms" || got.SegDur != "2s" {
		t.Fatalf("inverted LL pair not reverted: part=%q seg=%q", got.PartDur, got.SegDur)
	}

	// part 2000ms == segment 2s is also invalid (not strictly shorter) -> revert.
	got = base.WithOverrides(ParseOverrides([]byte(`{"server":{"partDur":"2000ms","segDur":"2s"}}`)))
	if got.PartDur != "1000ms" || got.SegDur != "2s" {
		t.Fatalf("equal LL pair not reverted: part=%q seg=%q", got.PartDur, got.SegDur)
	}

	// A valid pair (part strictly < segment) applies.
	got = base.WithOverrides(ParseOverrides([]byte(`{"server":{"partDur":"500ms","segDur":"3s"}}`)))
	if got.PartDur != "500ms" || got.SegDur != "3s" {
		t.Fatalf("valid LL pair not applied: part=%q seg=%q", got.PartDur, got.SegDur)
	}
}

func TestParseOverridesPartial(t *testing.T) {
	// Only the valid fields apply; an invalid neighbor doesn't poison them.
	o := ParseOverrides([]byte(`{"server":{"bitrate":"192k","channels":9}}`))
	if o.Bitrate == nil || *o.Bitrate != "192k" {
		t.Errorf("valid bitrate dropped: %v", o.Bitrate)
	}
	if o.Channels != nil {
		t.Errorf("invalid channels accepted: %v", o.Channels)
	}
	// latencyTargetSec 0 is a VALID value (auto) and must be applied, not treated as absent.
	o2 := ParseOverrides([]byte(`{"server":{"latencyTargetSec":0}}`))
	if o2.LatencyTarget == nil || *o2.LatencyTarget != 0 {
		t.Errorf("latencyTargetSec:0 should be a present, valid override, got %v", o2.LatencyTarget)
	}
}
