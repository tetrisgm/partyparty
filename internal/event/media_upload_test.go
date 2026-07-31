package event

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestSaveMediaPublishesCompletedUpload(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	type result struct {
		media Media
		err   error
	}
	done := make(chan result, 1)
	go func() {
		media, err := st.SaveMedia("clip.mp4", reader)
		done <- result{media: media, err: err}
	}()

	if _, err := writer.Write([]byte("partial upload")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.media.Size != int64(len("partial upload")) {
		t.Fatalf("saved size = %d", got.media.Size)
	}
	if _, ok := st.MediaPath(got.media.ID); !ok {
		t.Fatalf("completed media %q is unavailable", got.media.ID)
	}
}

func TestImportRelayPhotoPreservesIssuedID(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	media, err := st.ImportMedia("0123456789abcdef.jpg", "party.jpg", strings.NewReader("jpeg"))
	if err != nil {
		t.Fatal(err)
	}
	if media.ID != "0123456789abcdef.jpg" || media.Type != "image" {
		t.Fatalf("imported media = %+v", media)
	}
	path, ok := st.MediaPath(media.ID)
	if !ok {
		t.Fatal("imported photo is unavailable")
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "jpeg" {
		t.Fatalf("imported bytes = %q err=%v", body, err)
	}
	if _, err := st.ImportMedia("../escape.jpg", "bad.jpg", strings.NewReader("x")); err == nil {
		t.Fatal("accepted an unsafe relay media id")
	}
	if _, err := st.ImportMedia("0123456789abcdef.mp4", "bad.mp4", strings.NewReader("x")); err == nil {
		t.Fatal("accepted a relay video")
	}
}
