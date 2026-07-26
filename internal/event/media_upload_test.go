package event

import (
	"io"
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
