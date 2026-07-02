package server

import (
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
	host := ip
	// The PAGE/QR must always load, so it uses the raw LAN IP — some routers'
	// DNS-rebind protection blocks the public-name→private-IP trick for the
	// phones even when the Mac's own resolver passes (field-verified pain).
	// Only the STREAM URL uses the activated domain (it needs the TLS cert);
	// an explicit --domain still overrides for power users who know their DNS.
	if s.Config.Domain != "" {
		host = s.Config.Domain
	}
	return urls{
		Primary:     fmt.Sprintf("http://%s:%d/", host, s.Config.Port),
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
		// --start-offset overrides the computed target for experiments.
		offset := s.Config.StartOffset
		if offset <= 0 {
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

// latencyTarget is the wall-clock delay behind the DJ that every listener
// aligns to — the sync contract for the room. Players park at this offset via
// EXT-X-START when they join (the standard HLS mechanism), then play untouched.
//
// ONE target for the whole room regardless of which delivery each guest ended
// up on (LL-HLS guests simply carry more cushion) — a mixed room must still
// drop together; that beats letting the LL cohort run 2s early. The base is
// the plain-HLS constraint (low mode = 5s) and the server adapts within
// [base, base+3]: stalls raise it 0.5s at a time (smooth — everyone drifts via
// rate, no skips), 5+ clean minutes decay 0.25s. --latency-target pins it.
func (s *srv) latencyTarget(bc broadcast.Status, healthStatus string) float64 {
	if s.Config.LatencyTarget > 0 {
		return s.Config.LatencyTarget
	}
	seg := bc.SegDur
	if seg <= 0 {
		seg = 1
	}
	// Field-calibrated: at 5s the first minutes were rough and the adaptive
	// controller settled the room at 6.5s — so start there instead of making
	// every party rediscover it.
	base := 3*seg + 3.5 // low(1s)=6.5, balanced(2s)=9.5, stable(3s)=12.5
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
		return "200ms", "1s", 16
	case "balanced":
		return "350ms", "1s", 16
	case "stable":
		return "500ms", "2s", 16
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
