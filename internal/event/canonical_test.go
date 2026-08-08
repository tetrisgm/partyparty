package event

import "testing"

// The party is the permanent record on the platform; this Mac only remembers
// WHICH one its room is running. These cover that the pointer behaves like a
// pointer - and, most importantly, that ending a broadcast does not lose it.

func TestCanonicalPointsAtThePlatformParty(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-08")
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Canonical(); got.Key != "" {
		t.Fatalf("a fresh room points at nothing: %+v", got)
	}

	want := CanonicalParty{
		Key: "ev123", Slug: "warehouse-late", Title: "Warehouse, late",
		URL: "https://partyparty.party/@sundaze/warehouse-late", Handle: "sundaze",
		StartsMs: 1786000000000, Place: "Unit 7",
	}
	if err := store.SetCanonical(want); err != nil {
		t.Fatal(err)
	}
	got := store.Canonical()
	if got != want {
		t.Fatalf("pointer did not round-trip:\n got %+v\nwant %+v", got, want)
	}
	// The name the platform holds is the name the room shows, at once.
	if store.Meta().Title != "Warehouse, late" {
		t.Fatalf("the room still calls itself %q", store.Meta().Title)
	}
}

func TestCanonicalSurvivesEverythingAPartyDoes(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-08")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetCanonical(CanonicalParty{Key: "ev123", Slug: "s", Title: "Warehouse"}); err != nil {
		t.Fatal(err)
	}
	// The things that happen during and after a broadcast. None of them may
	// detach the room from its party: the record is what remains afterwards.
	host, bio := "DJ Luna", "bio"
	if err := store.SetProfile(&host, &bio); err != nil {
		t.Fatal(err)
	}
	if err := store.SetMeta("Renamed in the booth", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSchedule("2026-09-12", "21:00", "The Lido", ""); err != nil {
		t.Fatal(err)
	}
	if store.Canonical().Key != "ev123" {
		t.Fatal("the room forgot which party it is running")
	}
}

func TestClearCanonicalIsDeliberateAndIdempotent(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-08")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetCanonical(CanonicalParty{Key: "ev123", Title: "X"}); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearCanonical(); err != nil {
		t.Fatal(err)
	}
	if store.Canonical().Key != "" {
		t.Fatal("clear did not clear")
	}
	if err := store.ClearCanonical(); err != nil {
		t.Fatalf("clearing twice is not an error: %v", err)
	}
}
