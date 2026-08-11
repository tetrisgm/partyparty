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

// A set must outlive its engine - but must never outlive the DJ's Stop.
func TestACrashedSetRevivesButAStoppedOneDoesNot(t *testing.T) {
	b := New(config.Config{}, t.TempDir(), "", "")

	b.mu.Lock()
	b.state = "idle" // what Stop() leaves behind
	b.lastDevice = "mac"
	b.mu.Unlock()
	if b.shouldReviveAfterCrash() {
		t.Fatal("it would restart a DJ who pressed Stop")
	}

	b.mu.Lock()
	b.state = "error" // what a dead pipeline leaves behind
	b.mu.Unlock()
	if !b.shouldReviveAfterCrash() {
		t.Fatal("a crashed set was left dead")
	}
	if b.shouldReviveAfterCrash() {
		t.Fatal("revival is not throttled - a broken setup would be relaunched in a loop")
	}

	// And nothing to revive is not a crash.
	b.mu.Lock()
	b.lastDevice = ""
	b.lastPipelineRecover = time.Time{}
	b.mu.Unlock()
	if b.shouldReviveAfterCrash() {
		t.Fatal("it tried to revive a broadcast that never had a device")
	}
}
