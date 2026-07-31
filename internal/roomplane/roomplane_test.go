package roomplane

import (
	"encoding/json"
	"fmt"
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

// TestWritesDrainOnceAndAreBounded: queued guest actions reach the Mac exactly
// once, and a flood cannot grow memory without limit.
func TestWritesDrainOnceAndAreBounded(t *testing.T) {
	r := New()
	r.Enqueue("/api/react", json.RawMessage(`{"emoji":"fire"}`))

	d := r.Drain()
	if len(d.Writes) != 1 || d.Writes[0].Path != "/api/react" {
		t.Fatalf("first drain = %+v", d.Writes)
	}
	if d2 := r.Drain(); len(d2.Writes) != 0 {
		t.Fatalf("writes delivered twice: %+v", d2.Writes)
	}

	for i := 0; i < maxQueuedWrites*2; i++ {
		r.Enqueue("/api/post", json.RawMessage(`{}`))
	}
	if got := len(r.Drain().Writes); got > maxQueuedWrites {
		t.Fatalf("queue grew to %d, past the %d cap", got, maxQueuedWrites)
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
