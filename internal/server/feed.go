package server

import (
	"archive/zip"
	"context"
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

	"partyparty/internal/activate"
	"partyparty/internal/event"
	"partyparty/internal/publish"
	postsync "partyparty/internal/sync"
)

// The event feed: guests post text + photos/videos from the player page; the
// DJ sees, posts to, and moderates the same feed from the console. Guests are
// pseudonymous (fun name + emoji chosen client-side); their private cid rides
// along server-side only, as the future "claim my posts" proof.

const liveGuestVideoDeferBytes int64 = 32 << 20
const publicPartyBase = "https://party.ramine.net"

// isDJ: the console is the app's own WKWebView on localhost — loopback is the
// DJ, everyone else on the LAN is a guest. Same trust model as /api/shutdown.
func (s *srv) isDJ(r *http.Request) bool {
	ip := clientIP(r)
	return ip == "127.0.0.1" || ip == "::1" || ip == "1"
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
		dj := s.isDJ(r)
		posts, ids, mediaCount, cursor := s.Events.FeedFor(since, r.URL.Query().Get("cid"), dj)
		// Long-poll (wait=1): nothing new → park until the next mutation (or
		// ~25s heartbeat), then answer. Posts and comments land on every open
		// page within a network round-trip instead of a polling interval.
		if len(posts) == 0 && cursor <= since && r.URL.Query().Get("wait") == "1" {
			select {
			case <-s.Events.Wait():
			case <-time.After(25 * time.Second):
			case <-r.Context().Done():
				return true
			}
			posts, ids, mediaCount, cursor = s.Events.FeedFor(since, r.URL.Query().Get("cid"), dj)
		}
		if posts == nil {
			posts = []event.Post{}
		}
		meta := s.Events.Meta()
		links := s.eventOnlineLinks()
		writeJSON(w, http.StatusOK, map[string]any{
			"title": meta.Title, "host": meta.Host, "starts": meta.Starts, "slug": meta.Slug,
			"features": meta.Features, "moderationMode": meta.ModerationMode,
			"onlineSlug": links.Slug, "onlineUrl": links.OnlineURL, "claimBaseUrl": links.ClaimBaseURL, "published": links.Published,
			// dir = the event's identity; clients reset their cursor when it
			// changes (switching to an OLDER event must replay its posts).
			"dir":   filepath.Base(s.Events.Dir()),
			"posts": posts, "ids": ids, "total": len(ids), "media": mediaCount, "cursor": cursor, "dj": dj,
		})
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
		// Slug is a *pointer so a title/host edit that omits it doesn't wipe the
		// DJ's chosen slug — only an explicit slug field touches it.
		var body struct {
			Title, Host, Starts string
			Slug                *string
			ModerationMode      *string `json:"moderationMode"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return true
		}
		if err := s.Events.SetMeta(body.Title, body.Host, body.Starts); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		if body.Slug != nil {
			if _, err := s.Events.SetSlug(*body.Slug); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
		}
		if body.ModerationMode != nil {
			if err := s.Events.SetModerationMode(*body.ModerationMode); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return true
			}
		}
		meta := s.Events.Meta()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "slug": meta.Slug, "moderationMode": meta.ModerationMode})
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
	case "/api/publish":
		// Publish the current event's recorded set to its ONLINE /e/<slug> page
		// (DJ-initiated; the button always publishes, no duration threshold).
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		res, err := s.publishCurrentSet(r.Context())
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return true
		}
		_, _ = s.Events.SetSlug(res.Slug)
		s.syncCurrentPostsAsync(res.Slug)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "url": res.URL, "slug": res.Slug, "warning": res.Warning})
	case "/api/sync-posts":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		res, err := s.syncCurrentPosts(r.Context(), "")
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sync": res})
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
		p, claimToken, err := s.Events.AddPost(body.CID, body.Author, body.Emoji, body.Text, body.Media, dj)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		resp := map[string]any{"ok": true, "id": p.ID}
		if claimToken != "" {
			// First post from this guest: hand them their keepsake claim link
			// exactly once. Token rides in the URL FRAGMENT (never reaches
			// servers/logs); only its hash is stored here.
			links := s.eventOnlineLinks()
			claimBase := links.ClaimBaseURL
			if claimBase == "" {
				claimBase = publicPartyBase + "/e/" + filepath.Base(s.Events.Dir()) + "/claim"
			}
			resp["claimUrl"] = claimBase + "#g=" + claimToken
		}
		writeJSON(w, http.StatusOK, resp)
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
		r.Body = http.MaxBytesReader(w, r.Body, event.MaxUpload+(1<<20))
		f, hdr, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		defer f.Close()
		if !dj && uploadLooksLikeVideo(hdr.Filename, hdr.Header.Get("Content-Type")) && !s.featureOn("videoUploads") {
			writeFeatureDisabled(w)
			return true
		}
		if !dj {
			key := uploadLimitKey(r)
			if !s.limits.allow(key, "upload") {
				writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "one moment — too many uploads", "retry": true})
				return true
			}
			if !s.limits.acquireUpload() {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the party's busy — try again in a sec"})
				return true
			}
			defer s.limits.releaseUpload()
		}
		if s.Broadcaster != nil && s.Broadcaster.Status().State == "live" && uploadLooksLikeBigVideo(hdr.Filename, hdr.Size, r.ContentLength) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "your video will post after the set", "defer": true})
			return true
		}
		m, err := s.Events.SaveMedia(hdr.Filename, f)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return true
		}
		if p, ok := s.Events.MediaPath(m.ID); ok {
			s.Events.EnqueueThumb(m.ID, p, m.Type)
		}
		writeJSON(w, http.StatusOK, m)
	case "/api/event-cover":
		if r.Method != http.MethodPost || !s.isDJ(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "DJ only"})
			return true
		}
		const maxCoverUpload = 15 << 20
		r.Body = http.MaxBytesReader(w, r.Body, maxCoverUpload+(1<<20))
		f, hdr, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no file"})
			return true
		}
		defer f.Close()
		ext := strings.ToLower(filepath.Ext(hdr.Filename))
		if len(ext) > 8 {
			ext = ""
		}
		tmp, err := os.CreateTemp("", "pcover-*"+ext)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return true
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		n, copyErr := io.Copy(tmp, io.LimitReader(f, maxCoverUpload+1))
		closeErr := tmp.Close()
		if copyErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": copyErr.Error()})
			return true
		}
		if closeErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": closeErr.Error()})
			return true
		}
		if n > maxCoverUpload {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too large"})
			return true
		}
		id, secret := activate.InstallCreds()
		base := os.Getenv("PARTYPARTY_BROKER")
		if base == "" {
			base = "https://party.ramine.net"
		}
		cctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		err = publish.PublishCover(cctx, tmpPath, s.Events.Slug(), publish.Creds{
			ID: id, Secret: secret, InstallSlug: activate.InstallSlug(),
		}, base)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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

type eventLinks struct {
	Slug         string
	OnlineURL    string
	ClaimBaseURL string
	Published    bool
}

func (s *srv) eventOnlineLinks() eventLinks {
	if s.Events == nil {
		return eventLinks{}
	}
	installSlug := activate.InstallSlug()
	metaSlug := s.Events.Slug()
	slug := publish.SlugForEvent(metaSlug, installSlug)
	if strings.TrimSpace(slug) == "" {
		return eventLinks{}
	}
	published := metaSlug != "" || s.Events.LastPublishedSig() != ""
	links := eventLinks{Slug: slug, ClaimBaseURL: publicPartyBase + "/e/" + slug + "/claim", Published: published}
	if published {
		links.OnlineURL = publicPartyBase + "/e/" + slug
	}
	return links
}

func uploadLooksLikeBigVideo(name string, fileSize, requestSize int64) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".mov", ".m4v", ".webm":
	default:
		return false
	}
	return fileSize >= liveGuestVideoDeferBytes || requestSize >= liveGuestVideoDeferBytes
}

// publishCurrentSet remuxes + uploads the current event's set recording to its
// online /e/<slug> page, reusing this install's broker identity for auth.
func (s *srv) publishCurrentSet(ctx context.Context) (*publish.Result, error) {
	id, secret := activate.InstallCreds()
	base := os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://party.ramine.net"
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	return publish.FromEvent(cctx, s.Config.FFmpeg, s.Events, publish.Creds{
		ID: id, Secret: secret, InstallSlug: activate.InstallSlug(),
	}, base)
}

func (s *srv) syncCurrentPosts(ctx context.Context, slug string) (postsync.Result, error) {
	id, secret := activate.InstallCreds()
	installSlug := activate.InstallSlug()
	if slug == "" {
		slug = publish.SlugForEvent(s.Events.Slug(), installSlug)
	}
	base := os.Getenv("PARTYPARTY_BROKER")
	if base == "" {
		base = "https://party.ramine.net"
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	live := s.Broadcaster != nil && s.Broadcaster.Status().State == "live"
	return postsync.SyncPostsWithOptions(cctx, s.Events.Dir(), publish.Creds{
		ID: id, Secret: secret, InstallSlug: installSlug,
	}, slug, base, postsync.Options{DeferLargeMedia: live})
}

func (s *srv) syncCurrentPostsAsync(slug string) {
	if s.Events == nil {
		return
	}
	go func() {
		res, err := s.syncCurrentPosts(context.Background(), slug)
		if s.Diag == nil {
			return
		}
		if err != nil {
			s.Diag.Printf("post sync failed: %v", err)
			return
		}
		if res.Offline {
			s.Diag.Printf("post sync deferred: offline (%s)", res.LastError)
			return
		}
		s.Diag.Printf("post sync complete: posts=%d media=%d skipped_posts=%d skipped_media=%d deferred_media=%d", res.PostsPushed, res.MediaPushed, res.PostsSkipped, res.MediaSkipped, res.MediaDeferred)
	}()
}

func (s *srv) eventMirrorState() map[string]any {
	if s.Events == nil {
		return nil
	}
	links := s.eventOnlineLinks()
	if links.Slug == "" && links.OnlineURL == "" {
		return nil
	}
	id, secret := activate.InstallCreds()
	backlog, err := postsync.PendingBacklog(s.Events.Dir(), publish.Creds{
		ID: id, Secret: secret, InstallSlug: activate.InstallSlug(),
	}, links.Slug)
	postsPending := backlog.PostsPending
	mediaPending := backlog.MediaPending
	uploadsPending := backlog.UploadsPending
	mediaMissing := backlog.MediaMissing
	pending := postsPending + mediaPending + uploadsPending + mediaMissing
	setPublished := s.Events.LastPublishedSig() != ""
	done := setPublished && links.OnlineURL != "" && pending == 0 && err == nil
	m := map[string]any{
		"slug":           links.Slug,
		"url":            links.OnlineURL,
		"published":      setPublished,
		"pending":        pending,
		"done":           done,
		"postsPending":   postsPending,
		"mediaPending":   mediaPending,
		"uploadsPending": uploadsPending,
		"mediaMissing":   mediaMissing,
	}
	if err != nil {
		m["error"] = err.Error()
	}
	return m
}

// eventState summarizes the feed for /api/status (console header + badges).
func (s *srv) eventState() map[string]any {
	if s.Events == nil {
		return nil
	}
	_, ids, mediaCount := s.Events.Feed(1 << 62) // counts only, no post bodies
	meta := s.Events.Meta()
	return map[string]any{
		"title":    meta.Title,
		"host":     meta.Host,
		"features": meta.Features,
		"posts":    len(ids),
		"media":    mediaCount,
		"dir":      s.Events.Dir(),
	}
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
