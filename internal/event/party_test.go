package event

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPartyResumesInsteadOfRotatingAtMidnight is the regression test for the
// morning the console came up blank: storage rotated on the launch date, so a
// set that crossed midnight split and a relaunch started over.
func TestPartyResumesInsteadOfRotatingAtMidnight(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddPost("cid", "Neon Fox", "🦊", "first", nil, false); err != nil {
		t.Fatal(err)
	}
	first := st.PartyID()

	again, err := Open(base) // a relaunch, minutes later
	if err != nil {
		t.Fatal(err)
	}
	if again.PartyID() != first {
		t.Fatalf("relaunch started a new party: %q then %q", first, again.PartyID())
	}
	if posts, _, _ := again.Feed(0); len(posts) != 1 {
		t.Fatalf("resumed party lost its wall: %d posts", len(posts))
	}

	// Tomorrow, past the idle window: a new night is its own party.
	writeCurrent(base, first)
	stale := currentParty{ID: first, LastSeen: time.Now().Add(-9 * time.Hour).UnixMilli()}
	writeCurrentForTest(t, base, stale)
	next, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if next.PartyID() == first {
		t.Fatal("an idle party was resumed as if it were still tonight")
	}
	if posts, _, _ := next.Feed(0); len(posts) != 0 {
		t.Fatal("a new party inherited the previous wall")
	}
}

// TestEmptyPartyIsReusedNotLittered: opening and closing the app must not leave
// a trail of empty folders.
func TestEmptyPartyIsReusedNotLittered(t *testing.T) {
	base := t.TempDir()
	for i := 0; i < 3; i++ {
		if _, err := Open(base); err != nil {
			t.Fatal(err)
		}
	}
	if got := PastParties(base); len(got) != 1 {
		t.Fatalf("three launches left %d parties: %v", len(got), got)
	}
}

// TestPartyFolderHoldsOnlyKeepsakes: a DJ opening the folder should find the
// night's uploads and one page, not our journals.
func TestPartyFolderHoldsOnlyKeepsakes(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	media, err := st.SaveMedia("sunset.jpg", strings.NewReader("not really a jpeg"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddPost("cid", "Neon Fox", "🦊", "look at this", []Media{media}, false); err != nil {
		t.Fatal(err)
	}
	st.writeRecap()

	entries, err := os.ReadDir(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	var visible []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			visible = append(visible, e.Name())
		}
	}
	if len(visible) != 2 {
		t.Fatalf("party folder shows %v, want just the upload and %s", visible, recapFile)
	}
	page, err := os.ReadFile(filepath.Join(st.Dir(), recapFile))
	if err != nil {
		t.Fatalf("no recap page: %v", err)
	}
	for _, want := range []string{"look at this", "Neon Fox", media.ID} {
		if !strings.Contains(string(page), want) {
			t.Fatalf("recap page is missing %q", want)
		}
	}
	// Neither the machinery nor the recap is reachable through the media route.
	for _, id := range []string{recapFile, ".state", ".state/meta.json", "../secrets"} {
		if _, ok := st.MediaPath(id); ok {
			t.Fatalf("media route served %q", id)
		}
	}
	// The journal is present but hidden.
	if _, err := os.Stat(dataPath(st.Dir(), "posts.jsonl")); err != nil {
		t.Fatalf("journal is not in .state: %v", err)
	}
}

// TestMigrationCarriesOldEventsForward: yesterday's parties must still exist,
// in the new shape, with nothing thrown away.
func TestMigrationCarriesOldEventsForward(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "parties")
	old := filepath.Join(root, "events", "2026-08-01")
	for _, sub := range []string{"data", "media", filepath.Join("media", "thumbs"), "recordings"} {
		if err := os.MkdirAll(filepath.Join(old, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(old, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join("data", "meta.json"), `{"title":"Old Party","host":"DJ Prior"}`)
	write(filepath.Join("data", "posts.jsonl"), `{"op":"post","post":{"id":"p1","ts":1,"author":"Guest","text":"hi"}}`)
	write(filepath.Join("media", "photo.jpg"), "bytes")
	write(filepath.Join("media", "thumbs", "photo.jpg.jpg"), "thumb")
	write(filepath.Join("recordings", "set-1.aac"), "audio")

	if _, err := Open(base); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(base, "2026-08-01")
	for path, why := range map[string]string{
		filepath.Join(moved, "photo.jpg"):                             "guest upload at the party's top level",
		filepath.Join(moved, ".state", "meta.json"):                   "meta in .state",
		filepath.Join(moved, ".state", "posts.jsonl"):                 "journal in .state",
		filepath.Join(moved, ".state", "thumbs", "photo.jpg.jpg"):     "thumbnail in .state",
		filepath.Join(moved, ".state", "old-recordings", "set-1.aac"): "old recording kept, just out of sight",
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s: %v", why, err)
		}
	}
}

func writeCurrentForTest(t *testing.T, base string, c currentParty) {
	t.Helper()
	data := []byte(`{"id":"` + c.ID + `","lastSeenAt":` + itoa(c.LastSeen) + `}`)
	if err := os.WriteFile(currentPath(base), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
