package roomplane

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

func fixedClock(r *Room, at *time.Time) { r.now = func() time.Time { return *at } }

// TestReadsNeverCostTheMac is the whole reason this package exists. Five hundred
// guests reading is exactly as expensive for the Mac as one, because reads are
// served from what the Mac last published and never forwarded.
func TestReadsNeverCostTheMac(t *testing.T) {
	r := New()
	if _, ok := r.Read("status"); ok {
		t.Fatal("an unpublished kind must report not-ready, not an empty room")
	}
	if !r.Publish("status", json.RawMessage(`{"live":true}`), 1.0) {
		t.Fatal("publish rejected a valid snapshot")
	}
	for i := 0; i < 500; i++ {
		body, ok := r.Read("status")
		if !ok || string(body) != `{"live":true}` {
			t.Fatalf("read %d returned %q ok=%v", i, body, ok)
		}
	}
	// Reads must not have produced any work for the Mac to drain.
	if d := r.Drain(); len(d.Writes) != 0 {
		t.Fatalf("reads generated %d writes for the Mac", len(d.Writes))
	}
}

func TestPublishRejectsGarbage(t *testing.T) {
	r := New()
	oversized := make([]byte, maxSnapshotBytes+1)
	for i := range oversized {
		oversized[i] = 'x'
	}
	for _, tc := range []struct {
		kind string
		body string
	}{
		{"", `{"a":1}`},
		{"status", ``},
		{"status", `not json`},
		{"status", string(oversized)},
	} {
		if r.Publish(tc.kind, json.RawMessage(tc.body), 1.0) {
			t.Fatalf("publish accepted bad input kind=%q len=%d", tc.kind, len(tc.body))
		}
	}
}

// TestHeartbeatsAggregateIntoOneDigest is the scaling property: however many
// guests beat, the Mac receives one summary per interval, so its inbound rate is
// set by the digest interval rather than by attendance.
func TestHeartbeatsAggregateIntoOneDigest(t *testing.T) {
	r := New()
	now := time.Now()
	fixedClock(r, &now)
	r.Publish("status", json.RawMessage(`{}`), 1.0)

	for i := 0; i < 500; i++ {
		r.Beat(Guest{ID: fmt.Sprintf("guest-%d", i)}, 1000+float64(i), true)
	}

	d := r.Drain()
	if d.Listeners != 500 {
		t.Fatalf("listeners = %d, want 500", d.Listeners)
	}
	if d.SpreadMs != 499 {
		t.Fatalf("spread = %v, want 499", d.SpreadMs)
	}
	// Declared delay is 1.0s and the worst listener is at 1.499s.
	if d.DeviationMs < 498 || d.DeviationMs > 500 {
		t.Fatalf("deviation = %v, want about 499", d.DeviationMs)
	}
}

// TestDeviationNeverGoesNegative: a room that is comfortably ahead of schedule
// reports zero, not a negative number that could read as credit.
func TestDeviationNeverGoesNegative(t *testing.T) {
	r := New()
	r.Publish("status", json.RawMessage(`{}`), 3.0)
	r.Beat(Guest{ID: "a"}, 900, true)
	if d := r.Drain(); d.DeviationMs != 0 {
		t.Fatalf("deviation = %v, want 0", d.DeviationMs)
	}
}

// TestGuestsWithoutLatencyStillCount: a guest that cannot measure yet is present
// and must be counted, but must not be treated as perfectly on time.
func TestGuestsWithoutLatencyStillCount(t *testing.T) {
	r := New()
	r.Publish("status", json.RawMessage(`{}`), 1.0)
	r.Beat(Guest{ID: "measuring"}, 1200, true)
	r.Beat(Guest{ID: "silent"}, 0, false)

	d := r.Drain()
	if d.Listeners != 2 {
		t.Fatalf("listeners = %d, want 2", d.Listeners)
	}
	if d.SpreadMs != 0 {
		t.Fatalf("spread = %v; a guest with no measurement must not widen it", d.SpreadMs)
	}
}

func TestDigestPreservesLiveRoster(t *testing.T) {
	r := New()
	want := Guest{
		ID: "phone-1", Name: "Seth", Emoji: "headphones",
		DJID: "dj-2", Paused: true,
	}
	r.Beat(want, 1100, true)
	d := r.Drain()
	if len(d.Roster) != 1 || d.Roster[0] != want {
		t.Fatalf("roster = %+v, want %+v", d.Roster, want)
	}
}

// TestListenersExpire: a phone that walks out stops counting, without the Mac
// having to be told.
func TestListenersExpire(t *testing.T) {
	r := New()
	now := time.Now()
	fixedClock(r, &now)
	r.Beat(Guest{ID: "leaver"}, 1000, true)
	if d := r.Drain(); d.Listeners != 1 {
		t.Fatalf("listeners = %d, want 1", d.Listeners)
	}
	now = now.Add(listenerTTL + time.Second)
	if d := r.Drain(); d.Listeners != 0 {
		t.Fatalf("a departed listener still counts: %+v", d)
	}
}

// TestWritesDrainOnce: queued guest actions reach the Mac exactly once.
func TestWritesDrainOnce(t *testing.T) {
	r := New()
	if !r.Enqueue("/api/react", json.RawMessage(`{"emoji":"fire"}`)) {
		t.Fatal("enqueue rejected a write with an empty queue")
	}

	d := r.Drain()
	if len(d.Writes) != 1 || d.Writes[0].Path != "/api/react" {
		t.Fatalf("first drain = %+v", d.Writes)
	}
	if d2 := r.Drain(); len(d2.Writes) != 0 {
		t.Fatalf("writes delivered twice: %+v", d2.Writes)
	}
	if !r.Enqueue("/api/post", json.RawMessage(`{}`)) {
		t.Fatal("draining did not make queue capacity available again")
	}
}

func TestEnqueueRejectsAtCapacityWithoutDroppingAcceptedWrites(t *testing.T) {
	r := New()
	for i := 0; i < maxQueuedWrites; i++ {
		body := json.RawMessage(fmt.Sprintf(`{"id":%d}`, i))
		if !r.Enqueue("post", body) {
			t.Fatalf("enqueue %d rejected before the %d-write cap", i, maxQueuedWrites)
		}
	}
	if r.Enqueue("post", json.RawMessage(`{"id":"rejected"}`)) {
		t.Fatal("enqueue reported success for a write beyond the queue cap")
	}

	writes := r.Drain().Writes
	if len(writes) != maxQueuedWrites {
		t.Fatalf("drained %d writes, want all %d accepted writes", len(writes), maxQueuedWrites)
	}
	if got := string(writes[0].Body); got != `{"id":0}` {
		t.Fatalf("oldest accepted write was replaced: %s", got)
	}
	if got := string(writes[len(writes)-1].Body); got != fmt.Sprintf(`{"id":%d}`, maxQueuedWrites-1) {
		t.Fatalf("last accepted write = %s", got)
	}
	if !r.Enqueue("post", json.RawMessage(`{"id":"after-drain"}`)) {
		t.Fatal("draining did not restore queue capacity")
	}
}

func TestConcurrentEnqueueSaturationReportsEveryRejection(t *testing.T) {
	const workers = 16
	const attempts = maxQueuedWrites * 4

	r := New()
	start := make(chan struct{})
	accepted := make([]bool, attempts)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			<-start
			for id := worker; id < attempts; id += workers {
				body := json.RawMessage(fmt.Sprintf(`{"id":%d}`, id))
				accepted[id] = r.Enqueue("post", body)
			}
		}(worker)
	}
	close(start)
	wg.Wait()

	acceptedCount := 0
	for _, ok := range accepted {
		if ok {
			acceptedCount++
		}
	}
	if acceptedCount != maxQueuedWrites {
		t.Fatalf("accepted %d concurrent writes, want queue cap %d", acceptedCount, maxQueuedWrites)
	}
	writes := r.Drain().Writes
	if len(writes) != acceptedCount {
		t.Fatalf("drained %d writes after accepting %d", len(writes), acceptedCount)
	}
	assertDeliveredWritesMatchAccepted(t, writes, accepted)
}

func assertDeliveredWritesMatchAccepted(t *testing.T, writes []Write, accepted []bool) {
	t.Helper()
	delivered := make([]bool, len(accepted))
	for _, write := range writes {
		var payload struct {
			ID int `json:"id"`
		}
		if err := json.Unmarshal(write.Body, &payload); err != nil {
			t.Fatalf("decode delivered write %q: %v", write.Body, err)
		}
		if payload.ID < 0 || payload.ID >= len(accepted) {
			t.Fatalf("delivered out-of-range id %d", payload.ID)
		}
		if delivered[payload.ID] {
			t.Fatalf("write %d was delivered more than once", payload.ID)
		}
		delivered[payload.ID] = true
	}
	for id := range accepted {
		if delivered[id] != accepted[id] {
			t.Fatalf("write %d accepted=%v delivered=%v", id, accepted[id], delivered[id])
		}
	}
}

// TestRotatingClientIDCannotGrowMemory: presence is keyed by a client-supplied
// id, so a client that rotates it must not be able to grow the map forever.
func TestRotatingClientIDCannotGrowMemory(t *testing.T) {
	r := New()
	now := time.Now()
	fixedClock(r, &now)
	for i := 0; i < maxTrackedListeners*2; i++ {
		r.Beat(Guest{ID: fmt.Sprintf("rotating-%d", i)}, 1000, true)
	}
	if got := r.Drain().Listeners; got > maxTrackedListeners {
		t.Fatalf("tracked %d listeners, past the %d cap", got, maxTrackedListeners)
	}
}

// TestResetLeavesNothingBehind: the product has no cloud party storage, so when
// a party ends nothing about it may survive here.
func TestResetLeavesNothingBehind(t *testing.T) {
	r := New()
	r.Publish("status", json.RawMessage(`{"live":true}`), 1.0)
	r.Publish("feed", json.RawMessage(`[{"text":"hi"}]`), 1.0)
	r.Beat(Guest{ID: "a"}, 1000, true)
	r.Enqueue("/api/post", json.RawMessage(`{"text":"secret"}`))

	r.Reset()

	if _, ok := r.Read("status"); ok {
		t.Fatal("status survived reset")
	}
	if _, ok := r.Read("feed"); ok {
		t.Fatal("feed survived reset")
	}
	d := r.Drain()
	if d.Listeners != 0 || len(d.Writes) != 0 {
		t.Fatalf("presence or queued content survived reset: %+v", d)
	}
}

// TestPublishedSnapshotIsIsolated: the caller's buffer may be reused, so a
// published snapshot must not change underneath a guest read.
func TestPublishedSnapshotIsIsolated(t *testing.T) {
	r := New()
	body := []byte(`{"live":true}`)
	r.Publish("status", body, 1.0)
	copy(body, []byte(`{"live":fals`))

	got, ok := r.Read("status")
	if !ok || string(got) != `{"live":true}` {
		t.Fatalf("snapshot mutated after publish: %q", got)
	}
}
