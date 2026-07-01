// Package activate implements the "real cert on a LAN" story that unlocks
// LL-HLS for iPhones (the Plex *.plex.direct pattern):
//
//  1. a publicly-trusted certificate for a host you control (Let's Encrypt,
//     DNS-01 via the Cloudflare API — never needs inbound reachability), and
//  2. a public A record pointing that host at the Mac's current LAN IP, so
//     guests on the same Wi-Fi resolve it locally (RFC1918 in public DNS —
//     exactly what Plex does).
//
// Requirements (both optional — without them partyparty just uses plain HLS):
//   - PARTYPARTY_LIVE_HOST (or --live-host): e.g. "dj.ramine.net"
//   - PARTYPARTY_CF_TOKEN env, or a token in <app-support>/cf-token, scoped to
//     Zone → DNS → Edit for that host's zone.
//
// Everything fails SOFT: offline, bad token, DNS-rebind-protected router — the
// app logs why and falls back to plain HLS. The locked-phone rule is untouched
// (LL-HLS is still standard HLS through the native player).
package activate

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
)

const (
	letsEncryptDir = "https://acme-v02.api.letsencrypt.org/directory"
	renewWindow    = 30 * 24 * time.Hour
)

// Result reports what activation achieved.
type Result struct {
	OK       bool
	Host     string
	CertFile string
	KeyFile  string
	Reason   string // why activation is off/failed (for the log)
}

type Logf func(format string, args ...any)

// Try runs the full activation flow. It is synchronous but fast on the common
// path (valid cached cert + correct A record = two lookups); the slow path
// (first issuance) only happens once per ~60 days and only with internet.
func Try(host, token string, lanIP string, logf Logf) Result {
	if host == "" {
		return Result{Reason: "no live host configured (set PARTYPARTY_LIVE_HOST to enable low latency)"}
	}
	if token == "" {
		return Result{Host: host, Reason: "no Cloudflare token (set PARTYPARTY_CF_TOKEN or write <app-support>/cf-token)"}
	}
	if lanIP == "" {
		return Result{Host: host, Reason: "no LAN IP yet"}
	}
	dir, err := stateDir()
	if err != nil {
		return Result{Host: host, Reason: "no state dir: " + err.Error()}
	}
	certFile := filepath.Join(dir, "live-cert.pem")
	keyFile := filepath.Join(dir, "live-key.pem")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	cf := &cfAPI{token: token}

	// 1. Certificate: reuse if valid for this host and not near expiry.
	if !certUsable(certFile, host) {
		logf("activate: obtaining certificate for %s (Let's Encrypt, DNS-01)…", host)
		if err := issueCert(ctx, cf, host, certFile, keyFile, dir, logf); err != nil {
			return Result{Host: host, Reason: "certificate: " + err.Error()}
		}
		logf("activate: certificate issued for %s", host)
	}

	// 2. Public A record → this Mac's LAN IP.
	if err := cf.upsertA(ctx, host, lanIP); err != nil {
		return Result{Host: host, Reason: "DNS update: " + err.Error()}
	}

	// 3. Self-check through the system resolver (≈ what guests' phones use via
	// the router). Catches rebind-protecting routers and stale caches.
	if err := verifyResolves(ctx, host, lanIP); err != nil {
		return Result{Host: host, CertFile: certFile, KeyFile: keyFile,
			Reason: "resolution check: " + err.Error() + " (router DNS-rebind protection? falling back to plain HLS)"}
	}

	return Result{OK: true, Host: host, CertFile: certFile, KeyFile: keyFile}
}

// TokenFromEnvOrFile resolves the Cloudflare API token.
func TokenFromEnvOrFile() string {
	if t := strings.TrimSpace(os.Getenv("PARTYPARTY_CF_TOKEN")); t != "" {
		return t
	}
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dir, "cf-token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func stateDir() (string, error) {
	base, err := os.UserConfigDir() // ~/Library/Application Support on macOS
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "partyparty")
	return dir, os.MkdirAll(dir, 0o700)
}

// certUsable reports whether the cached cert covers host and has >renewWindow left.
func certUsable(certFile, host string) bool {
	data, err := os.ReadFile(certFile)
	if err != nil {
		return false
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return false
	}
	if err := cert.VerifyHostname(host); err != nil {
		return false
	}
	return time.Until(cert.NotAfter) > renewWindow
}

// ---- ACME (Let's Encrypt, DNS-01) ----

func issueCert(ctx context.Context, cf *cfAPI, host, certFile, keyFile, dir string, logf Logf) error {
	acct, err := loadOrCreateKey(filepath.Join(dir, "acme-account-key.pem"))
	if err != nil {
		return err
	}
	client := &acme.Client{Key: acct, DirectoryURL: letsEncryptDir}
	if _, err := client.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil &&
		!errors.Is(err, acme.ErrAccountAlreadyExists) {
		return fmt.Errorf("ACME register: %w", err)
	}

	order, err := client.AuthorizeOrder(ctx, acme.DomainIDs(host))
	if err != nil {
		return fmt.Errorf("ACME order: %w", err)
	}

	var cleanup []func()
	defer func() {
		for _, f := range cleanup {
			f()
		}
	}()
	for _, authzURL := range order.AuthzURLs {
		authz, err := client.GetAuthorization(ctx, authzURL)
		if err != nil {
			return err
		}
		if authz.Status == acme.StatusValid {
			continue
		}
		var chal *acme.Challenge
		for _, c := range authz.Challenges {
			if c.Type == "dns-01" {
				chal = c
				break
			}
		}
		if chal == nil {
			return errors.New("no dns-01 challenge offered")
		}
		txtVal, err := client.DNS01ChallengeRecord(chal.Token)
		if err != nil {
			return err
		}
		txtName := "_acme-challenge." + host
		recID, err := cf.createTXT(ctx, txtName, txtVal)
		if err != nil {
			return fmt.Errorf("challenge TXT: %w", err)
		}
		cleanup = append(cleanup, func() { _ = cf.deleteRecord(context.Background(), recID) })

		logf("activate: waiting for DNS challenge to propagate…")
		if err := waitTXT(ctx, txtName, txtVal); err != nil {
			return err
		}
		if _, err := client.Accept(ctx, chal); err != nil {
			return fmt.Errorf("challenge accept: %w", err)
		}
		if _, err := client.WaitAuthorization(ctx, authz.URI); err != nil {
			return fmt.Errorf("authorization: %w", err)
		}
	}

	if _, err := client.WaitOrder(ctx, order.URI); err != nil {
		return fmt.Errorf("order: %w", err)
	}

	certKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
	}, certKey)
	if err != nil {
		return err
	}
	chain, _, err := client.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		return fmt.Errorf("finalize: %w", err)
	}

	var certPEM bytes.Buffer
	for _, der := range chain {
		_ = pem.Encode(&certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	}
	keyDER, err := x509.MarshalECPrivateKey(certKey)
	if err != nil {
		return err
	}
	if err := os.WriteFile(certFile, certPEM.Bytes(), 0o644); err != nil {
		return err
	}
	return os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
}

func loadOrCreateKey(path string) (*ecdsa.PrivateKey, error) {
	if data, err := os.ReadFile(path); err == nil {
		if block, _ := pem.Decode(data); block != nil {
			if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
				return k, nil
			}
		}
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return nil, err
	}
	return k, os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600)
}

// waitTXT polls a public resolver until the challenge record is visible.
func waitTXT(ctx context.Context, name, want string) error {
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, "1.1.1.1:53")
	}}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		vals, _ := r.LookupTXT(ctx, name)
		for _, v := range vals {
			if v == want {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return errors.New("challenge TXT did not propagate in time")
}

// verifyResolves checks the SYSTEM resolver returns the LAN IP for host —
// the same path guests' phones take through the venue router.
func verifyResolves(ctx context.Context, host, lanIP string) error {
	var lastErr error
	for i := 0; i < 4; i++ {
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		if err == nil {
			for _, a := range addrs {
				if a == lanIP {
					return nil
				}
			}
			lastErr = fmt.Errorf("%s resolves to %v, not %s", host, addrs, lanIP)
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return lastErr
}

// ---- Cloudflare DNS API (token-scoped: Zone → DNS → Edit) ----

type cfAPI struct {
	token  string
	zoneID string
}

func (c *cfAPI) do(ctx context.Context, method, url string, body any, out any) error {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var envelope struct {
		Success bool            `json:"success"`
		Errors  []struct{ Message string } `json:"errors"`
		Result  json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("cloudflare: bad response (%s)", resp.Status)
	}
	if !envelope.Success {
		if len(envelope.Errors) > 0 {
			return fmt.Errorf("cloudflare: %s", envelope.Errors[0].Message)
		}
		return fmt.Errorf("cloudflare: request failed (%s)", resp.Status)
	}
	if out != nil {
		return json.Unmarshal(envelope.Result, out)
	}
	return nil
}

// zone finds the zone id for host by walking suffixes (dj.party.ramine.net →
// party.ramine.net → ramine.net).
func (c *cfAPI) zone(ctx context.Context, host string) (string, error) {
	if c.zoneID != "" {
		return c.zoneID, nil
	}
	labels := strings.Split(host, ".")
	for i := 0; i < len(labels)-1; i++ {
		cand := strings.Join(labels[i:], ".")
		var zones []struct{ ID string }
		if err := c.do(ctx, "GET", "https://api.cloudflare.com/client/v4/zones?name="+cand, nil, &zones); err != nil {
			return "", err
		}
		if len(zones) > 0 {
			c.zoneID = zones[0].ID
			return c.zoneID, nil
		}
	}
	return "", fmt.Errorf("no Cloudflare zone found for %s (token scoped to the right zone?)", host)
}

func (c *cfAPI) createTXT(ctx context.Context, name, content string) (string, error) {
	zid, err := c.zone(ctx, strings.TrimPrefix(name, "_acme-challenge."))
	if err != nil {
		return "", err
	}
	var rec struct{ ID string }
	err = c.do(ctx, "POST", "https://api.cloudflare.com/client/v4/zones/"+zid+"/dns_records",
		map[string]any{"type": "TXT", "name": name, "content": content, "ttl": 60}, &rec)
	return rec.ID, err
}

func (c *cfAPI) deleteRecord(ctx context.Context, id string) error {
	if c.zoneID == "" || id == "" {
		return nil
	}
	return c.do(ctx, "DELETE", "https://api.cloudflare.com/client/v4/zones/"+c.zoneID+"/dns_records/"+id, nil, nil)
}

// upsertA points host at ip (DNS-only — never proxied: guests must get the
// literal LAN IP back).
func (c *cfAPI) upsertA(ctx context.Context, host, ip string) error {
	zid, err := c.zone(ctx, host)
	if err != nil {
		return err
	}
	var existing []struct {
		ID      string `json:"id"`
		Content string `json:"content"`
	}
	if err := c.do(ctx, "GET", "https://api.cloudflare.com/client/v4/zones/"+zid+"/dns_records?type=A&name="+host, nil, &existing); err != nil {
		return err
	}
	body := map[string]any{"type": "A", "name": host, "content": ip, "ttl": 60, "proxied": false}
	if len(existing) > 0 {
		if existing[0].Content == ip {
			return nil // already correct
		}
		return c.do(ctx, "PUT", "https://api.cloudflare.com/client/v4/zones/"+zid+"/dns_records/"+existing[0].ID, body, nil)
	}
	return c.do(ctx, "POST", "https://api.cloudflare.com/client/v4/zones/"+zid+"/dns_records", body, nil)
}
