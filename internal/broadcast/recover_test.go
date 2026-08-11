package broadcast

import (
	"testing"
	"time"

	"partyparty/internal/config"
)

// The recovery gate, not the recovery: firing a real rebuild would exec
// ffmpeg. The gate is the part with rules - live only, once per 90s, a yes
// claims the slot - and the part a regression would quietly break.
func TestPipelineRecoveryIsGuarded(t *testing.T) {
	b := New(config.Config{}, t.TempDir(), "", "")

	if b.shouldRecoverPipeline() {
		t.Fatal("an idle broadcaster agreed to recover a pipeline it is not running")
	}

	b.mu.Lock()
	b.state = "live"
	b.mu.Unlock()
	if !b.shouldRecoverPipeline() {
		t.Fatal("a live broadcaster refused its first recovery")
	}
	if b.shouldRecoverPipeline() {
		t.Fatal("a second recovery fired inside the throttle window - a broken engine would be thrashed")
	}

	b.mu.Lock()
	b.lastPipelineRecover = time.Now().Add(-2 * time.Minute)
	b.mu.Unlock()
	if !b.shouldRecoverPipeline() {
		t.Fatal("the throttle never expires")
	}

	b.mu.Lock()
	b.state = "idle"
	b.lastPipelineRecover = time.Time{}
	b.mu.Unlock()
	if b.shouldRecoverPipeline() {
		t.Fatal("an ended set can still trigger recovery")
	}
}
