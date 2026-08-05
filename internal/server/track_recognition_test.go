package server

import (
	"bytes"
	"net/http"
	"testing"

	"partyparty/internal/event"
)

func TestTrackEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)
	events, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env.srv.Events = events

	post := func(addr, payload string) int {
		w := doBody(env.srv, http.MethodPost, "/api/track", addr, "application/json",
			bytes.NewBufferString(payload))
		return w.Code
	}

	if code := post("10.0.0.7:5000", `{"title":"Song"}`); code != http.StatusForbidden {
		t.Fatalf("guest post = %d, want 403 (loopback is the DJ)", code)
	}
	if w := do(env.srv, http.MethodGet, "/api/track", djAddr); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d, want 405", w.Code)
	}
	if code := post(djAddr, `{"artist":"No Title"}`); code != http.StatusBadRequest {
		t.Fatalf("title-less post = %d, want 400", code)
	}
	if code := post(djAddr, `{"id":"m1","title":"Song","artist":"Artist","artworkUrl":"https://example.com/a.jpg"}`); code != http.StatusOK {
		t.Fatalf("match post = %d, want 200", code)
	}
	// Repeats of the same catalog item are idempotent, not errors.
	if code := post(djAddr, `{"id":"m1","title":"Song","artist":"Artist"}`); code != http.StatusOK {
		t.Fatalf("repeat post = %d, want 200", code)
	}
	if code := post(djAddr, `{"silent":true}`); code != http.StatusOK {
		t.Fatalf("silent post = %d, want 200", code)
	}
}
