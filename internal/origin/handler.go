package origin

import (
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"partyparty/internal/roomplane"
)

// Config is the origin service configuration.
type Config struct {
	// Tokens maps a room token to the bearer credential its Mac publishes with.
	// Only that Mac may publish to that room; guests never need any credential to
	// listen, because a guest with no account is the product.
	Tokens func(room string) (string, bool)

	// Verify, when set, is asked whether a PRESENTED credential is the right one
	// for a room, and takes precedence over Tokens. Publish credentials are minted
	// per install by the broker, so in production the origin cannot know them
	// ahead of time and must ask. Asking "is this correct" rather than "what is
	// correct" means the broker never hands a publish credential to anything but
	// the Mac that owns it, and the origin stores no secret that could publish.
	Verify func(room, presented string) bool

	// BaseDomain, when set, routes by the first label of the Host header, so a
	// room is served at <token>.<BaseDomain>. Host routing keeps guest pages on
	// absolute paths exactly as they are served on the LAN.
	BaseDomain string

	Logf func(format string, args ...any)
}

// Handler serves both sides of the origin: authenticated uploads from a Mac and
// public reads by guests.
type Handler struct {
	cfg   Config
	store *Store
}

func NewHandler(cfg Config, store *Store) *Handler {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Handler{cfg: cfg, store: store}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/__pp/health" {
		h.health(w)
		return
	}

	room, rest, ok := h.route(r)
	if !ok {
		http.NotFound(w, r)
		return
	}

	switch {
	case strings.HasPrefix(rest, "__pp/plane/"):
		h.planePublish(w, r, room, strings.TrimPrefix(rest, "__pp/plane/"))
	case rest == "__pp/drain":
		h.planeDrain(w, r, room)
	case r.Method == http.MethodPut:
		h.upload(w, r, room, rest)
	case strings.HasPrefix(rest, "api/"):
		h.roomAPI(w, r, room, strings.TrimPrefix(rest, "api/"))
	case r.Method == http.MethodGet, r.Method == http.MethodHead:
		h.serve(w, r, room, rest)
	default:
		w.Header().Set("Allow", "GET, HEAD, PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// route resolves which room a request is for, by Host label when a base domain
// is configured and by a /r/<token>/ prefix otherwise. The path form keeps the
// service testable and runnable locally without wildcard DNS.
func (h *Handler) route(r *http.Request) (token, rest string, ok bool) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if h.cfg.BaseDomain != "" {
		host := r.Host
		if i := strings.IndexByte(host, ':'); i >= 0 {
			host = host[:i]
		}
		if suffix := "." + h.cfg.BaseDomain; strings.HasSuffix(host, suffix) {
			label := strings.TrimSuffix(host, suffix)
			if label != "" && !strings.Contains(label, ".") {
				return label, path, true
			}
		}
	}
	if strings.HasPrefix(path, "r/") {
		remainder := strings.TrimPrefix(path, "r/")
		token, rest, found := strings.Cut(remainder, "/")
		if token != "" && found {
			return token, rest, true
		}
		if token != "" {
			return token, "", true
		}
	}
	return "", "", false
}

// upload accepts one file from the room's Mac.
func (h *Handler) upload(w http.ResponseWriter, r *http.Request, token, name string) {
	if !h.authorized(r, token) {
		// Deliberately not distinguishing "unknown room" from "wrong credential":
		// a publish endpoint should not confirm which rooms exist.
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if name == "" || !safeName(name) {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxUploadBytes+1))
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	if len(body) > maxUploadBytes {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}

	room, _ := h.store.Room(token, true)
	// The room epoch rides every PUT response. It is how the Mac learns that the
	// store restarted and its once-uploaded fixed-name files (the init segment,
	// the guest page) no longer exist, even though every upload keeps succeeding.
	w.Header().Set("X-PP-Room-Epoch", strconv.FormatInt(room.Epoch(), 10))
	if strings.HasSuffix(name, ".m3u8") {
		// The playlist is stored verbatim. It carries PROGRAM-DATE-TIME, and
		// therefore the room's schedule, so rewriting any part of it here would
		// desynchronise relayed guests from direct ones.
		//
		// It also names the room's fixed-name media: EXT-X-MAP is the init
		// segment, uploaded once per set and required to decode ANYTHING. Pin it
		// (and the guest page) so live-window eviction can never delete the two
		// files whose age says nothing about their relevance.
		room.Pin(append(mapURIs(body), "index.html"))
		room.PutPlaylist(name, body)
	} else {
		room.PutMedia(name, body, r.Header.Get("Content-Type"))
	}
	noStore(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

// planePublish accepts a room-state snapshot from the Mac. Guests then read it
// from memory here, which is what keeps read cost flat as a room grows: 500
// listeners polling status cost the Mac one publish, not 500 requests.
func (h *Handler) planePublish(w http.ResponseWriter, r *http.Request, token, kind string) {
	if !h.authorized(r, token) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", "PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxUploadBytes+1))
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	room, _ := h.store.Room(token, true)
	delay, _ := parseFloat(r.URL.Query().Get("delaySec"))
	if !room.Plane().Publish(kind, body, delay) {
		http.Error(w, "bad snapshot", http.StatusBadRequest)
		return
	}
	noStore(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

// planeDrain hands the Mac one digest in place of every individual heartbeat and
// write. This is the exchange that makes 500 listeners cost the Mac the same as
// 5: its inbound rate is set by how often it drains, not by attendance.
func (h *Handler) planeDrain(w http.ResponseWriter, r *http.Request, token string) {
	if !h.authorized(r, token) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	room, ok := h.store.Room(token, false)
	if !ok {
		// Nothing published yet is not an error; it is an empty room.
		noStore(w.Header())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"listeners":0}`))
		return
	}
	noStore(w.Header())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(room.Plane().Drain())
}

func (h *Handler) authorized(r *http.Request, token string) bool {
	if h.cfg.Verify != nil {
		got := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		return got != "" && h.cfg.Verify(token, got)
	}
	if h.cfg.Tokens == nil {
		return false
	}
	want, ok := h.cfg.Tokens(token)
	if !ok || want == "" {
		return false
	}
	got := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	return got != "" && got == want
}

// mapURIs pulls every EXT-X-MAP URI out of a playlist.
func mapURIs(playlist []byte) []string {
	var names []string
	for _, line := range strings.Split(string(playlist), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#EXT-X-MAP:") {
			continue
		}
		if i := strings.Index(line, `URI="`); i >= 0 {
			rest := line[i+len(`URI="`):]
			if j := strings.IndexByte(rest, '"'); j >= 0 {
				names = append(names, rest[:j])
			}
		}
	}
	return names
}

// serve delivers media and playlists to guests, with no credential required.
func (h *Handler) serve(w http.ResponseWriter, r *http.Request, token, name string) {
	room, ok := h.store.Room(token, false)
	if !ok {
		if name == "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			relayWaitingPage(w, r)
			return
		}
		http.Error(w, "room is not live", http.StatusNotFound)
		return
	}
	if name == "" {
		// The room root is the guest page the Mac published. A relayed guest
		// cannot fetch a page from the Mac, so this is the only page they get.
		name = "index.html"
	}
	if !safeName(name) {
		http.NotFound(w, r)
		return
	}

	if strings.HasSuffix(name, ".m3u8") {
		msn, part := parseBlocking(r.URL.Query())
		body, err := room.Playlist(msn, part, time.Now().Add(maxBlockWait))
		if err != nil {
			http.Error(w, "stream is starting", http.StatusNotFound)
			return
		}
		noStore(w.Header())
		w.Header().Set("Content-Type", contentTypeFor(name, ""))
		writeCompressible(w, r, body)
		return
	}

	obj, found := room.Media(name)
	if !found {
		// Either not published yet, or aged out of the live window. Both mean the
		// guest should reattach rather than retry this exact file forever.
		http.Error(w, "not in the live window", http.StatusNotFound)
		return
	}
	// Media files are immutable once published, so they are safe to cache briefly
	// at the edge or in the client. Playlists never are.
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.Header().Set("Content-Type", contentTypeFor(name, obj.contentType))
	if strings.HasSuffix(name, ".html") {
		writeCompressible(w, r, obj.body)
		return
	}
	writeBody(w, r, obj.body)
}

func relayWaitingPage(w http.ResponseWriter, r *http.Request) {
	noStore(w.Header())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Joining PartyParty</title>
<style>:root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:32px;background:Canvas;color:CanvasText}main{width:min(100%,360px);text-align:center}.spinner{width:28px;height:28px;margin:0 auto 20px;border:3px solid color-mix(in srgb,CanvasText 18%,transparent);border-top-color:#ff2d6f;border-radius:50%;animation:spin .8s linear infinite}h1{font-size:22px;margin:0 0 8px}p{font-size:15px;line-height:1.45;margin:0;color:color-mix(in srgb,CanvasText 66%,transparent)}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body><main><div class="spinner" aria-hidden="true"></div><h1>Connecting to the DJ</h1><p>The music will start as soon as the secure stream is ready.</p></main>
<script>setTimeout(function(){location.reload()},1000)</script></body></html>`)
}

// planeParkMax bounds a parked room read. Under the Mac server's own 25s
// long-poll heartbeat and well under any proxy idle timeout, so a parked guest
// is answered by us rather than cut off by infrastructure.
const planeParkMax = 20 * time.Second

// planeETag is a strong validator for a snapshot version. The quotes are part
// of the ETag grammar, not decoration.
func planeETag(version uint64) string { return fmt.Sprintf("%q", strconv.FormatUint(version, 10)) }

// etagMatches reports whether the client's If-None-Match names the current
// version. Anything unparseable simply does not match, which degrades to an
// immediate answer rather than an error.
func etagMatches(header string, version uint64) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(candidate), "W/"))
		if candidate == planeETag(version) {
			return true
		}
	}
	return false
}

// roomAPI serves the room's interactive surface without involving the Mac per
// request. Reads come from what the Mac last published; beats aggregate; writes
// queue for the Mac to drain. This is what keeps 500 listeners as cheap for the
// Mac as 5.
func (h *Handler) roomAPI(w http.ResponseWriter, r *http.Request, token, endpoint string) {
	room, ok := h.store.Room(token, false)
	if !ok {
		http.Error(w, "room is not live", http.StatusNotFound)
		return
	}
	plane := room.Plane()
	noStore(w.Header())

	switch {
	// The heartbeat is matched by ENDPOINT before the read branch can claim it,
	// because the listener page sends it as a plain GET (fetch with no method).
	// The Mac's own server accepts that, and this origin must speak the page's
	// contract rather than a tidier one: matching POST only meant every relayed
	// guest's heartbeat bounced with 503, the room drained a count of zero all
	// night, and a phone that was audibly playing counted as nobody. The wire
	// format the page actually emits is the specification.
	case endpoint == "heartbeat" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		q := r.URL.Query()
		lat, hasLat := parseFloat(first(q["lat"]))
		plane.Beat(roomplane.Guest{
			ID:     first(q["cid"]),
			Name:   first(q["name"]),
			Emoji:  first(q["emoji"]),
			DJID:   first(q["dj"]),
			Paused: first(q["paused"]) == "1",
		}, lat, hasLat)
		w.WriteHeader(http.StatusNoContent)

	case endpoint == "upload" && r.Method == http.MethodPost:
		h.relayPhotoUpload(w, r, room, plane)

	case r.Method == http.MethodGet:
		body, version, published := plane.ReadVersioned(endpoint)
		// The listener page long-polls with wait=1 and is BUILT on the parked
		// request being the pacing: its loop breathes 150ms between answers. The
		// Mac's own server parks until something happens, so the page assumed
		// every server does. This one answered instantly from its snapshot, which
		// turned every relayed guest into a 7-requests-a-second hot loop. So:
		// when the guest proves it has the current content (If-None-Match), park
		// until the content actually changes, exactly like the Mac would.
		if published && r.URL.Query().Get("wait") == "1" &&
			etagMatches(r.Header.Get("If-None-Match"), version) {
			body, version, published = plane.WaitFor(endpoint, version, time.Now().Add(planeParkMax))
		}
		if !published {
			// Not yet published is different from empty: saying "{}" here would
			// render a live party as an empty one.
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("ETag", planeETag(version))
		w.Header().Set("Content-Type", "application/json")
		writeCompressible(w, r, body)

	case r.Method == http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "read failed", http.StatusBadRequest)
			return
		}
		if !json.Valid(body) {
			body = []byte("{}")
		}
		if !plane.Enqueue(endpoint, body) {
			// Telling the guest honestly beats accepting a post that will never
			// reach the Mac.
			http.Error(w, "room is busy", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusAccepted)

	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

var relayPhotoExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".heic": true, ".heif": true, ".webp": true,
}

func (h *Handler) relayPhotoUpload(w http.ResponseWriter, r *http.Request, room *Room, plane *roomplane.Room) {
	name, err := url.QueryUnescape(strings.TrimSpace(r.Header.Get("X-PP-Name")))
	if err != nil || strings.TrimSpace(name) == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid file name")
		return
	}
	name = filepath.Base(name)
	ext := strings.ToLower(filepath.Ext(name))
	if !relayPhotoExt[ext] || !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "image/") {
		writeJSONError(w, http.StatusConflict, "videos are unavailable in relay mode")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxUploadBytes+1))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "upload failed")
		return
	}
	if len(body) > maxUploadBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "photo is too large")
		return
	}
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "upload failed")
		return
	}
	id := hex.EncodeToString(idBytes) + ext
	room.PutPhoto(id, body, r.Header.Get("Content-Type"))
	source := "https://" + r.Host + "/media/" + url.PathEscape(id)
	action, _ := json.Marshal(map[string]any{
		"id": id, "name": name, "size": len(body), "source": source,
	})
	if !plane.Enqueue("relay-upload", action) {
		writeJSONError(w, http.StatusServiceUnavailable, "room is busy")
		return
	}
	noStore(w.Header())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": id, "type": "image", "name": name, "size": len(body),
	})
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (h *Handler) health(w http.ResponseWriter) {
	noStore(w.Header())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(h.store.Stats())
}

func writeBody(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}

// writeCompressible is writeBody plus on-the-fly gzip for text responses. The
// guest page is about 200KB of HTML, and the guests this origin exists for are
// exactly the ones on a congested venue network; the Mac's own server has
// gzipped this page all along, and a relayed guest should not pay four times
// the bytes for the same page. Media is never compressed (already compressed),
// and tiny bodies are not worth the header.
func writeCompressible(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if len(body) < 1024 || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		_, _ = w.Write(body)
		return
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Add("Vary", "Accept-Encoding")
	zw, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
	if err != nil {
		_, _ = w.Write(body)
		return
	}
	_, _ = zw.Write(body)
	_ = zw.Close()
}

func parseFloat(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	var v float64
	var neg bool
	i := 0
	if s[0] == '-' {
		neg, i = true, 1
	}
	seen, frac, scale := false, false, 1.0
	for ; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seen = true
			if frac {
				scale /= 10
				v += float64(c-'0') * scale
			} else {
				v = v*10 + float64(c-'0')
			}
		case c == '.' && !frac:
			frac = true
		default:
			return 0, false
		}
	}
	if !seen {
		return 0, false
	}
	if neg {
		v = -v
	}
	return v, true
}

// safeName refuses anything that could escape the room's namespace. Names arrive
// in URLs, so they are attacker-controlled input.
func safeName(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
		return false
	}
	return !strings.ContainsAny(name, "\\\x00")
}

// Sweeper drops idle rooms on an interval. Runs until stop is closed.
func Sweeper(store *Store, every time.Duration, logf func(string, ...any), stop <-chan struct{}) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if dropped := store.Sweep(); dropped > 0 && logf != nil {
				logf("origin: dropped %d idle room(s)", dropped)
			}
		}
	}
}
