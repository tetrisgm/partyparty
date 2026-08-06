package event

import (
	"os"
	"path/filepath"
	"testing"
)

// TestIdentitySurvivesEventRotation is the regression test for the day the DJ
// console came up blank: events rotate per calendar day, and everything stored
// only in an event's meta went with them.
func TestIdentitySurvivesEventRotation(t *testing.T) {
	base := t.TempDir()

	// Day one: a DJ sets up their identity.
	day1, err := openIn(base, "2026-08-05")
	if err != nil {
		t.Fatal(err)
	}
	name, bio := "DJ Luna", "House music and bright rooms."
	if err := day1.SetProfile(&name, &bio); err != nil {
		t.Fatal(err)
	}
	if err := day1.SetLinks([]Link{{Type: "instagram", URL: "https://instagram.com/luna"}}); err != nil {
		t.Fatal(err)
	}
	if err := day1.SetMeta("Sunset Rooftop", "", ""); err != nil {
		t.Fatal(err)
	}

	// Day two: a brand-new event folder, as midnight produces.
	day2, err := openIn(base, "2026-08-06")
	if err != nil {
		t.Fatal(err)
	}
	got := day2.Meta()
	if got.Host != "DJ Luna" {
		t.Fatalf("host did not survive rotation: %q", got.Host)
	}
	if got.Bio != "House music and bright rooms." {
		t.Fatalf("bio did not survive rotation: %q", got.Bio)
	}
	if len(got.Links) != 1 || got.Links[0].Type != "instagram" {
		t.Fatalf("links did not survive rotation: %#v", got.Links)
	}
	if got.Title != "Sunset Rooftop" {
		t.Fatalf("title did not survive rotation: %q", got.Title)
	}

	// A resumed event is never overwritten by the durable copy.
	other := "DJ Sol"
	if err := day2.SetProfile(&other, nil); err != nil {
		t.Fatal(err)
	}
	again, err := openIn(base, "2026-08-06")
	if err != nil {
		t.Fatal(err)
	}
	if again.Meta().Host != "DJ Sol" {
		t.Fatalf("reopening an event rewrote its host: %q", again.Meta().Host)
	}
}

// TestIdentityRecoveredFromPastEvent: the first launch after the fix must find
// the identity a DJ already set up, not start blank.
func TestIdentityRecoveredFromPastEvent(t *testing.T) {
	base := t.TempDir()
	old := filepath.Join(base, "2026-08-01", "data")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := `{"title":"Warehouse","host":"DJ Prior","bio":"Old bio","links":[{"label":"Instagram","url":"https://instagram.com/prior","type":"instagram"}]}`
	if err := os.WriteFile(filepath.Join(old, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(identityPath(base)); err == nil {
		t.Fatal("durable identity should not exist yet")
	}

	fresh, err := openIn(base, "2026-08-06")
	if err != nil {
		t.Fatal(err)
	}
	got := fresh.Meta()
	if got.Host != "DJ Prior" || got.Bio != "Old bio" || len(got.Links) != 1 {
		t.Fatalf("identity was not recovered from the past event: %#v", got)
	}
	if _, err := os.Stat(identityPath(base)); err != nil {
		t.Fatalf("recovery did not write the durable identity: %v", err)
	}
}

// openIn opens a specific dated event under base, the way Open does for today.
func openIn(base, day string) (*Store, error) {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, err
	}
	s := &Store{notify: make(chan struct{}), base: base}
	if err := s.use(filepath.Join(base, day)); err != nil {
		return nil, err
	}
	s.seedFromIdentity()
	return s, nil
}
