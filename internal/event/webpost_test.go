package event

import "testing"

// Web posts (off-LAN guests on the cloud event page) join the room feed once
// per cloud id — the check-in replays the same posts every 30s beat, so the
// dedupe must hold in memory AND across a store reload (CID rides the journal).
// NoPublish keeps the after-set mirror from echoing them back to the cloud.
func TestAddWebPostDedupesAndNeverRepublishes(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}

	added, err := st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet")
	if err != nil || !added {
		t.Fatalf("first AddWebPost = (%v, %v), want (true, nil)", added, err)
	}
	// The same cloud post on the next beat is a no-op.
	added, err = st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet")
	if err != nil || added {
		t.Fatalf("replayed AddWebPost = (%v, %v), want (false, nil)", added, err)
	}
	// Blank input never creates a post.
	if added, _ = st.AddWebPost("", "x", "", "text"); added {
		t.Fatal("empty webID must not add")
	}
	if added, _ = st.AddWebPost("web-def", "x", "", "   "); added {
		t.Fatal("empty text must not add")
	}

	posts, _, _ := st.Feed(0)
	if len(posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(posts))
	}
	p := posts[0]
	if p.Author != "Web Wanda" || p.Text != "hi from the internet" {
		t.Fatalf("post content = %q/%q", p.Author, p.Text)
	}
	if !p.NoPublish {
		t.Fatal("web post must be NoPublish (never echoed back to the cloud)")
	}

	// Reload from the journal: dedupe must survive a restart mid-party.
	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	added, err = st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet")
	if err != nil || added {
		t.Fatalf("post-reload AddWebPost on original store = (%v, %v), want (false, nil)", added, err)
	}
	if added, _ = reloaded.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet"); added {
		t.Fatal("reloaded store re-added an already-journaled web post")
	}
	rposts, _, _ := reloaded.Feed(0)
	if len(rposts) != 1 {
		t.Fatalf("reloaded posts = %d, want 1", len(rposts))
	}
	if !rposts[0].NoPublish {
		t.Fatal("NoPublish must survive the journal round-trip")
	}
}
