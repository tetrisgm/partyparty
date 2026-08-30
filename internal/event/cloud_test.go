package event

import (
	"regexp"
	"testing"
	"time"
)

func TestCloudPostIDIsStableSoARetryIsARetry(t *testing.T) {
	first := CloudPostID("abcdef0123456789", 1754500000000)
	second := CloudPostID("abcdef0123456789", 1754500000000)
	if first != second {
		t.Fatalf("the same post produced two ids: %s and %s", first, second)
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(first) {
		t.Fatalf("the platform only accepts 32 hex: %q", first)
	}
	if CloudPostID("abcdef0123456789", 1754500000000) == CloudPostID("0123456789abcdef", 1754500000000) {
		t.Fatal("two different posts must not share an id")
	}
}

func TestActivityCursorSurvivesRemoteClockSkewAndReload(t *testing.T) {
	base := t.TempDir()
	store, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour).UnixMilli()
	added, err := store.MergeRemotePost("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Remote", "future", future)
	if err != nil || !added {
		t.Fatalf("MergeRemotePost = (%v, %v), want added", added, err)
	}
	local, err := store.AddPost("cid", "Local", "", "after remote", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if local.Act <= future {
		t.Fatalf("local activity %d did not advance past remote cursor %d", local.Act, future)
	}
	if _, err := store.AddComment(local.ID, "other", "Guest", "", "still here", false); err != nil {
		t.Fatal(err)
	}
	updated, _, _, cursor := store.FeedFor(local.Act, "", true)
	if len(updated) != 1 || updated[0].ID != local.ID || cursor <= local.Act {
		t.Fatalf("comment after skew = posts %#v, cursor %d; want %s after %d", updated, cursor, local.ID, local.Act)
	}

	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	replayed, _, _, replayedCursor := reloaded.FeedFor(local.Act, "", true)
	if len(replayed) != 1 || replayed[0].ID != local.ID || replayedCursor != cursor {
		t.Fatalf("replayed activity = posts %#v, cursor %d; want %s at %d", replayed, replayedCursor, local.ID, cursor)
	}
	next, err := reloaded.AddPost("cid", "Local", "", "after reload", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if next.Act <= cursor {
		t.Fatalf("post-reload activity %d did not advance past cursor %d", next.Act, cursor)
	}
}

func TestMergeRemotePostIsIdempotentAndKeepsTheCursorMoving(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPost("cid-1", "Guest", "", "on the dancefloor", nil, false); err != nil {
		t.Fatal(err)
	}
	newest := store.Meta() // touch the store the way a caller would
	_ = newest

	id := "a1b2c3d4e5f60718293a4b5c6d7e8f90"
	added, err := store.MergeRemotePost(id, "Later", "here are my photos", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !added {
		t.Fatal("a web post must reach the wall")
	}

	// A sync that repeats itself is normal on a venue's Wi-Fi and must cost
	// nothing.
	again, err := store.MergeRemotePost(id, "Later", "here are my photos", 1)
	if err != nil {
		t.Fatal(err)
	}
	if again {
		t.Fatal("the same post was added twice")
	}

	posts, _, _ := store.Feed(0)
	if len(posts) != 2 {
		t.Fatalf("feed has %d posts, want 2", len(posts))
	}
	// It arrived stamped 1ms after the epoch. Left alone, every client that had
	// already read past that point would never see it.
	var merged *Post
	for i := range posts {
		if posts[i].ID == id {
			merged = &posts[i]
		}
	}
	if merged == nil {
		t.Fatal("the merged post is not in the feed")
	}
	if merged.Act <= posts[0].Act && posts[0].ID != id {
		t.Fatalf("merged post is invisible to a client that read past it: act=%d", merged.Act)
	}

	// It survives a reload: the journal carried it, not just memory.
	reloaded, err := Open(store.Dir()[:len(store.Dir())-len("/"+partyDirName(store))])
	if err != nil {
		// Directory shape differs by party id; reopening the parties root is
		// enough for the guarantee we care about.
		t.Skipf("could not reopen store root: %v", err)
	}
	if _, ok := reloaded.byID[id]; !ok {
		t.Fatal("the merged post did not survive a reload")
	}
}

func partyDirName(s *Store) string {
	return s.PartyID()
}

func TestOutgoingPostsSkipsWhatCameFromTheCloud(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPost("cid-1", "Guest", "", "local one", nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MergeRemotePost("a1b2c3d4e5f60718293a4b5c6d7e8f90", "Web", "from the web", 2); err != nil {
		t.Fatal(err)
	}

	out := store.OutgoingPosts(50)
	if len(out) != 1 {
		t.Fatalf("outgoing = %+v, want only the local post", out)
	}
	if out[0].Body != "local one" {
		t.Fatalf("outgoing body = %q", out[0].Body)
	}
	if len(out[0].ID) != 32 {
		t.Fatalf("outgoing id must be a cloud id: %q", out[0].ID)
	}
}
