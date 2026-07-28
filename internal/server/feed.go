package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"partyparty/internal/event"
	"partyparty/internal/peers"
)

// The event feed: guests post text + photos/videos from the player page; the
// DJ sees, posts to, and moderates the same feed from the console. Guests are
// pseudonymous (fun name + emoji chosen client-side); their private cid stays
// server-side so the Mac can associate activity within the current room.

// isDJ: the console is the app's own WKWebView on localhost — loopback is the
// DJ, everyone else on the LAN is a guest. Same trust model as /api/shutdown.
func (s *srv) isDJ(r *http.Request) bool {
	ip := clientIP(r)
	return ip == "127.0.0.1" || ip == "::1" || ip == "1"
}

func (s *srv) requireDJ(w http.ResponseWriter, r *http.Request) bool {
	if s.isDJ(r) {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
	return false
}

func (s *srv) featureOn(name string) bool {
	if s.Events == nil {
		return true
	}
	features := s.Events.Meta().Features
	if on, ok := features[name]; ok {
		return on
	}
	return true
}

func writeFeatureDisabled(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "the DJ turned this off", "disabled": true})
}

func mediaHasVideo(media []event.Media) bool {
	for _, m := range media {
		if m.Type == "video" {
			return true
		}
		switch strings.ToLower(filepath.Ext(m.ID)) {
		case ".mp4", ".mov", ".m4v", ".webm":
			return true
		}
	}
	return false
}

func uploadLooksLikeVideo(name, contentType string) bool {
	if strings.HasPrefix(strings.ToLower(contentType), "video/") {
		return true
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".mov", ".m4v", ".webm":
		return true
	default:
		return false
	}
}

func (s *srv) handleFeedAPI(w http.ResponseWriter, r *http.Request) bool {
	if s.Events == nil {
		return false
	}
	switch r.URL.Path {
	case "/api/feed":
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		dj := s.isDJ(r) && r.URL.Query().Get("guest") != "1"
		posts, ids, mediaCount, cursor := s.Events.FeedFor(since, r.URL.Query().Get("cid"), dj)
		// Long-poll (wait=1): nothing new → park until the next mutation (or
		// ~25s heartbeat), then answer. Posts and comments land on every open
		// page within a network round-trip instead of a polling interval.
		if len(posts) == 0 && cursor <= since && r.URL.Query().Get("wait") == "1" {
			wait := 25 * time.Second
			if len(s.roomPeers()) > 0 {
				wait = 2 * time.Second
			}
			select {
			case <-s.Events.Wait():
			case <-time.After(wait):
			case <-r.Context().Done():
				return true
			}
			posts, ids, mediaCount, cursor = s.Events.FeedFor(since, r.URL.Query().Get("cid"), dj)
		}
		if posts == nil {
			posts = []event.Post{}
		}
		posts, ids, mediaCount, cursor = mergeRoomFeed(posts, ids, mediaCount, cursor, since, s.roomPeers())
		photos, videos, audio := s.Events.MediaTypeCounts(r.URL.Query().Get("cid"), dj)
		meta := s.Events.Meta()
		reactions, spikes := s.Events.ReactionSnapshot()
		body := map[string]any{
			"title": meta.Title, "host": meta.Host, "starts": meta.Starts,
			"date": meta.Date, "time": meta.Time, "place": meta.Place, "cover": meta.Cover,
			"features":  meta.Features,
			"reactions": reactions, "spikes": spikes,
			// dir = the current room identity; clients reset their cursor when a
			// fresh room is created.
			"dir":   filepath.Base(s.Events.Dir()),
			"posts": posts, "ids": ids, "total": len(ids), "media": mediaCount,
			"photos": photos, "videos": videos, "audio": audio, "cursor": cursor, "dj": dj,
		}
		current, recent := s.Events.TrackSnapshot()
		body["nowPlaying"] = feedTrackFrom(current)
		body["recentTracks"] = feedTracksFrom(recent)
		if dj && s.featureOn("trackId") {
			body["trackAsks"] = s.Events.TrackAskCount()
		}
		if dj {
			body["links"] = meta.Links
		} else if len(meta.Links) > 0 {
			body["links"] = meta.Links
		}
		writeJSON(w, http.StatusOK, body)
	case "/api/reactions":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		if !s.featureOn("reactions") {
			writeFeatureDisabled(w)
			return true
		}
		var body struct{ CID, Type string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		body.Type = strings.TrimSpace(body.Type)
		if !event.ValidReactionType(body.Type) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown reaction"})
			return true
		}
		if !s.limits.allow(guestLimitKey(body.CID, r), "reaction") {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many reactions", "retry": true})
			return true
		}
		if err := s.Events.AddReaction(body.Type); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		w.WriteHeader(http.StatusNoContent)
	case "/api/post-reaction":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		var body struct {
			CID      string `json:"cid"`
			Post     string `json:"post"`
			Reaction string `json:"reaction"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if peerID, postID, remote := splitRoomPostID(body.Post); remote {
			body.Post = postID
			s.proxyRoomWrite(w, r, peerID, body)
			return true
		}
		if !s.isDJ(r) && !s.limits.allow(guestLimitKey(body.CID, r), "reaction") {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many reactions", "retry": true})
			return true
		}
		if err := s.Events.AddPostReaction(strings.TrimSpace(body.Post), strings.TrimSpace(body.Reaction)); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/requests":
		switch r.Method {
		case http.MethodGet:
			if !s.isDJ(r) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
				return true
			}
			writeJSON(w, http.StatusOK, map[string]any{"requests": s.Events.ListRequests()})
		case http.MethodPost:
			if !s.featureOn("requests") {
				writeFeatureDisabled(w)
				return true
			}
			dj := s.isDJ(r)
			var body struct {
				CID  string `json:"cid"`
				Text string `json:"text"`
				Note string `json:"note"`
				Vibe string `json:"vibe"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
				return true
			}
			body.Vibe = strings.TrimSpace(body.Vibe)
			if !event.ValidRequestVibe(body.Vibe) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown vibe"})
				return true
			}
			if !dj && !s.limits.allow(guestLimitKey(body.CID, r), "request") {
				writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — requests are sparse", "retry": true})
				return true
			}
			if _, err := s.Events.AddRequest(body.CID, body.Text, body.Note, body.Vibe); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "GET or POST required"})
		}
	case "/api/requests/state":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.SetRequestState(r.URL.Query().Get("id"), r.URL.Query().Get("state")); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/track/current":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			Title  string `json:"title"`
			Artist string `json:"artist"`
			Note   string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		tr, err := s.Events.SetCurrentTrack(body.Title, body.Artist, body.Note)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		_, recent := s.Events.TrackSnapshot()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "nowPlaying": tr, "recentTracks": recent})
	case "/api/track/clear":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.ClearCurrentTrack(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		_, recent := s.Events.TrackSnapshot()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "recentTracks": recent})
	case "/api/track-id-request":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		if !s.featureOn("trackId") {
			writeFeatureDisabled(w)
			return true
		}
		var body struct {
			CID string `json:"cid"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if !s.limits.allow(guestLimitKey(body.CID, r), "track-id") {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many track asks", "retry": true})
			return true
		}
		s.Events.AddTrackAsk()
		w.WriteHeader(http.StatusNoContent)
	case "/api/comment":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		dj := s.isDJ(r)
		if !dj && !s.featureOn("wallMode") {
			writeFeatureDisabled(w)
			return true
		}
		if !dj && !s.featureOn("comments") {
			writeFeatureDisabled(w)
			return true
		}
		var body struct{ Post, CID, Author, Emoji, Text string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if peerID, postID, remote := splitRoomPostID(body.Post); remote {
			body.Post = postID
			s.proxyRoomWrite(w, r, peerID, body)
			return true
		}
		if !dj && !s.limits.allow(guestLimitKey(body.CID, r), "comment") {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many comments", "retry": true})
			return true
		}
		c, err := s.Events.AddComment(body.Post, body.CID, body.Author, body.Emoji, body.Text, dj)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": c.ID})
	case "/api/event-config":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			Title, Host, Starts string
			Date                *string `json:"date"`
			Time                *string `json:"time"`
			Place               *string `json:"place"`
			Cover               *string `json:"cover"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetMeta(body.Title, body.Host, body.Starts); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		if body.Date != nil || body.Time != nil || body.Place != nil {
			meta := s.Events.Meta()
			date, clock, place := meta.Date, meta.Time, meta.Place
			if body.Date != nil {
				date = *body.Date
			}
			if body.Time != nil {
				clock = *body.Time
			}
			if body.Place != nil {
				place = *body.Place
			}
			if err := s.Events.SetSchedule(date, clock, place, body.Starts); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
		}
		if body.Cover != nil {
			if err := s.Events.SetCover(*body.Cover); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
		}
		meta := s.Events.Meta()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "date": meta.Date, "time": meta.Time, "place": meta.Place, "cover": meta.Cover,
		})
	case "/api/event-features":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.SetFeature(r.URL.Query().Get("name"), r.URL.Query().Get("on") != "0"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "features": s.Events.Meta().Features})
	case "/api/event-links":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			Links []event.Link `json:"links"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetLinks(body.Links); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "links": s.Events.Meta().Links})
	case "/api/post":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		var body struct {
			CID    string        `json:"cid"`
			Author string        `json:"author"`
			Emoji  string        `json:"emoji"`
			Text   string        `json:"text"`
			Media  []event.Media `json:"media"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		dj := s.isDJ(r)
		if !dj {
			if !s.featureOn("wallMode") {
				writeFeatureDisabled(w)
				return true
			}
			if strings.TrimSpace(body.Text) != "" && !s.featureOn("comments") {
				writeFeatureDisabled(w)
				return true
			}
			if len(body.Media) > 0 && !s.featureOn("uploads") {
				writeFeatureDisabled(w)
				return true
			}
			if mediaHasVideo(body.Media) && !s.featureOn("videoUploads") {
				writeFeatureDisabled(w)
				return true
			}
		}
		if !dj && !s.limits.allow(guestLimitKey(body.CID, r), "post") {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many posts", "retry": true})
			return true
		}
		p, err := s.Events.AddPost(body.CID, body.Author, body.Emoji, body.Text, body.Media, dj)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": p.ID})
	case "/api/upload":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		dj := s.isDJ(r)
		if !dj && !s.featureOn("wallMode") {
			writeFeatureDisabled(w)
			return true
		}
		if !dj && !s.featureOn("uploads") {
			writeFeatureDisabled(w)
			return true
		}
		// Current guest clients send the original File as the request body. This
		// avoids browser-side transcoding or multipart buffering and lets large
		// videos stream directly to disk. Keep multipart for older clients and
		// the DJ console.
		if encodedName := strings.TrimSpace(r.Header.Get("X-PP-Name")); encodedName != "" {
			name, err := url.QueryUnescape(encodedName)
			if err != nil || strings.TrimSpace(name) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid file name"})
				return true
			}
			if !dj && uploadLooksLikeVideo(name, r.Header.Get("Content-Type")) && !s.featureOn("videoUploads") {
				writeFeatureDisabled(w)
				return true
			}
			m, err := s.Events.SaveMedia(name, r.Body)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
			if p, ok := s.Events.MediaPath(m.ID); ok {
				s.Events.EnqueueThumb(m.ID, p, m.Type)
			}
			writeJSON(w, http.StatusOK, m)
			return true
		}
		mr, err := r.MultipartReader()
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		part, err := nextUploadedFile(mr)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		defer part.Close()
		if !dj && uploadLooksLikeVideo(part.FileName(), part.Header.Get("Content-Type")) && !s.featureOn("videoUploads") {
			writeFeatureDisabled(w)
			return true
		}
		m, err := s.Events.SaveMedia(part.FileName(), part)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		if p, ok := s.Events.MediaPath(m.ID); ok {
			s.Events.EnqueueThumb(m.ID, p, m.Type)
		}
		writeJSON(w, http.StatusOK, m)
	case "/api/guest-profile":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		var body struct{ CID, Name, Emoji string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetGuestProfile(body.CID, body.Name, body.Emoji); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/event-cover-local":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		if !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		r.Body = http.MaxBytesReader(w, r.Body, event.MaxCoverBytes+(1<<20))
		f, hdr, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		defer f.Close()
		if _, err := s.Events.SaveCover(hdr.Filename, f); err != nil {
			status := http.StatusBadRequest
			if strings.Contains(err.Error(), "too large") {
				status = http.StatusRequestEntityTooLarge
			}
			writeJSON(w, status, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cover": "/event-cover"})
	case "/api/post-delete":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.Delete(r.URL.Query().Get("id")); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/mod":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		id, commentID, state := r.URL.Query().Get("id"), r.URL.Query().Get("commentId"), r.URL.Query().Get("state")
		var err error
		if commentID == "" {
			err = s.Events.SetPostState(id, state)
		} else {
			err = s.Events.SetCommentState(id, commentID, state)
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/comment-delete":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct {
			PostID    string `json:"postID"`
			CommentID string `json:"commentID"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.DeleteComment(body.PostID, body.CommentID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/netcheck":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"checks": runNetChecks(s.netCheckOptions())})
	case "/api/open-logs":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if s.Diag == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no session log"})
			return true
		}
		if runtime.GOOS == "darwin" {
			_ = exec.Command("open", filepath.Dir(s.Diag.Path())).Start()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": s.Diag.Path()})
	case "/api/open-media":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if runtime.GOOS == "darwin" {
			_ = exec.Command("open", s.Events.Dir()).Start()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dir": s.Events.Dir()})
	default:
		return false
	}
	return true
}

func nextUploadedFile(mr *multipart.Reader) (*multipart.Part, error) {
	for {
		part, err := mr.NextPart()
		if err != nil {
			return nil, err
		}
		if part.FormName() == "file" && part.FileName() != "" {
			return part, nil
		}
		_ = part.Close()
	}
}

// eventState summarizes the feed for /api/status (console header + badges).
func (s *srv) eventState() map[string]any {
	if s.Events == nil {
		return nil
	}
	_, ids, mediaCount := s.Events.Feed(1 << 62) // counts only, no post bodies
	photos, videos, audio := s.Events.MediaTypeCounts("", true)
	meta := s.Events.Meta()
	body := map[string]any{
		"title":    meta.Title,
		"host":     meta.Host,
		"starts":   meta.Starts,
		"date":     meta.Date,
		"time":     meta.Time,
		"place":    meta.Place,
		"cover":    meta.Cover,
		"features": meta.Features,
		"posts":    len(ids),
		"media":    mediaCount,
		"photos":   photos,
		"videos":   videos,
		"audio":    audio,
		"dir":      s.Events.Dir(),
	}
	if len(meta.Links) > 0 {
		body["links"] = meta.Links
	}
	return body
}

type feedTrack struct {
	Title      string `json:"title"`
	Artist     string `json:"artist,omitempty"`
	ArtworkURL string `json:"artworkUrl,omitempty"`
	SetAt      int64  `json:"setAt"`
}

func feedTrackFrom(tr *event.CurrentTrack) *feedTrack {
	if tr == nil || tr.Title == "" {
		return nil
	}
	return &feedTrack{Title: tr.Title, Artist: tr.Artist, ArtworkURL: tr.ArtworkURL, SetAt: tr.SetAt}
}

func feedTracksFrom(tracks []event.CurrentTrack) []feedTrack {
	out := make([]feedTrack, 0, len(tracks))
	for _, tr := range tracks {
		if tr.Title == "" {
			continue
		}
		out = append(out, feedTrack{Title: tr.Title, Artist: tr.Artist, ArtworkURL: tr.ArtworkURL, SetAt: tr.SetAt})
	}
	if out == nil {
		out = []feedTrack{}
	}
	return out
}

// handleMedia serves uploaded files (inline, cacheable — ids are immutable).
func (s *srv) handleMedia(w http.ResponseWriter, r *http.Request) {
	if s.Events == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/media/thumb/") {
		id := strings.TrimPrefix(r.URL.Path, "/media/thumb/")
		p, ok := s.Events.ThumbPath(id)
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, p)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/media/")
	p, ok := s.Events.MediaPath(id)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

const roomPostSeparator = "~"

func roomPostID(peerID, postID string) string {
	return peerID + roomPostSeparator + postID
}

func splitRoomPostID(id string) (peerID, postID string, remote bool) {
	peerID, postID, remote = strings.Cut(id, roomPostSeparator)
	return
}

func mergeRoomFeed(local []event.Post, ids []string, mediaCount int, cursor, since int64, roomPeers []peers.Peer) ([]event.Post, []string, int, int64) {
	posts := append([]event.Post(nil), local...)
	allIDs := append([]string(nil), ids...)
	for _, peer := range roomPeers {
		if peer.Room == nil {
			continue
		}
		if peer.Room.Cursor > cursor {
			cursor = peer.Room.Cursor
		}
		for _, remote := range peer.Room.Posts {
			allIDs = append(allIDs, roomPostID(peer.ID, remote.ID))
			if remote.Act <= since {
				continue
			}
			remote.ID = roomPostID(peer.ID, remote.ID)
			for i := range remote.Media {
				remote.Media[i].URL = peer.RoomURL + "/media/" + url.PathEscape(remote.Media[i].ID)
				if remote.Media[i].Thumb != "" {
					remote.Media[i].Thumb = peer.RoomURL + remote.Media[i].Thumb
				}
			}
			mediaCount += len(remote.Media)
			posts = append(posts, remote)
		}
	}
	sort.Slice(posts, func(i, j int) bool { return posts[i].TS < posts[j].TS })
	return posts, allIDs, mediaCount, cursor
}

func (s *srv) proxyRoomWrite(w http.ResponseWriter, r *http.Request, peerID string, body any) {
	s.peersMu.RLock()
	directory := s.Peers
	s.peersMu.RUnlock()
	if directory == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "that DJ is no longer reachable"})
		return
	}
	peer, ok := directory.Peer(peerID)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "that DJ is no longer reachable"})
		return
	}
	payload, err := json.Marshal(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, peer.RoomURL+r.URL.Path, bytes.NewReader(payload))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't reach that DJ"})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "couldn't reach that DJ"})
		return
	}
	defer resp.Body.Close()
	response, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "invalid response from that DJ"})
		return
	}
	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(response)
}
