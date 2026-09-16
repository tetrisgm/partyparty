package contribute

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"partyparty/internal/origin"
)

func TestRelayedGuestReadsAdvancingSourceClock(t *testing.T) {
	store := origin.NewStore()
	h := origin.NewHandler(origin.Config{Tokens: func(string) (string, bool) { return "test-only", true }}, store)
	srv := httptest.NewServer(h)
	defer srv.Close()
	m := New(Config{Target: func() (string, string) { return srv.URL + "/r/test", "test-only" }})
	m.planeCycle(context.Background(), PlaneHooks{Snapshots: func() map[string]json.RawMessage {
		return map[string]json.RawMessage{"status": json.RawMessage(`{"live":true}`)}
	}})
	previous := 0.0
	for i := 0; i < 2; i++ {
		resp, err := srv.Client().Get(srv.URL + "/r/test/api/time")
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Sent, Received float64
			UncertaintyMS  float64 `json:"uncertaintyMs"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || body.Sent < body.Received || body.Sent <= previous || body.UncertaintyMS <= 0 {
			t.Fatalf("invalid time response: status=%d body=%+v err=%v", resp.StatusCode, body, err)
		}
		if delta := float64(time.Now().UnixMilli()) - body.Sent; delta < -100 || delta > 100 {
			t.Fatalf("wrong source clock: difference %v ms", delta)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("clock response cacheable")
		}
		previous = body.Sent
		time.Sleep(5 * time.Millisecond)
	}
	room, _ := store.Room("test", false)
	room.Plane().Reset()
	resp, err := srv.Client().Get(srv.URL + "/r/test/api/time")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unavailable source clock must not silently use origin time: %d", resp.StatusCode)
	}
}
