package event

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThumbWorkerProducesAndPersistsImageThumb(t *testing.T) {
	dir := t.TempDir()
	sips := filepath.Join(dir, "sips")
	if err := os.WriteFile(sips, []byte(`#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
	if [ "$1" = "--out" ]; then
		shift
		out="$1"
	fi
	shift
done
printf thumb > "$out"
`), 0o755); err != nil {
		t.Fatal(err)
	}
	oldLookPath := thumbLookPath
	thumbLookPath = func(name string) (string, error) {
		if name == "sips" {
			return sips, nil
		}
		return "", errors.New("not found")
	}
	t.Cleanup(func() { thumbLookPath = oldLookPath })

	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.StartThumbWorker("ffmpeg")
	m, err := st.SaveMedia("photo.jpg", strings.NewReader("image bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.AddPost("cid", "guest", ":)", "", []Media{m}, false); err != nil {
		t.Fatal(err)
	}
	src, ok := st.MediaPath(m.ID)
	if !ok {
		t.Fatal("media path missing")
	}
	if !st.EnqueueThumb(m.ID, src, m.Type) {
		t.Fatal("thumb job was not queued")
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if p, ok := st.ThumbPath(m.ID); ok {
			if filepath.Base(p) != m.ID+".jpg" {
				t.Fatalf("thumb path = %q, want <id>.jpg", p)
			}
			posts, _, _ := st.Feed(0)
			if len(posts) != 1 || len(posts[0].Media) != 1 {
				t.Fatalf("feed posts = %#v", posts)
			}
			if got, want := posts[0].Media[0].Thumb, "/media/thumb/"+m.ID; got != want {
				t.Fatalf("Media.Thumb = %q, want %q", got, want)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("thumbnail was not produced")
}

func TestThumbPathsRejectTraversal(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "../x.jpg", "nested/x.jpg", ".hidden"} {
		if p, ok := st.thumbTargetPath(id); ok {
			t.Fatalf("thumbTargetPath(%q) = %q, true; want rejected", id, p)
		}
		if p, ok := st.ThumbPath(id); ok {
			t.Fatalf("ThumbPath(%q) = %q, true; want rejected", id, p)
		}
	}
}

func TestThumbWorkerSkipsWhenToolMissing(t *testing.T) {
	oldLookPath := thumbLookPath
	thumbLookPath = func(string) (string, error) { return "", errors.New("not found") }
	t.Cleanup(func() { thumbLookPath = oldLookPath })

	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.StartThumbWorker("ffmpeg")
	m, err := st.SaveMedia("photo.jpg", strings.NewReader("image bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.AddPost("cid", "guest", ":)", "", []Media{m}, false); err != nil {
		t.Fatal(err)
	}
	src, _ := st.MediaPath(m.ID)
	if !st.EnqueueThumb(m.ID, src, m.Type) {
		t.Fatal("thumb job was not queued")
	}
	time.Sleep(100 * time.Millisecond)
	if p, ok := st.ThumbPath(m.ID); ok {
		t.Fatalf("ThumbPath = %q, true; want no thumb without encoder", p)
	}
	posts, _, _ := st.Feed(0)
	if got := posts[0].Media[0].Thumb; got != "" {
		t.Fatalf("Media.Thumb = %q, want empty", got)
	}
}
