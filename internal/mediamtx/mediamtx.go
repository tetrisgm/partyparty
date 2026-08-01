// Package mediamtx manages an embedded MediaMTX process that turns our RTSP
// audio push into Low-Latency HLS over HTTPS.
package mediamtx

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Find locates the mediamtx binary (custom path wins, else $PATH).
func Find(custom string) (string, error) {
	if custom != "" {
		return custom, nil
	}
	return exec.LookPath("mediamtx")
}

// GenerateSelfSignedCert writes a self-signed cert/key covering the given IPs
// and hostnames. Used for local testing when no real cert is supplied.
func GenerateSelfSignedCert(certPath, keyPath string, ips, hosts []string) error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "PartyParty"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, h := range hosts {
		if h != "" {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	for _, ip := range ips {
		if p := net.ParseIP(ip); p != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, p)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return err
	}
	return os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
}

type ConfigOpts struct {
	RTSPPort int
	HLSPort  int
	Path     string
	CertPath string
	KeyPath  string
	SegDur   string // e.g. "1s"
	PartDur  string // e.g. "200ms"
	SegCount int
}

// WriteConfig writes a minimal LL-HLS mediamtx.yml.
func WriteConfig(path string, o ConfigOpts) error {
	yml := fmt.Sprintf(`logLevel: info
api: no
metrics: no
playback: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: 127.0.0.1:%d
rtspTransports: [tcp]
moq: no
hls: yes
hlsAddress: 127.0.0.1:%d
hlsEncryption: yes
hlsServerCert: %s
hlsServerKey: %s
hlsVariant: lowLatency
hlsAlwaysRemux: yes
hlsSegmentCount: %d
hlsSegmentDuration: %s
hlsPartDuration: %s
hlsAllowOrigins: ['*']
authInternalUsers:
- user: any
  pass:
  permissions:
  - action: publish
  - action: read
paths:
  %s:
`, o.RTSPPort, o.HLSPort, o.CertPath, o.KeyPath, o.SegCount, o.SegDur, o.PartDur, o.Path)
	return os.WriteFile(path, []byte(yml), 0o644)
}

// Server runs and supervises the mediamtx subprocess.
type Server struct {
	bin     string
	cfgPath string
	log     io.Writer

	mu      sync.Mutex
	cmd     *exec.Cmd
	done    chan struct{} // closed when cmd exits (nil until first Start)
	running bool
}

func NewServer(bin, cfgPath string, log io.Writer) *Server {
	return &Server{bin: bin, cfgPath: cfgPath, log: log}
}

// Start launches MediaMTX if not already running (idempotent).
func (s *Server) Start() error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil
	}
	cmd := exec.Command(s.bin, s.cfgPath)
	cmd.Stdout = s.log
	cmd.Stderr = s.log
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	done := make(chan struct{})
	s.cmd = cmd
	s.done = done
	s.running = true
	s.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		close(done)
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
			s.running = false
		}
		s.mu.Unlock()
	}()
	return nil
}

// EnsureReady starts MediaMTX (if needed) and waits for both its RTSP ingest
// port and HTTPS HLS endpoint. A MediaMTX that launches but never opens either
// guest-critical port (port conflict, bad config) is a hard error so callers
// refuse Go Live instead of showing guests a dead stream.
func (s *Server) EnsureReady(rtspPort, hlsPort int, timeout time.Duration) error {
	if err := s.Start(); err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	if err := WaitReady(fmt.Sprintf("127.0.0.1:%d", rtspPort), time.Until(deadline)); err != nil {
		return err
	}
	if err := WaitHTTPSReady(fmt.Sprintf("127.0.0.1:%d", hlsPort), time.Until(deadline)); err != nil {
		return err
	}
	// The port answering is NOT enough: a stale orphan (old config, old CERT)
	// can own it while OUR child died on "bind: address already in use" -
	// field failure: the DJ broadcast into a zombie serving a certificate no
	// phone accepts, and zero guests could join. Ready means OUR process.
	if !s.Running() {
		return fmt.Errorf("port %d is served by another mediamtx (stale orphan?) - our instance failed to bind", rtspPort)
	}
	return nil
}

// ReapOrphans kills leftover mediamtx processes squatting on our ports (a
// force-quit skips child cleanup; the orphan may be from an OLD app version
// at a different binary path, so path matching is not enough). Only processes
// whose executable is named "mediamtx" are touched.
func ReapOrphans(ports ...int) int {
	killed := map[string]bool{}
	for _, port := range ports {
		out, err := exec.Command("lsof", "-ti", fmt.Sprintf("tcp:%d", port), "-sTCP:LISTEN").Output()
		if err != nil {
			continue // nobody listening
		}
		for _, pid := range strings.Fields(string(out)) {
			if killed[pid] {
				continue
			}
			comm, err := exec.Command("ps", "-o", "comm=", "-p", pid).Output()
			if err != nil {
				continue
			}
			name := strings.TrimSpace(string(comm))
			if strings.HasSuffix(name, "/mediamtx") || name == "mediamtx" {
				_ = exec.Command("kill", pid).Run()
				killed[pid] = true
			}
		}
	}
	if len(killed) > 0 {
		time.Sleep(time.Second) // let the ports actually free
	}
	return len(killed)
}

func (s *Server) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// WaitReady blocks until addr accepts TCP connections or timeout elapses.
func WaitReady(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
			_ = c.Close()
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("mediamtx not accepting connections at %s after %s", addr, timeout)
}

// WaitHTTPSReady blocks until addr completes a TLS/HTTP request or timeout
// elapses. Any HTTP status counts: readiness is about the guest-facing HTTPS
// HLS listener existing, not a specific stream already being published.
func WaitHTTPSReady(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := "https://" + addr + "/"
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		if remaining > 300*time.Millisecond {
			remaining = 300 * time.Millisecond
		}
		// Shared probeClient (same leak class as the playlist probes: a per-call
		// Transport strands its idle conn); the per-attempt bound rides a request
		// context since it is tighter than the client's own 2s timeout.
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		req, rerr := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if rerr != nil {
			cancel()
			return rerr
		}
		resp, err := probeClient.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			cancel()
			return nil
		}
		cancel()
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("mediamtx HLS endpoint not accepting HTTPS at %s after %s", addr, timeout)
}

// PathPublishing asks MediaMTX's own guest-facing truth - the local LL-HLS
// master manifest - whether a live publisher exists on the given path. This is
// the HONEST liveness the app must consult before trusting "live": ffmpeg's
// -progress only proves the encoder is running (the recording tee leg alone
// keeps it running), NOT that the RTSP publish leg actually landed in MediaMTX.
// Returns publishing=true when the manifest is a real playlist; false (with the
// body prefix) when MediaMTX answers its "no stream is available on path
// '<path>'" JSON - byte-for-byte what a guest sees. localhost-only, same
// InsecureSkipVerify transport as WaitHTTPSReady.
func PathPublishing(hlsPort int, path string) (publishing bool, httpCode int, bodyPrefix string) {
	url := fmt.Sprintf("https://127.0.0.1:%d/%s/index.m3u8", hlsPort, path)
	resp, err := probeClient.Get(url)
	if err != nil {
		return false, 0, "http error: " + err.Error()
	}
	defer resp.Body.Close()
	buf := make([]byte, 160)
	n, _ := io.ReadFull(resp.Body, buf)
	body := strings.TrimSpace(string(buf[:n]))
	prefix := body
	if len(prefix) > 80 {
		prefix = prefix[:80]
	}
	return strings.HasPrefix(body, "#EXTM3U"), resp.StatusCode, prefix
}

// HLSReadiness describes the real media currently available in an LL-HLS
// playlist. MediaMTX deliberately prefixes a new LL-HLS stream with seven GAP
// segments for iOS compatibility; those gaps are seekable timeline but not
// playable audio and must not be mistaken for startup history.
type HLSReadiness struct {
	Publishing   bool
	Generation   string
	RealHistory  float64
	GapHistory   float64
	PartHoldBack float64
	PartTarget   float64
}

// InspectHLS follows MediaMTX's multivariant playlist to its media playlist and
// reports the contiguous non-GAP history at the live edge. It is intended for
// a cached readiness probe, not for every guest request.
func InspectHLS(hlsPort int, streamPath string) HLSReadiness {
	body, mediaURL, ok := fetchMediaPlaylist(hlsPort, streamPath)
	if !ok {
		return HLSReadiness{}
	}
	state := parseHLSMediaPlaylist(body)
	state.Publishing = true
	state.Generation = lastPathComponent(mediaURL.Path)
	return state
}

// probeClient is shared by every loopback playlist probe. A per-call client
// leaks: an abandoned zero-value Transport never expires its idle keep-alive
// TLS connection (IdleConnTimeout=0) and MediaMTX sets no server-side idle
// timeout either - at the part-cadence heartbeat's 1/s sampling that compounds
// into thousands of stuck connections and goroutines over one live set, in
// BOTH processes. Sharing also reuses the connection, so steady sampling costs
// no TLS handshake at all.
var probeClient = &http.Client{
	Timeout: 2 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // loopback MediaMTX serves the hot-swapped cert
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
	},
}

// fetchMediaPlaylist follows the multivariant playlist to the media playlist
// and returns its body. Shared by InspectHLS and PlaylistTip.
func fetchMediaPlaylist(hlsPort int, streamPath string) (string, *url.URL, bool) {
	client := probeClient
	masterURL, _ := url.Parse(fmt.Sprintf("https://127.0.0.1:%d/%s/index.m3u8", hlsPort, streamPath))
	body, finalURL, ok := fetchPlaylist(client, masterURL)
	if !ok {
		return "", finalURL, false
	}
	mediaURL := finalURL
	if variant := playlistVariantURI(body); variant != "" {
		rel, err := url.Parse(variant)
		if err != nil {
			return "", mediaURL, false
		}
		mediaURL = finalURL.ResolveReference(rel)
		body, mediaURL, ok = fetchPlaylist(client, mediaURL)
		if !ok {
			return "", mediaURL, false
		}
	}
	return body, mediaURL, true
}

// PlaylistTip returns an opaque token identifying the LIVE EDGE of the media
// playlist. While the engine is healthy the token changes about once per
// PART-TARGET; a token that stops changing means MediaMTX stopped emitting new
// media - a PRODUCTION gap that every connected guest feels at the same moment
// (unlike per-phone Wi-Fi trouble, which hits one guest at a time). The
// part-cadence heartbeat samples this to attribute correlated guest stalls.
func PlaylistTip(hlsPort int, streamPath string) (string, bool) {
	body, _, ok := fetchMediaPlaylist(hlsPort, streamPath)
	if !ok {
		return "", false
	}
	return playlistTipToken(body), true
}

// playlistTipToken derives the tip identity from a media playlist body: the
// media sequence plus the newest part URI (falling back to the newest segment
// URI on non-LL playlists). Any new emission changes the token.
func playlistTipToken(body string) string {
	var seq, lastPart, lastSeg string
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			seq = strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:")
		case strings.HasPrefix(line, "#EXT-X-PART:"):
			if uri := playlistAttribute(line, "URI"); uri != "" {
				lastPart = uri
			}
		case line != "" && !strings.HasPrefix(line, "#"):
			lastSeg = line
		}
	}
	tip := lastPart
	if tip == "" {
		tip = lastSeg
	}
	return seq + "|" + tip
}

func fetchPlaylist(client *http.Client, playlistURL *url.URL) (string, *url.URL, bool) {
	resp, err := client.Get(playlistURL.String())
	if err != nil {
		return "", playlistURL, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", resp.Request.URL, false
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(data)), "#EXTM3U") {
		return "", resp.Request.URL, false
	}
	return string(data), resp.Request.URL, true
}

func playlistVariantURI(body string) string {
	// A media playlist already has its own timeline. Otherwise the first bare
	// URI following EXT-X-STREAM-INF is the variant to inspect.
	if strings.Contains(body, "#EXT-X-MEDIA-SEQUENCE:") {
		return ""
	}
	wantURI := false
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			wantURI = true
			continue
		}
		if wantURI && line != "" && !strings.HasPrefix(line, "#") {
			return line
		}
	}
	return ""
}

type hlsTimelineUnit struct {
	duration float64
	gap      bool
}

func parseHLSMediaPlaylist(body string) HLSReadiness {
	var state HLSReadiness
	var units []hlsTimelineUnit
	pendingDuration := -1.0
	pendingGap := false

	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:"):
			state.PartHoldBack = playlistAttributeFloat(line, "PART-HOLD-BACK")
		case strings.HasPrefix(line, "#EXT-X-PART-INF:"):
			state.PartTarget = playlistAttributeFloat(line, "PART-TARGET")
		case line == "#EXT-X-GAP":
			pendingGap = true
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimPrefix(line, "#EXTINF:")
			if comma := strings.IndexByte(value, ','); comma >= 0 {
				value = value[:comma]
			}
			pendingDuration, _ = strconv.ParseFloat(value, 64)
		case strings.HasPrefix(line, "#EXT-X-PART:"):
			duration := playlistAttributeFloat(line, "DURATION")
			if duration > 0 {
				units = append(units, hlsTimelineUnit{
					duration: duration,
					gap:      strings.EqualFold(playlistAttribute(line, "GAP"), "YES"),
				})
			}
		case line != "" && !strings.HasPrefix(line, "#") && pendingDuration >= 0:
			units = append(units, hlsTimelineUnit{duration: pendingDuration, gap: pendingGap})
			pendingDuration = -1
			pendingGap = false
		}
	}

	for _, unit := range units {
		if unit.gap {
			state.GapHistory += unit.duration
		}
	}
	for i := len(units) - 1; i >= 0; i-- {
		if units[i].gap {
			break
		}
		state.RealHistory += units[i].duration
	}
	return state
}

func playlistAttributeFloat(line, key string) float64 {
	value := playlistAttribute(line, key)
	n, _ := strconv.ParseFloat(value, 64)
	return n
}

func playlistAttribute(line, key string) string {
	colon := strings.IndexByte(line, ':')
	if colon < 0 {
		return ""
	}
	prefix := key + "="
	for _, field := range strings.Split(line[colon+1:], ",") {
		field = strings.TrimSpace(field)
		if strings.HasPrefix(field, prefix) {
			return strings.Trim(strings.TrimPrefix(field, prefix), `"`)
		}
	}
	return ""
}

func lastPathComponent(value string) string {
	value = strings.TrimSuffix(value, "/")
	if slash := strings.LastIndexByte(value, '/'); slash >= 0 {
		return value[slash+1:]
	}
	return value
}

// Stop signals MediaMTX to exit and returns immediately (shutdown path).
func (s *Server) Stop() { s.stop(false) }

// StopWait stops MediaMTX and BLOCKS until the process is actually gone.
// Required before a config-change restart: the old instance holds the RTSP and
// HLS ports until it dies, so launching the replacement early makes IT lose
// the bind and exit - while WaitReady happily connects to the dying listener
// and reports success. That race is exactly how switching latency modes
// bricked broadcasting in the field until an app restart.
func (s *Server) StopWait() { s.stop(true) }

func (s *Server) stop(wait bool) {
	s.mu.Lock()
	cmd, done := s.cmd, s.done
	s.cmd = nil
	s.running = false
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGINT)
	if !wait {
		go func() {
			select {
			case <-done:
			case <-time.After(1500 * time.Millisecond):
				_ = cmd.Process.Kill()
			}
		}()
		return
	}
	select {
	case <-done:
	case <-time.After(1500 * time.Millisecond):
		_ = cmd.Process.Kill()
		select {
		case <-done: // Wait() reaps the kill almost instantly
		case <-time.After(2 * time.Second):
		}
	}
}
