package peers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/grandcat/zeroconf"
	"partyparty/internal/event"
)

func TestTXTValues(t *testing.T) {
	got := txtValues([]string{"id=abc", "host=two-step.party.partyparty.party", "invalid"})
	if got["id"] != "abc" || got["host"] != "two-step.party.partyparty.party" {
		t.Fatalf("txtValues = %#v", got)
	}
	if _, ok := got["invalid"]; ok {
		t.Fatalf("invalid TXT field was retained: %#v", got)
	}
}

func TestAcceptCandidateRequiresResolvedTXT(t *testing.T) {
	d := &Directory{
		selfID:     "self",
		candidates: make(map[string]candidate),
		peers:      make(map[string]Peer),
	}
	if d.acceptCandidate(discoveredService{}) {
		t.Fatal("PTR-only browse result was accepted as a complete candidate")
	}
	resolved := discoveredService{id: "other", host: "cosmic-jam.party.partyparty.party", port: 8443}
	if !d.acceptCandidate(resolved) {
		t.Fatal("resolved service was rejected")
	}
	got := d.candidates["other"]
	if got.roomURL != "https://cosmic-jam.party.partyparty.party:8443" {
		t.Fatalf("candidate = %#v", got)
	}
}

func TestBonjourAdvertisement(t *testing.T) {
	if os.Getenv("PP_TEST_MDNS") != "1" {
		t.Skip("set PP_TEST_MDNS=1 for a physical multicast round trip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	d, err := New(ctx, "roundtrip-test", "roundtrip.local", 18443)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		t.Fatal(err)
	}
	entries := make(chan *zeroconf.ServiceEntry)
	go func() { _ = resolver.Browse(ctx, service, "local.", entries) }()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("Bonjour advertisement was not discovered")
		case entry := <-entries:
			if txtValues(entry.Text)["id"] == "roundtrip-test" {
				return
			}
		}
	}
}

func TestNativeBonjourBrowse(t *testing.T) {
	if os.Getenv("PP_TEST_MDNS") != "1" {
		t.Skip("set PP_TEST_MDNS=1 for a physical multicast round trip")
	}
	services, err := browseServices(1500)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("services: %#v", services)
	if len(services) < 2 {
		t.Fatalf("expected at least two PartyParty services, got %d", len(services))
	}
}

func TestProbeKeepsOnlyVerifiedPeer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/peer" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(Peer{ID: "other", Name: "Seth", Live: true, Ready: true, StreamURL: serverURL(r) + "/live/party/index.m3u8"})
	}))
	defer server.Close()

	d := &Directory{
		selfID:     "self",
		client:     server.Client(),
		candidates: map[string]candidate{"other": {id: "other", roomURL: server.URL, seen: time.Now()}},
		peers:      make(map[string]Peer),
	}
	d.probe(context.Background())
	got := d.Peers()
	if len(got) != 1 || got[0].ID != "other" || got[0].RoomURL != server.URL || !got[0].Ready {
		t.Fatalf("peers = %#v", got)
	}
}

func TestTransientProbeFailureKeepsPeer(t *testing.T) {
	d := &Directory{
		peers:    map[string]Peer{"other": {ID: "other", Name: "Seth"}},
		peerSeen: map[string]time.Time{"other": time.Now()},
	}
	d.markPeerUnavailable("other", "temporary timeout")
	if _, ok := d.Peer("other"); !ok {
		t.Fatal("one transient probe failure removed a live peer")
	}
	d.peerSeen["other"] = time.Now().Add(-peerGrace)
	d.markPeerUnavailable("other", "sustained timeout")
	if _, ok := d.Peer("other"); ok {
		t.Fatal("peer survived beyond the outage grace period")
	}
}

func TestPeerSnapshotsDoNotAliasDirectoryState(t *testing.T) {
	d := &Directory{peers: map[string]Peer{
		"other": {
			ID:         "other",
			NowPlaying: &event.CurrentTrack{Title: "Original track"},
			Links:      []event.Link{{Label: "Original link"}},
			Room: &Room{
				Roster: []Guest{{Name: "Original guest"}},
				Posts: []event.Post{{
					ID:        "post",
					Media:     []event.Media{{ID: "original.jpg"}},
					Comments:  []event.Comment{{ID: "comment", Text: "Original comment"}},
					Reactions: map[string]int{"fire": 1},
				}},
				IDs: []string{"post"},
			},
		},
	}}

	all := d.Peers()
	all[0].NowPlaying.Title = "Changed track"
	all[0].Links[0].Label = "Changed link"
	all[0].Room.Roster[0].Name = "Changed guest"
	all[0].Room.Posts[0].Media[0].ID = "changed.jpg"
	all[0].Room.Posts[0].Comments[0].Text = "Changed comment"
	all[0].Room.Posts[0].Reactions["fire"] = 2
	all[0].Room.IDs[0] = "changed"

	one, ok := d.Peer("other")
	if !ok {
		t.Fatal("peer disappeared")
	}
	if one.NowPlaying.Title != "Original track" || one.Links[0].Label != "Original link" ||
		one.Room.Roster[0].Name != "Original guest" || one.Room.Posts[0].Media[0].ID != "original.jpg" ||
		one.Room.Posts[0].Comments[0].Text != "Original comment" || one.Room.Posts[0].Reactions["fire"] != 1 ||
		one.Room.IDs[0] != "post" {
		t.Fatalf("Peers result mutated directory state: %#v", one)
	}

	one.Room.Posts[0].Media[0].ID = "changed-again.jpg"
	again, _ := d.Peer("other")
	if again.Room.Posts[0].Media[0].ID != "original.jpg" {
		t.Fatalf("Peer result mutated directory state: %#v", again.Room.Posts[0].Media)
	}
}

func TestMergePostsAppliesChangesAndRemovals(t *testing.T) {
	previous := []event.Post{{ID: "keep", Text: "old"}, {ID: "remove"}}
	changed := []event.Post{{ID: "keep", Text: "new"}, {ID: "add"}}
	got := mergePosts(previous, changed, []string{"keep", "add"})
	byID := make(map[string]event.Post, len(got))
	for _, post := range got {
		byID[post.ID] = post
	}
	if len(byID) != 2 || byID["keep"].Text != "new" || byID["add"].ID != "add" {
		t.Fatalf("merged posts = %#v", got)
	}
	if _, exists := byID["remove"]; exists {
		t.Fatalf("removed post survived: %#v", got)
	}
}

func serverURL(r *http.Request) string {
	return "https://" + r.Host
}
