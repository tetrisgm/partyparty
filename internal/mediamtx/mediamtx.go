// Package mediamtx manages an embedded MediaMTX process that turns our RTSP
// audio push into Low-Latency HLS over HTTPS.
package mediamtx

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
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
	yml := fmt.Sprintf(`logLevel: warn
api: no
metrics: no
playback: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: :%d
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
	s.cmd = cmd
	s.running = true
	s.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
			s.running = false
		}
		s.mu.Unlock()
	}()
	return nil
}

// EnsureReady starts MediaMTX (if needed) and waits for its RTSP port. A
// MediaMTX that launches but never opens its ingest port (port conflict, bad
// config) is a hard error — callers fall back to plain HLS instead of showing
// guests a dead stream.
func (s *Server) EnsureReady(rtspPort int, timeout time.Duration) error {
	if err := s.Start(); err != nil {
		return err
	}
	return WaitReady(fmt.Sprintf("127.0.0.1:%d", rtspPort), timeout)
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

func (s *Server) Stop() {
	s.mu.Lock()
	cmd := s.cmd
	s.cmd = nil
	s.running = false
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGINT)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		_ = cmd.Process.Kill()
	}()
}
