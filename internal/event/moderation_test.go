package event

import (
	"path/filepath"
	"testing"
	"time"
)

func TestReplayTreatsEmptyStateAsApproved(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.appendLine(line{Op: "post", CID: "cid-1", Post: &Post{
		ID: "p1", TS: now, Act: now, CID: "cid-1", Author: "Guest", Emoji: ":)", Text: "old post",
	}}); err != nil {
		t.Fatal(err)
	}
	if err := st.appendLine(line{Op: "comment", ID: "p1", CID: "cid-2", Comment: &Comment{
		ID: "c1", TS: now + 1, CID: "cid-2", Author: "Other", Emoji: ":D", Text: "old comment",
	}}); err != nil {
		t.Fatal(err)
	}

	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	posts, _, _ := reloaded.Feed(0)
	if len(posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(posts))
	}
	if posts[0].State != StateApproved {
		t.Fatalf("post state = %q, want approved", posts[0].State)
	}
	if len(posts[0].Comments) != 1 || posts[0].Comments[0].State != StateApproved {
		t.Fatalf("comments = %#v, want one approved comment", posts[0].Comments)
	}
}

func TestModerationStateOpsReplay(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	p, err := st.AddPost("cid-1", "Guest", ":)", "post", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	c, err := st.AddComment(p.ID, "cid-2", "Other", ":D", "comment", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPostState(p.ID, StateHidden); err != nil {
		t.Fatal(err)
	}
	if err := st.SetCommentState(p.ID, c.ID, StateHidden); err != nil {
		t.Fatal(err)
	}

	reloaded, err := Open(filepath.Dir(st.Dir()))
	if err != nil {
		t.Fatal(err)
	}
	posts, _, _ := reloaded.Feed(0)
	if len(posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(posts))
	}
	if posts[0].State != StateHidden {
		t.Fatalf("post state = %q, want hidden", posts[0].State)
	}
	if len(posts[0].Comments) != 1 || posts[0].Comments[0].State != StateHidden {
		t.Fatalf("comments = %#v, want hidden", posts[0].Comments)
	}
}

func TestDeleteCommentDropsOnReplay(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	p, err := st.AddPost("cid-1", "Guest", ":)", "post", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	c, err := st.AddComment(p.ID, "cid-2", "Other", ":D", "remove me", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteComment(p.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	posts, _, _ := st.Feed(0)
	if len(posts) != 1 || len(posts[0].Comments) != 0 {
		t.Fatalf("in-memory comments = %#v, want none", posts)
	}
	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	posts, _, _ = reloaded.Feed(0)
	if len(posts) != 1 || len(posts[0].Comments) != 0 {
		t.Fatalf("replayed comments = %#v, want none", posts)
	}
}
