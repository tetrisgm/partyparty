package roomplane

import (
	"encoding/json"
	"math"
	"time"
)

// sourceClock maps the relay's clock onto the Mac's PROGRAM-DATE-TIME clock.
// The Mac estimates this offset with a four-timestamp exchange, then publishes
// it once for the whole room. Guest requests never round-trip to the Mac.
type sourceClock struct {
	OriginMinusSourceMS float64 `json:"originMinusSourceMs"`
	UncertaintyMS       float64 `json:"uncertaintyMs"`
	SampledOriginMS     float64 `json:"sampledOriginMs"`
}

type clockAnchor struct {
	at          time.Time
	sourceMS    float64
	uncertainty float64
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// publishClock runs with r.mu held. An old offset is never refreshed merely
// because a queued request finally arrived.
func (r *Room) publishClock(body json.RawMessage) bool {
	var sample sourceClock
	if json.Unmarshal(body, &sample) != nil || !finite(sample.OriginMinusSourceMS) ||
		!finite(sample.UncertaintyMS) || !finite(sample.SampledOriginMS) ||
		sample.UncertaintyMS < 0 || sample.UncertaintyMS > 1000 {
		return false
	}
	now := r.now()
	age := float64(now.UnixMilli()) - sample.SampledOriginMS
	if age < -2 || age > 10000 {
		return false
	}
	r.clock = &clockAnchor{
		at: now, sourceMS: float64(now.UnixMilli()) - sample.OriginMinusSourceMS,
		uncertainty: sample.UncertaintyMS + math.Max(0, age)*0.0001,
	}
	return true
}

// SourceTime returns a live estimate in the SOURCE clock domain, never a
// cached time response or the relay's unrelated wall time. Expired calibration
// is unavailable; listeners keep playing without timing-based corrections.
func (r *Room) SourceTime() (sourceMS, uncertaintyMS float64, ok bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.clock == nil {
		return 0, 0, false
	}
	now := r.now()
	age := now.Sub(r.clock.at)
	wallAge := float64(now.UnixMilli() - r.clock.at.UnixMilli())
	if age < 0 || age > 15*time.Second || math.Abs(wallAge-float64(age)/float64(time.Millisecond)) > 100 {
		return 0, 0, false
	}
	elapsed := float64(age) / float64(time.Millisecond)
	return r.clock.sourceMS + elapsed, r.clock.uncertainty + elapsed*0.0001, true
}
