package server

import (
	"encoding/base64"
	"testing"
)

func TestParseRecognizedTrack(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte(`{"id":"123","title":"Song","artist":"Artist","artworkUrl":"https://example.com/art.jpg"}`))
	got, ok := parseRecognizedTrack("12:00:00  ppcapture: TRACK " + payload)
	if !ok || got.ID != "123" || got.Title != "Song" || got.Artist != "Artist" || got.ArtworkURL != "https://example.com/art.jpg" {
		t.Fatalf("parseRecognizedTrack = %#v, %v", got, ok)
	}
	if _, ok := parseRecognizedTrack("ppcapture: TRACK not-base64"); ok {
		t.Fatal("invalid payload parsed")
	}
}
