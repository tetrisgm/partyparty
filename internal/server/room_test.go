package server

import (
	"reflect"
	"testing"

	"partyparty/internal/event"
	"partyparty/internal/peers"
)

func TestMergeRoomFeedQualifiesOwnersAndMedia(t *testing.T) {
	remote := event.Post{
		ID: "post-1", TS: 20, Act: 21, Author: "Seth",
		Media: []event.Media{{ID: "photo one.jpg", Thumb: "/media/thumb/photo%20one.jpg"}},
	}
	posts, ids, media, cursor := mergeRoomFeed(
		[]event.Post{{ID: "local", TS: 10, Act: 10}},
		[]string{"local"}, 0, 10, 0,
		[]peers.Peer{{
			ID: "seth", RoomURL: "https://seth.party:8443",
			Room: &peers.Room{Posts: []event.Post{remote}, Cursor: 21},
		}},
	)
	if len(posts) != 2 || posts[1].ID != "seth~post-1" {
		t.Fatalf("merged posts = %#v", posts)
	}
	if len(ids) != 2 || ids[1] != "seth~post-1" || media != 1 || cursor != 21 {
		t.Fatalf("merged metadata ids=%v media=%d cursor=%d", ids, media, cursor)
	}
	if got := posts[1].Media[0].URL; got != "https://seth.party:8443/media/photo%20one.jpg" {
		t.Fatalf("remote media URL = %q", got)
	}
	if got := posts[1].Media[0].Thumb; got != "https://seth.party:8443/media/thumb/photo%20one.jpg" {
		t.Fatalf("remote thumb URL = %q", got)
	}
	peerID, postID, remotePost := splitRoomPostID(posts[1].ID)
	if !remotePost || peerID != "seth" || postID != "post-1" {
		t.Fatalf("owner routing = %q/%q/%v", peerID, postID, remotePost)
	}
}

func TestMergeRoomFeedRepeatedlyProducesExactMediaURLs(t *testing.T) {
	roomPeers := []peers.Peer{{
		ID:      "seth",
		RoomURL: "https://seth.party:8443",
		Room: &peers.Room{Posts: []event.Post{{
			ID: "post-1", TS: 20, Act: 21,
			Media: []event.Media{{
				ID:    "photo one.jpg",
				Thumb: "/media/thumb/photo%20one.jpg",
			}},
		}}},
	}}

	first, _, _, _ := mergeRoomFeed(nil, nil, 0, 0, 0, roomPeers)
	second, _, _, _ := mergeRoomFeed(nil, nil, 0, 0, 0, roomPeers)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("repeated merges differ:\nfirst:  %#v\nsecond: %#v", first, second)
	}
	media := second[0].Media[0]
	if media.URL != "https://seth.party:8443/media/photo%20one.jpg" ||
		media.Thumb != "https://seth.party:8443/media/thumb/photo%20one.jpg" {
		t.Fatalf("repeated merge media URLs = %#v", media)
	}
}

func TestMergeRoomFeedHonorsCursor(t *testing.T) {
	posts, _, _, cursor := mergeRoomFeed(nil, nil, 0, 100, 100, []peers.Peer{{
		ID: "seth",
		Room: &peers.Room{
			Posts:  []event.Post{{ID: "old", Act: 99}, {ID: "new", Act: 101}},
			Cursor: 101,
		},
	}})
	if len(posts) != 1 || posts[0].ID != "seth~new" || cursor != 101 {
		t.Fatalf("incremental merge posts=%#v cursor=%d", posts, cursor)
	}
}
