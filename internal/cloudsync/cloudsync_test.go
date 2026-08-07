package cloudsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type request struct {
	PartyID string `json:"partyId"`
	Since   int64  `json:"since"`
	Posts   []Post `json:"posts"`
	ID      string `json:"id"`
	Secret  string `json:"secret"`
}

func TestSyncPushesOnceAndAdvancesOnlyPastWhatArrived(t *testing.T) {
	var seen []request
	replies := []syncResponse{
		{Bound: true, Stored: 1, Posts: []Post{{ID: "w1", Body: "later", CreatedMs: 500}}},
		{Bound: true},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body request
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		reply := syncResponse{Bound: true}
		if len(seen) <= len(replies) {
			reply = replies[len(seen)-1]
		}
		_ = json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()

	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	got, err := client.Sync(context.Background(), "2026-08-06-2200-ab12",
		[]Post{{ID: "l1", Author: "Guest", Body: "dancefloor", CreatedMs: 100}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "w1" {
		t.Fatalf("web posts = %+v", got)
	}
	if seen[0].Since != 0 || len(seen[0].Posts) != 1 {
		t.Fatalf("first request = %+v", seen[0])
	}

	// The cursor moves to the newest post actually received - not to "now",
	// which would skip anything written while the request was in flight.
	if client.Since() != 500 {
		t.Fatalf("cursor = %d, want 500", client.Since())
	}
	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", nil); err != nil {
		t.Fatal(err)
	}
	if seen[1].Since != 500 {
		t.Fatalf("second request asked since %d", seen[1].Since)
	}
	if client.Since() != 500 {
		t.Fatalf("an empty reply must not move the cursor: %d", client.Since())
	}
}

func TestSyncOnAnUnboundPartyIsQuiet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(syncResponse{Bound: false})
	}))
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	// Most parties are just a Mac in a room. That is not an error and must not
	// look like one.
	posts, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", nil)
	if err != nil {
		t.Fatalf("an unbound party must not error: %v", err)
	}
	if len(posts) != 0 {
		t.Fatalf("posts = %+v", posts)
	}
}

func TestBindReportsTheNightAndItsLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Binding{Bound: true, Slug: "tonight", Handle: "sundaze", Title: "Sundaze"})
	}))
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	binding, err := client.Bind(context.Background(), "2026-08-06-2200-ab12")
	if err != nil {
		t.Fatal(err)
	}
	if got := binding.URL("https://partyparty.party/"); got != "https://partyparty.party/@sundaze/tonight" {
		t.Fatalf("link = %q", got)
	}
	if got := (Binding{}).URL("https://partyparty.party"); got != "" {
		t.Fatalf("an unbound party has no link, got %q", got)
	}
}

func TestNotConfiguredNeverCallsOut(t *testing.T) {
	// A Mac that has never registered must not make requests with empty
	// credentials; it should simply have nothing to sync.
	client := New("", "", "")
	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", nil); err == nil {
		t.Fatal("expected an error rather than a request with no credentials")
	}
	if _, err := client.Bind(context.Background(), "2026-08-06-2200-ab12"); err == nil {
		t.Fatal("expected an error rather than a request with no credentials")
	}
}

func TestServerErrorsSurfaceRatherThanLoseTheCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()
	client.Resume(900)

	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", nil); err == nil {
		t.Fatal("a 502 must be reported")
	}
	if client.Since() != 900 {
		t.Fatalf("a failed sync must not move the cursor: %d", client.Since())
	}
}
