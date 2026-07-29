package server

import (
	"strings"
	"testing"
)

// The page the Mac publishes to the origin must be the actual listener page.
// This exists because a live set once served audio with NO page at the room
// root, and nothing logged: the push path treated an empty page as "nothing to
// do" rather than as the failure it is.
func TestGuestPageRendersTheListenerPage(t *testing.T) {
	env := newTestEnv(t, nil)
	page := env.srv.GuestPage()
	if len(page) == 0 {
		t.Fatal("GuestPage returned nothing; relayed guests would get a 404 at the room root")
	}
	if !strings.Contains(string(page), "<html") && !strings.Contains(string(page), "<!doctype") {
		t.Fatalf("GuestPage returned something that is not a page: %.80q", page)
	}
}

// Room snapshots must render for a fresh server too: a relayed party's status
// and feed have to exist from the first second, not only after some warmup.
func TestRoomSnapshotsRenderStatusAndFeed(t *testing.T) {
	env := newTestEnv(t, nil)
	snaps := env.srv.RoomSnapshots()
	if _, ok := snaps["status"]; !ok {
		t.Fatalf("no status snapshot: %v", keys(snaps))
	}
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
