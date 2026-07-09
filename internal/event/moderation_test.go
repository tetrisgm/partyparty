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
	p, _, err := st.AddPost("cid-1", "Guest", ":)", "post", nil, false)
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
	if err := st.SetCommentState(p.ID, c.ID, StatePending); err != nil {
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
	if len(posts[0].Comments) != 1 || posts[0].Comments[0].State != StatePending {
		t.Fatalf("comments = %#v, want one pending comment", posts[0].Comments)
	}
}

func TestPreApproveInitialState(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Meta().ModerationMode; got != ModerationPostModerate {
		t.Fatalf("default moderation mode = %q, want post_moderate", got)
	}
	p, _, err := st.AddPost("cid-1", "Guest", ":)", "approved now", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if p.State != StateApproved {
		t.Fatalf("default post state = %q, want approved", p.State)
	}
	if err := st.SetModerationMode(ModerationPreApprove); err != nil {
		t.Fatal(err)
	}
	p, _, err = st.AddPost("cid-2", "Guest", ":)", "needs review", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if p.State != StatePending {
		t.Fatalf("pre-approve post state = %q, want pending", p.State)
	}
	c, err := st.AddComment(p.ID, "cid-3", "Other", ":D", "needs review too", false)
	if err != nil {
		t.Fatal(err)
	}
	if c.State != StatePending {
		t.Fatalf("pre-approve comment state = %q, want pending", c.State)
	}
	djPost, _, err := st.AddPost("dj", "Ramine", "🎧", "host update", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if djPost.State != StateApproved {
		t.Fatalf("pre-approve DJ post state = %q, want approved", djPost.State)
	}
	djComment, err := st.AddComment(p.ID, "dj", "Ramine", "🎧", "host reply", true)
	if err != nil {
		t.Fatal(err)
	}
	if djComment.State != StateApproved {
		t.Fatalf("pre-approve DJ comment state = %q, want approved", djComment.State)
	}
}

func TestDeleteCommentDropsOnReplay(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	p, _, err := st.AddPost("cid-1", "Guest", ":)", "post", nil, false)
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
