package event

import "testing"

// The profile is one record with two editors - this console and the web - so
// every test here is really the same question: which of them saw it last.

func TestCloudProfileReadsWhatTheConsoleShows(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-07")
	if err != nil {
		t.Fatal(err)
	}
	name, bio := "DJ Luna", "House music and bright rooms."
	if err := store.SetProfile(&name, &bio); err != nil {
		t.Fatal(err)
	}
	if err := store.SetLinks([]Link{
		{Type: "instagram", URL: "https://instagram.com/luna"},
		{Type: "newsletter", URL: "https://luna.example/list"},
	}); err != nil {
		t.Fatal(err)
	}

	got := store.CloudProfile()
	if got.Name != "DJ Luna" || got.Bio != "House music and bright rooms." {
		t.Fatalf("name/bio: %+v", got)
	}
	if got.Links["instagram"] != "luna" { // stored as a URL, sent up as a name
		t.Fatalf("instagram: %+v", got.Links)
	}
	if _, ok := got.Links["newsletter"]; ok {
		t.Fatal("only the three the platform stores are sent up")
	}
}

func TestStampProfileAlwaysMovesForward(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-07")
	if err != nil {
		t.Fatal(err)
	}
	// Two edits inside one millisecond must still be ordered, or the second
	// looks stale to the platform and is silently discarded.
	first := store.StampProfile()
	second := store.StampProfile()
	if second <= first {
		t.Fatalf("stamp went backwards or stood still: %d then %d", first, second)
	}
	if store.CloudProfile().UpdatedMs != second {
		t.Fatalf("the stamp is not what a sync would read")
	}
}

func TestApplyCloudProfileTakesTheNewerCopyOnly(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-07")
	if err != nil {
		t.Fatal(err)
	}
	local, bio := "Set in the booth", "Local bio"
	if err := store.SetProfile(&local, &bio); err != nil {
		t.Fatal(err)
	}
	mine := store.StampProfile()

	// Older than what this Mac has: refused, and the handle still lands,
	// because the handle is the platform's to give and is never in dispute.
	changed, err := store.ApplyCloudProfile(CloudProfile{
		Handle: "lunaparty", Name: "Stale", UpdatedMs: mine - 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("the handle is new, so something did change")
	}
	if store.Meta().Host != "Set in the booth" {
		t.Fatalf("an older copy overwrote a newer one: %q", store.Meta().Host)
	}
	if store.CloudProfile().Handle != "lunaparty" {
		t.Fatal("the handle should have been recorded")
	}

	// Newer: taken.
	if _, err := store.ApplyCloudProfile(CloudProfile{
		Handle: "lunaparty", Name: "Set on the web", Bio: "Web bio",
		Links: map[string]string{"soundcloud": "lunasets"}, UpdatedMs: mine + 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if store.Meta().Host != "Set on the web" || store.Meta().Bio != "Web bio" {
		t.Fatalf("the newer copy was not taken: %+v", store.Meta())
	}
	if store.CloudProfile().Links["soundcloud"] != "lunasets" {
		t.Fatalf("links: %+v", store.CloudProfile().Links)
	}

	// And applying it a second time is a no-op rather than a fight.
	changed, err = store.ApplyCloudProfile(CloudProfile{
		Handle: "lunaparty", Name: "Set on the web", UpdatedMs: mine + 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("the same copy twice should settle, not keep changing")
	}
}

func TestCloudProfileSurvivesAnUnrelatedEdit(t *testing.T) {
	store, err := openIn(t.TempDir(), "2026-08-07")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyCloudProfile(CloudProfile{Handle: "lunaparty", UpdatedMs: 5000}); err != nil {
		t.Fatal(err)
	}
	// Renaming the party rewrites the identity file. If that dropped the handle
	// and the stamp, every local profile would look brand new and this Mac
	// would start overwriting the web on the next tick.
	if err := store.SetMeta("Sunset Rooftop", "", ""); err != nil {
		t.Fatal(err)
	}
	got := store.CloudProfile()
	if got.Handle != "lunaparty" || got.UpdatedMs != 5000 {
		t.Fatalf("a party rename lost the profile's identity: %+v", got)
	}
}

func TestMergeCloudLinksKeepsWhatThePlatformCannotHold(t *testing.T) {
	current := []Link{
		{Type: "instagram", URL: "old"},
		{Type: "newsletter", URL: "https://luna.example/list"},
	}
	merged := mergeCloudLinks(current, map[string]string{"instagram": "new", "website": "luna.example"})

	byType := map[string]string{}
	for _, link := range merged {
		byType[link.Type] = link.URL
	}
	if byType["instagram"] != "https://instagram.com/new" {
		t.Fatalf("the platform's value should win for a field it holds: %+v", byType)
	}
	if byType["newsletter"] != "https://luna.example/list" {
		t.Fatal("a link the platform has no field for must not be deleted on the way past")
	}
	if byType["website"] != "https://luna.example" {
		t.Fatalf("website: %+v", byType)
	}
}
