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
	"partyparty/internal/devices"
	"partyparty/internal/diag"
	"partyparty/internal/event"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/ota"
	"partyparty/internal/stats"
)

const defaultLLHLSLatencyTarget = 7.0

type Deps struct {
	Config      config.Config
	Broadcaster *broadcast.Broadcaster
	Listeners   *stats.Listeners
	RunDir      string
	Web         fs.FS
	MTX         *mediamtx.Server // nil if mediamtx unavailable (LL-HLS disabled)

	// Payload is the over-the-air content store (nil = serve embedded Web
	// only). When set, all web content and the version stamp come from it, so
	// an adopted cloud payload is served without an app update.
	Payload *ota.Store

	// Events is the party's social layer (feed + media + recordings).
	// nil disables the feed endpoints.
	Events *event.Store

	// Diag is the session diagnostics log (nil = off): guest joins, room
	// snapshots, anything support would need after a bad party.
	Diag *diag.Logger

	// Version is the app build version — shown in UIs and broadcast to clients
	// so stale player pages refresh themselves after an update.
	Version string
}

type srv struct {
	Deps
	vendor    http.Handler
	liveProxy http.Handler
	limits    *limiter

	// Async activation result (cert broker / BYO) — set after launch so the
	// server can start serving instantly while certs are obtained in the
	// background. Guarded by actMu.
	actMu      sync.Mutex
	actDomain  string
	actReason  string // why activation isn't ready yet (console pending state)
	actLast    activate.Result
	actLastSet bool
	// accActivated: this Mac's DJ account is linked, or running on a cached
	// prior activation (offline party after first sign-in). The console requires
	// it before it renders and /api/start refuses without it. Default false =
	// blocked, so a never-activated or signed-out install cannot go live.
	// Refreshed by the /api/account/status handler that the console polls.
	accActivated bool

	// Last /api/account/status result, so the console's activation poll does not
	// broker-roundtrip every 2s. Guarded by accStatusMu.
	accStatusMu sync.Mutex
	accStatus   accountStatusCache

	// Web guests listening to this party's cloud mirror right now, from the
	// live check-in response (0 while idle/offline). Written by the check-in
	// loop, read by /api/status — the room and the web share one count.
	webListeners atomic.Int64

	// Room-sync toggles (per-DJ, persisted to stateDir/room-settings.json). Both
	// OFF by default: guests ride the live edge (lowest latency) and no drift
	// re-pull runs. ON restores the 3s unison park (EXT-X-START) / drift watchdog.
	// Guarded by roomSyncMu; lazily loaded once via roomSyncOnce.
	roomSyncOnce    sync.Once
	roomSyncMu      sync.Mutex
	roomSyncDelay   bool
	driftCorrection bool
	stable          bool // STABLE SETTINGS toggle (default ON); see ensureRoomSyncLoaded

	hostCache  sync.Map // ip -> reverse-DNS device name ("" = looked up, nothing useful)
	bonjour    sync.Map // ip -> friendly Bonjour name ("Ramine's iPhone")
	seenCIDs   sync.Map // cid -> true (first-heartbeat join logging)
	clientLogN sync.Map // cid -> *int32 (client error reports, capped per guest)
	clientEvN  int32    // global event ceiling — a rotating cid can't defeat this
	clientCIDs int32    // distinct-cid ceiling — a rotating cid can't grow clientLogN without bound

	syncDrainOnce    sync.Once
	syncDrainKick    chan struct{}
	syncDrainMu      sync.Mutex
	syncDrainRunning bool

	devNoLoginLogOnce sync.Once

	// streamHealthNote: set by the go-live health check (main.go) when the
	// broadcast reports "live" but MediaMTX has no publisher on the path —
	// i.e. guests hear nothing. Surfaced in /api/status so the console tells
	// the DJ honestly instead of showing a false "Live". Guarded by healthMu.
	healthMu         sync.Mutex
	streamHealthNote string

	// streamSync caches one lightweight playlist inspection per live generation.
	// It prevents native HLS clients from attaching while MediaMTX's required
	// initial GAP segments are the only history at the room target.
	streamSyncMu         sync.Mutex
	streamSyncGeneration int64
	streamSyncReadiness  mediamtx.HLSReadiness
	streamSyncCheckedAt  time.Time
	streamSyncChecking   bool
	streamSyncReady      bool

	// audioProven: Mac-audio capture has gone live at least once on this
	// install, so the system-audio permission is provably granted. macOS has no
	// status API for Core Audio tap permission, so this observed proof is the
	// ONLY reliable signal. Persisted server-side (Application Support) because
	// the console's earlier localStorage flag was origin-scoped and got wiped by
	// origin changes and data-store resets — which re-scared DJs with a
	// "permission not confirmed" banner on Macs that were already granted.
	audioProven     atomic.Bool
	audioProvenSave sync.Once
}

func New(d Deps) *Srv {
	webFS := d.Web
	if d.Payload != nil {
		webFS = d.Payload // /vendor/ follows OTA swaps too, since the store IS the FS
	}
	s := &Srv{srv{
		Deps: d, vendor: http.FileServer(http.FS(webFS)),
		limits: newLimiter(), accStatus: newAccountStatusCache(accountStatusCacheTTL), syncDrainKick: make(chan struct{}, 1),
	}}
	// The /live proxy injects the EXT-X-START room-start pin; the offset is
	// read at REQUEST time from s.syncTarget so it always equals what
	// /api/status reports as the room target.
	s.liveProxy = newLiveProxy(d.Config.HLSPort, s.syncTarget, "/live")
	if _, err := os.Stat(audioProvenPath()); err == nil {
		s.audioProven.Store(true)
	}
	return s
}

// audioProvenPath is the durable "Mac audio capture has worked here" marker —
// ~/Library/Application Support/partyparty/audio-proven. Empty string disables
// persistence (in-memory only) when the config dir is unavailable.
func audioProvenPath() string {
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "partyparty", "audio-proven")
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
func newLiveProxy(hlsPort int, roomTarget func() float64, prefix string) http.Handler {
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
			// Pin the room's start position in the MULTIVARIANT playlist (index.m3u8,
			// fetched once per join) so every device begins the SAME distance behind
			// the live edge. This is a server-side start HINT, not a client seek —
			// it tightens the room toward zero spread with NO risk of the Safari-27
			// seek hang, and a player that ignores it just falls back to the natural
			// hold-back position (still no gross outlier). Media playlists pass
			// through untouched. Per RFC 8216 EXT-X-START belongs in the multivariant.
			if resp.Request != nil && resp.StatusCode == http.StatusOK &&
				strings.HasSuffix(resp.Request.URL.Path, "/index.m3u8") {
				if d := roomTarget(); d > 0.5 {
					body, err := io.ReadAll(resp.Body)
					_ = resp.Body.Close()
					if err != nil {
						return err
					}
					pl := string(body)
					if strings.Contains(pl, "#EXT-X-STREAM-INF") && !strings.Contains(pl, "EXT-X-START") {
						tag := fmt.Sprintf("#EXT-X-START:TIME-OFFSET=-%.3f,PRECISE=YES\n", d)
						if i := strings.IndexByte(pl, '\n'); i >= 0 && strings.HasPrefix(pl, "#EXTM3U") {
							pl = pl[:i+1] + tag + pl[i+1:]
						} else {
							pl = "#EXTM3U\n" + tag + pl
						}
						body = []byte(pl)
					}
					resp.Body = io.NopCloser(bytes.NewReader(body))
					resp.ContentLength = int64(len(body))
					resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
					resp.Header.Del("Content-Encoding")
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "live stream temporarily unavailable", http.StatusBadGateway)
		},
	}
}

// webFS is the live content source: the OTA payload store if present (which
// serves the embedded copy until a newer payload is verified), else embedded.
func (s *srv) webFS() fs.FS {
	if s.Payload != nil {
		return s.Payload
	}
	return s.Web
}

// version is the effective content version stamped into pages and reported to
// clients. Payload-aware, so adopting a new payload changes the version and
// stale tabs self-refresh — same mechanism as an app update.
func (s *srv) version() string {
	if s.Payload != nil {
		return s.Payload.Version(s.Version)
	}
	return s.Version
}

// payloadConfig is the OTA config.json (feature flags + tunables) surfaced to
// clients in /api/status, so remotely-shipped config takes effect with the
// rest of the payload. Falls back to the embedded config when no store is set.
func (s *srv) payloadConfig() json.RawMessage {
	if s.Payload != nil {
		return s.Payload.Config()
	}
	if data, err := fs.ReadFile(s.Web, "config.json"); err == nil && json.Valid(data) {
		return json.RawMessage(data)
	}
	return nil
}

// Srv is the exported handle: an http.Handler plus the async-activation hook.
type Srv struct{ srv }

// SetActivation records a completed low-latency activation (real cert +
// resolvable domain). Guest/stream URLs and the console's LL-HLS gate flip
// live on the next status poll.
// SetActivationResult caches the latest online activation attempt (cert / host /
// LAN IP) for lanStateSnapshot to read. It never switches network mode.
func (s *Srv) SetActivationResult(res activate.Result) {
	s.actMu.Lock()
	s.actLast = res
	s.actLastSet = true
	s.actMu.Unlock()
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
	s.actMu.Unlock()
}

// SetActivationPending records why the secure link isn't ready yet — shown in
// the console while Go Live is gated.
func (s *Srv) SetActivationPending(reason string) {
	s.actMu.Lock()
	if s.actDomain == "" {
		s.actReason = reason
	}
	s.actMu.Unlock()
}

// setAccountActivated latches this process "activated" the first time the DJ
// account shows linked (or offline-cached-linked). The /api/account/status
// handler the console polls calls it; /api/start reads it. It only ever latches
// TRUE — a later sign-out/revoke never blocks a live party mid-set; it takes
// effect on the next launch (fresh process starts back at false). Default false
// means a never-activated install cannot go live.
func (s *srv) setAccountActivated(v bool) {
	if !v {
		return
	}
	s.actMu.Lock()
	s.accActivated = true
	s.actMu.Unlock()
}

func (s *srv) accountActivated() bool {
	if s.devNoLogin() {
		return true
	}
	s.actMu.Lock()
	defer s.actMu.Unlock()
	return s.accActivated
}

// SetStreamHealth records the go-live health verdict (main.go's health check).
// Empty = healthy (guests can hear); non-empty = a DJ-facing warning that the
// broadcast shows "live" but the guest stream never reached MediaMTX.
func (s *Srv) SetStreamHealth(note string) {
	s.healthMu.Lock()
	s.streamHealthNote = note
	s.healthMu.Unlock()
}

// SetWebListeners records how many web guests are on the cloud mirror right
// now (from the live check-in response) so the room's surfaces can show one
// combined party count.
func (s *Srv) SetWebListeners(n int) {
	if n < 0 {
		n = 0
	}
	s.webListeners.Store(int64(n))
}

// ActiveListeners is the LAN listener count the check-in reports to the broker
// so the web event page can show the ROOM's side of the combined party count.
func (s *Srv) ActiveListeners() int {
	if s.Listeners == nil {
		return 0
	}
	return s.Listeners.Active()
}

func (s *srv) streamHealthText() string {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	return s.streamHealthNote
}

const accountStatusCacheTTL = 15 * time.Second

type accountStatusSource func() (activate.AccountState, error)

type accountStatusCache struct {
	ttl       time.Duration
	status    activate.AccountState
	checkedAt time.Time
	set       bool
}

func newAccountStatusCache(ttl time.Duration) accountStatusCache {
	return accountStatusCache{ttl: ttl}
}

func (c *accountStatusCache) lookup(now func() time.Time, fresh bool, source accountStatusSource) (activate.AccountState, bool, error) {
	if !fresh && c.set && c.ttl > 0 && now().Sub(c.checkedAt) < c.ttl {
		return c.status, false, nil
	}
	status, err := source()
	c.status = status
	c.checkedAt = now()
	c.set = true
	return status, true, err
}

func (c *accountStatusCache) clear() {
	ttl := c.ttl
	*c = accountStatusCache{ttl: ttl}
}

func (s *srv) cachedAccountStatus(fresh bool, source accountStatusSource) activate.AccountState {
	s.accStatusMu.Lock()
	defer s.accStatusMu.Unlock()
	status, _, _ := s.accStatus.lookup(time.Now, fresh, source)
	return status
}

func (s *srv) clearAccountStatusCache() {
	s.accStatusMu.Lock()
	s.accStatus.clear()
	s.accStatusMu.Unlock()
}

func (s *srv) devNoLogin() bool {
	if os.Getenv("PP_DEV_NO_LOGIN") != "1" {
		return false
	}
	active := s.Version == "dev"
	if s.Diag != nil {
		s.devNoLoginLogOnce.Do(func() {
			if active {
				s.Diag.Printf("WARNING: PP_DEV_NO_LOGIN=1 active; DJ account activation is bypassed for local development")
				return
			}
			s.Diag.Printf("WARNING: PP_DEV_NO_LOGIN=1 ignored; app version %q is not a dev build", s.Version)
		})
	}
	return active
}

func (s *srv) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Private Network Access preflight (Chromium): the cloud join page probes this
	// LAN host from a public origin to prove the guest is on the party's Wi-Fi.
	// Chromium may preflight such public→private requests; answering with
	// Allow-Private-Network keeps the probe (and any future PNA-gated fetch) from
	// false-negativing an on-LAN guest. Read-only, no credentials — allowing any
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
		http.ServeFile(w, r, cover)
	case strings.HasPrefix(p, "/covers/"):
		w.Header().Set("Cache-Control", "public, max-age=3600")
		s.vendor.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/vendor/"):
		// Through serveWeb (not the FileServer) so text assets gzip — hls.js is
		// 404KB plain, ~130KB gzipped, fetched by every non-Apple guest.
		s.serveWeb(w, r, strings.TrimPrefix(p, "/"), "public, max-age=3600")
	case strings.HasPrefix(p, "/live/"):
		s.liveProxy.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/media/"):
		s.handleMedia(w, r)
	case p == "/api/room-settings":
		// DJ room-sync toggles. POST {roomSyncDelay?, driftCorrection?} sets them
		// (each field optional — omitted keeps its current value); any method
		// returns the current state. Default OFF: guests ride the live edge.
		if r.Method == http.MethodPost {
			var body struct {
				RoomSyncDelay   *bool `json:"roomSyncDelay"`
				DriftCorrection *bool `json:"driftCorrection"`
				Stable          *bool `json:"stable"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			delay, drift := s.roomSyncState()
			if body.RoomSyncDelay != nil {
				delay = *body.RoomSyncDelay
			}
			if body.DriftCorrection != nil {
				drift = *body.DriftCorrection
			}
			if body.RoomSyncDelay != nil || body.DriftCorrection != nil {
				s.setRoomSync(delay, drift)
			}
			if body.Stable != nil {
				s.setStable(*body.Stable)
			}
		}
		delay, drift := s.roomSyncState()
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"roomSyncDelay": delay, "driftCorrection": drift, "stable": s.stableEnabled()})
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
	Primary     string          `json:"primary"`
	Public      string          `json:"public,omitempty"`
	IP          string          `json:"ip"`
	Port        int             `json:"port"`
	HostnameURL string          `json:"hostnameUrl"`
	Interfaces  []netinfo.Iface `json:"interfaces"`
}

// publicPartyURL builds the DJ's permanent guest-facing link — the ONE URL that
// is their profile when idle and their party when live (<handle>.partyparty.party,
// the proxied Worker router). This is what the console shows and the QR encodes;
// the machine hostname (ramine-live...:8443) stays internal plumbing the router
// hands guests off to. Empty (caller falls back to the direct machine link) when
// it cannot work: offline/captive parties (the cloud router is unreachable — the
// QR must encode the LAN host directly), no handle yet, a handle with dots or
// underscores (can't form the single-label hostname the router serves), or no
// activated domain to derive the zone from.
func publicPartyURL(domain, handle string) string {
	if handle == "" || domain == "" {
		return ""
	}
	for _, r := range handle {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '_' {
			return ""
		}
	}
	// The machine host is <slug>.party.<zone> in the broker namespace; the public
	// link is <handle>.<zone>. Derive <zone> by dropping the machine prefix:
	// <slug>.party. (two labels) in the broker namespace, else one label (a
	// legacy <slug>.<zone> or a BYO live-host). Getting this wrong once put the
	// stray "party." into the QR link (seth.party.partyparty.party).
	var zone string
	if parts := strings.SplitN(domain, ".", 3); len(parts) == 3 && parts[1] == "party" {
		zone = parts[2] // seth-live.party.partyparty.party -> partyparty.party
	} else if i := strings.Index(domain, "."); i > 0 && i+1 < len(domain) {
		zone = domain[i+1:] // ramine-live.partyparty.party -> partyparty.party
	} else {
		return ""
	}
	return "https://" + zone + "/@" + handle
}

// accountHandle is the linked profile's handle from the in-memory account-status
// cache (primed by the console's /api/account/status poll; sourced online or
// from the on-disk account cache, so it survives offline). "" until known.
func (s *srv) accountHandle() string {
	s.accStatusMu.Lock()
	defer s.accStatusMu.Unlock()
	return s.accStatus.status.Profile.Handle
}

// AdvertisedGuestPort is the port guests use to reach this Mac: always the
// direct TLS listener. An earlier build could advertise a bare :443 (hiding the
// port behind the privileged pp-port443 redirect) whenever a TLS handshake
// succeeded there — but the handshake never proved the redirect actually
// forwarded, so a half-broken helper (e.g. one that lost its approval in a macOS
// reset) handed guests a dead port-less link in the QR while
// https://<host>:<tlsPort>/ still worked. Reliability beats a cosmetic port, so
// the guest link is always the proven direct path.
func (s *srv) AdvertisedGuestPort() int {
	return s.Config.TLSPort
}

func (s *srv) urls() urls {
	ip := netinfo.PrimaryLanIP()
	// The Plex model: the ONLY advertised link is https:// on the activated
	// domain. The page itself requires working DNS + TLS — exactly the gate
	// that guarantees the LL stream will play for whoever loaded it. No http
	// fallback link is ever shown; until activation completes, Primary stays
	// http and the console renders a "setting up the secure link" state.
	if d := s.liveDomain(); d != "" && s.realCert() {
		port := s.AdvertisedGuestPort()
		return urls{
			Primary:     fmt.Sprintf("https://%s:%d/", d, port),
			Public:      publicPartyURL(d, s.accountHandle()),
			IP:          ip,
			Port:        port,
			HostnameURL: fmt.Sprintf("http://%s:%d/", netinfo.LocalHostname(), s.Config.Port),
			Interfaces:  netinfo.LanInterfaces(),
		}
	}
	return urls{
		Primary:     fmt.Sprintf("http://%s:%d/", ip, s.Config.Port),
		IP:          ip,
		Port:        s.Config.Port,
		HostnameURL: fmt.Sprintf("http://%s:%d/", netinfo.LocalHostname(), s.Config.Port),
		Interfaces:  netinfo.LanInterfaces(),
	}
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
		writeJSONGzip(w, r, http.StatusOK, map[string]any{
			"name":           s.Config.Name,
			"appVersion":     s.version(),
			"broadcast":      bc,
			"listeners":      health.Listeners,
			"listenersTotal": s.Listeners.TotalUnique(),
			"webListeners":   s.webListeners.Load(),
			"health":         health,
			"urls":           s.urls(),
			"lan":            s.lanStateSnapshot(), // honest LAN readiness from observed LAN vs cloud listeners
			"llhlsUrl":       s.llhlsURL(),
			"delivery":       bc.Delivery,
			"llhlsAvailable": s.MTX != nil,
			"llhlsRealCert":  s.realCert(),
			"audioProven":    s.audioProven.Load(),
			"activation":     s.activationState(),
			"latencyTarget":  latencyTarget,
			"sync":           s.syncModeState(),
			"streamSync":     s.streamSyncState(bc, latencyTarget),
			"roomSync":       s.roomSyncStatePayload(),
			"log":            lastN(s.Broadcaster.Log(), 60),
			"latency":        s.Listeners.LatencySpread(),
			"roster":         rosterBody,
			"event":          s.eventState(),
			"mirror":         s.eventMirrorState(),
			"config":         s.payloadConfig(),
			"appUpdate":      s.Payload != nil && s.Payload.AppUpdateAvailable(),
			"streamHealth":   s.streamHealthText(),
		})
	case "/api/update/check":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		payloadChanged := false
		if s.Payload != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
			defer cancel()
			adopted, err := s.Payload.Refresh(ctx)
			if err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]any{
					"ok":         false,
					"error":      err.Error(),
					"appVersion": s.version(),
					"appUpdate":  s.Payload.AppUpdateAvailable(),
				})
				return
			}
			payloadChanged = adopted
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"appVersion":     s.version(),
			"payloadChanged": payloadChanged,
			"appUpdate":      s.Payload != nil && s.Payload.AppUpdateAvailable(),
		})
	case "/api/time":
		// Master clock for the listeners' NTP-style offset estimate. Expose the
		// server receive/transmit pair so clients can use the full four-timestamp
		// calculation instead of assuming all response time was symmetric.
		received := time.Now().UnixMilli()
		sent := time.Now().UnixMilli()
		writeJSON(w, http.StatusOK, map[string]any{"t": sent, "received": received, "sent": sent})
	case "/api/network-situation":
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "GET required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, s.networkSituation())
	case "/api/account/status":
		if !s.requireDJ(w, r) {
			return
		}
		if s.devNoLogin() {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":        true,
				"linked":    true,
				"devBypass": true,
				"checkedMs": time.Now().UnixMilli(),
			})
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		fresh := r.URL.Query().Get("fresh") == "1"
		status := s.cachedAccountStatus(fresh, func() (activate.AccountState, error) {
			status, err := activate.AccountStatus(broker, func(format string, args ...any) {
				if s.Diag != nil {
					s.Diag.Printf(format, args...)
				}
			})
			// status.Linked is true both online-linked and offline-cached-linked
			// (the cache only ever returns Linked when this Mac was linked before),
			// so it is the single activation signal. It latches the process
			// activated; a sign-out re-gates on the next launch, not mid-session.
			s.setAccountActivated(status.Linked)
			return status, err
		})
		writeJSON(w, http.StatusOK, status)
	case "/api/account/sign-out":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		if err := activate.SignOutAccount(broker, func(format string, args ...any) {
			if s.Diag != nil {
				s.Diag.Printf(format, args...)
			}
		}); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		s.clearAccountStatusCache()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/account/open":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		_ = exec.Command("open", strings.TrimRight(broker, "/")+"/account").Start()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/account/profile":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		_ = exec.Command("open", strings.TrimRight(broker, "/")+"/profile/edit").Start()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/link-install/start":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		linkURL, err := activate.StartInstallLink(broker, func(format string, args ...any) {
			if s.Diag != nil {
				s.Diag.Printf(format, args...)
			}
		})
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		// inapp=1: the native app hosts sign-in in its own in-app window (no
		// browser bounce), so just hand back the URL. Otherwise (browser
		// fallback / dev) open the system browser as before.
		if r.URL.Query().Get("inapp") != "1" {
			_ = exec.Command("open", linkURL).Start()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "url": linkURL})
	case "/api/link-install":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		var body struct{ Code string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad request"})
			return
		}
		broker := os.Getenv("PARTYPARTY_BROKER")
		if broker == "" {
			broker = "https://partyparty.party"
		}
		handle, err := activate.LinkInstall(broker, body.Code, func(format string, args ...any) {
			if s.Diag != nil {
				s.Diag.Printf(format, args...)
			}
		})
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "handle": handle})
	case "/api/client-log":
		// Guest-side error reports into the session diagnostics. Field lesson:
		// a phone whose JOIN button silently fails never heartbeats — it was
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
		if atomic.AddInt32(nAny.(*int32), 1) <= 25 { // cap per guest — no log floods
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
		// cid can't grow clientLogN without limit — past the distinct-cid ceiling
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
			return // distinct-client ceiling hit — stop tracking new cids
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
			// per-cid cap, so bound total logged events for the process too —
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
			case "error", "media", "play-failed", "join-stuck", "reconnect", "offline", "dj-stop":
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
		rate, _ := strconv.ParseFloat(q.Get("rate"), 64)
		buf, _ := strconv.ParseFloat(q.Get("buf"), 64)
		s.Listeners.Debug(key, q.Get("del"), rate, buf)
		s.Listeners.Meta(key, clientIP(r), s.friendlyName(clientIP(r), r.UserAgent()))
		s.Listeners.Identity(key, clipStr(strings.TrimSpace(q.Get("name")), 40), clipStr(strings.TrimSpace(q.Get("emoji")), 16))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/delivery":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		mode := r.URL.Query().Get("mode")
		if mode != "llhls" && mode != "hls" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "mode must be llhls or hls"})
			return
		}
		if mode == "llhls" {
			if s.MTX == nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "low-latency unavailable (install mediamtx)"})
				return
			}
			// Without a real (publicly-trusted) cert, LL-HLS would hand every
			// iPhone an https:// URL Safari rejects — worse than any latency.
			if !s.realCert() {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "low latency needs a real HTTPS certificate (--domain/--cert/--key) — iPhones can't play the self-signed fallback"})
				return
			}
			if err := s.MTX.EnsureReady(s.Config.RTSPPort, s.Config.HLSPort, 6*time.Second); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			s.Broadcaster.SetDelivery("llhls")
		} else {
			s.Broadcaster.SetDelivery("hls")
			if s.MTX != nil {
				// StopWait, not Stop: a quick toggle back to llhls within the
				// SIGINT grace would otherwise launch a replacement that loses
				// the port race to the still-dying instance.
				s.MTX.StopWait()
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/open-settings":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		// System-audio capture (Core Audio process tap) lives under
		// Privacy & Security → "Screen & System Audio Recording" on modern macOS
		// (the ScreenCapture TCC pane). Open it so the DJ can toggle partyparty on.
		switch r.URL.Query().Get("pane") {
		case "mic":
			_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").Start()
		default: // "audio" / "screen" / anything → the audio-recording pane
			_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").Start()
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
		// Activation gate: the app requires a linked DJ account (or a cached prior
		// activation for offline use) before it can go live. Guests are never
		// touched by this — only this localhost-only DJ action.
		if !s.accountActivated() {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "not_activated"})
			return
		}
		q := r.URL.Query()
		device := q.Get("device")
		if device == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "device required"})
			return
		}
		// LL-HLS needs a publicly-trusted cert. Plain HLS is the offline-safe
		// fallback and must be able to start before activation completes.
		if device != "test" && s.Broadcaster.Delivery() == "llhls" && !s.realCert() {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "secure guest link isn't ready yet — hold on (needs internet once)"})
			return
		}
		opts := broadcast.Options{Bitrate: validBitrate(q.Get("bitrate"))}
		switch q.Get("mono") {
		case "1", "true":
			opts.Channels = 1
		case "0", "false":
			opts.Channels = 2
		}
		// Record the set by default (opt-out via record=0): the event page can
		// publish it later, and a recording nobody wanted deletes in one click.
		if s.Events != nil && q.Get("record") != "0" && s.Broadcaster.Delivery() == "llhls" {
			opts.RecordPath = s.Events.RecordingPath()
		}
		// One fixed LL timing profile now (no latency modes, no MediaMTX
		// bouncing) — but a start must still revive a silently-dead MediaMTX,
		// or ffmpeg pushes into the void and guests see a "live" broadcast
		// nobody can hear. If a stale orphan owns the ports, reap and retry.
		if s.Broadcaster.Delivery() == "llhls" && s.MTX != nil && !s.MTX.Running() {
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
		s.Broadcaster.Start(device, q.Get("name"), opts)
		s.addStreamFeedPost("Started the stream.")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/stop":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		if !s.requireDJ(w, r) {
			return
		}
		wasStreaming := false
		if s.Broadcaster != nil {
			switch s.Broadcaster.Status().State {
			case "starting", "live":
				wasStreaming = true
			}
		}
		s.webListeners.Store(0)
		s.Broadcaster.Stop()
		if wasStreaming {
			s.addStreamFeedPost("Stopped the stream.")
		}
		// Opt-in auto-publish (DJ toggle, default off): push the just-ended set to
		// its shareable /e/<slug> page. Fire-and-forget — publish is slow (remux +
		// upload) and needs a linked account + connectivity, so it must never hold
		// up the Stop response or the local party.
		if r.URL.Query().Get("publish") == "1" {
			go func() {
				res, err := s.publishCurrentSet(context.Background())
				if err != nil {
					if s.Diag != nil {
						s.Diag.Printf("auto-publish failed: %v", err)
					}
					return
				}
				_, _ = s.Events.SetSlug(res.Slug)
				s.syncCurrentPostsAsync(res.Slug)
				if s.Diag != nil {
					s.Diag.Printf("auto-published set -> %s", res.URL)
				}
			}()
		}
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

func (s *srv) addStreamFeedPost(text string) {
	if s.Events == nil {
		return
	}
	posts, _, _ := s.Events.Feed(0)
	for _, post := range posts {
		if post.DJ && post.CID == "dj" && post.Text == text {
			if err := s.Events.Delete(post.ID); err != nil && s.Diag != nil {
				s.Diag.Printf("old stream feed post delete failed: %v", err)
			}
		}
	}
	meta := s.Events.Meta()
	author := strings.TrimSpace(meta.Host)
	if author == "" {
		author = "the DJ"
	}
	if _, _, err := s.Events.AddPost("dj", author, "🎧", text, nil, true); err != nil && s.Diag != nil {
		s.Diag.Printf("stream feed post failed: %v", err)
	}
}

// llhlsURL is the low-latency upgrade a guest MAY use if its device can
// resolve the domain and complete TLS — "" when not engaged/available.
func (s *srv) llhlsURL() string {
	if s.Broadcaster.Delivery() != "llhls" || !s.realCert() {
		return ""
	}
	host := s.liveDomain()
	if host == "" {
		return ""
	}
	return fmt.Sprintf("https://%s:%d/live/%s/index.m3u8", host, s.Config.TLSPort, s.Config.StreamPath)
}

// friendlyName prefers the device's real network name ("Ramine's iPhone",
// resolved once via reverse DNS / mDNS off the LAN IP and cached) over the
// generic UA label. macOS's resolver answers reverse mDNS for Apple devices, so
// this often works on a home/party Wi-Fi; it fails gracefully to the UA label.
func (s *srv) friendlyName(ip, ua string) string {
	label := deviceName(ua)
	if ip == "" || strings.HasPrefix(ip, "127.") || ip == "::1" || ip == "1" {
		return label
	}
	// Best: the device's FRIENDLY Bonjour name ("Ramine's iPhone").
	if v, ok := s.bonjour.Load(ip); ok {
		if name, _ := v.(string); name != "" {
			return name
		}
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

// cleanHostname turns "Ramines-iPhone.local." into "Ramines iPhone".
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
// every 3s, roster+sync state — a few KB that gzip to a fraction on venue
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

// suggest returns a quality hint when the network is straining.
func suggest(status string, bc broadcast.Status) string {
	if status != "strain" && status != "congested" {
		return ""
	}
	stereo := bc.Channels == 2
	high := kbps(bc.Bitrate) > 96
	switch {
	case stereo && high:
		return "Network strain — turn on Mono and/or lower the audio quality."
	case stereo:
		return "Network strain — turn on Mono."
	case high:
		return "Network strain — lower the audio quality."
	default:
		return "Network strain — already near the floor; the Wi-Fi/access point is likely the limit."
	}
}

// validBitrate allowlists the quality values the console can request; anything
// else returns "" so the broadcaster keeps its configured default.
func validBitrate(v string) string {
	switch v {
	case "64k", "96k", "128k", "160k", "192k", "256k", "320k":
		return v
	default:
		return ""
	}
}

// realCert reports whether the https guest link is actually SERVABLE — the
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

// currentTarget computes the fixed room target exposed by /api/status.
func (s *srv) currentTarget() float64 {
	bc := s.Broadcaster.Status()
	health := s.Listeners.Health(bc.State == "live", kbps(bc.Bitrate))
	return s.latencyTarget(bc, health.Status)
}

func (s *srv) streamSyncState(bc broadcast.Status, target float64) map[string]any {
	generation := bc.Since
	if bc.State != "live" || bc.Delivery != "llhls" || s.MTX == nil {
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
	}
	if !s.streamSyncReady && !s.streamSyncChecking && now.Sub(s.streamSyncCheckedAt) >= time.Second {
		s.streamSyncChecking = true
		s.streamSyncCheckedAt = now
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
	s.streamSyncMu.Unlock()

	if ready && !wasReady && s.Diag != nil {
		s.Diag.Printf("stream sync ready: generation=%d real=%.3fs gaps=%.3fs holdback=%.3fs target=%.3fs playlist=%s",
			generation, state.RealHistory, state.GapHistory, state.PartHoldBack, target, state.Generation)
	}
}

// activationState reports the secure-link status for the console.
func (s *srv) activationState() map[string]any {
	s.actMu.Lock()
	reason := s.actReason
	s.actMu.Unlock()
	return map[string]any{"ready": s.realCert(), "reason": reason}
}

// latencyTarget is the fixed wall-clock delay used for startup alignment.
// Moving this value while a room is live made healthy players seek whenever a
// struggling peer changed room health. Recovery is now strictly per-device.
func (s *srv) latencyTarget(bc broadcast.Status, _ string) float64 {
	if bc.Delivery == "llhls" {
		// The room's global sync approach owns the LL-HLS target so /api/status,
		// the EXT-X-START pin, and the client's align math all read ONE value and
		// can't disagree. syncTarget() resolves the current preset's target (or
		// inherits Config.LatencyTarget / the LL-HLS default). The historical
		// authoritative-deadline reasoning now lives in the "balanced"/"deep"
		// presets in syncmode.go.
		return s.syncTarget()
	}
	if s.Config.LatencyTarget > 0 {
		return s.Config.LatencyTarget
	}
	seg := bc.SegDur
	if seg <= 0 {
		seg = 1
	}
	// Plain HLS remains a development-only escape hatch with a deeper target.
	return 3*seg + 7
}

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
