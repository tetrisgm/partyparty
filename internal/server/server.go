package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/contribute"
	"partyparty/internal/devices"
	"partyparty/internal/diag"
	"partyparty/internal/event"
	"partyparty/internal/mediamtx"
	"partyparty/internal/peers"
	"partyparty/internal/relay"
	"partyparty/internal/stats"
)

type Deps struct {
	Config      config.Config
	Broadcaster *broadcast.Broadcaster
	Listeners   *stats.Listeners
	RunDir      string
	Web         fs.FS
	MTX         *mediamtx.Server // nil if mediamtx unavailable (LL-HLS disabled)
	Peers       *peers.Directory // nil when Bonjour discovery is unavailable
	PeerID      string
	Relay       *relay.Manager // nil only in tests or explicit local development

	// Contribute reports whether this Mac's push to the relay origin is
	// actually succeeding. Presence (relay.fresh) and media push are separate
	// planes that fail separately - a set ran for hours with presence healthy
	// while the media push 401ed on every cycle and relayed guests got a dead
	// page, and the console had no way to know. nil in tests.
	Contribute interface{ Snapshot() contribute.Status }

	// Events is the party's active-room social layer.
	// nil disables the feed endpoints.
	Events *event.Store

	// Diag is the session diagnostics log (nil = off): guest joins, room
	// snapshots, anything support would need after a bad party.
	Diag *diag.Logger

	// Version is the app build version - shown in UIs and broadcast to clients
	// so stale player pages refresh themselves after an update.
	Version string
}

type srv struct {
	Deps
	isolation isolationProbe
	// go-live trace: observed OUTSIDE the audio core, so the console can show
	// which stage a slow start is in and the log can say afterwards where the
	// time went. The engine itself stays untouched.
	startMu        sync.Mutex
	startRequested time.Time
	startMTXReady  time.Time
	startLiveAt    time.Time
	startRelayAt   time.Time
	vendor         http.Handler
	liveProxy      http.Handler
	limits         *limiter

	// What the origin last reported about relayed guests. Guarded by relayMu.
	relayMu        sync.RWMutex
	relayListeners int
	relaySpreadMs  float64
	relayGuests    []RelayGuest
	relayAt        time.Time

	// Async activation result (cert broker / BYO) - set after launch so the
	// server can start serving instantly while certs are obtained in the
	// background. Guarded by actMu.
	actMu      sync.Mutex
	actDomain  string
	actReason  string // why activation isn't ready yet (console pending state)
	actLast    activate.Result
	actLastSet bool

	peersMu sync.RWMutex

	hostCache  sync.Map // ip -> reverse-DNS device name ("" = looked up, nothing useful)
	seenCIDs   sync.Map // cid -> true (first-heartbeat join logging)
	clientLogN sync.Map // cid -> *int32 (client error reports, capped per guest)
	clientEvN  int32    // global event ceiling - a rotating cid can't defeat this
	clientCIDs int32    // distinct-cid ceiling - a rotating cid can't grow clientLogN without bound

	// streamHealthNote: set by the go-live health check (main.go) when the
	// broadcast reports "live" but MediaMTX has no publisher on the path -
	// i.e. guests hear nothing. Surfaced in /api/status so the console tells
	// the DJ honestly instead of showing a false "Live". Guarded by healthMu.
	healthMu         sync.Mutex
	streamHealthNote string

	// streamSync caches one lightweight playlist inspection per live generation.
	// It prevents native HLS clients from attaching while MediaMTX's required
	// initial GAP segments are the only history at the room target. After the
	// ready latch it keeps a slow pulse purely for gap telemetry: fresh GAP
	// parts at the live edge mean the INGEST starved (capture-side stall) and
	// deserve a timestamped diag line while the set is still running.
	streamSyncMu           sync.Mutex
	streamSyncGeneration   int64
	streamSyncReadiness    mediamtx.HLSReadiness
	streamSyncCheckedAt    time.Time
	streamSyncChecking     bool
	streamSyncReady        bool
	streamSyncChecks       int
	streamSyncLastGap      float64
	streamSyncGapBaselined bool

	// audioProven: Mac-audio capture has gone live at least once on this
	// install, so the system-audio permission is provably granted. macOS has no
	// status API for Core Audio tap permission, so this observed proof is the
	// ONLY reliable signal. Persisted server-side (Application Support) because
	// the console's earlier localStorage flag was origin-scoped and got wiped by
	// origin changes and data-store resets - which re-scared DJs with a
	// "permission not confirmed" banner on Macs that were already granted.
	audioProven     atomic.Bool
	audioProvenSave sync.Once
}

func New(d Deps) *Srv {
	s := &Srv{srv{
		Deps: d, vendor: http.FileServer(http.FS(d.Web)),
		limits: newLimiter(),
	}}
	// The /live proxy keeps LL-HLS on the guest page's HTTPS origin without
	// rewriting MediaMTX's low-latency playlist.
	s.liveProxy = newLiveProxy(d.Config.HLSPort, "/live")
	if _, err := os.Stat(audioProvenPath()); err == nil {
		s.audioProven.Store(true)
	}
	return s
}

// diagPath reports where this run's session log is being written, or "" when
// diagnostics are off. The 2026-08-03 party produced no session log anywhere
// and nothing surfaced that fact, which turned a debuggable failure into
// archaeology - so the path rides /api/status where it can be checked in one
// request.
func (s *srv) diagPath() string {
	if s.Diag == nil {
		return ""
	}
	return s.Diag.Path()
}

// audioProvenPath is the durable "Mac audio capture has worked here" marker -
// ~/Library/Application Support/PartyParty/audio-proven. Empty string disables
// persistence (in-memory only) when the config dir is unavailable.
func audioProvenPath() string {
	dir, err := activate.StateDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "audio-proven")
}

// markAudioProven records the observed proof, once, without blocking /api/status.
func (s *srv) markAudioProven() {
	if s.audioProven.Swap(true) {
		return
	}
	s.audioProvenSave.Do(func() {
		go func() {
			p := audioProvenPath()
			if p == "" {
				return
			}
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte("1\n"), 0o644)
		}()
	})
}

// newLiveProxy keeps the guest page and LL-HLS on one public HTTPS origin.
// MediaMTX remains loopback-only from the Go server's point of view; guests no
// longer need a second TLS connection to a second externally reachable port.
func newLiveProxy(hlsPort int, prefix string) http.Handler {
	upstream := fmt.Sprintf("127.0.0.1:%d", hlsPort)
	return &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme = "https"
			r.URL.Host = upstream
			r.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
			r.Host = upstream
		},
		Transport: &http.Transport{
			TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // loopback MediaMTX uses the same hot-swapped cert
			MaxIdleConns:        64,
			MaxIdleConnsPerHost: 64,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression:  true,
		},
		FlushInterval: -1,
		ModifyResponse: func(resp *http.Response) error {
			// MediaMTX's cookie capability probe redirects to an origin-absolute
			// path. Preserve the public /live prefix or Safari follows the redirect
			// outside the proxy and gets the app's 404 page.
			if location := resp.Header.Get("Location"); strings.HasPrefix(location, "/") && !strings.HasPrefix(location, prefix+"/") {
				resp.Header.Set("Location", prefix+location)
			}
			// Author the room schedule into the media playlist (see schedule.go).
			// Media bytes, timestamps, and PROGRAM-DATE-TIME pass through
			// untouched; only the declared distance from the live edge is ours.
			if resp.Request != nil && resp.StatusCode == http.StatusOK &&
				strings.HasSuffix(resp.Request.URL.Path, ".m3u8") {
				body, err := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				if err != nil {
					return err
				}
				body = rewriteLivePlaylist(body)
				resp.Body = io.NopCloser(bytes.NewReader(body))
				resp.ContentLength = int64(len(body))
				resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "live stream temporarily unavailable", http.StatusBadGateway)
		},
	}
}

func (s *srv) webFS() fs.FS {
	return s.Web
}

func (s *srv) version() string {
	return s.Version
}

func (s *srv) payloadConfig() json.RawMessage {
	if data, err := fs.ReadFile(s.Web, "config.json"); err == nil && json.Valid(data) {
		return json.RawMessage(data)
	}
	return nil
}

// Srv is the exported handle: an http.Handler plus the async-activation hook.
type Srv struct{ srv }

// AllowHTTPFallback permits the explicit offline emergency link only when the
// current LAN IP is known and the secure hostname cannot be resolved. Normal
// HTTP requests continue to redirect to HTTPS, and an old IP never becomes a
// second way into the room.
func (s *Srv) AllowHTTPFallback(r *http.Request) bool {
	if r == nil || r.TLS != nil {
		return false
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = strings.TrimSpace(r.Host)
	}
	lan := s.lanStateSnapshot()
	connection := s.connectionState()
	return host != "" && host == lan.ExpectedIP && lan.ExpectedIP != "" &&
		!connection.InternetOK && connection.Mode == relay.ModeNoPath &&
		connection.Reason == relay.ReasonResolverBad
}

// SetActivation records a completed low-latency activation (real cert +
// resolvable domain). Guest/stream URLs and the console's LL-HLS gate flip
// live on the next status poll.
// SetActivationResult caches the latest online activation attempt (cert / host /
// LAN IP) for lanStateSnapshot to read. It never switches network mode.
func (s *Srv) SetActivationResult(res activate.Result) {
	s.actMu.Lock()
	// A failed online refresh is not evidence that the cached certificate or
	// current LAN identity disappeared. Preserve the last usable activation so
	// an offline party can still choose the hostname or the guarded IP fallback.
	// Explicit certificate/DNS failures carry structured evidence and must not
	// be hidden by this fail-soft path.
	if !res.CertReady && res.ReasonCode == "" && s.actLastSet && s.actLast.CertReady {
		if res.ExpectedIP != "" && res.ExpectedIP != s.actLast.ExpectedIP {
			s.actLast.ExpectedIP = res.ExpectedIP
			s.actLast.DNSPublished = false
			s.actLast.ResolverMatches = false
			s.actLast.ResolverObserved = false
		}
	} else {
		s.actLast = res
	}
	s.actLastSet = true
	s.actMu.Unlock()
	// The resolver observation is the evidence that decides whether guests can
	// find this Mac with no internet at all, so it belongs in the mode decision
	// rather than only in the LAN-readiness display. Only when an observation
	// was actually made: an attempt that died before reaching the resolver (no
	// internet) knows nothing, and its zero value stomping a real observation
	// is what kept an offline party on NO PATH while its router resolved fine.
	if s.Relay != nil && res.ResolverObserved {
		s.Relay.SetResolverOK(res.ResolverMatches)
	}
}

func (s *Srv) SetActivation(domain string) {
	s.actMu.Lock()
	s.actDomain = domain
	s.actReason = ""
	// Stamp engaged-OK + host but PRESERVE the structured evidence the immediately
	// preceding SetActivationResult recorded (CertReady / ExpectedIP / DNSPublished
	// / ResolverMatches / ReasonCode). Overwriting the whole struct here used to
	// zero that evidence, which would make the LAN-readiness reducer wrongly read
	// "unavailable" right after a successful activation.
	s.actLast.OK = true
	s.actLast.Host = domain
	s.actLastSet = true
	resolverOK := s.actLast.ResolverMatches
	resolverObserved := s.actLast.ResolverObserved
	s.actMu.Unlock()
	if s.Relay != nil {
		if resolverObserved {
			s.Relay.SetResolverOK(resolverOK)
		}
		s.Relay.SetDirectURL(s.directGuestURL())
	}
}

// SetActivationPending records why the secure link isn't ready yet - shown in
// the console while Go Live is gated.
func (s *Srv) SetActivationPending(reason string) {
	s.actMu.Lock()
	if s.actDomain == "" {
		s.actReason = reason
	}
	s.actMu.Unlock()
}

// SetPeers installs discovery after asynchronous secure-link activation. Fresh
// Store installs do not have a broker hostname when the server is constructed,
// so discovery cannot be treated as a launch-only dependency.
func (s *Srv) SetPeers(directory *peers.Directory, peerID string) {
	s.peersMu.Lock()
	s.Peers = directory
	s.PeerID = peerID
	s.peersMu.Unlock()
}

// SetStreamHealth records the go-live health verdict (main.go's health check).
// Empty = healthy (guests can hear); non-empty = a DJ-facing warning that the
// broadcast shows "live" but the guest stream never reached MediaMTX.
func (s *Srv) SetStreamHealth(note string) {
	s.healthMu.Lock()
	s.streamHealthNote = note
	s.healthMu.Unlock()
}

func (s *srv) streamHealthText() string {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	return s.streamHealthNote
}

func (s *srv) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Private Network Access preflight (Chromium): the cloud join page probes this
	// LAN host from a public origin to prove the guest is on the party's Wi-Fi.
	// Chromium may preflight such public→private requests; answering with
	// Allow-Private-Network keeps the probe (and any future PNA-gated fetch) from
	// false-negativing an on-LAN guest. Read-only, no credentials - allowing any
	// origin is safe here.
	if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Private-Network", "true")
		h.Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	p := r.URL.Path
	switch {
	case p == "/":
		s.serveWeb(w, r, "listener.html", "no-cache")
	case p == "/dj" || p == "/dj/":
		s.serveWeb(w, r, "dj.html", "no-cache")
	case p == "/wall" || p == "/wall/":
		s.serveWeb(w, r, "wall.html", "no-cache")
	case p == "/art-512.png":
		s.serveWeb(w, r, "art-512.png", "")
	case p == "/favicon.ico":
		w.WriteHeader(http.StatusNoContent)
	case p == "/event-cover":
		if s.Events == nil {
			http.NotFound(w, r)
			return
		}
		cover, ok := s.Events.CoverPath()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		serveDiskFile(w, r, cover)
	case p == "/dj-avatar":
		if s.Events == nil {
			http.NotFound(w, r)
			return
		}
		avatar, ok := s.Events.AvatarPath()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		serveDiskFile(w, r, avatar)
	case strings.HasPrefix(p, "/covers/"):
		w.Header().Set("Cache-Control", "public, max-age=3600")
		s.vendor.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/vendor/"):
		// Through serveWeb (not the FileServer) so text assets gzip - hls.js is
		// 404KB plain, ~130KB gzipped, fetched by every non-Apple guest.
		s.serveWeb(w, r, strings.TrimPrefix(p, "/"), "public, max-age=3600")
	case strings.HasPrefix(p, "/fonts/"):
		// The bundled typeface. It is immutable for a given build, so it may be
		// cached hard; the guest page declares font-display:swap so a cold fetch
		// never holds up the join.
		s.serveWeb(w, r, strings.TrimPrefix(p, "/"), "public, max-age=31536000, immutable")
	case strings.HasPrefix(p, "/live/"):
		s.liveProxy.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/media/"):
		s.handleMedia(w, r)
	case strings.HasPrefix(p, "/api/"):
		if s.handleFeedAPI(w, r) {
			return
		}
		s.handleAPI(w, r)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

type urls struct {
	Primary string `json:"primary"`
	Join    string `json:"join,omitempty"`
}

// AdvertisedGuestPort is the port guests use to reach this Mac: always the
// direct TLS listener. An earlier build could advertise a bare :443 (hiding the
// port) whenever a TLS handshake
// succeeded there - but the handshake never proved the redirect actually
// forwarded, so a half-broken helper (e.g. one that lost its approval in a macOS
// reset) handed guests a dead port-less link in the QR while
// https://<host>:<tlsPort>/ still worked. Reliability beats a cosmetic port, so
// the guest link is always the proven direct path.
func (s *srv) AdvertisedGuestPort() int {
	return s.Config.TLSPort
}

func (s *srv) urls() urls {
	// The Plex model: the ONLY advertised link is https:// on the activated
	// domain. The page itself requires working DNS + TLS - exactly the gate
	// that guarantees the LL stream will play for whoever loaded it. No http
	// fallback link is ever shown; until activation completes, Primary stays
	// http and the console renders a "setting up the secure link" state.
	if d := s.liveDomain(); d != "" && s.realCert() {
		port := s.AdvertisedGuestPort()
		direct := fmt.Sprintf("https://%s:%d/", d, port)
		join := direct
		if s.Relay != nil {
			// The relay manager is the single authority on what the QR encodes:
			// it already weighs the mode, the registered bootstrap and the direct
			// URL. Re-deciding it here is what deadlocked 125.x. This switch used
			// to blank the join URL for the whole of CHECKING unless a field
			// called RelayConnected was set, and that field belonged to the
			// socket relay that no longer exists, so nothing ever set it. The QR
			// was therefore withheld for every CHECKING install, and CHECKING
			// only ends when a guest scans the withheld QR and reports the probe.
			// The console sat on "Creating secure guest link" forever.
			join = ""
			if connection := s.Relay.Snapshot(); strings.HasPrefix(connection.JoinURL, "https://") {
				join = connection.JoinURL
			}
		}
		return urls{Primary: direct, Join: join}
	}
	return urls{}
}

func (s *srv) directGuestURL() string {
	if d := s.liveDomain(); d != "" && s.realCert() {
		return fmt.Sprintf("https://%s:%d/", d, s.AdvertisedGuestPort())
	}
	return ""
}

func (s *srv) connectionState() relay.Status {
	if s.Relay != nil {
		return s.Relay.Snapshot()
	}
	direct := s.directGuestURL()
	if direct == "" {
		return relay.Status{
			Mode:    relay.ModeChecking,
			Message: "Preparing the secure guest connection.",
		}
	}
	return relay.Status{
		Mode:         relay.ModeDirect,
		Reason:       relay.ReasonProbeDirect,
		Override:     relay.OverrideAuto,
		JoinURL:      direct,
		DirectURL:    direct,
		KnownNetwork: false,
		Message:      "Guests are connecting directly to this Mac on the venue Wi-Fi.",
	}
}

// serveDiskFile serves a real file while defeating http.ServeFile's sendfile
// fast path. Inside the App Sandbox on macOS 27 (seed 26A5388g), sendfile(2)
// silently truncates the response to the first 512 bytes: a plain GET of a
// 194KB avatar delivered exactly 512 bytes while Range reads of the same file
// returned every byte - ranges flow through io.CopyN, which hides the
// *os.File from the fast path. Wrapping the file the same way keeps
// ServeContent's Range and modtime semantics with a buffered copy.
func serveDiskFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), struct{ io.ReadSeeker }{f})
}

func (s *srv) serveWeb(w http.ResponseWriter, r *http.Request, name, cache string) {
	data, err := fs.ReadFile(s.webFS(), name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if strings.HasSuffix(name, ".html") {
		// Stamp the effective content version into the page so it can detect an
		// app OR payload update and refresh itself (stale open tabs run old
		// logic forever).
		data = []byte(strings.ReplaceAll(string(data), "__PP_VERSION__", s.version()))
	}
	if name == "dj.html" {
		// The server already knows whether its cached certificate is engaged.
		// Embed that stable URL in the first document so the QR does not depend
		// on a later /api/status fetch or the rest of the console renderer.
		initialURL, _ := json.Marshal(s.urls().Join)
		data = []byte(strings.ReplaceAll(
			string(data),
			"__PP_INITIAL_GUEST_URL_JSON__",
			string(initialURL),
		))
	}
	w.Header().Set("Content-Type", mimeFor(name))
	if cache != "" {
		w.Header().Set("Cache-Control", cache)
	}
	if compressibleAsset(name) && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		zw, zerr := gzip.NewWriterLevel(w, gzip.BestSpeed)
		if zerr == nil {
			_, _ = zw.Write(data)
			_ = zw.Close()
			return
		}
	}
	_, _ = w.Write(data)
}

// compressibleAsset: text assets worth gzipping on the fly. The big win is
// vendor/hls.js (~404KB -> ~130KB) for every Android/desktop-Chrome guest on
// congested venue Wi-Fi; images and media are already compressed.
func compressibleAsset(name string) bool {
	for _, ext := range []string{".html", ".js", ".css", ".svg", ".json", ".txt", ".map"} {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	return false
}

func (s *srv) handleAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/connection-mode":
		// The DJ's connection preference. POST {"override":"auto|direct|relay|local"}
		// sets it; any method returns the current state. Automatic is the default
		// and right almost always; the rest are preferences with honest fallback,
		// never forced dead ends, so asking for relay with no internet reports
		// NO PATH rather than pretending.
		if s.Relay == nil {
			writeJSON(w, http.StatusOK, map[string]any{"override": relay.OverrideAuto, "available": false})
			return
		}
		if r.Method == http.MethodPost {
			var body struct {
				Override string `json:"override"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.Relay.SetOverride(strings.TrimSpace(body.Override))
		}
		connection := s.Relay.Snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"override":  s.Relay.Override(),
			"available": true,
			"mode":      connection.Mode,
			"reason":    connection.Reason,
			"message":   connection.Message,
		})
	case "/api/status":
		bc := s.Broadcaster.Status()
		if bc.State == "live" && bc.Device == "mac" {
			s.markAudioProven()
		}
		health := s.Listeners.Health(bc.State == "live", kbps(bc.Bitrate))
		health.Suggestion = suggest(health.Status, bc)
		latencyTarget := s.latencyTarget(bc, health.Status)
		roster := s.Listeners.Roster()
		var rosterBody any = roster
		if !s.isDJ(r) {
			public := make([]map[string]string, 0, len(roster))
			for _, listener := range roster {
				public = append(public, map[string]string{"name": listener.Name, "emoji": listener.Emoji})
			}
			rosterBody = public
		}
		rosterBody, roomListeners := s.roomRoster(rosterBody)
		writeJSONGzip(w, r, http.StatusOK, map[string]any{
			"name":           s.Config.Name,
			"appVersion":     s.version(),
			"broadcast":      broadcastStatus(bc),
			"listeners":      roomListeners,
			"listenersTotal": s.Listeners.TotalUnique(),
			"health":         health,
			"urls":           s.urls(),
			"lan":            s.lanStateSnapshot(), // honest LAN readiness from observed LAN vs cloud listeners
			"connection":     s.connectionState(),
			"llhlsUrl":       s.llhlsURLFor(r),
			"llhlsAvailable": s.MTX != nil,
			"llhlsRealCert":  s.realCert(),
			"audioProven":    s.audioProven.Load(),
			"activation":     s.activationState(),
			"latencyTarget":  latencyTarget,
			"streamSync":     s.streamSyncState(bc, latencyTarget),
			"log":            lastN(s.Broadcaster.Log(), 60),
			"diagPath":       s.diagPath(), // "" = session log unavailable; a whole night once ran with no log and no way to notice
			"startup":        s.startupTrace(bc.State),
			"latency":        s.Listeners.LatencySpread(),
			"relay":          s.relayPresenceState(),
			"schedule":       s.scheduleState(),
			"roster":         rosterBody,
			"listenerGroups": s.listenerGroups(roster),
			"event":          s.eventState(),
			"config":         s.payloadConfig(),
			"streamHealth":   s.streamHealthText(),
			"peers":          s.peerList(),
		})
	case "/api/peer":
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		writeJSON(w, http.StatusOK, s.peerState(since))
	case "/api/track":
		s.handleTrackPost(w, r)
	case "/api/reach":
		if !s.requireDJ(w, r) {
			return
		}
		if s.Relay == nil {
			writeJSON(w, http.StatusOK, map[string]any{"reach": relay.ReachWiFi, "available": false})
			return
		}
		if r.Method == http.MethodPost {
			var body struct {
				Reach string `json:"reach"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.Relay.SetReach(strings.TrimSpace(body.Reach))
		}
		writeJSON(w, http.StatusOK, map[string]any{"reach": s.Relay.Reach(), "available": true})
	case "/api/time":
		// Master clock for the listeners' NTP-style offset estimate. Expose the
		// server receive/transmit pair so clients can use the full four-timestamp
		// calculation instead of assuming all response time was symmetric.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		received := time.Now().UnixMilli()
		sent := time.Now().UnixMilli()
		writeJSON(w, http.StatusOK, map[string]any{"t": sent, "received": received, "sent": sent})
	case "/api/client-log":
		// Guest-side error reports into the session diagnostics. Field lesson:
		// a phone whose JOIN button silently fails never heartbeats - it was
		// completely invisible. Now the page tells us what broke.
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		var body struct{ CID, V, Kind, Msg string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return
		}
		nAny, _ := s.clientLogN.LoadOrStore(body.CID, new(int32))
		if atomic.AddInt32(nAny.(*int32), 1) <= 25 { // cap per guest - no log floods
			if s.Diag != nil {
				s.Diag.Printf("client[%s v%s]: %s: %s", clientIP(r), clipStr(body.V, 16), clipStr(body.Kind, 16), clipStr(body.Msg, 300))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/client-events":
		// The black-box recorder: a batched, structured event stream from every
		// client (open+environment, play/stall/recover/align/error, multi-tab,
		// periodic health) folded into the session log so a guest's whole story
		// is visible after the fact. Important events flag a prompt cloud upload.
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		var body struct {
			CID, Tab, V, Plat, Page string
			Events                  []map[string]any
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return
		}
		// Bound the memory a LAN peer can consume: an empty batch tracks nothing,
		// the cid is length-clipped so the map key can't be huge, and a rotating
		// cid can't grow clientLogN without limit - past the distinct-cid ceiling
		// we accept-and-ignore (existing clients keep working). This closes the
		// unauthenticated map-growth DoS the per-event cap alone didn't.
		if len(body.Events) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		body.CID = clipStr(body.CID, 64)
		who := fmt.Sprintf("%s %s.%s v%s %s", clientIP(r), clipStr(body.CID, 14), clipStr(body.Tab, 12), clipStr(body.V, 16), clipStr(body.Page, 6))
		if body.Page == "guest" || body.Page == "" { // enrich guest attribution with the device name
			who = s.friendlyName(clientIP(r), r.UserAgent()) + " | " + who
		}
		key := "ev:" + body.CID
		if _, seen := s.clientLogN.Load(key); !seen && atomic.AddInt32(&s.clientCIDs, 1) > 20000 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return // distinct-client ceiling hit - stop tracking new cids
		}
		nAny, _ := s.clientLogN.LoadOrStore(key, new(int32))
		urgent := false
		for i, ev := range body.Events {
			if i >= 200 { // one batch is a burst, not a flood
				break
			}
			if atomic.AddInt32(nAny.(*int32), 1) > 5000 { // generous per-session cap (no users yet)
				break
			}
			// Global ceiling: a peer rotating cid every batch can't defeat the
			// per-cid cap, so bound total logged events for the process too -
			// past it we stop appending and stop forcing cloud uploads.
			if atomic.AddInt32(&s.clientEvN, 1) > 500000 {
				break
			}
			kind, _ := ev["k"].(string)
			delete(ev, "k")
			if s.Diag != nil {
				s.Diag.Printf("ev[%s] %s %s", who, clipStr(kind, 20), compactFields(ev))
			}
			switch kind {
			case "error", "media", "play-failed", "join-stuck", "reconnect", "offline", "dj-stop", "dj-switch-failed":
				urgent = true
			}
		}
		if urgent && s.Diag != nil {
			s.Diag.MarkUrgent() // ship the log to the cloud within seconds, not on the 30s tick
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/heartbeat":
		q := r.URL.Query()
		key := q.Get("cid")
		if key == "" {
			key = clientIP(r)
		}
		lat, hasLat := 0.0, false
		if v := q.Get("lat"); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
				lat, hasLat = f, true
			}
		}
		if q.Get("v") == "" {
			// Legacy zombie tab: every page since 0.13 sends its version, but
			// pages older than the self-refresh mechanism heartbeat FOREVER
			// (field: a days-old Chrome tab inflating the listener count as a
			// permanently-paused ghost). Acknowledge and ignore.
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		if _, known := s.seenCIDs.LoadOrStore(key, true); !known {
			if s.Diag != nil {
				s.Diag.Printf("guest joined: %s ip=%s plat=%s pageV=%s", s.friendlyName(clientIP(r), r.UserAgent()), clientIP(r), q.Get("plat"), q.Get("v"))
			}
		}
		s.Listeners.Heartbeat(key, q.Get("stalled") == "1", q.Get("paused") == "1", lat, hasLat, q.Get("plat"))
		s.Listeners.Selection(key, clipStr(strings.TrimSpace(q.Get("dj")), 160))
		rate, _ := strconv.ParseFloat(q.Get("rate"), 64)
		buf, _ := strconv.ParseFloat(q.Get("buf"), 64)
		s.Listeners.Debug(key, rate, buf)
		s.Listeners.Meta(key, clientIP(r), s.friendlyName(clientIP(r), r.UserAgent()))
		s.Listeners.Identity(key, clipStr(strings.TrimSpace(q.Get("name")), 40), clipStr(strings.TrimSpace(q.Get("emoji")), 16))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/open-settings":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		// Core Audio process taps use the dedicated System Audio Recording Only
		// privacy pane. Screen Recording is not required.
		switch r.URL.Query().Get("pane") {
		case "mic":
			_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").Start()
		default: // "audio" / anything → the audio-recording pane
			_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture").Start()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/devices":
		if !s.requireDJ(w, r) {
			return
		}
		devs := devices.List(s.Config.FFmpeg)
		writeJSON(w, http.StatusOK, map[string]any{
			"devices":     devs,
			"hasVirtual":  devices.HasVirtual(devs),
			"systemAudio": s.Broadcaster.SystemAudioAvailable(),
		})
	case "/api/start":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		q := r.URL.Query()
		device := q.Get("device")
		if device == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "device required"})
			return
		}
		// Every guest path is HTTPS LL-HLS, so a real device cannot go live
		// before the cached or freshly issued certificate is active.
		if device != "test" && !s.realCert() {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "secure guest link isn't ready yet - hold on (needs internet once)"})
			return
		}
		// One fixed LL timing profile now (no latency modes, no MediaMTX
		// bouncing) - but a start must still revive a silently-dead MediaMTX,
		// or ffmpeg pushes into the void and guests see a "live" broadcast
		// nobody can hear. If a stale orphan owns the ports, reap and retry.
		s.startMu.Lock()
		s.startRequested = time.Now()
		s.startMTXReady, s.startLiveAt, s.startRelayAt = time.Time{}, time.Time{}, time.Time{}
		s.startMu.Unlock()
		if s.MTX != nil && !s.MTX.Running() {
			err := s.MTX.EnsureReady(s.Config.RTSPPort, s.Config.HLSPort, 6*time.Second)
			if err != nil {
				if n := mediamtx.ReapOrphans(s.Config.RTSPPort, s.Config.HLSPort); n > 0 {
					err = s.MTX.EnsureReady(s.Config.RTSPPort, s.Config.HLSPort, 6*time.Second)
				}
			}
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "low-latency engine failed to start: " + err.Error()})
				return
			}
		}
		s.startMu.Lock()
		s.startMTXReady = time.Now()
		s.startMu.Unlock()
		// A fresh start voids the previous set's health verdict: the warning
		// otherwise haunts the console until the next verdict lands ~7s in.
		s.healthMu.Lock()
		s.streamHealthNote = ""
		s.healthMu.Unlock()
		s.Broadcaster.Start(device, q.Get("name"), broadcast.Options{})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/stop":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		s.Broadcaster.Stop()
		// Stopped means the warning's moment is over; a stale scare must not
		// outlive the set it described.
		s.healthMu.Lock()
		s.streamHealthNote = ""
		s.healthMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/shutdown":
		// Loopback-only orphan reaper: a force-quit app skips child cleanup and
		// the leftover server squats on the port; the next launch asks it to
		// exit. Never reachable from the LAN.
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if ip := clientIP(r); ip != "127.0.0.1" && ip != "::1" && ip != "1" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "localhost only"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		go func() {
			time.Sleep(300 * time.Millisecond)
			os.Exit(0)
		}()
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown api"})
	}
}

func (s *srv) peerState(since int64) peers.Peer {
	s.peersMu.RLock()
	peerID := s.PeerID
	s.peersMu.RUnlock()
	bc := s.Broadcaster.Status()
	name := strings.TrimSpace(s.Config.Name)
	if s.Events != nil {
		if host := strings.TrimSpace(s.Events.Meta().Host); host != "" {
			name = host
		}
	}
	if name == "" {
		name = "PartyParty DJ"
	}
	syncState := s.streamSyncState(bc, roomLatencyTarget)
	ready, _ := syncState["ready"].(bool)
	generation, _ := syncState["generation"].(int64)
	roster := s.Listeners.Roster()
	publicRoster := make([]peers.Guest, 0, len(roster))
	for _, listener := range roster {
		publicRoster = append(publicRoster, peers.Guest{
			ID: listener.ID, Name: listener.Name, Emoji: listener.Emoji, Paused: listener.Paused, DJID: listener.DJID,
		})
	}
	var posts []event.Post
	var ids []string
	var cursor int64
	if s.Events != nil {
		posts, ids, _, cursor = s.Events.FeedFor(since, "", false)
	}
	var nowPlaying *event.CurrentTrack
	var links []event.Link
	var bio, avatar string
	if s.Events != nil {
		nowPlaying, _ = s.Events.TrackSnapshot()
		meta := s.Events.Meta()
		links, bio, avatar = meta.Links, meta.Bio, meta.Avatar
	}
	if posts == nil {
		posts = []event.Post{}
	}
	if ids == nil {
		ids = []string{}
	}
	return peers.Peer{
		ID:            peerID,
		Name:          name,
		Bio:           bio,
		Avatar:        avatar,
		RoomURL:       s.urls().Primary,
		StreamURL:     s.llhlsURL(),
		Live:          bc.State == "live",
		Ready:         ready,
		Generation:    generation,
		LatencyTarget: roomLatencyTarget,
		NowPlaying:    nowPlaying,
		Links:         links,
		Room:          &peers.Room{Roster: publicRoster, Posts: posts, IDs: ids, Cursor: cursor},
	}
}

func (s *srv) peerList() []peers.Peer {
	s.peersMu.RLock()
	directory := s.Peers
	s.peersMu.RUnlock()
	if directory == nil {
		return []peers.Peer{}
	}
	out := directory.Peers()
	for i := range out {
		out[i].Room = nil
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name == out[j].Name {
			return out[i].ID < out[j].ID
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (s *srv) roomRoster(local any) (any, int) {
	switch roster := local.(type) {
	case []map[string]string:
		out := append([]map[string]string(nil), roster...)
		for _, guest := range s.RelayGuests() {
			out = append(out, map[string]string{"name": guest.Name, "emoji": guest.Emoji})
		}
		for _, peer := range s.roomPeers() {
			if peer.Room == nil {
				continue
			}
			for _, guest := range peer.Room.Roster {
				out = append(out, map[string]string{"name": guest.Name, "emoji": guest.Emoji})
			}
		}
		return out, len(out)
	default:
		// The DJ console retains detailed local health rows. Remote guests are
		// appended as public identity-only rows because their playback health
		// belongs to the Mac serving their stream.
		out, _ := json.Marshal(local)
		var rows []map[string]any
		_ = json.Unmarshal(out, &rows)
		for _, guest := range s.RelayGuests() {
			rows = append(rows, map[string]any{
				"name": guest.Name, "emoji": guest.Emoji, "remote": true,
			})
		}
		for _, peer := range s.roomPeers() {
			if peer.Room == nil {
				continue
			}
			for _, guest := range peer.Room.Roster {
				rows = append(rows, map[string]any{"name": guest.Name, "emoji": guest.Emoji, "remote": true})
			}
		}
		return rows, len(rows)
	}
}

type publicListener struct {
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
}

type publicListenerGroup struct {
	ID        string           `json:"id,omitempty"`
	DJ        string           `json:"dj"`
	Listeners []publicListener `json:"listeners"`
}

func (s *srv) listenerGroups(local []stats.Listener) []publicListenerGroup {
	name := strings.TrimSpace(s.Config.Name)
	if s.Events != nil {
		if host := strings.TrimSpace(s.Events.Meta().Host); host != "" {
			name = host
		}
	}
	if name == "" {
		name = "This DJ"
	}
	groups := []publicListenerGroup{{DJ: name, Listeners: []publicListener{}}}
	groupIndex := map[string]int{"": 0}
	roomPeers := s.roomPeers()
	for _, peer := range roomPeers {
		groupIndex[peer.ID] = len(groups)
		groups = append(groups, publicListenerGroup{
			ID: peer.ID, DJ: peer.Name, Listeners: []publicListener{},
		})
	}

	type assignment struct {
		group  string
		person publicListener
		active bool
	}
	assignments := make(map[string]assignment)
	fallbackKey := func(name, emoji string) string {
		return "name:" + strings.ToLower(strings.TrimSpace(name)) + "\x00" + strings.TrimSpace(emoji)
	}
	assign := func(id, listenerName, emoji, group string, active bool) {
		if id == "" {
			id = fallbackKey(listenerName, emoji)
		}
		if current, ok := assignments[id]; ok && current.active && !active {
			return
		}
		assignments[id] = assignment{
			group: group, active: active,
			person: publicListener{Name: listenerName, Emoji: emoji},
		}
	}
	for _, listener := range local {
		assign(listener.ID, listener.Name, listener.Emoji, listener.DJID, !listener.Paused)
	}
	for _, listener := range s.RelayGuests() {
		assign(listener.ID, listener.Name, listener.Emoji, listener.DJID, !listener.Paused)
	}
	for _, peer := range roomPeers {
		if peer.Room == nil {
			continue
		}
		for _, listener := range peer.Room.Roster {
			group := listener.DJID
			if group == "" {
				group = peer.ID
			}
			assign(listener.ID, listener.Name, listener.Emoji, group, !listener.Paused)
		}
	}

	for _, listener := range assignments {
		if i, ok := groupIndex[listener.group]; ok {
			groups[i].Listeners = append(groups[i].Listeners, listener.person)
		}
	}
	sortPeople := func(people []publicListener) {
		sort.Slice(people, func(i, j int) bool {
			return strings.ToLower(people[i].Name) < strings.ToLower(people[j].Name)
		})
	}
	for i := range groups {
		sortPeople(groups[i].Listeners)
	}
	return groups
}

// startupTrace reports where a go-live spent its time, from transitions this
// process observes without touching the audio core: the API request, the
// low-latency engine ready, capture reporting live, the relay serving. Zero
// means "not reached yet". The console stages its "starting" copy off these
// facts, and the numbers stay readable here afterwards.
func (s *srv) startupTrace(state string) map[string]any {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if s.startRequested.IsZero() {
		return nil
	}
	if state == "live" && s.startLiveAt.IsZero() {
		s.startLiveAt = time.Now()
	}
	if s.startRelayAt.IsZero() {
		if rp := s.relayPresenceState(); rp["fresh"] == true {
			s.startRelayAt = time.Now()
		}
	}
	ms := func(t time.Time) int64 {
		if t.IsZero() {
			return 0
		}
		return t.UnixMilli()
	}
	return map[string]any{
		"requestedMs": ms(s.startRequested),
		"engineMs":    ms(s.startMTXReady),
		"liveMs":      ms(s.startLiveAt),
		"relayMs":     ms(s.startRelayAt),
	}
}

func (s *srv) roomPeers() []peers.Peer {
	s.peersMu.RLock()
	directory := s.Peers
	s.peersMu.RUnlock()
	if directory == nil {
		return nil
	}
	return directory.Peers()
}

func broadcastStatus(status broadcast.Status) map[string]any {
	return map[string]any{
		"state":      status.State,
		"device":     status.Device,
		"deviceName": status.DeviceName,
		"since":      status.Since,
		"bitrate":    status.Bitrate,
		"channels":   status.Channels,
		"sampleRate": status.SampleRate,
		"lastError":  status.LastError,
		"note":       status.Note,
		"captureBad": status.CaptureBad,
	}
}

// llhlsURL is the one guest stream URL, available once the cert-backed LAN
// hostname is active.
func (s *srv) llhlsURL() string {
	if !s.realCert() {
		return ""
	}
	host := s.liveDomain()
	if host == "" {
		return ""
	}
	return fmt.Sprintf("https://%s:%d/live/%s/index.m3u8", host, s.Config.TLSPort, s.Config.StreamPath)
}

// relayPublishedPlaylist is the playlist name contribution publishes to the
// origin. Kept in step with contribute.PublishedPlaylist.
const relayPublishedPlaylist = "stream.m3u8"

func (s *srv) llhlsURLFor(r *http.Request) string {
	if r.Header.Get("X-PartyParty-Relay") == "1" {
		// Relayed guests fetch from the origin, which serves what contribution
		// publishes under a fixed name beside the page itself. It is not the
		// muxer's path: this Mac is unreachable from that guest's network, which
		// is the whole reason they are on the relay.
		return relayPublishedPlaylist
	}
	return s.llhlsURL()
}

// friendlyName prefers the device's real network name ("Alex's iPhone",
// resolved once via reverse DNS / mDNS off the LAN IP and cached) over the
// generic UA label. macOS's resolver answers reverse mDNS for Apple devices, so
// this often works on a home/party Wi-Fi; it fails gracefully to the UA label.
func (s *srv) friendlyName(ip, ua string) string {
	label := deviceName(ua)
	if ip == "" || strings.HasPrefix(ip, "127.") || ip == "::1" || ip == "1" {
		return label
	}
	if v, ok := s.hostCache.Load(ip); ok {
		if name, _ := v.(string); name != "" {
			return name // resolved to a real device name
		}
		return label // looked up already, nothing useful
	}
	// First sight of this IP: mark pending + resolve in the background.
	s.hostCache.Store(ip, "")
	go func(ip string) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		names, err := net.DefaultResolver.LookupAddr(ctx, ip)
		if err != nil || len(names) == 0 {
			return
		}
		if n := cleanHostname(names[0]); n != "" {
			s.hostCache.Store(ip, n)
		}
	}(ip)
	return label
}

// cleanHostname turns "Alexs-iPhone.local." into "Alexs iPhone".
func cleanHostname(h string) string {
	h = strings.TrimSuffix(h, ".")
	for _, suf := range []string{".local", ".lan", ".home", ".home.arpa"} {
		h = strings.TrimSuffix(h, suf)
	}
	if h == "" || strings.Contains(h, ".") { // still an FQDN → not a friendly device name
		return ""
	}
	h = strings.NewReplacer("-", " ", "_", " ").Replace(h)
	return h
}

// deviceName derives a short friendly label from a User-Agent for the DJ's
// details view (e.g. "iPhone · Safari", "Android · Chrome", "Mac · Chrome").
func deviceName(ua string) string {
	if ua == "" {
		return "Browser"
	}
	dev := "Computer"
	switch {
	case strings.Contains(ua, "iPhone"):
		dev = "iPhone"
	case strings.Contains(ua, "iPad"):
		dev = "iPad"
	case strings.Contains(ua, "Android"):
		dev = "Android"
	case strings.Contains(ua, "Macintosh"):
		dev = "Mac"
	case strings.Contains(ua, "Windows"):
		dev = "Windows"
	case strings.Contains(ua, "Linux"):
		dev = "Linux"
	}
	br := ""
	switch {
	case strings.Contains(ua, "CriOS") || (strings.Contains(ua, "Chrome") && !strings.Contains(ua, "Edg")):
		br = "Chrome"
	case strings.Contains(ua, "Edg"):
		br = "Edge"
	case strings.Contains(ua, "Firefox") || strings.Contains(ua, "FxiOS"):
		br = "Firefox"
	case strings.Contains(ua, "Safari"):
		br = "Safari"
	}
	if br == "" {
		return dev
	}
	return dev + " · " + br
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return strings.TrimPrefix(host, "::ffff:")
}

func mimeFor(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".woff2"):
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeJSONGzip is writeJSON for hot polled payloads (/api/status: every guest,
// every 3s, roster+sync state - a few KB that gzip to a fraction on venue
// Wi-Fi). Small bodies skip compression; anything under one MTU gains nothing.
func writeJSONGzip(w http.ResponseWriter, r *http.Request, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "encode failed"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if len(b) > 1400 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		var buf bytes.Buffer
		if zw, zerr := gzip.NewWriterLevel(&buf, gzip.BestSpeed); zerr == nil {
			if _, werr := zw.Write(b); werr == nil && zw.Close() == nil {
				w.Header().Set("Content-Encoding", "gzip")
				w.Header().Add("Vary", "Accept-Encoding")
				w.WriteHeader(status)
				_, _ = w.Write(buf.Bytes())
				return
			}
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func kbps(bitrate string) int {
	n, _ := strconv.Atoi(strings.TrimSuffix(bitrate, "k"))
	return n
}

// parseDurSeconds parses "500ms" / "1s" / "800ms" into seconds.
func parseDurSeconds(d string) float64 {
	d = strings.TrimSpace(d)
	if strings.HasSuffix(d, "ms") {
		n, _ := strconv.ParseFloat(strings.TrimSuffix(d, "ms"), 64)
		return n / 1000
	}
	if strings.HasSuffix(d, "s") {
		n, _ := strconv.ParseFloat(strings.TrimSuffix(d, "s"), 64)
		return n
	}
	n, _ := strconv.ParseFloat(d, 64)
	return n
}

// suggest reports venue Wi-Fi trouble without exposing retired stream presets.
func suggest(status string, bc broadcast.Status) string {
	if status != "strain" && status != "congested" {
		return ""
	}
	return "The venue Wi-Fi is congested or isolating guests. Move closer to the access point or ask the venue to disable client isolation."
}

// realCert reports whether the https guest link is actually SERVABLE - the
// gate for LL-HLS (iOS Safari rejects self-signed certs on LAN
// IPs). True only once SetActivation ran, which main.go does strictly after a
// cert loaded and the TLS listener bound: raw --cert/--key config presence
// used to count, and a bad key or busy port then advertised an https link no
// guest could open.
func (s *srv) realCert() bool {
	s.actMu.Lock()
	defer s.actMu.Unlock()
	return s.actDomain != ""
}

// liveDomain is the hostname guests should use: the explicit --domain, or the
// async-activated one, or "" (fall back to the LAN IP).
func (s *srv) liveDomain() string {
	if s.Config.Domain != "" {
		return s.Config.Domain
	}
	s.actMu.Lock()
	defer s.actMu.Unlock()
	return s.actDomain
}

func (s *srv) streamSyncState(bc broadcast.Status, target float64) map[string]any {
	generation := bc.Since
	if bc.State != "live" || s.MTX == nil {
		s.streamSyncMu.Lock()
		if generation != s.streamSyncGeneration || bc.State != "live" {
			s.streamSyncGeneration = generation
			s.streamSyncReadiness = mediamtx.HLSReadiness{}
			s.streamSyncCheckedAt = time.Time{}
			s.streamSyncChecking = false
			s.streamSyncReady = false
		}
		s.streamSyncMu.Unlock()
		return map[string]any{
			"generation": generation,
			"ready":      false,
			"checking":   false,
		}
	}

	now := time.Now()
	s.streamSyncMu.Lock()
	if generation != s.streamSyncGeneration {
		s.streamSyncGeneration = generation
		s.streamSyncReadiness = mediamtx.HLSReadiness{}
		s.streamSyncCheckedAt = time.Time{}
		s.streamSyncChecking = false
		s.streamSyncReady = false
		s.streamSyncChecks = 0
		s.streamSyncLastGap = 0
		s.streamSyncGapBaselined = false
	}
	interval := time.Second
	switch {
	case s.streamSyncReady:
		// Latched. The slow pulse below exists only so source-side stalls keep
		// landing in the diag log with timestamps.
		interval = 10 * time.Second
	case s.streamSyncChecks >= 30:
		// Not latching after ~30 checks is a fact about the stream (GAP parts
		// keep reaching the live edge), not a reason to open a muxer session
		// every second for a whole set - which is exactly what the Shack15
		// 2026-08-04 set did, flooding the ring while proving nothing new.
		interval = 5 * time.Second
	}
	if !s.streamSyncChecking && now.Sub(s.streamSyncCheckedAt) >= interval {
		s.streamSyncChecking = true
		s.streamSyncCheckedAt = now
		s.streamSyncChecks++
		go s.refreshStreamSync(generation, target)
	}
	state := s.streamSyncReadiness
	ready := s.streamSyncReady
	checking := s.streamSyncChecking
	s.streamSyncMu.Unlock()

	return map[string]any{
		"generation":   generation,
		"ready":        ready,
		"checking":     checking,
		"publishing":   state.Publishing,
		"playlist":     state.Generation,
		"realHistory":  state.RealHistory,
		"gapHistory":   state.GapHistory,
		"partHoldBack": state.PartHoldBack,
		"partTarget":   state.PartTarget,
	}
}

func (s *srv) refreshStreamSync(generation int64, target float64) {
	state := mediamtx.InspectHLS(s.Config.HLSPort, s.Config.StreamPath)
	ready := state.Publishing && state.RealHistory+0.05 >= target

	s.streamSyncMu.Lock()
	if generation != s.streamSyncGeneration {
		s.streamSyncMu.Unlock()
		return
	}
	wasReady := s.streamSyncReady
	s.streamSyncReadiness = state
	s.streamSyncChecking = false
	if ready {
		s.streamSyncReady = true
	}
	// Fresh GAP parts after the baseline mean the ingest starved mid-set: the
	// muxer had nothing real to serve for that stretch, and every listener hit
	// the same hole at the same moment. This line is what turns "the cutoffs
	// were back" from an anecdote into a timestamp.
	gapGrew := s.streamSyncGapBaselined && state.GapHistory > s.streamSyncLastGap+0.01
	s.streamSyncLastGap = state.GapHistory
	s.streamSyncGapBaselined = true
	s.streamSyncMu.Unlock()

	if gapGrew && s.Diag != nil {
		s.Diag.Printf("stream gaps: %.2fs of GAP parts in the live window - the ingest starved (capture-side stall)", state.GapHistory)
	}
	if ready && !wasReady && s.Diag != nil {
		s.Diag.Printf("stream sync ready: generation=%d real=%.3fs gaps=%.3fs holdback=%.3fs part=%.3fs target=%.3fs playlist=%s",
			generation, state.RealHistory, state.GapHistory, state.PartHoldBack, state.PartTarget, target, state.Generation)
	}
}

// activationState reports the secure-link status for the console.
func (s *srv) activationState() map[string]any {
	s.actMu.Lock()
	reason := s.actReason
	s.actMu.Unlock()
	return map[string]any{"ready": s.realCert(), "reason": reason}
}

func (s *srv) latencyTarget(_ broadcast.Status, _ string) float64 { return roomLatencyTarget }

func lastN(s []string, n int) []string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func clipStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// compactFields renders a client event's fields as one greppable line:
// "+<t>ms #<seq> key=val …" with the rest sorted for stable diffs.
func compactFields(m map[string]any) string {
	var b strings.Builder
	if t, ok := m["t"]; ok {
		fmt.Fprintf(&b, "+%vms ", t)
		delete(m, "t")
	}
	if n, ok := m["n"]; ok {
		fmt.Fprintf(&b, "#%v ", n)
		delete(m, "n")
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if m[k] == nil {
			continue
		}
		s := fmt.Sprintf("%v", m[k])
		if len(s) > 200 {
			s = s[:200]
		}
		fmt.Fprintf(&b, "%s=%s ", k, s)
	}
	return strings.TrimSpace(b.String())
}
