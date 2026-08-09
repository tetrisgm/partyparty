package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"partyparty/internal/cloudsync"
	"partyparty/internal/event"
)

// PartyClient is the platform, as the console needs it: the canonical parties
// belonging to this account, created and edited through the same path the web
// uses. An interface so the server can be tested without a network, and so this
// package never learns how the platform is reached.
type PartyClient interface {
	Parties(ctx context.Context) ([]cloudsync.Party, bool, error)
	CreateParty(ctx context.Context, p cloudsync.NewParty) (cloudsync.Party, error)
	UpdateParty(ctx context.Context, key string, fields map[string]any) (cloudsync.Party, error)
}

func canonicalFrom(p cloudsync.Party) event.CanonicalParty {
	return event.CanonicalParty{
		Key: p.Key, Slug: p.Slug, Title: p.Title, URL: p.URL,
		Handle: p.Handle, StartsMs: p.StartsMs, Place: p.Place,
	}
}

// pushPartyEdit carries a local rename up to the canonical party this room is
// running, if it is running one. Everything about it is deliberately quiet:
//
//   - It returns immediately. The console saves the DJ's words locally first
//     and the platform is not allowed to make that wait, or fail it.
//   - No party attached, not signed in, no internet: nothing happens, and
//     nothing is said. Most parties are a Mac in a room.
//   - Only fields that actually changed are sent, so a save that touched the
//     place does not also rewrite a title somebody edited on the web.
func (s *srv) pushPartyEdit(title string, place *string) {
	if s.Parties == nil || s.Events == nil {
		return
	}
	current := s.Events.Canonical()
	if current.Key == "" {
		return
	}
	fields := map[string]any{}
	if title = strings.TrimSpace(title); title != "" && title != current.Title {
		fields["title"] = title
	}
	if place != nil && strings.TrimSpace(*place) != current.Place {
		fields["place"] = strings.TrimSpace(*place)
	}
	if len(fields) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		party, err := s.Parties.UpdateParty(ctx, current.Key, fields)
		if err != nil {
			log.Printf("party: could not carry the rename to the platform: %v", err)
			return
		}
		if err := s.Events.SetCanonical(canonicalFrom(party)); err != nil {
			log.Printf("party: %v", err)
		}
	}()
}

// handlePartyAPI is the Mac's party management: everything the web console can
// do to a party, done from the booth against the same record.
func (s *srv) handlePartyAPI(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/parties":
		// Everything on this account, so a party made on the web can be opened
		// here. The one this room is currently running is marked.
		if !s.requireDJ(w, r) {
			return true
		}
		if s.Parties == nil {
			writeJSON(w, http.StatusOK, map[string]any{"linked": false, "parties": []any{}})
			return true
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		list, linked, err := s.Parties.Parties(ctx)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return true
		}
		current := ""
		if s.Events != nil {
			current = s.Events.Canonical().Key
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"linked": linked, "parties": list, "current": current,
		})

	case "/api/party/create":
		// Create the canonical party FIRST, then point this room at it. A
		// broadcast never mints a record of its own.
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		// The same four fields the web's own form asks for, so "add a party"
		// means one thing with two front doors rather than two features that
		// resemble each other.
		var body struct {
			Title string `json:"title"`
			Place string `json:"place"`
			DJs   string `json:"djs"`
			// Milliseconds, as the console's date field resolves it. Zero means
			// no date yet, which is a real answer: a party you know about
			// before you know when.
			StartsMs int64 `json:"startsMs"`
			// Open true attaches this Mac's room to the new party. False makes
			// the party and leaves the room alone - creating one for Friday
			// while standing in Tuesday must not hijack tonight.
			Open bool `json:"open"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if s.Parties == nil || s.Events == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error": "this Mac is not signed in"})
			return true
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		// The room id goes up with the party when this one is being opened, so
		// the live session and the record are joined from the first moment.
		roomID := ""
		if body.Open {
			roomID = s.Events.Identity().ID
		}
		// A party being opened right now is starting now unless told otherwise;
		// one made for later carries the date that was typed, or none at all.
		startsMs := body.StartsMs
		if startsMs == 0 && body.Open {
			startsMs = time.Now().UnixMilli()
		}
		party, err := s.Parties.CreateParty(ctx, cloudsync.NewParty{
			Title: body.Title, Place: body.Place, DJs: body.DJs,
			StartsMs: startsMs, PartyID: roomID,
		})
		if err != nil {
			status := http.StatusBadGateway
			if cloudsync.NotSignedIn(err) {
				status = http.StatusForbidden
			}
			writeJSON(w, status, map[string]any{"error": err.Error()})
			return true
		}
		if body.Open {
			if err := s.Events.SetCanonical(canonicalFrom(party)); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return true
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "party": party, "opened": body.Open})

	case "/api/party/open":
		// Point this room at a party that already exists - the flow for one
		// made on the web. Attaching the room is an edit to that same record.
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			Key string `json:"key"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "which party?"})
			return true
		}
		if s.Parties == nil || s.Events == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error": "this Mac is not signed in"})
			return true
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		party, err := s.Parties.UpdateParty(ctx, body.Key, map[string]any{
			"partyId": s.Events.Identity().ID,
		})
		if err != nil {
			status := http.StatusBadGateway
			if cloudsync.NotSignedIn(err) {
				status = http.StatusForbidden
			}
			writeJSON(w, status, map[string]any{"error": err.Error()})
			return true
		}
		if err := s.Events.SetCanonical(canonicalFrom(party)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "party": party})

	case "/api/party/edit":
		// Editing from the booth writes to the same row the web edits. Only the
		// fields sent move.
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			Title *string `json:"title"`
			Place *string `json:"place"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if s.Parties == nil || s.Events == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error": "this Mac is not signed in"})
			return true
		}
		current := s.Events.Canonical()
		if current.Key == "" {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "this room is not running a party yet"})
			return true
		}
		fields := map[string]any{}
		if body.Title != nil {
			fields["title"] = *body.Title
		}
		if body.Place != nil {
			fields["place"] = *body.Place
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		party, err := s.Parties.UpdateParty(ctx, current.Key, fields)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return true
		}
		if err := s.Events.SetCanonical(canonicalFrom(party)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "party": party})

	default:
		return false
	}
	return true
}
