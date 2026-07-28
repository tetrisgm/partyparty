package event

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCurrentTrackRotatesRecentAndPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}

	first, err := st.SetCurrentTrack("First Tune", "One Artist", "opener")
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.SetCurrentTrack("Second Tune", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if second.SetAt < first.SetAt {
		t.Fatalf("second setAt = %d, first = %d", second.SetAt, first.SetAt)
	}

	current, recent := st.TrackSnapshot()
	if current == nil || current.Title != "Second Tune" {
		t.Fatalf("current = %#v, want Second Tune", current)
	}
	if len(recent) != 1 || recent[0].Title != "First Tune" || recent[0].Artist != "One Artist" || recent[0].Note != "opener" {
		t.Fatalf("recent = %#v, want First Tune", recent)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	current, recent = reopened.TrackSnapshot()
	if current == nil || current.Title != "Second Tune" {
		t.Fatalf("reopened current = %#v, want Second Tune", current)
	}
	if len(recent) != 1 || recent[0].Title != "First Tune" {
		t.Fatalf("reopened recent = %#v, want First Tune", recent)
	}

	if err := reopened.ClearCurrentTrack(); err != nil {
		t.Fatal(err)
	}
	current, recent = reopened.TrackSnapshot()
	if current != nil {
		t.Fatalf("cleared current = %#v, want nil", current)
	}
	if len(recent) != 2 || recent[0].Title != "Second Tune" || recent[1].Title != "First Tune" {
		t.Fatalf("cleared recent = %#v, want Second then First", recent)
	}

	reopened, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	current, recent = reopened.TrackSnapshot()
	if current != nil {
		t.Fatalf("reopened cleared current = %#v, want nil", current)
	}
	if len(recent) != 2 || recent[0].Title != "Second Tune" || recent[1].Title != "First Tune" {
		t.Fatalf("reopened cleared recent = %#v, want Second then First", recent)
	}
	setlist, err := os.ReadFile(filepath.Join(reopened.Dir(), "data", "setlist.txt"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(setlist)
	if !strings.Contains(text, "One Artist - First Tune") || !strings.Contains(text, "Second Tune") {
		t.Fatalf("setlist.txt = %q", text)
	}
}

func TestRecognizedTrackDeduplicatesCatalogCallbacks(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := st.SetRecognizedTrack("shazam-1", "Song", "Artist", "https://example.com/art.jpg"); err != nil || !changed {
		t.Fatalf("first match changed=%v err=%v", changed, err)
	}
	if _, changed, err := st.SetRecognizedTrack("shazam-1", "Song", "Artist", "https://example.com/art.jpg"); err != nil || changed {
		t.Fatalf("duplicate match changed=%v err=%v", changed, err)
	}
	current, recent := st.TrackSnapshot()
	if current == nil || current.MatchID != "shazam-1" ||
		current.ArtworkURL != "https://example.com/art.jpg" || len(recent) != 0 {
		t.Fatalf("current=%#v recent=%#v", current, recent)
	}
}
