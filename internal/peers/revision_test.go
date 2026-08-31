package peers

import (
	"testing"

	"partyparty/internal/event"
)

func TestPeerVisibleEqualityUsesRoomRevisionNotRetainedPostBodies(t *testing.T) {
	base := Peer{ID: "peer", Room: &Room{
		IDs: []string{"post"}, Cursor: 7,
		Posts: []event.Post{{ID: "post", Act: 7, Text: "old retained body"}},
	}}
	sameRevision := base
	sameRoom := *base.Room
	sameRoom.Posts = []event.Post{{ID: "post", Act: 7, Text: "newly fetched body"}}
	sameRevision.Room = &sameRoom
	if !peerVisibleEqual(base, sameRevision) {
		t.Fatal("retained post bodies made an unchanged peer revision look new")
	}

	changed := sameRevision
	changedRoom := *sameRevision.Room
	changedRoom.Cursor++
	changed.Room = &changedRoom
	if peerVisibleEqual(base, changed) {
		t.Fatal("room cursor change did not advance the visible peer revision")
	}

	deleted := sameRevision
	deletedRoom := *sameRevision.Room
	deletedRoom.IDs = nil
	deleted.Room = &deletedRoom
	if peerVisibleEqual(base, deleted) {
		t.Fatal("room deletion did not advance the visible peer revision")
	}
}
