package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"partyparty/internal/cloudsync"
)

// ShazamImporter is the platform, as an import needs it: it knows which nights
// exist and which of them a dated match belongs to. An interface so this
// package never learns how the platform is reached, and so the seam can be
// tested without one.
type ShazamImporter interface {
	ImportShazam(ctx context.Context, items []cloudsync.ShazamItem, preview bool, create []string, places map[string]string) (cloudsync.ShazamImport, error)
}

// shazamShelf is the library snapshot, as the app last read it.
//
// The app is the only process that can read a Shazam library - the store lives
// outside the sandbox and the grant is a bookmark the app holds - so the
// direction is fixed: the app reads and pushes, and the console asks the
// server. `at` distinguishes "no library" from "nobody has looked yet", and
// `denied` from "you said no"; all three are different things to tell somebody
// waiting for a button to do something.
type shazamShelf struct {
	mu      sync.RWMutex
	items   []cloudsync.ShazamItem
	at      time.Time
	denied  bool
	places  map[string]string // night -> where it was, once the app has looked
	pending int               // venues still being looked up
}

func (s *shazamShelf) put(items []cloudsync.ShazamItem, denied bool,
	places map[string]string, pending int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = items
	s.at = time.Now()
	s.denied = denied
	s.places = places
	s.pending = pending
}

func (s *shazamShelf) get() ([]cloudsync.ShazamItem, time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.items, s.at
}

// refused reports that the DJ said no to the file panel, which is a different
// thing from an empty library and has to read differently.
func (s *shazamShelf) refused() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.denied
}

// where reports the venues found so far, and how many are still being looked
// up. The second number is why the console knows to ask again: a first import
// sends what it has immediately and finds the rest at one a second.
func (s *shazamShelf) where_() (map[string]string, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.places, s.pending
}

// handleShazam serves the three sides of the import: the app putting a library
// down, the console reading what is there, and the console asking for it to be
// filed into nights.
//
// All three are DJ-only. A library is a list of everywhere its owner has been,
// which is not a thing a guest on the party Wi-Fi may read.
func (s *srv) handleShazam(w http.ResponseWriter, r *http.Request, path string) {
	if !s.requireDJ(w, r) {
		return
	}
	switch path {
	case "/api/shazam/library":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		var body struct {
			Items         []cloudsync.ShazamItem `json:"items"`
			Denied        bool                   `json:"denied"`
			Places        map[string]string      `json:"places"`
			PlacesPending int                    `json:"placesPending"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad json"})
			return
		}
		s.shazam.put(body.Items, body.Denied, body.Places, body.PlacesPending)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(body.Items)})

	case "/api/shazam":
		items, at := s.shazam.get()
		places, pending := s.shazam.where_()
		out := map[string]any{
			"read":          !at.IsZero(),
			"count":         len(items),
			"available":     s.Shazam != nil,
			"denied":        s.shazam.refused(),
			"placed":        len(places),
			"placesPending": pending,
		}
		if !at.IsZero() {
			out["readMs"] = at.UnixMilli()
		}
		if len(items) > 0 {
			out["oldest"] = items[0].At
			out["newest"] = items[len(items)-1].At
		}
		writeJSON(w, http.StatusOK, out)

	case "/api/shazam/import":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		var body struct {
			Preview bool     `json:"preview"`
			Create  []string `json:"create"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		items, at := s.shazam.get()
		if at.IsZero() {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "library not read yet"})
			return
		}
		if s.Shazam == nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "not signed in"})
			return
		}
		if len(items) == 0 {
			writeJSON(w, http.StatusOK, cloudsync.ShazamImport{Nights: []cloudsync.ShazamNight{}})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		places, _ := s.shazam.where_()
		result, err := s.Shazam.ImportShazam(ctx, items, body.Preview, body.Create, places)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		if result.Nights == nil {
			result.Nights = []cloudsync.ShazamNight{}
		}
		if result.NewNights == nil {
			result.NewNights = []cloudsync.ShazamNewNight{}
		}
		writeJSON(w, http.StatusOK, result)

	default:
		http.NotFound(w, r)
	}
}
