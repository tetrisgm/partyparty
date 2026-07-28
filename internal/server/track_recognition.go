package server

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"strings"
	"time"
)

const recognizedTrackMarker = "ppcapture: TRACK "

type recognizedTrack struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	ArtworkURL string `json:"artworkUrl"`
}

func parseRecognizedTrack(line string) (recognizedTrack, bool) {
	i := strings.Index(line, recognizedTrackMarker)
	if i < 0 {
		return recognizedTrack{}, false
	}
	encoded := strings.TrimSpace(line[i+len(recognizedTrackMarker):])
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return recognizedTrack{}, false
	}
	var track recognizedTrack
	if json.Unmarshal(data, &track) != nil || strings.TrimSpace(track.Title) == "" {
		return recognizedTrack{}, false
	}
	return track, true
}

func (s *srv) watchRecognizedTracks() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	seenLines := make(map[string]struct{})
	for range ticker.C {
		for _, line := range s.Broadcaster.Log() {
			if !strings.Contains(line, recognizedTrackMarker) {
				continue
			}
			if _, seen := seenLines[line]; seen {
				continue
			}
			seenLines[line] = struct{}{}
			track, ok := parseRecognizedTrack(line)
			if !ok {
				continue
			}
			_, changed, err := s.Events.SetRecognizedTrack(track.ID, track.Title, track.Artist, track.ArtworkURL)
			if err != nil {
				log.Printf("track recognition: save failed: %v", err)
				continue
			}
			if changed {
				log.Printf("track recognition: %s - %s", track.Artist, track.Title)
			}
		}
	}
}
