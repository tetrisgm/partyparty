package contribute

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"partyparty/internal/origin"
)

// The plane's two ends are tested against each other rather than against a stub,
// because the wire format IS the contract between them and a shared struct would
// hide a mismatch.

func planeRig(t *testing.T) (*Manager, *origin.Store, func()) {
	t.Helper()
	store := origin.NewStore()
	srv := httptest.NewServer(origin.NewHandler(origin.Config{
		Tokens: func(string) (string, bool) { return "secret", true },
	}, store))
	m := New(Config{
		SourceURL:  srv.URL + "/unused/stream.m3u8",
		TargetBase: srv.URL + "/r/room1/",
		Token:      "secret",
		Logf:       func(string, ...any) {},
	})
	m.SetEnabled(true)
	return m, store, srv.Close
}

// TestPlanePublishesStateGuestsCanRead is the scaling property end to end: the
// Mac publishes once, and any number of guests read without touching it.
func TestPlanePublishesStateGuestsCanRead(t *testing.T) {
	m, store, done := planeRig(t)
	defer done()

	m.planeCycle(context.Background(), PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{
				"status": json.RawMessage(`{"live":true,"listeners":3}`),
				"feed":   json.RawMessage(`[{"text":"hello"}]`),
			}
		},
		DelaySec: func() float64 { return 1.0 },
	})

	room, ok := store.Room("room1", false)
	if !ok {
		t.Fatal("publishing did not create the room")
	}
	for kind, want := range map[string]string{
		"status": `{"live":true,"listeners":3}`,
		"feed":   `[{"text":"hello"}]`,
	} {
		got, published := room.Plane().Read(kind)
		if !published || string(got) != want {
			t.Fatalf("%s read back as %q (published=%v)", kind, got, published)
		}
	}
}

// TestPlaneDrainsGuestActivity: heartbeats arrive as one aggregate and posts
// arrive intact, so the Mac's load is set by the drain interval rather than by
// how many people came.
func TestPlaneDrainsGuestActivity(t *testing.T) {
	m, store, done := planeRig(t)
	defer done()
	ctx := context.Background()

	m.planeCycle(ctx, PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
		},
		DelaySec: func() float64 { return 1.0 },
	})

	room, _ := store.Room("room1", false)
	for i := 0; i < 200; i++ {
		room.Plane().Beat(fmt.Sprintf("guest%d", i), 1200, true)
	}
	room.Plane().Enqueue("post", json.RawMessage(`{"text":"hi"}`))

	var mu sync.Mutex
	var listeners int
	var writes []string
	m.planeCycle(ctx, PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
		},
		DelaySec: func() float64 { return 1.0 },
		Presence: func(n int, _ float64) { mu.Lock(); listeners = n; mu.Unlock() },
		ApplyWrite: func(path string, body json.RawMessage) {
			mu.Lock()
			writes = append(writes, path+":"+string(body))
			mu.Unlock()
		},
	})

	mu.Lock()
	defer mu.Unlock()
	if listeners != 200 {
		t.Fatalf("presence reported %d listeners, want 200", listeners)
	}
	if len(writes) != 1 || !strings.Contains(writes[0], `"text":"hi"`) {
		t.Fatalf("writes = %v", writes)
	}
}

// TestPlaneDeliversEachWriteOnce: a guest post applied twice would double-post
// to the room.
func TestPlaneDeliversEachWriteOnce(t *testing.T) {
	m, store, done := planeRig(t)
	defer done()
	ctx := context.Background()

	hooks := PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
		},
		DelaySec: func() float64 { return 1.0 },
	}
	m.planeCycle(ctx, hooks)

	room, _ := store.Room("room1", false)
	room.Plane().Enqueue("post", json.RawMessage(`{"n":1}`))

	var count int
	hooks.ApplyWrite = func(string, json.RawMessage) { count++ }
	m.planeCycle(ctx, hooks)
	m.planeCycle(ctx, hooks)

	if count != 1 {
		t.Fatalf("write applied %d times, want 1", count)
	}
}

// TestPlaneIsSilentWhenNotRelaying: a direct or local party must never talk to
// the origin at all.
func TestPlaneIsSilentWhenNotRelaying(t *testing.T) {
	store := origin.NewStore()
	srv := httptest.NewServer(origin.NewHandler(origin.Config{
		Tokens: func(string) (string, bool) { return "secret", true },
	}, store))
	defer srv.Close()

	m := New(Config{TargetBase: srv.URL + "/r/room1/", Token: "secret"})
	// Deliberately NOT enabled.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.RunPlane(ctx, PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
		},
	})
	time.Sleep(250 * time.Millisecond)

	if _, ok := store.Room("room1", false); ok {
		t.Fatal("the plane published while the room was not relaying")
	}
}
