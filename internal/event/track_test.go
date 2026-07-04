package event

import "testing"

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
}
