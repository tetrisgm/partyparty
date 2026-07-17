package event

import (
	"testing"
	"time"
)

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

	added, err := st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet", 0)
	if err != nil || !added {
		t.Fatalf("first AddWebPost = (%v, %v), want (true, nil)", added, err)
	}
	// The same cloud post on the next beat is a no-op.
	added, err = st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet", 0)
	if err != nil || added {
		t.Fatalf("replayed AddWebPost = (%v, %v), want (false, nil)", added, err)
	}
	// Blank input never creates a post.
	if added, _ = st.AddWebPost("", "x", "", "text", 0); added {
		t.Fatal("empty webID must not add")
	}
	if added, _ = st.AddWebPost("web-def", "x", "", "   ", 0); added {
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
	added, err = st.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet", 0)
	if err != nil || added {
		t.Fatalf("post-reload AddWebPost on original store = (%v, %v), want (false, nil)", added, err)
	}
	if added, _ = reloaded.AddWebPost("web-abc123", "Web Wanda", "✨", "hi from the internet", 0); added {
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

func TestAddWebPostUsesArrivalForFeedCursor(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	local, _, err := st.AddPost("lan-guest", "Local", "", "newer LAN post", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	cloudTS := time.Now().Add(-time.Hour).UnixMilli()
	added, err := st.AddWebPost("cloud-post", "Remote", "", "older cloud post", cloudTS)
	if err != nil || !added {
		t.Fatalf("AddWebPost = (%v, %v), want (true, nil)", added, err)
	}

	posts, _, _ := st.Feed(local.Act)
	if len(posts) != 1 || posts[0].CID != "web:cloud-post" {
		t.Fatalf("feed after cursor %d = %#v, want newly arrived web post", local.Act, posts)
	}
	if posts[0].TS != cloudTS {
		t.Fatalf("web post TS = %d, want cloud creation time %d", posts[0].TS, cloudTS)
	}
	if posts[0].Act <= local.Act {
		t.Fatalf("web post Act = %d, must advance past feed cursor %d", posts[0].Act, local.Act)
	}
}
