package event

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type trackStateSnapshot struct {
	current *CurrentTrack
	recent  []CurrentTrack
	setlist []CurrentTrack
}

func snapshotTrackState(st *Store) trackStateSnapshot {
	current, recent := st.TrackSnapshot()
	return trackStateSnapshot{current: current, recent: recent, setlist: st.Setlist(0)}
}

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
	setlist, err := os.ReadFile(filepath.Join(reopened.Dir(), ".state", "setlist.txt"))
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

func TestDropTrackCommitsBeforeMutationAndReplaysExactly(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range [][2]string{
		{"First Tune", "One Artist"},
		{"Wrong Guess", "Bar Playlist"},
		{"Current Tune", "Three Artist"},
	} {
		if _, err := st.SetCurrentTrack(tr[0], tr[1], ""); err != nil {
			t.Fatal(err)
		}
	}

	beforeFailure := snapshotTrackState(st)
	journal := dataPath(st.Dir(), "posts.jsonl")
	savedJournal := journal + ".saved"
	if err := os.Rename(journal, savedJournal); err != nil {
		t.Fatal(err)
	}
	restored := false
	t.Cleanup(func() {
		if !restored {
			_ = os.Remove(journal)
			_ = os.Rename(savedJournal, journal)
		}
	})
	if err := os.Mkdir(journal, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := st.DropTrack("Wrong Guess", "Bar Playlist"); err == nil {
		t.Fatal("DropTrack succeeded with an unavailable journal")
	}
	if afterFailure := snapshotTrackState(st); !reflect.DeepEqual(afterFailure, beforeFailure) {
		t.Fatalf("failed drop changed live state:\n before = %#v\n after  = %#v", beforeFailure, afterFailure)
	}
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(savedJournal, journal); err != nil {
		t.Fatal(err)
	}
	restored = true

	if err := st.DropTrack("Wrong Guess", "Bar Playlist"); err != nil {
		t.Fatal(err)
	}
	if err := st.DropTrack("Current Tune", "Three Artist"); err != nil {
		t.Fatal(err)
	}
	want := trackStateSnapshot{
		recent:  []CurrentTrack{beforeFailure.recent[1]},
		setlist: []CurrentTrack{beforeFailure.setlist[0]},
	}
	if got := snapshotTrackState(st); !reflect.DeepEqual(got, want) {
		t.Fatalf("live state after drops = %#v, want %#v", got, want)
	}

	setlist, err := os.ReadFile(dataPath(st.Dir(), "setlist.txt"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(setlist)
	if !strings.Contains(text, "One Artist - First Tune") ||
		strings.Contains(text, "Wrong Guess") || strings.Contains(text, "Current Tune") {
		t.Fatalf("setlist.txt was not refreshed after drops: %q", text)
	}

	journalBeforeNoop, err := os.Stat(journal)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DropTrack("Never Played", "Nobody"); err != nil {
		t.Fatal(err)
	}
	journalAfterNoop, err := os.Stat(journal)
	if err != nil {
		t.Fatal(err)
	}
	if journalAfterNoop.Size() != journalBeforeNoop.Size() {
		t.Fatalf("no-op drop grew journal from %d to %d bytes", journalBeforeNoop.Size(), journalAfterNoop.Size())
	}

	reopened, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if got := snapshotTrackState(reopened); !reflect.DeepEqual(got, want) {
		t.Fatalf("replayed state = %#v, want live state %#v", got, want)
	}
}
