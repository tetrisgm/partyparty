package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"partyparty/internal/broadcast"
	"partyparty/internal/cloudsync"
	"partyparty/internal/config"
	"partyparty/internal/event"
	"partyparty/internal/stats"
)

type fakeImporter struct {
	got     []cloudsync.ShazamItem
	preview []bool
	created []string
	placed  map[string]string
	err     error
}

func (f *fakeImporter) ImportShazam(_ context.Context, items []cloudsync.ShazamItem, preview bool, create []string, places map[string]string) (cloudsync.ShazamImport, error) {
	f.created = create
	f.placed = places
	if f.err != nil {
		return cloudsync.ShazamImport{}, f.err
	}
	f.got = items
	f.preview = append(f.preview, preview)
	return cloudsync.ShazamImport{
		Nights: []cloudsync.ShazamNight{{
			Slug: "mutant-zoo", Handle: "shokunin", Title: "Mutant zoo",
			Day: "2026-08-08", Added: len(items),
		}},
		NewNights: []cloudsync.ShazamNewNight{{
			Day: "2025-07-19", Count: 84, Titles: []string{"Xtal - Aphex Twin"},
		}},
		NewNightTracks: 84,
		Matched:        len(items), Preview: preview,
	}, nil
}

func shazamSrv(t *testing.T, importer ShazamImporter) *Srv {
	t.Helper()
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{}
	return New(Deps{
		Config: cfg, Events: ev, Shazam: importer,
		Broadcaster: broadcast.New(cfg, t.TempDir(), "", ""),
		Listeners:   stats.New(15 * time.Second),
		Web:         fstest.MapFS{"dj.html": {Data: []byte("<html>dj</html>")}},
	})
}

func shazamPost(s *Srv, path, body string) *httptest.ResponseRecorder {
	return doBody(s, http.MethodPost, path, "127.0.0.1:1234", "application/json",
		bytes.NewBufferString(body))
}

func shazamState(t *testing.T, s *Srv, into any) {
	t.Helper()
	raw := do(s, http.MethodGet, "/api/shazam", "127.0.0.1:1234").Body.Bytes()
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("bad json %q: %v", raw, err)
	}
}

// The library arrives from the app, and the console reads it back. The two
// halves never meet directly: only the app can read a Shazam library, and only
// the console has a person looking at it.
func TestTheAppHandsOverTheLibraryAndTheConsoleSeesIt(t *testing.T) {
	s := shazamSrv(t, &fakeImporter{})

	// Before anything is read, the console must be able to tell the difference
	// between "your library is empty" and "nobody has looked yet". A button that
	// says "0 matches" when it has not asked is a lie.
	var before struct {
		Read bool `json:"read"`
	}
	shazamState(t, s, &before)
	if before.Read {
		t.Fatal("the server claims to have read a library nobody asked for")
	}

	w := shazamPost(s, "/api/shazam/library", `{"items":[
		{"title":"Xtal","artist":"Aphex Twin","at":1754600000000,"night":"2026-08-07"},
		{"title":"Ptolemy","artist":"Aphex Twin","at":1754700000000,"night":"2026-08-08"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("the app could not hand over its library: %d", w.Code)
	}

	var after struct {
		Read   bool  `json:"read"`
		Count  int   `json:"count"`
		Oldest int64 `json:"oldest"`
		Newest int64 `json:"newest"`
	}
	shazamState(t, s, &after)
	if !after.Read || after.Count != 2 {
		t.Fatalf("the console cannot see the library: %+v", after)
	}
	if after.Oldest != 1754600000000 || after.Newest != 1754700000000 {
		t.Fatalf("the span is wrong: %+v", after)
	}
}

// A preview must not write anything, and the thing the DJ then agrees to must
// be the same list they were shown - same items, only the flag differs.
func TestPreviewLooksWithoutTouching(t *testing.T) {
	importer := &fakeImporter{}
	s := shazamSrv(t, importer)
	shazamPost(s, "/api/shazam/library",
		`{"items":[{"title":"Tha","artist":"Aphex Twin","at":1,"night":"2026-08-08"}]}`)

	var preview cloudsync.ShazamImport
	if err := json.Unmarshal(
		shazamPost(s, "/api/shazam/import", `{"preview":true}`).Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.Preview || len(preview.Nights) != 1 || preview.Nights[0].Added != 1 {
		t.Fatalf("the preview did not describe the import: %+v", preview)
	}

	var real cloudsync.ShazamImport
	if err := json.Unmarshal(
		shazamPost(s, "/api/shazam/import", `{"preview":false}`).Body.Bytes(), &real); err != nil {
		t.Fatal(err)
	}
	if real.Preview {
		t.Fatal("the real import still says it was a preview")
	}
	if len(importer.preview) != 2 || !importer.preview[0] || importer.preview[1] {
		t.Fatalf("the platform was told the wrong thing: %v", importer.preview)
	}
	if len(importer.got) != 1 || importer.got[0].Night != "2026-08-08" {
		t.Fatalf("the night the app decided did not survive the trip: %+v", importer.got)
	}
}

// Importing before the app has read anything must not quietly succeed with
// nothing: an empty import that reports OK looks exactly like a working one.
func TestImportingBeforeTheLibraryIsReadSaysSo(t *testing.T) {
	s := shazamSrv(t, &fakeImporter{})
	if w := shazamPost(s, "/api/shazam/import", `{"preview":true}`); w.Code != http.StatusConflict {
		t.Fatalf("importing with no library = %d, want 409", w.Code)
	}
}

// A platform that is down is not a reason to lose the library, and not a reason
// to tell the DJ their import worked.
func TestAPlatformThatFailsIsReportedNotSwallowed(t *testing.T) {
	s := shazamSrv(t, &fakeImporter{err: errors.New("no")})
	shazamPost(s, "/api/shazam/library",
		`{"items":[{"title":"Actium","at":1,"night":"2026-08-08"}]}`)
	if w := shazamPost(s, "/api/shazam/import", `{"preview":false}`); w.Code != http.StatusBadGateway {
		t.Fatalf("a failed import = %d, want 502", w.Code)
	}
	var still struct {
		Count int `json:"count"`
	}
	shazamState(t, s, &still)
	if still.Count != 1 {
		t.Fatal("a failed import threw the library away")
	}
}

// Everything the platform says has to reach the console.
//
// This is a typed pipe, and a field nobody declared on the way through is not
// passed on - it is dropped in silence. That is exactly what happened to the
// nights with no party: the platform sent them, the struct in the middle had no
// field for them, and the console rendered "896 of these have nowhere to go"
// while the answer was sitting one hop upstream. Both ends looked right alone.
func TestNothingTheePlatformSaysIsLostInTheMiddle(t *testing.T) {
	importer := &fakeImporter{}
	s := shazamSrv(t, importer)
	shazamPost(s, "/api/shazam/library",
		`{"items":[{"title":"Tha","artist":"Aphex Twin","at":1,"night":"2025-07-19"}]}`)

	raw := shazamPost(s, "/api/shazam/import", `{"preview":true}`).Body.Bytes()
	var seen map[string]any
	if err := json.Unmarshal(raw, &seen); err != nil {
		t.Fatal(err)
	}
	nights, _ := seen["newNights"].([]any)
	if len(nights) != 1 {
		t.Fatalf("the nights with no party did not reach the console: %s", raw)
	}
	if seen["newNightTracks"] != float64(84) {
		t.Fatalf("their weight did not reach the console: %s", raw)
	}

	// And the days the DJ agreed to must arrive at the platform, or the button
	// makes nothing and says it made something.
	shazamPost(s, "/api/shazam/import", `{"preview":false,"create":["2025-07-19","2025-03-22"]}`)
	if len(importer.created) != 2 || importer.created[0] != "2025-07-19" {
		t.Fatalf("the platform was asked to make %v", importer.created)
	}
}
