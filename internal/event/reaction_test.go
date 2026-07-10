package event

import "testing"

func TestPostReactionsReplay(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	post, _, err := st.AddPost("guest-1", "Guest", "🎉", "hello", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddPostReaction(post.ID, "❤️"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddPostReaction(post.ID, "❤️"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddPostReaction(post.ID, "not-an-emoji"); err == nil {
		t.Fatal("invalid reaction was accepted")
	}

	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	posts, _, _ := reloaded.Feed(0)
	if len(posts) != 1 || posts[0].Reactions["❤️"] != 2 {
		t.Fatalf("replayed reactions = %#v", posts)
	}
}
