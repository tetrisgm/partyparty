package event

import "testing"

func TestFeedHidesLegacyStreamStatusPosts(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPost("dj", "DJ", "🎧", "Started the stream.", nil, true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPost("dj", "DJ", "🎧", "A real DJ message", nil, true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPost("guest", "Guest", "🎉", "Stopped the stream.", nil, false); err != nil {
		t.Fatal(err)
	}

	posts, ids, _, _ := store.FeedFor(0, "", false)
	if len(posts) != 2 || len(ids) != 2 {
		t.Fatalf("visible feed = %#v, ids = %#v; want only user-authored posts", posts, ids)
	}
	if posts[0].Text != "A real DJ message" || posts[1].Text != "Stopped the stream." {
		t.Fatalf("visible posts = %#v", posts)
	}
}
