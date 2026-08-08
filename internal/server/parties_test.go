package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"partyparty/internal/cloudsync"
	"partyparty/internal/event"
)

// A stand-in platform. The point of these tests is the Mac's half of the
// contract: that it creates the canonical party FIRST and then points the room
// at it, that opening a web-made party is an edit to that same record, and that
// none of it ever mints a second party.
type fakePlatform struct {
	linked  bool
	parties []cloudsync.Party
	creates []cloudsync.Party
	updates []struct {
		key    string
		fields map[string]any
	}
}

func (f *fakePlatform) Parties(context.Context) ([]cloudsync.Party, bool, error) {
	return f.parties, f.linked, nil
}

func (f *fakePlatform) CreateParty(_ context.Context, title, place, partyID string, startsMs int64) (cloudsync.Party, error) {
	if !f.linked {
		return cloudsync.Party{}, errors.New("this Mac is not signed in")
	}
	p := cloudsync.Party{
		Key: "ev-created", Slug: "warehouse-late", Title: title, Place: place,
		PartyID: partyID, StartsMs: startsMs, Handle: "sundaze",
		URL: "https://partyparty.party/@sundaze/warehouse-late", State: "announced",
	}
	f.creates = append(f.creates, p)
	f.parties = append(f.parties, p)
	return p, nil
}

func (f *fakePlatform) UpdateParty(_ context.Context, key string, fields map[string]any) (cloudsync.Party, error) {
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
