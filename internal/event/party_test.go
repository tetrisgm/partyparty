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

func TestPartyIDGrammar(t *testing.T) {
	for _, now := range []time.Time{
		time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, time.August, 30, 23, 59, 0, 0, time.FixedZone("PDT", -7*60*60)),
	} {
		id := newPartyID(now)
		if !validPartyID(id) {
			t.Errorf("generated party id %q was rejected", id)
		}
	}

	tests := []struct {
		name string
		id   string
		want bool
	}{
		{name: "valid", id: "2026-08-06-2213-ab12", want: true},
		{name: "parent traversal", id: "../2026-08-06-2213-ab12"},
		{name: "absolute", id: "/tmp/2026-08-06-2213-ab12"},
		{name: "slash separator", id: "2026-08-06/2213-ab12"},
		{name: "backslash separator", id: `2026-08-06\2213-ab12`},
		{name: "unicode division slash", id: "2026-08-06∕2213-ab12"},
		{name: "unicode fullwidth digits", id: "２０２６-08-06-2213-ab12"},
		{name: "malformed date", id: "2026-02-30-2213-ab12"},
		{name: "malformed time", id: "2026-08-06-2460-ab12"},
		{name: "uppercase hex", id: "2026-08-06-2213-AB12"},
		{name: "missing suffix", id: "2026-08-06-2213"},
		{name: "overlong", id: "2026-08-06-2213-ab12-extra"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validPartyID(tt.id); got != tt.want {
				t.Fatalf("validPartyID(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestJoinPartyRejectsInvalidIDsBeforeUsingAPath(t *testing.T) {
	invalid := []string{
		"../outside",
		"/tmp/2026-08-06-2213-ab12",
		"2026-08-06/2213-ab12",
		`2026-08-06\2213-ab12`,
		"2026-08-06∕2213-ab12",
		"2026-02-30-2213-ab12",
		"2026-08-06-2213-ab12-extra",
	}
	for _, id := range invalid {
		t.Run(id, func(t *testing.T) {
			base := t.TempDir()
			st, err := Open(base)
			if err != nil {
				t.Fatal(err)
			}
			before := st.PartyID()
			joined, err := st.JoinParty(PartyIdentity{ID: id, Name: "Untrusted peer"})
			if err == nil {
				t.Fatalf("JoinParty(%q) did not reject the invalid id", id)
			}
			if joined || st.PartyID() != before {
				t.Fatalf("invalid join changed party: joined=%v id=%q, want %q", joined, st.PartyID(), before)
			}
		})
	}
}

func TestCurrentPartyRejectsInvalidIDBeforeUsingAPath(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "parties")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	writeCurrentForTest(t, base, currentParty{ID: "../outside", LastSeen: time.Now().UnixMilli()})

	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if !validPartyID(st.PartyID()) {
		t.Fatalf("Open selected invalid party id %q", st.PartyID())
	}
	if st.Dir() == outside {
		t.Fatal("Open escaped the parties root through current.json")
	}
}

func TestPartyPathRejectsSymlinkedChild(t *testing.T) {
	base := t.TempDir()
	id := "2026-08-06-2213-ab12"
	if err := os.Symlink(t.TempDir(), filepath.Join(base, id)); err != nil {
		t.Fatal(err)
	}
	if _, err := partyPath(base, id); err == nil {
		t.Fatal("partyPath accepted a child that resolves through a symlink")
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

// TestJoiningAPartyAdoptsItsIdentity: a second DJ going live joins the party
// already happening - same id, same name, same link handed to guests - while
// keeping their own name and photo.
func TestJoiningAPartyAdoptsItsIdentity(t *testing.T) {
	base := t.TempDir()
	guest, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	me := "DJ Two"
	if err := guest.SetProfile(&me, nil); err != nil {
		t.Fatal(err)
	}
	host := PartyIdentity{
		ID: "2026-08-06-2213-aaaa", Name: "Shoku @ home",
		Cover: "/covers/warehouse.webp", Join: "https://happy-dance.partyparty.party/",
	}
	joined, err := guest.JoinParty(host)
	if err != nil || !joined {
		t.Fatalf("JoinParty = %v, %v", joined, err)
	}
	if guest.PartyID() != host.ID {
		t.Fatalf("party id = %q, want %q", guest.PartyID(), host.ID)
	}
	got := guest.Meta()
	if got.Title != host.Name || got.Cover != host.Cover {
		t.Fatalf("party presentation not adopted: %#v", got)
	}
	if got.Host != "DJ Two" {
		t.Fatalf("the joiner lost their own DJ name: %q", got.Host)
	}
	id := guest.Identity()
	if id.Join != host.Join || id.Host {
		t.Fatalf("joiner identity = %#v, want the host's link and Host=false", id)
	}
	// A joiner must never republish its own machine link as the party's.
	guest.SetJoinURL("https://my-own-mac.party.partyparty.party:8443/")
	if guest.Identity().Join != host.Join {
		t.Fatal("a joiner overwrote the party's link")
	}
}

// TestAPartyWithAWallIsNeverAbandoned: joining is for a Mac that has not
// started anything, never a way to strand posts already on the wall.
func TestAPartyWithAWallIsNeverAbandoned(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddPost("cid", "Neon Fox", "🦊", "already here", nil, false); err != nil {
		t.Fatal(err)
	}
	mine := st.PartyID()
	joined, err := st.JoinParty(PartyIdentity{ID: "2026-08-06-2213-bbbb", Name: "Someone else"})
	if err != nil {
		t.Fatal(err)
	}
	if joined || st.PartyID() != mine {
		t.Fatalf("a party with posts was abandoned: joined=%v id=%q", joined, st.PartyID())
	}
}
