package roomplane

import (
	"testing"
	"time"
)

// The Mac republishes snapshots on a timer whether or not anything changed. If
// each republish bumped the version, every parked guest read would wake once a
// second and long-poll would quietly degrade into a poll.
func TestVersionChangesOnlyWhenContentDoes(t *testing.T) {
	r := New()
	r.Publish("feed", []byte(`{"posts":1}`), 1.0)
	_, v1, _ := r.ReadVersioned("feed")
	r.Publish("feed", []byte(`{"posts":1}`), 1.0)
	_, v2, _ := r.ReadVersioned("feed")
	if v1 != v2 {
		t.Fatalf("identical republish bumped the version: %d -> %d", v1, v2)
	}
	r.Publish("feed", []byte(`{"posts":2}`), 1.0)
	_, v3, _ := r.ReadVersioned("feed")
	if v3 == v2 {
		t.Fatal("changed content did not bump the version")
	}
}

// A guest holding the current version parks; publishing different bytes
// releases it with the new content. Publishing a DIFFERENT kind must not
// release it with stale content.
func TestWaitForParksUntilThisKindChanges(t *testing.T) {
	r := New()
	r.Publish("feed", []byte(`{"posts":1}`), 1.0)
	_, v, _ := r.ReadVersioned("feed")

	released := make(chan []byte, 1)
	go func() {
		body, _, _ := r.WaitFor("feed", v, time.Now().Add(5*time.Second))
		released <- body
	}()

	time.Sleep(50 * time.Millisecond)
	r.Publish("status", []byte(`{"tick":1}`), 1.0) // another kind: re-park, not release
	select {
	case body := <-released:
		t.Fatalf("a different kind's publish released the feed wait with %s", body)
	case <-time.After(150 * time.Millisecond):
	}

	r.Publish("feed", []byte(`{"posts":2}`), 1.0)
	select {
	case body := <-released:
		if string(body) != `{"posts":2}` {
			t.Fatalf("released with stale content: %s", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("publishing the kind never released the parked read")
	}
}

// Versions survive Reset, so an ETag issued before a room was reset can never
// accidentally validate different bytes afterwards.
func TestVersionsNeverReusedAcrossReset(t *testing.T) {
	r := New()
	r.Publish("feed", []byte(`{"posts":1}`), 1.0)
	_, before, _ := r.ReadVersioned("feed")
	r.Reset()
	r.Publish("feed", []byte(`{"posts":"different"}`), 1.0)
	_, after, _ := r.ReadVersioned("feed")
	if after == before {
		t.Fatalf("version %d reused for different content after Reset", after)
	}
}
