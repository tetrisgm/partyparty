package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"partyparty/internal/cloudsync"
	"partyparty/internal/event"
)

// A stand-in platform. The point of these tests is the Mac's half of the
// contract: that it creates the canonical party FIRST and then points the room
// at it, that opening a web-made party is an edit to that same record, and that
// none of it ever mints a second party.
type fakePlatform struct {
	// Guarded because a rename typed in the console is carried to the platform
	// in the background: the DJ's words are saved locally first and never wait
	// on the network. That makes this a second goroutine's view of the fake.
	mu      sync.Mutex
	linked  bool
	parties []cloudsync.Party
	creates []cloudsync.Party
	djs     []string
	updates []struct {
		key    string
		fields map[string]any
	}
}

func (f *fakePlatform) Parties(context.Context) ([]cloudsync.Party, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.parties, f.linked, nil
}

func (f *fakePlatform) CreateParty(_ context.Context, p cloudsync.NewParty) (cloudsync.Party, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.linked {
		return cloudsync.Party{}, errors.New("this Mac is not signed in")
	}
	made := cloudsync.Party{
		Key: "ev-created", Slug: "warehouse-late", Title: p.Title, Place: p.Place,
		PartyID: p.PartyID, StartsMs: p.StartsMs, Handle: "sundaze",
		URL: "https://partyparty.party/@sundaze/warehouse-late", State: "announced",
	}
	f.djs = append(f.djs, p.DJs)
	f.creates = append(f.creates, made)
	f.parties = append(f.parties, made)
	return made, nil
}

func (f *fakePlatform) UpdateParty(_ context.Context, key string, fields map[string]any) (cloudsync.Party, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, struct {
		key    string
		fields map[string]any
	}{key, fields})
	for i := range f.parties {
		if f.parties[i].Key != key {
			continue
		}
		if v, ok := fields["partyId"].(string); ok {
			f.parties[i].PartyID = v
		}
		if v, ok := fields["title"].(string); ok {
			f.parties[i].Title = v
		}
		if v, ok := fields["place"].(string); ok {
			f.parties[i].Place = v
		}
		return f.parties[i], nil
	}
	return cloudsync.Party{}, http.ErrNoLocation
}

// waitForUpdates blocks until the platform has seen n edits, or gives up. The
// rename is carried in the background on purpose, so there is nothing in the
// response to wait on - and sleeping a fixed amount is how a test becomes flaky
// on a loaded build runner.
func (f *fakePlatform) waitForUpdates(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		got := len(f.updates)
		f.mu.Unlock()
		if got >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the platform never saw %d edits", n)
}

// quiet proves the opposite: that nothing was sent, after long enough that a
// send would have arrived.
func (f *fakePlatform) quiet(t *testing.T) {
	t.Helper()
	time.Sleep(150 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.updates) != 0 {
		t.Fatalf("something was sent to the platform: %+v", f.updates)
	}
}

func macSrv(t *testing.T, platform *fakePlatform) (*Srv, *event.Store) {
	t.Helper()
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(Deps{Events: ev, Parties: platform}), ev
}

func post(t *testing.T, s *Srv, path string, body any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(body)
	w := doBody(s, http.MethodPost, path, "127.0.0.1:1234", "application/json", bytes.NewBuffer(raw))
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	out["__status"] = float64(w.Code)
	return out
}

func TestCreatingAPartyOnTheMacMakesTheCanonicalRecordFirst(t *testing.T) {
	platform := &fakePlatform{linked: true}
	s, ev := macSrv(t, platform)

	got := post(t, s, "/api/party/create", map[string]any{
		"title": "Warehouse, late", "place": "Unit 7", "open": true,
	})
	if got["__status"] != float64(200) {
		t.Fatalf("create: %v", got)
	}
	if len(platform.creates) != 1 {
		t.Fatalf("expected exactly one canonical party, got %d", len(platform.creates))
	}
	made := platform.creates[0]
	if made.Title != "Warehouse, late" || made.Place != "Unit 7" {
		t.Fatalf("the platform got the wrong fields: %+v", made)
	}
	// The Mac knows when it is and says so, rather than leaving it blank.
	if made.StartsMs <= 0 {
		t.Fatal("the Mac must fill in the time it already knows")
	}
	// The live room rides along at creation, so broadcasting never needs a
	// second record to hang itself off.
	if made.PartyID != ev.Identity().ID {
		t.Fatalf("the room was not attached at creation: %q", made.PartyID)
	}
	// And this room now knows which party it is running.
	if ev.Canonical().Key != "ev-created" {
		t.Fatalf("the room did not adopt the party: %+v", ev.Canonical())
	}
	if ev.Meta().Title != "Warehouse, late" {
		t.Fatalf("the room still calls itself %q", ev.Meta().Title)
	}
}

func TestCreatingWithoutOpeningLeavesTonightAlone(t *testing.T) {
	platform := &fakePlatform{linked: true}
	s, ev := macSrv(t, platform)

	got := post(t, s, "/api/party/create", map[string]any{"title": "Friday", "open": false})
	if got["__status"] != float64(200) {
		t.Fatalf("create: %v", got)
	}
	if len(platform.creates) != 1 {
		t.Fatal("the party is still made")
	}
	if platform.creates[0].PartyID != "" {
		t.Fatal("a party made for later must not seize the live room")
	}
	if ev.Canonical().Key != "" {
		t.Fatal("making a party for Friday hijacked tonight")
	}
}

func TestOpeningAWebMadePartyEditsThatSameRecord(t *testing.T) {
	platform := &fakePlatform{linked: true, parties: []cloudsync.Party{{
		Key: "ev-web", Slug: "lido", Title: "Sundaze at the Lido", Handle: "sundaze",
		URL: "https://partyparty.party/@sundaze/lido", State: "announced",
	}}}
	s, ev := macSrv(t, platform)

	list := post(t, s, "/api/parties", nil)
	if list["linked"] != true {
		t.Fatalf("list: %v", list)
	}

	got := post(t, s, "/api/party/open", map[string]any{"key": "ev-web"})
	if got["__status"] != float64(200) {
		t.Fatalf("open: %v", got)
	}
	if len(platform.creates) != 0 {
		t.Fatal("opening an existing party must never create one")
	}
	if len(platform.updates) != 1 || platform.updates[0].key != "ev-web" {
		t.Fatalf("the wrong record was edited: %+v", platform.updates)
	}
	if platform.updates[0].fields["partyId"] != ev.Identity().ID {
		t.Fatal("the live room was not attached to it")
	}
	if ev.Canonical().Key != "ev-web" || ev.Meta().Title != "Sundaze at the Lido" {
		t.Fatalf("the room did not adopt it: %+v", ev.Canonical())
	}
}

func TestEditingFromTheBoothMovesOnlyWhatWasSent(t *testing.T) {
	platform := &fakePlatform{linked: true}
	s, ev := macSrv(t, platform)
	post(t, s, "/api/party/create", map[string]any{"title": "Rooftop", "place": "The roof", "open": true})

	title := "Rooftop, later"
	got := post(t, s, "/api/party/edit", map[string]any{"title": title})
	if got["__status"] != float64(200) {
		t.Fatalf("edit: %v", got)
	}
	last := platform.updates[len(platform.updates)-1]
	if last.key != "ev-created" {
		t.Fatalf("edited the wrong party: %q", last.key)
	}
	if _, sent := last.fields["place"]; sent {
		t.Fatal("a field nobody touched must not be sent, or it clears on the web")
	}
	if ev.Canonical().Title != "Rooftop, later" {
		t.Fatalf("the room did not take the new name: %+v", ev.Canonical())
	}
}

func TestAPartyIsNotRequiredAndAnUnsignedMacSaysSo(t *testing.T) {
	platform := &fakePlatform{linked: false}
	s, _ := macSrv(t, platform)

	list := post(t, s, "/api/parties", nil)
	if list["linked"] != false {
		t.Fatalf("an unsigned Mac has no parties: %v", list)
	}
	edit := post(t, s, "/api/party/edit", map[string]any{"title": "x"})
	if edit["__status"] != float64(409) {
		t.Fatalf("a room running no party cannot be edited into one: %v", edit)
	}
}

// Renaming the party in the booth is the same edit as renaming it on the web.
// It used to change only this Mac's copy, and the party's own page kept the old
// name for the rest of the night - two names for one party, which is the whole
// thing the canonical record exists to prevent.
func TestRenamingInTheBoothRenamesTheParty(t *testing.T) {
	platform := &fakePlatform{linked: true}
	s, ev := macSrv(t, platform)
	post(t, s, "/api/party/create", map[string]any{
		"title": "Rooftop", "place": "The roof", "open": true})

	got := post(t, s, "/api/event-config", map[string]any{"title": "Rooftop, later"})
	if got["__status"] != float64(200) {
		t.Fatalf("rename: %v", got)
	}
	// Local first, and without waiting for anything.
	if ev.Meta().Title != "Rooftop, later" {
		t.Fatalf("the room did not take the name: %q", ev.Meta().Title)
	}
	platform.waitForUpdates(t, 1)

	platform.mu.Lock()
	last := platform.updates[len(platform.updates)-1]
	platform.mu.Unlock()
	if last.key != "ev-created" || last.fields["title"] != "Rooftop, later" {
		t.Fatalf("the wrong edit reached the platform: %+v", last)
	}
	if _, sent := last.fields["place"]; sent {
		t.Fatal("a place nobody typed must not be sent; it would clear one set on the web")
	}
	if ev.Canonical().Title != "Rooftop, later" {
		t.Fatalf("the room's pointer kept the old name: %+v", ev.Canonical())
	}
}

func TestRenamingSaysNothingWhenThereIsNoPartyToRename(t *testing.T) {
	// A Mac in a room with no page on the platform, which is most of them. The
	// rename still works; it just has nowhere to go, and says nothing about it.
	platform := &fakePlatform{linked: true}
	s, ev := macSrv(t, platform)

	got := post(t, s, "/api/event-config", map[string]any{"title": "Someone's kitchen"})
	if got["__status"] != float64(200) {
		t.Fatalf("rename: %v", got)
	}
	if ev.Meta().Title != "Someone's kitchen" {
		t.Fatalf("the room did not take the name: %q", ev.Meta().Title)
	}
	platform.quiet(t)

	// And re-saving the same name is not an edit at all.
	post(t, s, "/api/party/create", map[string]any{"title": "Named", "open": true})
	platform.mu.Lock()
	platform.updates = nil
	platform.mu.Unlock()
	post(t, s, "/api/event-config", map[string]any{"title": "Named"})
	platform.quiet(t)
}

func TestGuestsOnlyEverSeeTheRoom(t *testing.T) {
	platform := &fakePlatform{linked: true}
	s, _ := macSrv(t, platform)
	// Every party-management route is the DJ's. A guest on the LAN reaching
	// them would be editing somebody's account from a phone.
	for _, path := range []string{"/api/parties", "/api/party/create", "/api/party/open", "/api/party/edit"} {
		w := doBody(s, http.MethodPost, path, "192.168.1.44:5555", "application/json",
			bytes.NewBufferString(`{"title":"x","key":"ev-web"}`))
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s let a guest in: %d", path, w.Code)
		}
	}
	if len(platform.creates)+len(platform.updates) != 0 {
		t.Fatal("a guest reached the platform")
	}
}
