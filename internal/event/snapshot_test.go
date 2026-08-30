package event

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestSnapshotPostDeepCopiesMutableBacking(t *testing.T) {
	source := &Post{
		Media:     []Media{{ID: "photo.jpg", Thumb: "before-thumb"}},
		Comments:  []Comment{{ID: "comment", Text: "before-comment"}},
		Reactions: map[string]int{"fire": 1},
	}
	snapshot := snapshotPost(source)

	source.Media[0].Thumb = "source-thumb"
	source.Comments[0].Text = "source-comment"
	source.Reactions["fire"] = 2
	if snapshot.Media[0].Thumb != "before-thumb" || snapshot.Comments[0].Text != "before-comment" || snapshot.Reactions["fire"] != 1 {
		t.Fatalf("source mutation reached snapshot: %#v", snapshot)
	}

	snapshot.Media[0].Thumb = "snapshot-thumb"
	snapshot.Comments[0].Text = "snapshot-comment"
	snapshot.Reactions["fire"] = 3
	if source.Media[0].Thumb != "source-thumb" || source.Comments[0].Text != "source-comment" || source.Reactions["fire"] != 2 {
		t.Fatalf("snapshot mutation reached source: %#v", source)
	}
}

func TestFeedForReturnsIndependentPostSnapshots(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := &Post{
		ID: "post", TS: 1, Act: 1, State: StateApproved,
		Media:     []Media{{ID: "photo.jpg", Thumb: "stored-thumb"}},
		Comments:  []Comment{{ID: "comment", Text: "stored-comment", State: StateApproved}},
		Reactions: map[string]int{"fire": 1},
	}
	st.mu.Lock()
	st.posts = []*Post{p}
	st.byID = map[string]*Post{p.ID: p}
	st.mu.Unlock()

	posts, _, _, _ := st.FeedFor(0, "", true)
	if len(posts) != 1 {
		t.Fatalf("FeedFor returned %d posts, want 1", len(posts))
	}
	posts[0].Media[0].Thumb = "caller-thumb"
	posts[0].Comments[0].Text = "caller-comment"
	posts[0].Reactions["fire"] = 2

	again, _, _, _ := st.FeedFor(0, "", true)
	if again[0].Media[0].Thumb != "stored-thumb" || again[0].Comments[0].Text != "stored-comment" || again[0].Reactions["fire"] != 1 {
		t.Fatalf("caller mutation reached store: %#v", again[0])
	}
}

func TestFeedForCurrentCursorDoesNotCopyHistory(t *testing.T) {
	const postCount = 100
	measure := func(rich bool) float64 {
		store := &Store{posts: make([]*Post, 0, postCount), lastActivity: postCount}
		for i := int64(1); i <= postCount; i++ {
			post := &Post{ID: fmt.Sprintf("post-%d", i), TS: i, Act: i, State: StateApproved}
			if rich {
				post.Media = []Media{{ID: "photo.jpg"}}
				post.Comments = []Comment{{ID: "comment", State: StateApproved}}
				post.Reactions = map[string]int{"🔥": 1}
			}
			store.posts = append(store.posts, post)
		}
		return testing.AllocsPerRun(50, func() {
			posts, ids, _, cursor := store.FeedFor(postCount, "", true)
			if len(posts) != 0 || len(ids) != postCount || cursor != postCount {
				t.Fatalf("current feed = %d posts, %d ids, cursor %d", len(posts), len(ids), cursor)
			}
		})
	}

	lean, rich := measure(false), measure(true)
	// Compiler/runtime bookkeeping may move the absolute number. What matters
	// is that mutable history does not add one allocation per nested field.
	if rich > lean+1 {
		t.Fatalf("rich current-cursor feed allocated %.1f times versus lean %.1f; historical snapshots were copied", rich, lean)
	}
}

func TestAddPostReturnsIndependentSnapshot(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	media, err := st.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	post, err := st.AddPost("cid", "Guest", "🎉", "hello", []Media{media}, false)
	if err != nil {
		t.Fatal(err)
	}
	post.Media[0].Thumb = "caller-thumb"

	posts, _, _, _ := st.FeedFor(0, "", true)
	if got := posts[0].Media[0].Thumb; got != "" {
		t.Fatalf("AddPost result mutation reached store: Thumb = %q", got)
	}
}

func TestPostSnapshotsRemainRaceFreeDuringMutations(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	media, err := st.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	post, err := st.AddPost("cid", "Guest", "🎉", "hello", []Media{media}, false)
	if err != nil {
		t.Fatal(err)
	}
	comment, err := st.AddComment(post.ID, "other", "Other", "🪩", "nice", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddPostReaction(post.ID, "🔥"); err != nil {
		t.Fatal(err)
	}
	thumbPath, ok := st.thumbTargetPath(media.ID)
	if !ok {
		t.Fatal("thumbnail target was rejected")
	}
	if err := os.WriteFile(thumbPath, []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}

	stable, _, _, _ := st.FeedFor(0, "", true)
	if len(stable) != 1 {
		t.Fatalf("FeedFor returned %d posts, want 1", len(stable))
	}

	started := make(chan struct{})
	stop := make(chan struct{})
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		close(started)
		for {
			select {
			case <-stop:
				return
			default:
				_ = stable[0].Media[0].Thumb
				_ = stable[0].Comments[0].State
				_ = stable[0].Reactions["🔥"]
			}
		}
	}()
	go func() {
		defer readers.Done()
		for {
			select {
			case <-stop:
				return
			default:
				st.writeRecap()
			}
		}
	}()

	<-started
	if err := st.SetMediaThumb(media.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 40; i++ {
		state := StateApproved
		if i%2 == 0 {
			state = StateHidden
		}
		if err := st.SetCommentState(post.ID, comment.ID, state); err != nil {
			t.Fatal(err)
		}
		if err := st.AddPostReaction(post.ID, "🔥"); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	readers.Wait()

	if stable[0].Media[0].Thumb != "" || stable[0].Comments[0].State != StateApproved || stable[0].Reactions["🔥"] != 1 {
		t.Fatalf("in-flight snapshot changed during mutations: %#v", stable[0])
	}
}
