package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"partyparty/internal/contribute"
)

// relayPresenceTTL is how long a presence report from the origin is believed.
// Three publish cycles: long enough to ride out one lost report, short enough
// that a finished party stops showing a crowd.
const relayPresenceTTL = 5 * time.Second

// Photo downloads are secondary to the live room. A drained burst must not
// turn into one network goroutine per guest upload on the Mac.
const relayPhotoImportConcurrency = 2
const relayPhotoImportQueue = 32

var nowFunc = time.Now
var relayPhotoHTTPClient = &http.Client{Timeout: 30 * time.Second}

type relayPhotoImport struct {
	ID     string
	Name   string
	Source url.URL
}

// The room's interactive surface, for guests who reach us through the relay.
//
// A relayed guest cannot reach this Mac at all, so the origin answers on its
// behalf: the Mac publishes a snapshot of each guest endpoint once a second, the
// origin serves it to everyone, and guest writes come back in one batch. That is
// what keeps five hundred listeners exactly as expensive for the Mac as five.
//
// The snapshots are produced by RUNNING THE REAL HANDLERS in process rather than
// by assembling a parallel payload. A second implementation of "what a guest
// sees" would drift from the first, and the drift would show up only as a relayed
// party behaving subtly unlike a direct one, which is the hardest kind of bug to
// notice and the easiest to avoid: there is exactly one renderer, and both paths
// call it.

// relayGuestAddr is a non-loopback address, so these render as a guest would see
// them rather than as the DJ console does.
const relayGuestAddr = "203.0.113.1:9999"

// recorder is a minimal ResponseWriter. net/http/httptest would do this, but it
// is a testing package and this is production code.
type recorder struct {
	status int
	header http.Header
	body   bytes.Buffer
}

func newRecorder() *recorder { return &recorder{status: http.StatusOK, header: http.Header{}} }

func (r *recorder) Header() http.Header { return r.header }
func (r *recorder) Write(p []byte) (int, error) {
	return r.body.Write(p)
}
func (r *recorder) WriteHeader(code int) { r.status = code }

// render runs one in-process request against this server and returns the body.
func (s *srv) render(method, target string, body []byte) (int, []byte) {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, target, reader)
	if err != nil {
		return http.StatusBadRequest, nil
	}
	req.RemoteAddr = relayGuestAddr
	// Tells the status renderer that this is being published to the origin, so
	// the stream URL it reports is the one the origin actually serves.
	req.Header.Set("X-PartyParty-Relay", "1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := newRecorder()
	s.ServeHTTP(w, req)
	return w.status, w.body.Bytes()
}

// RoomSnapshots renders the guest endpoints the origin serves on our behalf.
// Anything that fails to render is omitted rather than published empty, because
// an empty snapshot would render a live party as a dead one.
func (s *Srv) RoomSnapshots() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for kind, target := range map[string]string{
		"status": "/api/status",
		"feed":   "/api/feed?guest=1",
	} {
		status, body := s.render(http.MethodGet, target, nil)
		if status != http.StatusOK || len(body) == 0 || !json.Valid(body) {
			continue
		}
		out[kind] = json.RawMessage(body)
	}
	return out
}

// ApplyRelayWrite replays one guest action that arrived at the origin.
//
// The path is data that came off the internet, so it is matched against a fixed
// set rather than trusted to name a handler. A write that is not on the list is
// dropped: a live party would rather lose one reaction than accept a request
// that was never meant to be reachable this way.
func (s *Srv) ApplyRelayWrite(path string, body json.RawMessage) {
	name, query, _ := strings.Cut(strings.TrimPrefix(path, "/"), "?")
	if name == "relay-upload" {
		s.importRelayPhoto(body)
		return
	}
	switch name {
	case "post", "comment", "post-reaction", "reactions", "track-id-request",
		"guest-profile", "client-events":
	default:
		return
	}
	target := "/api/" + name
	if query != "" {
		if parsed, err := url.ParseQuery(query); err == nil {
			target += "?" + parsed.Encode()
		}
	}
	s.render(http.MethodPost, target, body)
}

func (s *srv) importRelayPhoto(body json.RawMessage) {
	if s.Events == nil {
		return
	}
	var upload struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Source string `json:"source"`
	}
	if json.Unmarshal(body, &upload) != nil {
		return
	}
	source, err := url.Parse(upload.Source)
	if err != nil || !trustedRelayPhotoURL(source, nil) {
		return
	}
	s.enqueueRelayPhotoImport(relayPhotoImport{ID: upload.ID, Name: upload.Name, Source: *source})
}

// enqueueRelayPhotoImport keeps the plane loop non-blocking while bounding
// both live downloads and retained photo work. Fixed workers would sit around
// forever for every short-lived test/server; this starts at most two goroutines
// on demand and hands each the next queued job as it finishes.
func (s *srv) enqueueRelayPhotoImport(upload relayPhotoImport) {
	s.relayPhotoMu.Lock()
	if s.relayPhotoActive >= relayPhotoImportConcurrency {
		if len(s.relayPhotoPending) < relayPhotoImportQueue {
			s.relayPhotoPending = append(s.relayPhotoPending, upload)
		}
		s.relayPhotoMu.Unlock()
		return
	}
	s.relayPhotoActive++
	s.relayPhotoMu.Unlock()
	go s.runRelayPhotoImport(upload)
}

func (s *srv) runRelayPhotoImport(upload relayPhotoImport) {
	defer s.advanceRelayPhotoImports()
	source := &upload.Source
	client := *relayPhotoHTTPClient
	priorRedirectCheck := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("stopped after 10 redirects")
		}
		if !trustedRelayPhotoURL(req.URL, source) {
			return fmt.Errorf("relay photo redirect left its room origin")
		}
		if priorRedirectCheck != nil {
			return priorRedirectCheck(req, via)
		}
		return nil
	}
	resp, err := client.Get(source.String())
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	media, err := s.Events.ImportMedia(upload.ID, upload.Name, io.LimitReader(resp.Body, (8<<20)+1))
	if err != nil {
		return
	}
	if p, ok := s.Events.MediaPath(media.ID); ok {
		s.Events.EnqueueThumb(media.ID, p, media.Type)
	}
}

func (s *srv) advanceRelayPhotoImports() {
	s.relayPhotoMu.Lock()
	if len(s.relayPhotoPending) == 0 {
		s.relayPhotoActive--
		s.relayPhotoMu.Unlock()
		return
	}
	next := s.relayPhotoPending[0]
	s.relayPhotoPending[0] = relayPhotoImport{}
	if len(s.relayPhotoPending) == 1 {
		s.relayPhotoPending = nil
	} else {
		s.relayPhotoPending = s.relayPhotoPending[1:]
	}
	s.relayPhotoMu.Unlock()
	go s.runRelayPhotoImport(next)
}

func trustedRelayPhotoURL(candidate, roomOrigin *url.URL) bool {
	if candidate == nil || !strings.EqualFold(candidate.Scheme, "https") || candidate.User != nil ||
		candidate.Port() != "" && candidate.Port() != "443" ||
		!strings.HasSuffix(strings.ToLower(candidate.Hostname()), ".relay.partyparty.party") ||
		candidate.RawQuery != "" || candidate.Fragment != "" {
		return false
	}
	name := strings.TrimPrefix(candidate.Path, "/media/")
	if name == candidate.Path || name == "" || name != filepath.Base(name) {
		return false
	}
	if roomOrigin == nil {
		return true
	}
	return strings.EqualFold(candidate.Hostname(), roomOrigin.Hostname()) &&
		relayOriginPort(candidate) == relayOriginPort(roomOrigin)
}

func relayOriginPort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	return "443"
}

// GuestPage renders the listener page for publication to the origin. Relayed
// guests cannot fetch a page from this Mac, so this is the page they get.
func (s *Srv) GuestPage() []byte {
	status, body := s.render(http.MethodGet, "/", nil)
	if status != http.StatusOK {
		return nil
	}
	return body
}

// PageAssets returns the static files the published guest page references by
// absolute path - the DJ avatar, the event cover, the fonts. A relayed guest
// resolves those URLs against the ORIGIN, so the page is only whole if these
// travel with it: without them the DJ photo is a broken image and the event
// header sits on a blank artwork block, which is exactly how this gap showed
// up at a real party. Names match the page's references minus the leading
// slash.
func (s *Srv) PageAssets() []contribute.Asset {
	var out []contribute.Asset
	add := func(name string, body []byte, contentType string) {
		if name != "" && len(body) > 0 {
			out = append(out, contribute.Asset{Name: name, Body: body, ContentType: contentType})
		}
	}
	fromWeb := func(name, contentType string) {
		if s.Web == nil {
			return
		}
		if body, err := fs.ReadFile(s.Web, name); err == nil {
			add(name, body, contentType)
		}
	}
	fromWeb("fonts/Geist-Variable.woff2", "font/woff2")
	if s.Events != nil {
		if avatar, ok := s.Events.AvatarPath(); ok {
			if body, err := os.ReadFile(avatar); err == nil {
				add("dj-avatar", body, mimeByExt(avatar))
			}
		}
		cover := s.Events.Meta().Cover
		switch {
		case strings.HasPrefix(cover, "/covers/"):
			fromWeb(strings.TrimPrefix(cover, "/"), mimeByExt(cover))
		case cover == "/event-cover":
			if path, ok := s.Events.CoverPath(); ok {
				if body, err := os.ReadFile(path); err == nil {
					add("event-cover", body, mimeByExt(path))
				}
			}
		}
	}
	return out
}

// PageAssetsRev is a cheap fingerprint of PageAssets, evaluated every push
// cycle: assets are re-uploaded only when it changes, so an avatar swapped
// mid-set reaches relayed guests within a cycle without the cycle ever
// rebuilding file bytes just to compare them. Fonts ship with the binary, so
// the version stamp covers them.
func (s *Srv) PageAssetsRev() string {
	var b strings.Builder
	b.WriteString(s.Version)
	if s.Events == nil {
		return b.String()
	}
	stamp := func(path string) {
		if st, err := os.Stat(path); err == nil {
			fmt.Fprintf(&b, "|%s:%d:%d", path, st.Size(), st.ModTime().UnixNano())
		}
	}
	if avatar, ok := s.Events.AvatarPath(); ok {
		stamp(avatar)
	}
	cover := s.Events.Meta().Cover
	b.WriteString("|" + cover)
	if cover == "/event-cover" {
		if path, ok := s.Events.CoverPath(); ok {
			stamp(path)
		}
	}
	return b.String()
}

func mimeByExt(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".webp":
		return "image/webp"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".woff2":
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}

type RelayGuest struct {
	ID     string
	Name   string
	Emoji  string
	DJID   string
	Paused bool
}

func (s *Srv) SetRelayPresence(listeners int, spreadMs float64, guests []RelayGuest) {
	s.relayMu.Lock()
	s.relayListeners = listeners
	s.relaySpreadMs = spreadMs
	s.relayGuests = append([]RelayGuest(nil), guests...)
	s.relayAt = nowFunc()
	s.relayMu.Unlock()
}

// RelayPresence returns the last reported relayed presence, and whether it is
// recent enough to believe. Stale counts are worse than none: a party that ended
// would keep showing a crowd.
func (s *srv) RelayPresence() (listeners int, spreadMs float64, fresh bool) {
	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	if s.relayAt.IsZero() || nowFunc().Sub(s.relayAt) > relayPresenceTTL {
		return 0, 0, false
	}
	return s.relayListeners, s.relaySpreadMs, true
}

func (s *srv) RelayGuests() []RelayGuest {
	s.relayMu.RLock()
	defer s.relayMu.RUnlock()
	if s.relayAt.IsZero() || nowFunc().Sub(s.relayAt) > relayPresenceTTL {
		return nil
	}
	return append([]RelayGuest(nil), s.relayGuests...)
}

// relayPresenceState is the status payload's honest account of relayed guests.
// Without it the console counts only listeners this Mac serves directly, and a
// relayed room full of people reads as zero: the count existed, arrived from
// the origin, and was stored by SetRelayPresence, and nothing ever read it.
func (s *srv) relayPresenceState() map[string]any {
	listeners, spreadMs, fresh := s.RelayPresence()
	out := map[string]any{"listeners": listeners, "spreadMs": spreadMs, "fresh": fresh}
	// Media push health rides along, because presence alone has proven itself a
	// liar: the presence plane kept reporting fresh for hours while the media
	// push failed every cycle and relayed guests had nothing to hear.
	if s.Contribute != nil {
		c := s.Contribute.Snapshot()
		out["pushing"] = c.Running
		out["pushFailures"] = c.Failures
		if c.LastError != "" {
			out["pushError"] = c.LastError
		}
	}
	return out
}
