package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/devices"
	"partyparty/internal/mediamtx"
	"partyparty/internal/netinfo"
	"partyparty/internal/stats"
)

type Deps struct {
	Config      config.Config
	Broadcaster *broadcast.Broadcaster
	Listeners   *stats.Listeners
	RunDir      string
	Web         fs.FS
	MTX         *mediamtx.Server // nil if mediamtx unavailable (LL-HLS disabled)
	// ReconfigureLLHLS rewrites mediamtx.yml with new LL-HLS timing and bounces
	// MediaMTX. nil when mediamtx is unavailable.
	ReconfigureLLHLS func(partDur, segDur string, segCount int) error

	// Version is the app build version — shown in UIs and broadcast to clients
	// so stale player pages refresh themselves after an update.
	Version string
}

type srv struct {
	Deps
	vendor     http.Handler
	curPartDur string

	// Adaptive room-latency target: the room finds its own floor instead of a
	// hardcoded pessimistic delay. Raised when listeners stall, decayed slowly
	// when clean. Guarded by adaptMu.
	adaptMu    sync.Mutex
	adaptDelta float64 // seconds above the base target, [0, 3]
	lastAdj    time.Time
	lastRaise  time.Time

	// Async activation result (cert broker / BYO) — set after launch so the
	// server can start serving instantly while certs are obtained in the
	// background. Guarded by actMu.
	actMu     sync.Mutex
	actDomain string
	actReason string // why activation isn't ready yet (console pending state)

	hostCache sync.Map // ip -> reverse-DNS device name ("" = looked up, nothing useful)
	bonjour   sync.Map // ip -> friendly Bonjour name ("Ramine's iPhone")
}

func New(d Deps) *Srv {
	return &Srv{srv{Deps: d, vendor: http.FileServer(http.FS(d.Web)), curPartDur: d.Config.PartDur}}
}

// Srv is the exported handle: an http.Handler plus the async-activation hook.
type Srv struct{ srv }

// SetActivation records a completed low-latency activation (real cert +
// resolvable domain). Guest/stream URLs and the console's LL-HLS gate flip
// live on the next status poll.
func (s *Srv) SetActivation(domain string) {
	s.actMu.Lock()
	s.actDomain = domain
	s.actReason = ""
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

var hlsFileRE = regexp.MustCompile(`^(stream\.m3u8|seg_\d+\.ts)$`)

func (s *srv) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.captiveProbe(w, r) {
		return
	}
	p := r.URL.Path
	switch {
	case p == "/":
		s.serveWeb(w, "listener.html", "no-cache")
	case p == "/dj" || p == "/dj/":
		s.serveWeb(w, "dj.html", "no-cache")
	case p == "/art-512.png":
		s.serveWeb(w, "art-512.png", "")
	case p == "/favicon.ico":
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(p, "/vendor/"):
		w.Header().Set("Cache-Control", "public, max-age=3600")
		s.vendor.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/hls/"):
		s.handleHLS(w, r)
	case strings.HasPrefix(p, "/api/"):
		s.handleAPI(w, r)
	default:
		if s.Config.Captive {
			http.Redirect(w, r, s.urls().Primary, http.StatusFound)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}
}

type urls struct {
	Primary     string          `json:"primary"`
	IP          string          `json:"ip"`
	Port        int             `json:"port"`
	HostnameURL string          `json:"hostnameUrl"`
	Interfaces  []netinfo.Iface `json:"interfaces"`
}

func (s *srv) urls() urls {
	ip := netinfo.PrimaryLanIP()
	// The Plex model: the ONLY advertised link is https:// on the activated
	// domain. The page itself requires working DNS + TLS — exactly the gate
	// that guarantees the LL stream will play for whoever loaded it. No http
	// fallback link is ever shown; until activation completes, Primary stays
	// http and the console renders a "setting up the secure link" state.
	if d := s.liveDomain(); d != "" && s.realCert() {
		return urls{
			Primary:     fmt.Sprintf("https://%s:%d/", d, s.Config.TLSPort),
			IP:          ip,
			Port:        s.Config.TLSPort,
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

func (s *srv) serveWeb(w http.ResponseWriter, name, cache string) {
	data, err := fs.ReadFile(s.Web, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if strings.HasSuffix(name, ".html") {
		// Stamp the build version into the page so it can detect a server
		// update and refresh itself (stale open tabs run old logic forever).
		data = []byte(strings.ReplaceAll(string(data), "__PP_VERSION__", s.Version))
	}
	w.Header().Set("Content-Type", mimeFor(name))
	if cache != "" {
		w.Header().Set("Cache-Control", cache)
	}
	_, _ = w.Write(data)
}

func (s *srv) handleAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/status":
		bc := s.Broadcaster.Status()
		health := s.Listeners.Health(bc.State == "live", kbps(bc.Bitrate))
		health.Suggestion = suggest(health.Status, bc)
		writeJSON(w, http.StatusOK, map[string]any{
			"name":           s.Config.Name,
			"appVersion":     s.Version,
			"broadcast":      bc,
			"listeners":      health.Listeners,
			"listenersTotal": s.Listeners.TotalUnique(),
			"health":         health,
			"urls":           s.urls(),
			"streamUrl":      s.streamURL(),
			"llhlsUrl":       s.llhlsURL(),
			"delivery":       bc.Delivery,
			"llhlsAvailable": s.MTX != nil,
			"llhlsRealCert":  s.realCert(),
			"activation":     s.activationState(),
			"latencyTarget":  s.latencyTarget(bc, health.Status),
			"log":            lastN(s.Broadcaster.Log(), 60),
			"captive":        s.Config.Captive,
			"latency":        s.Listeners.LatencySpread(),
			"roster":         s.Listeners.Roster(),
		})
	case "/api/time":
		// Master clock for the listeners' NTP-style offset estimate.
		writeJSON(w, http.StatusOK, map[string]any{"t": time.Now().UnixMilli()})
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
		s.Listeners.Heartbeat(key, q.Get("stalled") == "1", q.Get("paused") == "1", lat, hasLat, q.Get("plat"))
		rate, _ := strconv.ParseFloat(q.Get("rate"), 64)
		buf, _ := strconv.ParseFloat(q.Get("buf"), 64)
		s.Listeners.Debug(key, q.Get("del"), rate, buf)
		s.Listeners.Meta(key, clientIP(r), s.friendlyName(clientIP(r), r.UserAgent()))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/delivery":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
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
			if err := s.MTX.EnsureReady(s.Config.RTSPPort, 6*time.Second); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			s.Broadcaster.SetDelivery("llhls")
		} else {
			s.Broadcaster.SetDelivery("hls")
			if s.MTX != nil {
				s.MTX.Stop()
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/open-settings":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		var deepLink string
		switch r.URL.Query().Get("pane") {
		case "screen":
			deepLink = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
		case "mic":
			deepLink = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
		default:
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown pane"})
			return
		}
		_ = exec.Command("open", deepLink).Start()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/devices":
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
		q := r.URL.Query()
		device := q.Get("device")
		if device == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "device required"})
			return
		}
		// No broadcasting before the secure link exists (the test tone is
		// allowed — it's the DJ's own rehearsal, no guests involved).
		if device != "test" && !s.realCert() {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "secure guest link isn't ready yet — hold on (needs internet once)"})
			return
		}
		opts := broadcast.Options{Bitrate: validBitrate(q.Get("bitrate")), HLSTime: latencySegDur(q.Get("latency"))}
		switch q.Get("mono") {
		case "1", "true":
			opts.Channels = 1
		case "0", "false":
			opts.Channels = 2
		}
		// In LL-HLS the latency modes are part durations, applied by rewriting
		// mediamtx.yml and bouncing MediaMTX before ffmpeg re-pushes.
		if s.Broadcaster.Delivery() == "llhls" && s.ReconfigureLLHLS != nil {
			if part, seg, n := latencyPartDur(q.Get("latency")); part != "" && part != s.curPartDur {
				if err := s.ReconfigureLLHLS(part, seg, n); err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "low-latency reconfigure failed: " + err.Error()})
					return
				}
				s.curPartDur = part
			}
		}
		s.Broadcaster.Start(device, q.Get("name"), opts)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "/api/stop":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
			return
		}
		s.Broadcaster.Stop()
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

// handleHLS serves the plain-HLS files (delivery=hls). For delivery=llhls,
// MediaMTX serves the stream and this path is unused. Listener counting is via
// /api/heartbeat, so this just serves files.
func (s *srv) handleHLS(w http.ResponseWriter, r *http.Request) {
	file := path.Base(r.URL.Path)
	if !hlsFileRE.MatchString(file) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if strings.HasSuffix(file, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		// THE sync mechanism ("aligned start, passive playback"): every player
		// that joins parks at the same program position — the room target —
		// via the standard EXT-X-START tag, then plays untouched at 1.0x.
		// Devices stay in sync because they STARTED in sync; no client-side
		// rate control or corrective seeking (that was a field disaster on
		// real iOS hardware). Players that ignore the tag park at their own
		// default — worse spread for that device, zero artifacts: fails soft.
		// --start-offset overrides the computed target for experiments. In
		// LL-HLS mode this plain playlist is only the fallback for probe-failed
		// guests, so we DON'T inject (a 2.3s offset is impossible on 1s plain
		// segments) — those outliers just park at their natural position.
		offset := s.Config.StartOffset
		if offset <= 0 && s.Broadcaster.Delivery() != "llhls" {
			offset = s.currentTarget()
		}
		if offset > 0 {
			if data, err := os.ReadFile(filepath.Join(s.RunDir, file)); err == nil {
				tag := fmt.Sprintf("#EXT-X-START:TIME-OFFSET=-%.1f,PRECISE=YES\n", offset)
				out := strings.Replace(string(data), "#EXTM3U\n", "#EXTM3U\n"+tag, 1)
				_, _ = w.Write([]byte(out))
				return
			}
		}
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
		// no-store: each live segment URL is fetched once per client, so caching
		// buys nothing — but a cached segment surviving a broadcast restart can
		// replay the PREVIOUS set's audio under the same URL. Never cache.
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeFile(w, r, filepath.Join(s.RunDir, file))
}

// streamURL is the baseline every device can play: our plain-HLS playlist
// (in llhls mode the tee still writes it). The LL-HLS URL is advertised
// separately (llhlsURL) and each guest probes it, falling back here.
func (s *srv) streamURL() string {
	return "/hls/stream.m3u8"
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
	return fmt.Sprintf("https://%s:%d/%s/index.m3u8", host, s.Config.HLSPort, s.Config.StreamPath)
}

// captiveProbe answers the OS connectivity-check URLs. Only reached when this
// Mac is the DNS for those hostnames (i.e. DNS hijack). When captive mode is
// off, answer "online" so a guest's normal connectivity is never broken.
func (s *srv) captiveProbe(w http.ResponseWriter, r *http.Request) bool {
	p := r.URL.Path
	isApple := p == "/hotspot-detect.html" || strings.HasPrefix(p, "/library/test/success.html")
	isAndroid := p == "/generate_204" || p == "/gen_204"
	isWindows := p == "/ncsi.txt" || strings.HasPrefix(p, "/connecttest.txt")
	if !isApple && !isAndroid && !isWindows {
		return false
	}
	if !s.Config.Captive {
		switch {
		case isAndroid:
			w.WriteHeader(http.StatusNoContent)
		case isWindows:
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("Microsoft NCSI"))
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>"))
		}
		return true
	}
	s.captiveLanding(w)
	return true
}

func (s *srv) captiveLanding(w http.ResponseWriter) {
	u := s.urls()
	html := `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
		`<title>` + s.Config.Name + `</title>` +
		`<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0b12;color:#fff;text-align:center;padding:48px 20px;margin:0">` +
		`<h1 style="font-weight:600">` + s.Config.Name + `</h1>` +
		`<p style="color:#9aa0b4">Tap to open the live audio player in your browser.</p>` +
		`<p><a href="` + u.Primary + `" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:16px 28px;border-radius:12px;font-size:18px">Open the player</a></p>` +
		`<p style="color:#6b7088;font-size:14px">If nothing happens, open your browser and go to<br><b>` + u.Primary + `</b></p></body>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(html))
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

// realCert reports whether a publicly-trusted cert is available — the gate
// for LL-HLS (iOS Safari rejects self-signed certs on LAN IPs). True when
// explicitly configured or when async activation has completed.
func (s *srv) realCert() bool {
	if s.Config.Domain != "" && s.Config.CertFile != "" && s.Config.KeyFile != "" {
		return true
	}
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

// currentTarget computes the room target for playlist injection (hot path:
// every playlist fetch), reusing the same adaptive state as /api/status.
func (s *srv) currentTarget() float64 {
	bc := s.Broadcaster.Status()
	health := s.Listeners.Health(bc.State == "live", kbps(bc.Bitrate))
	return s.latencyTarget(bc, health.Status)
}

// activationState reports the secure-link status for the console.
func (s *srv) activationState() map[string]any {
	s.actMu.Lock()
	reason := s.actReason
	s.actMu.Unlock()
	return map[string]any{"ready": s.realCert(), "reason": reason}
}

// latencyTarget is the wall-clock delay behind the DJ that the room aligns to —
// the sync contract. It DIFFERS by delivery because native and hls.js park at
// different natural points, and the target is what reconciles them:
//   - LL-HLS: native iOS parks at PART-HOLD-BACK (2.5×part) by itself; the
//     target ≈ that + ~1s player overhead, and hls.js is told (liveSyncDuration)
//     to hold the SAME distance instead of running ~1s closer to live (the
//     "Ethernet PC is early" bug). So all platforms land together at ~2.3s.
//   - Plain HLS: everyone parks at the injected EXT-X-START; deep + generous
//     (tightness ≫ closeness, product decree).
//
// The server adapts within [base, base+3] on sustained stalls. --latency-target
// pins it.
func (s *srv) latencyTarget(bc broadcast.Status, healthStatus string) float64 {
	if s.Config.LatencyTarget > 0 {
		return s.Config.LatencyTarget
	}
	var base float64
	if bc.Delivery == "llhls" {
		part := parseDurSeconds(s.curPartDur)
		if part <= 0 {
			part = 0.5
		}
		base = 2.5*part + 1.0 // 500ms→2.25, 800ms→3.0, 1s→3.5
	} else {
		seg := bc.SegDur
		if seg <= 0 {
			seg = 1
		}
		// Field-calibrated, then deliberately generous: tightness-of-room beats
		// closeness-to-DJ (product decree). A deep park position = fat buffer on
		// every phone = fewer stalls = fewer drift events = a tighter room all
		// night. The DJ-to-ear delay is the price and it's explicitly accepted.
		base = 3*seg + 7 // low(1s)=10, balanced(2s)=13, stable(3s)=16
	}
	s.adaptMu.Lock()
	defer s.adaptMu.Unlock()
	now := time.Now()
	if now.Sub(s.lastAdj) > 90*time.Second {
		switch healthStatus {
		case "strain", "congested":
			if s.adaptDelta < 3 {
				s.adaptDelta += 0.5
				s.lastRaise = now
			}
			s.lastAdj = now
		case "good":
			if s.adaptDelta > 0 && now.Sub(s.lastRaise) > 5*time.Minute {
				s.adaptDelta -= 0.25
				s.lastAdj = now
			}
		}
	}
	return base + s.adaptDelta
}

// latencySegDur maps a latency mode to an HLS segment length (seconds).
// Real-world glass-to-glass ≈ 4x this (Safari parks 3x TARGETDURATION behind
// live, plus the segment being filled), so low/balanced/stable ≈ 4s/7-8s/10s.
// 0 = keep the configured default.
func latencySegDur(mode string) float64 {
	switch mode {
	case "low":
		return 1
	case "balanced":
		return 2
	case "stable":
		return 3
	default:
		return 0
	}
}

// latencyPartDur maps a latency mode to LL-HLS timing (part duration, segment
// duration, playlist segment count). PART-HOLD-BACK = 2.5x part (gohlslib), so
// glass-to-glass ≈ hold-back + ~1s player overhead: low ≈ 1.4-2s (200ms parts —
// experimental: field data saw iPhones stall at 200ms with video; audio-only
// must prove itself on a device soak), balanced ≈ 1.7-2.5s (350ms, the shipped
// default), stable ≈ 2.2-3s (500ms, biggest cushion).
func latencyPartDur(mode string) (string, string, int) {
	switch mode {
	case "low":
		return "500ms", "1s", 16 // hold-back 1.25s — the standard cushion
	case "balanced":
		return "800ms", "2s", 16 // hold-back 2s
	case "stable":
		return "1000ms", "2s", 16 // hold-back 2.5s — party Wi-Fi armor
	default:
		return "", "", 0
	}
}

func lastN(s []string, n int) []string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
