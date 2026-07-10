package event

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRetentionDefaultKeepApproved(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Meta().RetentionMode; got != RetentionKeepApproved {
		t.Fatalf("retention mode = %q, want %q", got, RetentionKeepApproved)
	}
}

func TestCleanupTreatsLegacyPendingAsApprovedAndRemovesHiddenMedia(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	approvedMedia, err := st.SaveMedia("approved.jpg", strings.NewReader("approved"))
	if err != nil {
		t.Fatal(err)
	}
	pendingMedia, err := st.SaveMedia("pending.jpg", strings.NewReader("pending"))
	if err != nil {
		t.Fatal(err)
	}
	hiddenMedia, err := st.SaveMedia("hidden.jpg", strings.NewReader("hidden"))
	if err != nil {
		t.Fatal(err)
	}
	pendingThumb := filepath.Join(st.Dir(), "media", "thumbs", pendingMedia.ID+".jpg")
	if err := os.WriteFile(pendingThumb, []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	approved, _, err := st.AddPost("cid-a", "Guest", ":)", "", []Media{approvedMedia}, false)
	if err != nil {
		t.Fatal(err)
	}
	comment, err := st.AddComment(approved.ID, "cid-c", "Guest", ":)", "hide me", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetCommentState(approved.ID, comment.ID, StateHidden); err != nil {
		t.Fatal(err)
	}
	pending, _, err := st.AddPost("cid-p", "Guest", ":)", "", []Media{pendingMedia}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPostState(pending.ID, StatePending); err != nil {
		t.Fatal(err)
	}
	hidden, _, err := st.AddPost("cid-h", "Guest", ":)", "", []Media{hiddenMedia}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPostState(hidden.ID, StateHidden); err != nil {
		t.Fatal(err)
	}

	res, err := st.CleanupPendingHidden()
	if err != nil {
		t.Fatal(err)
	}
	if res.PostsRemoved != 1 || res.CommentsRemoved != 1 || res.MediaRemoved != 1 || res.ThumbsRemoved != 0 {
		t.Fatalf("cleanup result = %#v", res)
	}
	if _, ok := st.MediaPath(approvedMedia.ID); !ok {
		t.Fatal("approved media was removed")
	}
	if _, ok := st.MediaPath(pendingMedia.ID); !ok {
		t.Fatal("legacy pending media was removed")
	}
	if _, ok := st.MediaPath(hiddenMedia.ID); ok {
		t.Fatal("hidden media survived cleanup")
	}
	if _, err := os.Stat(pendingThumb); err != nil {
		t.Fatalf("legacy pending thumb was removed: %v", err)
	}
	posts, ids, mediaCount := st.Feed(0)
	if len(ids) != 2 || len(posts) != 2 || mediaCount != 2 {
		t.Fatalf("feed after cleanup posts=%v ids=%v media=%d, want approved and legacy pending", posts, ids, mediaCount)
	}
	if len(posts[0].Comments) != 0 {
		t.Fatalf("hidden comment survived cleanup: %#v", posts[0].Comments)
	}
}

func TestDeleteEventDataKeepsRecordingsAndStaysInsideEventDir(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := filepath.Join(st.Dir(), "recordings", "set-20060102-150405.aac")
	if err := os.WriteFile(rec, []byte("recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	media, err := st.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.AddPost("cid", "Guest", ":)", "", []Media{media}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "posts.jsonl")); err != nil {
		t.Fatal(err)
	}

	res, err := st.DeleteEventData(false)
	if err != nil {
		t.Fatal(err)
	}
	if res.PostsRemoved != 1 || res.MediaRemoved != 1 {
		t.Fatalf("delete result = %#v", res)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("outside file touched: %v", err)
	}
	if _, err := os.Stat(rec); err != nil {
		t.Fatalf("recording was not preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "posts.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("posts journal stat err = %v, want not exist", err)
	}
	if _, ok := st.MediaPath(media.ID); ok {
		t.Fatal("media survived event data delete")
	}
	_, ids, mediaCount := st.Feed(0)
	if len(ids) != 0 || mediaCount != 0 {
		t.Fatalf("feed after delete ids=%v media=%d, want empty", ids, mediaCount)
	}
}
