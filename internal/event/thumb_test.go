package event

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestThumbWorkerProducesAndPersistsImageThumb(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a Unix shell stub for sips")
	}
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
# Real sips/ffmpeg infer the output format from the filename extension; a bare
# ".tmp" makes them fail. Mirror that so a regression to a non-.jpg temp path
# (which silently killed every video thumbnail) fails this test.
case "$out" in
	*.jpg) printf thumb > "$out" ;;
	*) echo "cannot infer output format from $out" >&2; exit 1 ;;
esac
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
	if _, err := st.AddPost("cid", "guest", ":)", "", []Media{m}, false); err != nil {
		t.Fatal(err)
	}
	src, ok := st.MediaPath(m.ID)
	if !ok {
		t.Fatal("media path missing")
	}
	if !st.EnqueueThumb(m.ID, src, m.Type) {
		t.Fatal("thumb job was not queued")
	}

	// Wait on the POINTER, not on the file.
	//
	// runThumbWorker writes the thumbnail and only then calls SetMediaThumb, and
	// that order is deliberate: a feed entry pointing at a file that does not
	// exist yet would show every guest a broken image. It does mean ThumbPath
	// succeeds slightly before the feed carries the pointer, so waiting on the
	// file and asserting on the feed is a race in the test. It failed under
	// -race, where the window is wider, while passing without it.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		posts, _, _ := st.Feed(0)
		if len(posts) == 1 && len(posts[0].Media) == 1 && posts[0].Media[0].Thumb != "" {
			if got, want := posts[0].Media[0].Thumb, "/media/thumb/"+m.ID; got != want {
				t.Fatalf("Media.Thumb = %q, want %q", got, want)
			}
			// The file the pointer names must already be there. This is the half
			// of the ordering that would actually hurt a guest.
			p, ok := st.ThumbPath(m.ID)
			if !ok {
				t.Fatal("the feed points at a thumbnail that does not exist")
			}
			if filepath.Base(p) != m.ID+".jpg" {
				t.Fatalf("thumb path = %q, want <id>.jpg", p)
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
	if _, err := st.AddPost("cid", "guest", ":)", "", []Media{m}, false); err != nil {
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
