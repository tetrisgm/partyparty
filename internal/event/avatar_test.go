package event

import (
	"bytes"
	"image"
	"image/jpeg"
	"strings"
	"testing"
)

// A truncated progressive JPEG keeps a plausible header and only fails on a
// complete decode. One got published once - an upload raced a process quit -
// and every surface showed a broken glyph. Publishing now requires a full
// decode.
func TestSaveAvatarRejectsTruncatedImages(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 24, 24)), nil); err != nil {
		t.Fatal(err)
	}
	whole := buf.Bytes()

	if _, err := st.SaveAvatar("photo.jpg", bytes.NewReader(whole)); err != nil {
		t.Fatalf("intact jpeg rejected: %v", err)
	}
	if _, err := st.SaveAvatar("photo.jpg", bytes.NewReader(whole[:len(whole)/2])); err == nil {
		t.Fatal("truncated jpeg was published")
	} else if !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("truncated jpeg error = %v, want the damaged-image message", err)
	}
	// A WebP whose RIFF envelope declares more bytes than the file holds is the
	// same failure in different clothes.
	bad := append([]byte("RIFF"), 0xFF, 0xFF, 0x00, 0x00)
	bad = append(bad, []byte("WEBP")...)
	bad = append(bad, make([]byte, 32)...)
	if _, err := st.SaveAvatar("photo.webp", bytes.NewReader(bad)); err == nil {
		t.Fatal("truncated webp was published")
	}
	// The failed saves must not have clobbered the good photo.
	if _, ok := st.AvatarPath(); !ok {
		t.Fatal("valid avatar lost after rejected uploads")
	}
}
