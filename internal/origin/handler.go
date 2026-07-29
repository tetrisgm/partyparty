package origin

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Config is the origin service configuration.
type Config struct {
	// Tokens maps a room token to the bearer credential its Mac publishes with.
	// Only that Mac may publish to that room; guests never need any credential to
	// listen, because a guest with no account is the product.
	Tokens func(room string) (string, bool)

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
	if strings.HasSuffix(name, ".m3u8") {
		// The playlist is stored verbatim. It carries PROGRAM-DATE-TIME, and
		// therefore the room's schedule, so rewriting any part of it here would
		// desynchronise relayed guests from direct ones.
		room.PutPlaylist(name, body)
	} else {
		room.PutMedia(name, body, r.Header.Get("Content-Type"))
	}
	noStore(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) authorized(r *http.Request, token string) bool {
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

// serve delivers media and playlists to guests, with no credential required.
func (h *Handler) serve(w http.ResponseWriter, r *http.Request, token, name string) {
	room, ok := h.store.Room(token, false)
	if !ok {
		http.Error(w, "room is not live", http.StatusNotFound)
		return
	}
	if name == "" || !safeName(name) {
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
		writeBody(w, r, body)
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
	writeBody(w, r, obj.body)
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
	case r.Method == http.MethodGet:
		body, published := plane.Read(endpoint)
		if !published {
			// Not yet published is different from empty: saying "{}" here would
			// render a live party as an empty one.
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writeBody(w, r, body)

	case r.Method == http.MethodPost && endpoint == "heartbeat":
		q := r.URL.Query()
		lat, hasLat := parseFloat(first(q["lat"]))
		plane.Beat(first(q["cid"]), lat, hasLat)
		w.WriteHeader(http.StatusNoContent)

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
