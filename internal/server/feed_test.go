package server

import (
	"bytes"
	"net/http"
	"testing"

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/event"
	"partyparty/internal/peers"
)

// replacingFeedSource models event.Store's close-and-replace notification.
// Its feed read performs a mutation in the exact gap that used to exist
// between FeedFor and Wait, without depending on goroutine scheduling.
type replacingFeedSource struct {
	current chan struct{}
}

func (s *replacingFeedSource) Wait() <-chan struct{} {
	return s.current
}

func (s *replacingFeedSource) FeedFor(int64, string, bool) ([]event.Post, []string, int, int64) {
	close(s.current)
	s.current = make(chan struct{})
	return nil, nil, 0, 0
}

func TestWatchedFeedCannotLoseMutationBetweenSnapshotAndPark(t *testing.T) {
	source := &replacingFeedSource{current: make(chan struct{})}
	_, _, _, _, changed := watchedFeed(source, 0, "guest", false, nil)
	select {
	case <-changed:
		// The snapshot raced a mutation, so the request must not park.
	default:
		t.Fatal("feed mutation was lost; long-poll would wait on the replacement channel")
	}
}

func TestWatchedFeedIncludesKnownPeerBeforePark(t *testing.T) {
	source := &replacingFeedSource{current: make(chan struct{})}
	peerPost := event.Post{ID: "remote-post", TS: 11, Act: 12}
	posts, _, _, cursor, _ := watchedFeed(source, 10, "guest", false, []peers.Peer{{
		ID: "other-dj", Room: &peers.Room{Posts: []event.Post{peerPost}, Cursor: peerPost.Act},
	}})
	if len(posts) != 1 || posts[0].ID != "other-dj~remote-post" || cursor != peerPost.Act {
		t.Fatalf("watched feed = posts %#v, cursor %d; known peer update would be parked", posts, cursor)
	}
}

// The night's record has to reach the page that shows it.
//
// The setlist was recorded from the first day and never surfaced: the store
// kept it, no accessor exposed it, and the console had a leftover .trackcard
// CSS rule and no markup. A DJ finished a set and the page said nothing about
// what they had played.
func TestTheSetlistReachesTheConsole(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev, Broadcaster: broadcast.New(config.Config{}, t.TempDir(), "", "")})

	for _, tr := range []struct{ title, artist string }{
		{"Windowlicker", "Aphex Twin"},
		{"Xtal", "Aphex Twin"},
		{"Ptolemy", "Aphex Twin"},
	} {
		if _, err := ev.SetCurrentTrack(tr.title, tr.artist, ""); err != nil {
			t.Fatal(err)
		}
	}

	body := decodeJSON(t, do(s, http.MethodGet, "/api/feed?since=0", "127.0.0.1:1234"))
	set, _ := body["setlist"].([]any)
	if len(set) != 3 {
		t.Fatalf("the console was sent %d tracks, want the whole set of 3: %v", len(set), body["setlist"])
	}
	// Oldest first: a set list read top to bottom is the night in order.
	first, _ := set[0].(map[string]any)
	last, _ := set[len(set)-1].(map[string]any)
	if first["title"] != "Windowlicker" || last["title"] != "Ptolemy" {
		t.Fatalf("the set is out of order: %v", set)
	}
	// The track under the needle counts - otherwise the list lags the room by
	// one song for the whole night.
	if now, _ := body["nowPlaying"].(map[string]any); now == nil || now["title"] != "Ptolemy" {
		t.Fatalf("now playing did not survive: %v", body["nowPlaying"])
	}

	// A guest is not shown the DJ's record.
	guest := decodeJSON(t, do(s, http.MethodGet, "/api/feed?since=0", "192.168.1.44:5555"))
	if _, ok := guest["setlist"]; ok {
		t.Fatal("the setlist was served to a guest")
	}
}

// Recognition guesses, so the DJ can take a song off the record.
//
// The setlist is REPLAYED from the journal, so a removal that only edits
// memory comes back on the next launch. This asserts it survives a reopen -
// which is the whole reason the drop is a journal line and not a slice edit.
func TestATrackCanBeTakenOffTheRecord(t *testing.T) {
	dir := t.TempDir()
	ev, err := event.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev, Broadcaster: broadcast.New(config.Config{}, t.TempDir(), "", "")})

	for _, tr := range [][2]string{
		{"Windowlicker", "Aphex Twin"},
		{"Sports Bar Playlist", "Nobody"},
		{"Xtal", "Aphex Twin"},
	} {
		if _, err := ev.SetCurrentTrack(tr[0], tr[1], ""); err != nil {
			t.Fatal(err)
		}
	}

	out := decodeJSON(t, doBody(s, http.MethodPost, "/api/track/drop", "127.0.0.1:1234",
		"application/json", bytes.NewBufferString(`{"title":"Sports Bar Playlist","artist":"Nobody"}`)))
	got, _ := out["setlist"].([]any)
	if len(got) != 2 {
		t.Fatalf("the reply still carries %d tracks: %v", len(got), out["setlist"])
	}

	// It has to survive the journal being replayed, or it returns on relaunch.
	again, err := event.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, tr := range again.Setlist(0) {
		titles = append(titles, tr.Title)
	}
	if len(titles) != 2 || titles[0] != "Windowlicker" || titles[1] != "Xtal" {
		t.Fatalf("after a reopen the set is %v - the drop did not persist", titles)
	}

	// And a guest cannot edit the DJ's account of their own set.
	if w := doBody(s, http.MethodPost, "/api/track/drop", "192.168.1.44:5555",
		"application/json", bytes.NewBufferString(`{"title":"Xtal","artist":"Aphex Twin"}`)); w.Code == http.StatusOK {
		t.Fatal("a guest removed a track from the setlist")
	}
}
