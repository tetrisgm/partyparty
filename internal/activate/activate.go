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
	"net/url"
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

type AccountState struct {
	OK        bool           `json:"ok"`
	Linked    bool           `json:"linked"`
	Offline   bool           `json:"offline,omitempty"`
	Error     string         `json:"error,omitempty"`
	CheckedMS int64          `json:"checkedMs,omitempty"`
	User      AccountUser    `json:"user,omitempty"`
	Profile   AccountProfile `json:"profile,omitempty"`
	Install   AccountInstall `json:"install,omitempty"`
	License   AccountLicense `json:"license,omitempty"`
	Events    []AccountEvent `json:"events,omitempty"`
}

type AccountUser struct {
	ID          string `json:"id,omitempty"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

type AccountProfile struct {
	ID          string `json:"id,omitempty"`
	Handle      string `json:"handle,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

type AccountInstall struct {
	ID   string `json:"id,omitempty"`
	Slug string `json:"slug,omitempty"`
	Host string `json:"host,omitempty"`
}

type AccountLicense struct {
	OK     bool   `json:"ok"`
	Source string `json:"source,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type AccountEvent struct {
	Slug          string `json:"slug,omitempty"`
	Title         string `json:"title,omitempty"`
	Status        string `json:"status,omitempty"`
	ScheduledAtMS int64  `json:"scheduled_at_ms,omitempty"`
	Starts        string `json:"starts,omitempty"`
	Where         string `json:"where_txt,omitempty"`
	LocationName  string `json:"location_name,omitempty"`
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

// TryBroker is the zero-config activation path (the Plex pattern): the install
// registers with the party.ramine.net cert broker once and gets a MEMORABLE
// hostname (disco42.pp.ramine.net — no IP-encoded eyesores), issues an exact
// cert for it locally (the private key never leaves this Mac; the broker only
// publishes DNS records), and upserts the single A record to the current venue
// IP at every launch. Fails soft like Try.
func TryBroker(brokerURL, lanIP string, logf Logf) Result {
	if lanIP == "" {
		return Result{Reason: "no LAN IP yet"}
	}
	dir, err := stateDir()
	if err != nil {
		return Result{Reason: "no state dir: " + err.Error()}
	}
	certFile := filepath.Join(dir, "live-cert.pem")
	keyFile := filepath.Join(dir, "live-key.pem")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return Result{Reason: "broker: " + err.Error()}
	}

	// The BROKER is the source of truth for the hostname (its /a response) —
	// if the base domain changes server-side (e.g. a purchased product domain),
	// every install follows on its next launch, no re-registration.
	var aResp struct{ Host string }
	if err := b.post(ctx, "/api/broker/a", map[string]any{"id": b.id, "secret": b.secret, "ip": lanIP}, &aResp); err != nil {
		return Result{Reason: "DNS update: " + err.Error()}
	}
	host := aResp.Host
	if host == "" {
		host = b.slug + "." + b.base
	}
	if err := b.rememberHost(dir, host); err != nil {
		logf("activate: could not persist broker host %s: %v", host, err)
	}

	if !certUsable(certFile, host) {
		logf("activate: obtaining certificate for %s (Let's Encrypt, DNS-01 via broker)…", host)
		if err := issueCert(ctx, b, host, certFile, keyFile, dir, logf); err != nil {
			return Result{Host: host, Reason: "certificate: " + err.Error()}
		}
		logf("activate: certificate issued for %s", host)
	}

	if err := verifyResolves(ctx, host, lanIP); err != nil {
		return Result{Host: host, CertFile: certFile, KeyFile: keyFile,
			Reason: "resolution check: " + err.Error() + " (router DNS-rebind protection?)"}
	}
	return Result{OK: true, Host: host, CertFile: certFile, KeyFile: keyFile}
}

// LinkInstall binds this local install id/secret to a signed-in web account via
// a one-time code generated at /account. Certificate DNS writes are broker-gated
// on this link.
func LinkInstall(brokerURL, code string, logf Logf) (string, error) {
	code = strings.TrimSpace(strings.ToLower(code))
	if !isHexN(code, 32) {
		return "", errors.New("bad code")
	}
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return "", err
	}
	var out struct{ Handle string }
	if err := b.post(ctx, "/api/broker/link-install", map[string]any{"id": b.id, "secret": b.secret, "code": code}, &out); err != nil {
		return "", err
	}
	return out.Handle, nil
}

// StartInstallLink creates a short-lived browser handoff URL. The local install
// authenticates to the broker with its id/secret; the user then signs in on the
// website and the website binds this install to that account.
func StartInstallLink(brokerURL string, logf Logf) (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return "", err
	}
	var out struct{ URL string }
	if err := b.post(ctx, "/api/broker/link-start", map[string]any{"id": b.id, "secret": b.secret}, &out); err != nil {
		return "", err
	}
	u, err := url.Parse(out.URL)
	base, berr := url.Parse(brokerURL)
	if err != nil || berr != nil || u.Scheme != "https" || u.Host == "" || u.Host != base.Host {
		return "", errors.New("broker returned a bad sign-in URL")
	}
	return out.URL, nil
}

// AccountStatus verifies the local install against the broker and returns the
// linked web account. A successful linked response is cached locally so the app
// can still open at an offline venue after the account was verified once.
func AccountStatus(brokerURL string, logf Logf) (AccountState, error) {
	dir, err := stateDir()
	if err != nil {
		return AccountState{OK: false, Linked: false, Error: err.Error()}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return cachedAccountOrError(dir, err)
	}
	var out AccountState
	if err := b.post(ctx, "/api/broker/account-status", map[string]any{"id": b.id, "secret": b.secret}, &out); err != nil {
		return cachedAccountOrError(dir, err)
	}
	if out.CheckedMS == 0 {
		out.CheckedMS = time.Now().UnixMilli()
	}
	if out.Install.ID == "" {
		out.Install.ID = b.id
	}
	if out.Install.Slug == "" {
		out.Install.Slug = b.slug
	}
	if out.Linked {
		if err := saveAccountCache(dir, out); err != nil && logf != nil {
			logf("activate: could not save account cache: %v", err)
		}
	} else {
		if err := clearAccountCache(dir); err != nil && logf != nil {
			logf("activate: could not clear account cache: %v", err)
		}
	}
	return out, nil
}

func SignOutAccount(brokerURL string, logf Logf) error {
	dir, err := stateDir()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return err
	}
	var out struct {
		OK      bool `json:"ok"`
		Revoked int  `json:"revoked"`
	}
	if err := b.post(ctx, "/api/broker/account-unlink", map[string]any{"id": b.id, "secret": b.secret}, &out); err != nil {
		return err
	}
	if !out.OK {
		return errors.New("sign out failed")
	}
	return clearAccountCache(dir)
}

func cachedAccountOrError(dir string, err error) (AccountState, error) {
	if st, ok := loadAccountCache(dir); ok && st.Linked {
		st.Offline = true
		st.Error = err.Error()
		return st, nil
	}
	return AccountState{OK: false, Linked: false, Error: err.Error(), CheckedMS: time.Now().UnixMilli()}, err
}

func accountCachePath(dir string) string {
	return filepath.Join(dir, "account.json")
}

func clearAccountCache(dir string) error {
	if err := os.Remove(accountCachePath(dir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func loadAccountCache(dir string) (AccountState, bool) {
	data, err := os.ReadFile(accountCachePath(dir))
	if err != nil {
		return AccountState{}, false
	}
	var st AccountState
	if json.Unmarshal(data, &st) != nil || !st.Linked {
		return AccountState{}, false
	}
	return st, true
}

func saveAccountCache(dir string, st AccountState) error {
	st.Offline = false
	st.Error = ""
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(accountCachePath(dir), data, 0o600)
}

func isHexN(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

// brokerClient talks to the cert broker; it also implements txtPublisher.
type brokerClient struct {
	url, id, secret, base, slug string
}

func (b *brokerClient) post(ctx context.Context, path string, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", b.url+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		var e struct{ Error string }
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("broker: %s", resp.Status)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (b *brokerClient) publishTXT(ctx context.Context, _ string, value string) (func(), error) {
	// The broker derives the record name from the install id itself (writes are
	// confined to the install's namespace); it also clears the previous TXT.
	err := b.post(ctx, "/api/broker/txt", map[string]any{"id": b.id, "secret": b.secret, "value": value}, nil)
	return func() {}, err
}

// loadOrRegisterInstall returns this Mac's broker identity, registering on
// first use and persisting it (install.json, 0600). Pre-slug installs (no
// memorable hostname) re-register once to pick one up.
func loadOrRegisterInstall(ctx context.Context, brokerURL, dir string, logf Logf) (*brokerClient, error) {
	path := filepath.Join(dir, "install.json")
	var rec struct{ ID, Secret, Base, Slug string }
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &rec) == nil && rec.ID != "" && rec.Slug != "" {
		return &brokerClient{url: brokerURL, id: rec.ID, secret: rec.Secret, base: rec.Base, slug: rec.Slug}, nil
	}
	b := &brokerClient{url: brokerURL}
	var out struct{ ID, Secret, Base, Slug string }
	if err := b.post(ctx, "/api/broker/register", map[string]any{}, &out); err != nil {
		return nil, err
	}
	if out.ID == "" || out.Secret == "" || out.Base == "" || out.Slug == "" {
		return nil, errors.New("register: malformed response")
	}
	rec.ID, rec.Secret, rec.Base, rec.Slug = out.ID, out.Secret, out.Base, out.Slug
	data, _ := json.Marshal(rec)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	logf("activate: registered install %s → %s.%s", out.ID, out.Slug, out.Base)
	b.id, b.secret, b.base, b.slug = out.ID, out.Secret, out.Base, out.Slug
	return b, nil
}

func (b *brokerClient) rememberHost(dir, host string) error {
	base, ok := brokerBaseFromHost(host, b.slug)
	if !ok {
		return nil
	}
	b.base = base
	rec := struct{ ID, Secret, Base, Slug string }{ID: b.id, Secret: b.secret, Base: b.base, Slug: b.slug}
	data, _ := json.Marshal(rec)
	return os.WriteFile(filepath.Join(dir, "install.json"), data, 0o600)
}

func brokerBaseFromHost(host, slug string) (string, bool) {
	host = strings.TrimSpace(strings.TrimSuffix(host, "."))
	slug = strings.TrimSpace(strings.TrimSuffix(slug, "."))
	prefix := slug + "."
	if host == "" || slug == "" || !strings.HasPrefix(host, prefix) {
		return "", false
	}
	base := strings.TrimPrefix(host, prefix)
	if base == "" || strings.Contains(base, "/") {
		return "", false
	}
	return base, true
}

// InstallCreds returns this Mac's broker identity for authenticated calls
// (telemetry etc.), or empty strings if the install never registered.
func InstallCreds() (id, secret string) {
	dir, err := stateDir()
	if err != nil {
		return "", ""
	}
	var rec struct{ ID, Secret string }
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil {
		return "", ""
	}
	return rec.ID, rec.Secret
}

// CachedCert returns the previously-issued live cert/key paths when they exist
// and the cert is currently valid (with an hour of margin) — so the TLS
// listener can serve the instant it comes up instead of racing async
// re-activation. ok=false means no usable cache (issue fresh).
func CachedCert() (certFile, keyFile string, ok bool) {
	dir, err := stateDir()
	if err != nil {
		return "", "", false
	}
	certFile = filepath.Join(dir, "live-cert.pem")
	keyFile = filepath.Join(dir, "live-key.pem")
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return "", "", false
	}
	if _, err := os.Stat(keyFile); err != nil {
		return "", "", false
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return "", "", false
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", "", false
	}
	now := time.Now()
	if now.Before(c.NotBefore) || now.After(c.NotAfter.Add(-time.Hour)) {
		return "", "", false // expired / not-yet-valid — don't serve it
	}
	return certFile, keyFile, true
}

// CachedCertReady returns the local live cert/key when they are immediately
// valid for host. This is intentionally network-free: a party can start
// offline with a still-valid cached cert even when online activation would
// prefer to renew it soon.
func CachedCertReady(host string) (Result, bool) {
	if host == "" {
		return Result{Reason: "no cached activation host"}, false
	}
	dir, err := stateDir()
	if err != nil {
		return Result{Host: host, Reason: "no state dir: " + err.Error()}, false
	}
	certFile := filepath.Join(dir, "live-cert.pem")
	keyFile := filepath.Join(dir, "live-key.pem")
	if _, err := os.Stat(keyFile); err != nil {
		return Result{Host: host, CertFile: certFile, KeyFile: keyFile, Reason: "no cached key"}, false
	}
	if !certValid(certFile, host, time.Hour) {
		return Result{Host: host, CertFile: certFile, KeyFile: keyFile, Reason: "cached certificate is missing, expired, or for a different host"}, false
	}
	return Result{OK: true, Host: host, CertFile: certFile, KeyFile: keyFile}, true
}

// BrokerHost returns this install's guest hostname (<slug>.<base>) from the
// persisted broker registration, or "" (BYO installs use their configured host).
func BrokerHost() string {
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	var rec struct{ Base, Slug string }
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil || rec.Slug == "" || rec.Base == "" {
		return ""
	}
	return rec.Slug + "." + rec.Base
}

// InstallSlug returns this install's memorable broker slug ("fader91"), or "".
func InstallSlug() string {
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	var rec struct{ Slug string }
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil {
		return ""
	}
	return rec.Slug
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

// HostFromEnvOrFile resolves the low-latency host from the env var or a
// persisted file (so the double-clicked .app activates without a shell env).
func HostFromEnvOrFile() string {
	if h := strings.TrimSpace(os.Getenv("PARTYPARTY_LIVE_HOST")); h != "" {
		return h
	}
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dir, "live-host"))
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

// StateDir is the app's per-user state directory (certs, install creds, the OTA
// payload cache) — ~/Library/Application Support/partyparty. Exported so other
// packages can cache alongside without re-deriving the path.
func StateDir() (string, error) { return stateDir() }

// certUsable reports whether the cached cert covers host and has >renewWindow left.
func certUsable(certFile, host string) bool {
	return certValid(certFile, host, renewWindow)
}

func certValid(certFile, host string, minRemaining time.Duration) bool {
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
	now := time.Now()
	if now.Before(cert.NotBefore) {
		return false
	}
	return time.Until(cert.NotAfter) > minRemaining
}

// ---- ACME (Let's Encrypt, DNS-01) ----

// txtPublisher publishes a DNS-01 challenge TXT record. Two implementations:
// the user's own Cloudflare token (BYO), or the party.ramine.net cert broker
// (zero-config — the Plex pattern; the token never leaves the broker).
type txtPublisher interface {
	publishTXT(ctx context.Context, name, value string) (cleanup func(), err error)
}

func (c *cfAPI) publishTXT(ctx context.Context, name, value string) (func(), error) {
	recID, err := c.createTXT(ctx, name, value)
	if err != nil {
		return nil, err
	}
	return func() { _ = c.deleteRecord(context.Background(), recID) }, nil
}

func issueCert(ctx context.Context, pub txtPublisher, domain, certFile, keyFile, dir string, logf Logf) error {
	acct, err := loadOrCreateKey(filepath.Join(dir, "acme-account-key.pem"))
	if err != nil {
		return err
	}
	client := &acme.Client{Key: acct, DirectoryURL: letsEncryptDir}
	if _, err := client.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil &&
		!errors.Is(err, acme.ErrAccountAlreadyExists) {
		return fmt.Errorf("ACME register: %w", err)
	}

	order, err := client.AuthorizeOrder(ctx, acme.DomainIDs(domain))
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
		// The authorization identifier, NOT the order domain: a wildcard order
		// for *.x.y authorizes the identifier "x.y", and that's where the
		// challenge record must live (_acme-challenge.x.y).
		txtName := "_acme-challenge." + authz.Identifier.Value
		cl, err := pub.publishTXT(ctx, txtName, txtVal)
		if err != nil {
			return fmt.Errorf("challenge TXT: %w", err)
		}
		cleanup = append(cleanup, cl)

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
		Subject: pkix.Name{CommonName: domain}, DNSNames: []string{domain},
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

// verifyResolves checks the host resolves to the LAN IP over the network's
// configured DNS — the path guests' phones take. It uses a Go-native resolver
// (PreferGo), which queries the configured nameserver directly and BYPASSES the
// macOS mDNSResponder cache: a freshly-created record is otherwise shadowed by
// the OS's cached NXDOMAIN (negative TTL) on the DJ's Mac only, a false positive
// that never affects guests. Querying the real resolver still catches genuine
// router DNS-rebind protection. Patient (~48s) for propagation.
func verifyResolves(ctx context.Context, host, lanIP string) error {
	res := &net.Resolver{PreferGo: true}
	var lastErr error
	for i := 0; i < 12; i++ {
		addrs, err := res.LookupHost(ctx, host)
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
		Success bool                       `json:"success"`
		Errors  []struct{ Message string } `json:"errors"`
		Result  json.RawMessage            `json:"result"`
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
