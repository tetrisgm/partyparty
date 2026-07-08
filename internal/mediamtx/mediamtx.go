// Package mediamtx manages an embedded MediaMTX process that turns our RTSP
// audio push into Low-Latency HLS over HTTPS.
package mediamtx

import (
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
	"os"
	"os/exec"
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
		Subject:               pkix.Name{CommonName: "partyparty"},
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
hlsAddress: :%d
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
// guest-critical port (port conflict, bad config) is a hard error — callers
// fall back to plain HLS instead of showing guests a dead stream.
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
	// can own it while OUR child died on "bind: address already in use" —
	// field failure: the DJ broadcast into a zombie serving a certificate no
	// phone accepts, and zero guests could join. Ready means OUR process.
	if !s.Running() {
		return fmt.Errorf("port %d is served by another mediamtx (stale orphan?) — our instance failed to bind", rtspPort)
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
		client := &http.Client{
			Timeout: remaining,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
		resp, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("mediamtx HLS endpoint not accepting HTTPS at %s after %s", addr, timeout)
}

// PathPublishing asks MediaMTX's own guest-facing truth — the local LL-HLS
// master manifest — whether a live publisher exists on the given path. This is
// the HONEST liveness the app must consult before trusting "live": ffmpeg's
// -progress only proves the encoder is running (the recording tee leg alone
// keeps it running), NOT that the RTSP publish leg actually landed in MediaMTX.
// Returns publishing=true when the manifest is a real playlist; false (with the
// body prefix) when MediaMTX answers its "no stream is available on path
// '<path>'" JSON — byte-for-byte what a guest sees. localhost-only, same
// InsecureSkipVerify transport as WaitHTTPSReady.
func PathPublishing(hlsPort int, path string) (publishing bool, httpCode int, bodyPrefix string) {
	url := fmt.Sprintf("https://127.0.0.1:%d/%s/index.m3u8", hlsPort, path)
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
	resp, err := client.Get(url)
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

// Stop signals MediaMTX to exit and returns immediately (shutdown path).
func (s *Server) Stop() { s.stop(false) }

// StopWait stops MediaMTX and BLOCKS until the process is actually gone.
// Required before a config-change restart: the old instance holds the RTSP and
// HLS ports until it dies, so launching the replacement early makes IT lose
// the bind and exit — while WaitReady happily connects to the dying listener
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
