package roomplane

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestSourceClockAdvancesExpiresAndResets(t *testing.T) {
	r := New()
	now := time.Unix(1700000000, 0)
	r.now = func() time.Time { return now }
	if _, _, ok := r.SourceTime(); ok {
		t.Fatal("unpublished clock was usable")
	}
	body, _ := json.Marshal(sourceClock{OriginMinusSourceMS: 42000, UncertaintyMS: 12, SampledOriginMS: float64(now.UnixMilli())})
	if !r.Publish("clock", body, 0) {
		t.Fatal("clock rejected")
	}
	now = now.Add(3 * time.Second)
	source, uncertainty, ok := r.SourceTime()
	if !ok || math.Abs(source-float64(now.UnixMilli()-42000)) > 0.01 || uncertainty < 12 {
		t.Fatalf("source clock = %v ± %v (ok=%v)", source, uncertainty, ok)
	}
	if _, published := r.Read("clock"); published {
		t.Fatal("clock calibration leaked into cached snapshot responses")
	}
	now = now.Add(13 * time.Second)
	if _, _, ok := r.SourceTime(); ok {
		t.Fatal("expired clock usable")
	}
	if r.Publish("clock", body, 0) {
		t.Fatal("stale calibration refreshed its age")
	}
	body, _ = json.Marshal(sourceClock{SampledOriginMS: float64(now.UnixMilli())})
	if !r.Publish("clock", body, 0) {
		t.Fatal("fresh calibration rejected")
	}
	r.Reset()
	if _, _, ok := r.SourceTime(); ok {
		t.Fatal("clock survived room reset")
	}
}

func TestSourceClockRejectsInvalidSamples(t *testing.T) {
	r := New()
	now := time.Unix(1700000000, 0)
	r.now = func() time.Time { return now }
	for _, sample := range []sourceClock{
		{}, {SampledOriginMS: float64(now.Add(time.Second).UnixMilli())},
		{SampledOriginMS: float64(now.UnixMilli()), UncertaintyMS: -1},
		{SampledOriginMS: float64(now.UnixMilli()), UncertaintyMS: 2000},
	} {
		body, _ := json.Marshal(sample)
		if r.Publish("clock", body, 0) {
			t.Fatalf("invalid calibration accepted: %s", body)
		}
	}
}
