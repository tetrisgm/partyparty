package server

import (
	"encoding/json"
	"log"
	"net/http"
)

// Track recognition runs in the APP process: ShazamKit authenticates by
// code-signing identity, and fm.partyparty.app is the one identity with a
// provisioning profile carrying the ShazamKit service. The capture helper's
// identity is not provisionable, so recognition there failed with error 202
// on every provisioned build (proven on TestFlight 255, 2026-08-05). The app
// posts results here; loopback is the DJ, the same trust model as /api/start.

type recognizedTrack struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	ArtworkURL string `json:"artworkUrl"`
	Silent     bool   `json:"silent"`
}

func (s *srv) handleTrackPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
		return
	}
	if !s.requireDJ(w, r) {
		return
	}
	if s.Events == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "no event store"})
		return
	}
	var track recognizedTrack
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&track); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad payload"})
		return
	}
	if track.Silent {
		if err := s.Events.ClearCurrentTrack(); err != nil {
			log.Printf("track recognition: clear failed: %v", err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	_, changed, err := s.Events.SetRecognizedTrack(track.ID, track.Title, track.Artist, track.ArtworkURL)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if changed {
		log.Printf("track recognition: %s - %s", track.Artist, track.Title)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
