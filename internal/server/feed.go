package server

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"partyparty/internal/event"
)

// The event feed: guests post text + photos/videos from the player page; the
// DJ sees, posts to, and moderates the same feed from the console. Guests are
// pseudonymous (fun name + emoji chosen client-side); their private cid rides
// along server-side only, as the future "claim my posts" proof.

// isDJ: the console is the app's own WKWebView on localhost — loopback is the
// DJ, everyone else on the LAN is a guest. Same trust model as /api/shutdown.
func (s *srv) isDJ(r *http.Request) bool {
	ip := clientIP(r)
	return ip == "127.0.0.1" || ip == "::1" || ip == "1"
}

func (s *srv) handleFeedAPI(w http.ResponseWriter, r *http.Request) bool {
	if s.Events == nil {
		return false
	}
	switch r.URL.Path {
	case "/api/feed":
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		posts, ids, mediaCount := s.Events.Feed(since)
		// Long-poll (wait=1): nothing new → park until the next mutation (or
		// ~25s heartbeat), then answer. Posts and comments land on every open
		// page within a network round-trip instead of a polling interval.
		if len(posts) == 0 && r.URL.Query().Get("wait") == "1" {
			select {
			case <-s.Events.Wait():
			case <-time.After(25 * time.Second):
			case <-r.Context().Done():
				return true
			}
			posts, ids, mediaCount = s.Events.Feed(since)
		}
		if posts == nil {
			posts = []event.Post{}
		}
		meta := s.Events.Meta()
		writeJSON(w, http.StatusOK, map[string]any{
			"title": meta.Title, "host": meta.Host, "starts": meta.Starts,
			// dir = the event's identity; clients reset their cursor when it
			// changes (switching to an OLDER event must replay its posts).
			"dir":   filepath.Base(s.Events.Dir()),
			"posts": posts, "ids": ids, "total": len(ids), "media": mediaCount, "dj": s.isDJ(r),
		})
	case "/api/comment":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		var body struct{ Post, CID, Author, Emoji, Text string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		c, err := s.Events.AddComment(body.Post, body.CID, body.Author, body.Emoji, body.Text, s.isDJ(r))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": c.ID})
	case "/api/post-publish":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.SetPublish(r.URL.Query().Get("id"), r.URL.Query().Get("on") != "0"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/event-config":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		var body struct{ Title, Host, Starts string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetMeta(body.Title, body.Host, body.Starts); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/media.zip":
		// "Everyone can take the media home": one tap streams the whole
		// event's media as an uncompressed zip (photos/videos are already
		// compressed — Store mode keeps a 2GB set from cooking the Mac).
		files := s.Events.MediaFiles()
		if len(files) == 0 {
			http.Error(w, "no media yet", http.StatusNotFound)
			return true
		}
		name := "partyparty-media-" + filepath.Base(s.Events.Dir()) + ".zip"
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(name, `"`, "")+`"`)
		zw := zip.NewWriter(w)
		for _, f := range files {
			src, err := os.Open(f)
			if err != nil {
				continue
			}
			dst, err := zw.CreateHeader(&zip.FileHeader{Name: filepath.Base(f), Method: zip.Store})
			if err == nil {
				_, _ = io.Copy(dst, src)
			}
			src.Close()
		}
		_ = zw.Close()
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
		p, claimToken, err := s.Events.AddPost(body.CID, body.Author, body.Emoji, body.Text, body.Media, s.isDJ(r))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		resp := map[string]any{"ok": true, "id": p.ID}
		if claimToken != "" {
			// First post from this guest: hand them their keepsake claim link
			// exactly once. Token rides in the URL FRAGMENT (never reaches
			// servers/logs); only its hash is stored here.
			resp["claimUrl"] = "https://party.ramine.net/e/" + filepath.Base(s.Events.Dir()) + "/claim#g=" + claimToken
		}
		writeJSON(w, http.StatusOK, resp)
	case "/api/upload":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		r.Body = http.MaxBytesReader(w, r.Body, event.MaxUpload+(1<<20))
		f, hdr, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		defer f.Close()
		m, err := s.Events.SaveMedia(hdr.Filename, f)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, m)
	case "/api/guest-contact":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return true
		}
		var body struct{ CID, Contact string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetContact(body.CID, body.Contact); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	case "/api/event-fresh":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.Fresh(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/netcheck":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://party.ramine.net"
		}
		writeJSON(w, http.StatusOK, map[string]any{"checks": runNetChecks(broker)})
	case "/api/events":
		if !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"events": s.Events.List()})
	case "/api/event-switch":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		if err := s.Events.SwitchTo(r.URL.Query().Get("dir")); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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

// eventState summarizes the feed for /api/status (console header + badges).
func (s *srv) eventState() map[string]any {
	if s.Events == nil {
		return nil
	}
	_, ids, mediaCount := s.Events.Feed(1 << 62) // counts only, no post bodies
	meta := s.Events.Meta()
	return map[string]any{
		"title": meta.Title,
		"host":  meta.Host,
		"posts": len(ids),
		"media": mediaCount,
		"dir":   s.Events.Dir(),
	}
}

// handleMedia serves uploaded files (inline, cacheable — ids are immutable).
func (s *srv) handleMedia(w http.ResponseWriter, r *http.Request) {
	if s.Events == nil {
		http.Error(w, "not found", http.StatusNotFound)
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
