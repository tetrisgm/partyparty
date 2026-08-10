package cloudsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type request struct {
	PartyID string `json:"partyId"`
	Since   int64  `json:"since"`
	Posts   []Post `json:"posts"`
	ID      string `json:"id"`
	Secret  string `json:"secret"`
	JoinURL string `json:"joinUrl"`
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
		"https://early-heron.party.partyparty.party:8443/",
		[]Post{{ID: "l1", Author: "Guest", Body: "dancefloor", CreatedMs: 100}},
		[]Track{{Title: "Windowlicker", Artist: "Aphex Twin"}},
		[]string{"Cy"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "w1" {
		t.Fatalf("web posts = %+v", got)
	}
	if seen[0].Since != 0 || len(seen[0].Posts) != 1 {
		t.Fatalf("first request = %+v", seen[0])
	}
	// The link a guest opens rides along with the sync, because that call is
	// also what tells the platform this room is still playing.
	if seen[0].JoinURL != "https://early-heron.party.partyparty.party:8443/" {
		t.Fatalf("join URL did not travel: %q", seen[0].JoinURL)
	}

	// The cursor moves to the newest post actually received - not to "now",
	// which would skip anything written while the request was in flight.
	if client.Since() != 500 {
		t.Fatalf("cursor = %d, want 500", client.Since())
	}
	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", "", nil, nil, nil); err != nil {
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
	posts, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", "", nil, nil, nil)
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
	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", "", nil, nil, nil); err == nil {
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

	if _, err := client.Sync(context.Background(), "2026-08-06-2200-ab12", "", nil, nil, nil); err == nil {
		t.Fatal("a 502 must be reported")
	}
	if client.Since() != 900 {
		t.Fatalf("a failed sync must not move the cursor: %d", client.Since())
	}
}

func TestRunBindsOncePerPartyAndMergesWhatComesBack(t *testing.T) {
	var binds, syncs int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/party/bind" {
			binds++
			_ = json.NewEncoder(w).Encode(Binding{Bound: true, Slug: "tonight", Handle: "sundaze"})
			return
		}
		syncs++
		reply := syncResponse{Bound: true}
		if syncs == 1 {
			reply.Posts = []Post{{ID: "w1", Author: "Web", Body: "photos", CreatedMs: 10}}
		}
		_ = json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()

	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	var merged []string
	var boundURL string
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		client.Run(ctx, Hooks{
			PartyID:  func() string { return "2026-08-06-2200-ab12" },
			Live:     func() bool { return true },
			Outgoing: func(int) []Post { return nil },
			Merge: func(id, author, body string, createdMs int64) (bool, error) {
				merged = append(merged, id)
				return true, nil
			},
			Bound: func(url string) { boundURL = url },
		}, time.Millisecond)
	}()

	deadline := time.After(3 * time.Second)
	for {
		if syncs >= 3 {
			break
		}
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatalf("sync did not run: binds=%d syncs=%d", binds, syncs)
		case <-time.After(2 * time.Millisecond):
		}
	}
	cancel()
	<-done

	// Binding is asked once for a party. Asking every tick would rewrite the
	// binding of a night another Mac has since claimed.
	if binds != 1 {
		t.Fatalf("bound %d times, want 1", binds)
	}
	if boundURL != server.URL+"/@sundaze/tonight" {
		t.Fatalf("bound url = %q", boundURL)
	}
	if len(merged) != 1 || merged[0] != "w1" {
		t.Fatalf("merged = %v", merged)
	}
}

func TestRunStaysSilentWhenThereIsNoParty(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(syncResponse{Bound: false})
	}))
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	// A Mac that is not playing must not talk to the cloud at all.
	client.Run(ctx, Hooks{
		PartyID: func() string { return "2026-08-06-2200-ab12" },
		Live:    func() bool { return false },
	}, time.Millisecond)
	if calls != 0 {
		t.Fatalf("made %d requests while not live", calls)
	}
}

// ---------------------------------------------------------------- profiles

// The whole contract of the profile sync is "newer wins", so these test which
// direction it moves and nothing else.

type profileServer struct {
	remote   Profile
	linked   bool
	pushes   []map[string]any
	avatars  int
	cleared  int
	imageHit int
}

func (p *profileServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/install/profile", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Set       map[string]any `json:"set"`
			UpdatedMs int64          `json:"updatedMs"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Set != nil {
			p.pushes = append(p.pushes, body.Set)
			if body.UpdatedMs > p.remote.UpdatedMs {
				p.remote.Name, _ = body.Set["name"].(string)
				p.remote.UpdatedMs = body.UpdatedMs
			}
		}
		_ = json.NewEncoder(w).Encode(profileResponse{Linked: p.linked, Profile: p.remote})
	})
	mux.HandleFunc("/api/v1/install/avatar", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseMultipartForm(1 << 20)
		if r.FormValue("clear") != "" {
			p.cleared++
		} else {
			p.avatars++
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"linked": true, "avatarUrl": "https://x/media/a"})
	})
	mux.HandleFunc("/photo.png", func(w http.ResponseWriter, r *http.Request) {
		p.imageHit++
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write([]byte("PNGBYTES"))
	})
	return mux
}

func TestProfileTakesTheNewerSideAndOnlyThat(t *testing.T) {
	state := &profileServer{linked: true, remote: Profile{Name: "From the web", UpdatedMs: 500}}
	server := httptest.NewServer(state.handler())
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	// The web is newer: the Mac takes it and sends nothing.
	var applied []Profile
	hooks := ProfileHooks{
		Local: func() Profile { return Profile{Name: "Stale", UpdatedMs: 100} },
		Apply: func(p Profile) (bool, error) { applied = append(applied, p); return true, nil },
	}
	if err := client.SyncProfile(context.Background(), hooks); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(applied) != 1 || applied[0].Name != "From the web" {
		t.Fatalf("expected the web's copy to be applied, got %+v", applied)
	}
	if len(state.pushes) != 0 {
		t.Fatalf("a stale Mac must not write: %+v", state.pushes)
	}

	// The Mac is newer: it writes, and the platform ends up holding its copy.
	hooks.Local = func() Profile { return Profile{Name: "From the booth", UpdatedMs: 900} }
	if err := client.SyncProfile(context.Background(), hooks); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(state.pushes) != 1 || state.pushes[0]["name"] != "From the booth" {
		t.Fatalf("expected one push of the booth's copy, got %+v", state.pushes)
	}
	if len(applied) != 1 {
		t.Fatalf("the Mac must not then apply its own write back over itself")
	}
	if state.remote.Name != "From the booth" {
		t.Fatalf("platform kept %q", state.remote.Name)
	}
}

func TestProfileFetchesAPhotoOnceAndPushesTheLocalOne(t *testing.T) {
	state := &profileServer{linked: true}
	server := httptest.NewServer(state.handler())
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()
	state.remote = Profile{Name: "Web", UpdatedMs: 500, AvatarURL: server.URL + "/photo.png"}

	seen := ""
	hooks := ProfileHooks{
		Local:       func() Profile { return Profile{UpdatedMs: 1} },
		Apply:       func(Profile) (bool, error) { return true, nil },
		AvatarSeen:  func() string { return seen },
		ApplyAvatar: func(url, _ string, data []byte) error { seen = url; return nil },
	}
	for i := 0; i < 3; i++ {
		if err := client.SyncProfile(context.Background(), hooks); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	if state.imageHit != 1 {
		t.Fatalf("an unchanged photo must be fetched once, not %d times", state.imageHit)
	}

	// Newer locally: the photo goes up with the rest of the profile.
	hooks.Local = func() Profile { return Profile{Name: "Booth", UpdatedMs: 9000} }
	hooks.LocalAvatar = func() (string, []byte, bool) { return "a.png", []byte("BYTES"), true }
	if err := client.SyncProfile(context.Background(), hooks); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if state.avatars != 1 {
		t.Fatalf("expected the local photo to be sent once, got %d", state.avatars)
	}
}

func TestProfileOnAnUnpairedMacChangesNothing(t *testing.T) {
	state := &profileServer{linked: false}
	server := httptest.NewServer(state.handler())
	defer server.Close()
	client := New(server.URL, "aabbccddeeff", "s3cret")
	client.HTTP = server.Client()

	applied := 0
	err := client.SyncProfile(context.Background(), ProfileHooks{
		Local: func() Profile { return Profile{Name: "Local only", UpdatedMs: 900} },
		Apply: func(Profile) (bool, error) { applied++; return true, nil },
	})
	if err != nil {
		t.Fatalf("an unpaired Mac is not an error: %v", err)
	}
	if applied != 0 || len(state.pushes) != 0 {
		t.Fatalf("nothing should move: applied=%d pushes=%d", applied, len(state.pushes))
	}
}
