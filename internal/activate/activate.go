// Package activate implements the "real cert on a LAN" story that unlocks
// LL-HLS for iPhones (the Plex *.plex.direct pattern):
//
//  1. a publicly-trusted certificate for a host you control (Let's Encrypt,
//     DNS-01 via the Cloudflare API - never needs inbound reachability), and
//  2. a public A record pointing that host at the Mac's current LAN IP, so
//     guests on the same Wi-Fi resolve it locally (RFC1918 in public DNS -
//     exactly what Plex does).
//
// Optional self-managed configuration (normal installs use the account broker):
//   - PARTYPARTY_LIVE_HOST (or --live-host): e.g. "dj.example.net"
//   - PARTYPARTY_CF_TOKEN env, or a token in <app-support>/cf-token, scoped to
//     Zone → DNS → Edit for that host's zone.
//
// A failed refresh keeps a previously cached certificate usable offline. If no
// valid certificate exists, Go Live stays unavailable rather than exposing a
// guest URL iPhones cannot trust.
package activate

import (
	"bytes"
	"context"
	"crypto/x509"
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

	"partyparty/internal/netinfo"
)

const (
	renewWindow = 30 * 24 * time.Hour
	// Broker operations are simple JSON and R2 reads that normally complete in
	// well under a second. A captive portal or broken venue uplink must produce
	// a visible retry reason, not leave first-run setup spinning for minutes.
	brokerAttemptTimeout = 15 * time.Second
	brokerRequestTimeout = 8 * time.Second
)

// Result reports what activation achieved. The fields separate independent
// facts that the old single OK conflated: a usable certificate, a VERIFIED DNS
// publication, and local resolver agreement. LAN readiness is computed later
// from all of this evidence plus TLS reachability - never inferred from OK alone.
type Result struct {
	OK       bool // the whole chain succeeded (cert usable + DNS verified + resolver matches)
	Host     string
	CertFile string
	KeyFile  string

	CertReady       bool   // a usable certificate/key exists for Host
	ExpectedIP      string // the current LAN IP this activation published
	DNSPublished    bool   // the broker returned a VERIFIED Cloudflare A-record receipt
	ResolverMatches bool   // the local resolver returned ExpectedIP for Host
	// ResolverObserved reports whether ResolverMatches is an actual observation
	// rather than a zero value. An activation attempt that dies before reaching
	// the resolver (no internet, no broker) knows NOTHING about the resolver,
	// and consumers must not treat its false as evidence: doing so made every
	// offline retry stomp the boot-time observation back to "mismatch", which
	// pinned a working travel-router party on NO PATH forever.
	ResolverObserved bool
	ReasonCode       string // stable machine code (see reason codes below); "" on success

	Reason string // human-readable detail (for the log); text may change, code does not
}

// Stable activation reason codes. Branch on these, never on Reason prose.
const (
	ReasonNoHost           = "no_host"
	ReasonNoToken          = "no_token"
	ReasonNoLanIP          = "no_lan_ip"
	ReasonCert             = "cert_failed"
	ReasonDNSPublish       = "dns_publish_failed"
	ReasonResolverMismatch = "resolver_mismatch"
)

type Logf func(format string, args ...any)

// RelayRegistration is the public join address and authenticated outbound
// WebSocket assigned to this anonymous install. The relay carries requests only
// while the Mac has selected relay mode. Direct mode keeps guest traffic on the
// venue Wi-Fi.
type RelayRegistration struct {
	JoinURL    string `json:"joinUrl"`
	NetworkKey string `json:"networkKey"`

	// RelayURL and PublishToken are this install's own relay room and the
	// credential that proves it owns it. Minted by the broker so every install
	// gets its own, rather than a hand-placed pair that only scales to one Mac.
	RelayURL     string `json:"relayUrl"`
	PublishToken string `json:"publishToken"`
	Room         string `json:"room"`

	// Probe carries a guest's reachability verdict when one was reported since
	// the last poll. There is no socket for the browser to push it over any more,
	// so it rides the registration response instead. nil means nothing new.
	Probe *bool `json:"probe"`
}

// RegisterRelay ensures this install has a stable, unguessable public join
// address. The broker combines the venue's public address with the Mac's LAN
// subnet into an opaque network key so the app can remember a proven direct or
// isolated verdict without storing Wi-Fi names.
func RegisterRelay(ctx context.Context, brokerURL, lanIP, directURL string, logf Logf) (RelayRegistration, error) {
	parsedLANIP := net.ParseIP(strings.TrimSpace(lanIP))
	if parsedLANIP == nil || parsedLANIP.To4() == nil || parsedLANIP.IsLoopback() || parsedLANIP.IsLinkLocalUnicast() {
		return RelayRegistration{}, errors.New("no LAN IP yet")
	}
	dir, err := stateDir()
	if err != nil {
		return RelayRegistration{}, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return RelayRegistration{}, err
	}
	var out RelayRegistration
	if err := b.post(ctx, "/api/broker/relay/register", map[string]any{
		"id": b.id, "secret": b.secret, "lanIp": lanIP, "directUrl": directURL,
	}, &out); err != nil {
		return RelayRegistration{}, err
	}
	join, joinErr := url.Parse(out.JoinURL)
	if joinErr != nil || join.Scheme != "https" || join.Host == "" ||
		out.NetworkKey == "" {
		return RelayRegistration{}, errors.New("relay registration: malformed response")
	}
	return out, nil
}

// TryBroker is the zero-config activation path (the Plex pattern): the install
// registers with the partyparty.party cert broker once and gets a MEMORABLE
// hostname (disco42.pp.example.net - no IP-encoded eyesores), issues an exact
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

	ctx, cancel := context.WithTimeout(context.Background(), brokerAttemptTimeout)
	defer cancel()

	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return Result{Reason: "broker: " + err.Error()}
	}

	// The BROKER is the source of truth for the hostname AND returns a strict,
	// VERIFIED Cloudflare receipt. Cloud reachability of the broker is not the
	// same as a proven LAN A record - `verified` is the only truth that counts.
	var aResp struct {
		OK       bool   `json:"ok"`
		Host     string `json:"host"`
		IP       string `json:"ip"`
		Verified bool   `json:"verified"`
		Reason   string `json:"reason"`
	}
	postErr := b.post(ctx, "/api/broker/a", map[string]any{"id": b.id, "secret": b.secret, "ip": lanIP}, &aResp)
	host := aResp.Host
	if host == "" {
		host = b.hostLabel + "." + b.base
	}
	if err := b.rememberHost(dir, host); err != nil {
		logf("activate: could not persist broker host %s: %v", host, err)
	}
	dnsPublished := postErr == nil && aResp.OK && aResp.Verified

	if !certUsable(certFile, host) {
		// The shared machine wildcard (*.party.<base>) is the ONLY cert path for
		// broker installs: one cert covers every machine host under the base, so
		// there is no per-Mac ACME and no Let's Encrypt rate limit. It is fetched
		// over the authed broker endpoint and validated with certUsable - exactly
		// like a self-issued cert - before it is trusted. No fallback by design: a
		// transient fetch failure leaves the cert not-yet-ready and the refresh
		// loop retries; the renew window gives a buffer before any real expiry, and
		// once fetched the cert is cached locally so later parties run offline.
		if err := fetchWildcard(ctx, b, certFile, keyFile); err != nil {
			return Result{Host: host, ExpectedIP: lanIP, ReasonCode: ReasonCert, Reason: "wildcard cert: " + err.Error()}
		}
		if !certUsable(certFile, host) {
			return Result{Host: host, ExpectedIP: lanIP, ReasonCode: ReasonCert, Reason: "wildcard cert not usable for " + host}
		}
		logf("activate: using shared wildcard cert for %s", host)
	}
	// OK means only that the certificate is usable (Go Live works everywhere).
	// DNS publication and resolver agreement are separate LAN-readiness evidence.
	res := Result{OK: true, Host: host, CertFile: certFile, KeyFile: keyFile, CertReady: true, ExpectedIP: lanIP, DNSPublished: dnsPublished}

	if !dnsPublished {
		res.ReasonCode = ReasonDNSPublish
		switch {
		case postErr != nil:
			res.Reason = "DNS publish: " + postErr.Error()
		case aResp.Reason != "":
			res.Reason = "DNS publish unverified: " + aResp.Reason
		default:
			res.Reason = "DNS publish unverified"
		}
		return res
	}

	// DNS agreement is readiness evidence, not certificate provisioning. Keep
	// this first observation short so a fresh/stale venue resolver cannot hold
	// the usable certificate and concrete status result behind a minute-long
	// retry loop. The activation loop retries the complete observation on its
	// own backoff until the resolver catches up.
	resolveCtx, resolveCancel := context.WithTimeout(ctx, 2*time.Second)
	obs := observeResolver(resolveCtx, host, lanIP)
	resolveCancel()
	res.ResolverMatches = obs.Matches
	res.ResolverObserved = true
	if !obs.Matches {
		res.ReasonCode = ReasonResolverMismatch
		res.Reason = obs.describe()
	}
	return res
}

// brokerClient talks to the cert broker
type brokerClient struct {
	url, id, secret, base, hostLabel string
}

type installRecord struct {
	ID        string `json:"id"`
	Secret    string `json:"secret"`
	Base      string `json:"base"`
	HostLabel string `json:"hostLabel"`
	Slug      string `json:"Slug,omitempty"` // legacy installs; migrated on read
}

func (r installRecord) label() string {
	if r.HostLabel != "" {
		return r.HostLabel
	}
	return r.Slug
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
	client := &http.Client{Timeout: brokerRequestTimeout}
	resp, err := client.Do(req)
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

// loadOrRegisterInstall returns this Mac's broker identity, registering on
// first use and persisting it (install.json, 0600).
func loadOrRegisterInstall(ctx context.Context, brokerURL, dir string, logf Logf) (*brokerClient, error) {
	path := filepath.Join(dir, "install.json")
	var rec installRecord
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &rec) == nil &&
		rec.ID != "" && rec.label() != "" && brokerOwnsBase(brokerURL, rec.Base) {
		rec.HostLabel = rec.label()
		rec.Slug = ""
		if migrated, err := json.Marshal(rec); err == nil {
			_ = os.WriteFile(path, migrated, 0o600)
		}
		return &brokerClient{url: brokerURL, id: rec.ID, secret: rec.Secret, base: rec.Base, hostLabel: rec.HostLabel}, nil
	}
	if rec.ID != "" && rec.label() != "" {
		logf("activate: retired broker registration %s.%s does not belong to %s; registering this install with the current broker", rec.label(), rec.Base, brokerURL)
	}
	b := &brokerClient{url: brokerURL}
	var out struct {
		ID        string `json:"id"`
		Secret    string `json:"secret"`
		Base      string `json:"base"`
		HostLabel string `json:"hostLabel"`
	}
	if err := b.post(ctx, "/api/broker/register", map[string]any{}, &out); err != nil {
		return nil, err
	}
	if out.ID == "" || out.Secret == "" || out.Base == "" || out.HostLabel == "" {
		return nil, errors.New("register: malformed response")
	}
	rec.ID, rec.Secret, rec.Base, rec.HostLabel = out.ID, out.Secret, out.Base, out.HostLabel
	data, _ := json.Marshal(rec)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	logf("activate: registered install %s → %s.%s", out.ID, out.HostLabel, out.Base)
	b.id, b.secret, b.base, b.hostLabel = out.ID, out.Secret, out.Base, out.HostLabel
	return b, nil
}

func brokerOwnsBase(brokerURL, base string) bool {
	parsed, err := url.Parse(strings.TrimSpace(brokerURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	base = strings.ToLower(strings.Trim(strings.TrimSpace(base), "."))
	return host != "" && (base == host || strings.HasSuffix(base, "."+host))
}

func (b *brokerClient) rememberHost(dir, host string) error {
	base, ok := brokerBaseFromHost(host, b.hostLabel)
	if !ok {
		return nil
	}
	b.base = base
	rec := installRecord{ID: b.id, Secret: b.secret, Base: b.base, HostLabel: b.hostLabel}
	data, _ := json.Marshal(rec)
	return os.WriteFile(filepath.Join(dir, "install.json"), data, 0o600)
}

func brokerBaseFromHost(host, hostLabel string) (string, bool) {
	host = strings.TrimSpace(strings.TrimSuffix(host, "."))
	hostLabel = strings.TrimSpace(strings.TrimSuffix(hostLabel, "."))
	prefix := hostLabel + "."
	if host == "" || hostLabel == "" || !strings.HasPrefix(host, prefix) {
		return "", false
	}
	base := strings.TrimPrefix(host, prefix)
	if base == "" || strings.Contains(base, "/") {
		return "", false
	}
	return base, true
}

// InstallCreds returns this Mac's broker identity, or empty strings if the
// install never registered.
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
// and the cert is currently valid (with an hour of margin) - so the TLS
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
		return "", "", false // expired / not-yet-valid - don't serve it
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
	res := Result{OK: true, Host: host, CertFile: certFile, KeyFile: keyFile, CertReady: true}
	// The cached-cert path is the OFFLINE path: a travel-router party boots
	// here with no broker and no internet, and whether guests can find this Mac
	// rests entirely on the venue's own resolver. Not observing it left
	// ResolverMatches at its zero value, which downstream read as "mismatch",
	// which made LOCAL mode unreachable on exactly the network it exists for.
	if lanIP := netinfo.PrimaryLanIP(); lanIP != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
		obs := observeResolver(ctx, host, lanIP)
		cancel()
		res.ExpectedIP = lanIP
		res.ResolverMatches = obs.Matches
		res.ResolverObserved = true
	}
	return res, true
}

// BrokerHost returns this install's guest hostname (<hostLabel>.<base>) from the
// persisted broker registration, or "" (BYO installs use their configured host).
func BrokerHost() string {
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	var rec installRecord
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil || rec.label() == "" || rec.Base == "" {
		return ""
	}
	return rec.label() + "." + rec.Base
}

// InstallHostLabel returns this install's memorable two-word hostname label.
func InstallHostLabel() string {
	dir, err := stateDir()
	if err != nil {
		return ""
	}
	var rec installRecord
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil {
		return ""
	}
	return rec.label()
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
// payload cache) - ~/Library/Application Support/partyparty. Exported so other
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

// fetchWildcard pulls the shared *.party.<base> machine cert+key from the broker
// (authed with this install's id/secret) and writes them to certFile/keyFile.
// The caller validates the result with certUsable before trusting it, so a
// missing/expired/wrong response is simply ignored in favor of per-Mac ACME.
func fetchWildcard(ctx context.Context, b *brokerClient, certFile, keyFile string) error {
	var out struct {
		Cert string `json:"cert"`
		Key  string `json:"key"`
	}
	if err := b.post(ctx, "/api/broker/wildcard-cert", map[string]any{"id": b.id, "secret": b.secret}, &out); err != nil {
		return err
	}
	if out.Cert == "" || out.Key == "" {
		return errors.New("empty wildcard cert response")
	}
	if err := os.WriteFile(keyFile, []byte(out.Key), 0o600); err != nil {
		return err
	}
	return os.WriteFile(certFile, []byte(out.Cert), 0o600)
}

// ResolverObservation is the structured result of asking the network's own DNS
// resolver (the path guests' phones take) to resolve the machine host. It only
// records what was returned; it never judges WHY a mismatch happened. A single
// recursive-resolver mismatch is NOT proof of router rebind protection -
// different recursive caches legitimately disagree during a TTL - so this type
// carries no rebind classification and there is no DoH cross-check.
type ResolverObservation struct {
	Host       string
	ExpectedIP string
	Addrs      []string // everything the local resolver returned
	Matches    bool     // ExpectedIP was among Addrs
	Err        error
	At         time.Time
}

func (o ResolverObservation) describe() string {
	if o.Err != nil {
		return fmt.Sprintf("this Wi-Fi's resolver could not look up %s: %v", o.Host, o.Err)
	}
	return fmt.Sprintf("this Wi-Fi is not returning the Mac's LAN address for %s (got %v, want %s)",
		o.Host, o.Addrs, o.ExpectedIP)
}

// observeResolver queries the network's configured resolver (PreferGo bypasses
// the macOS mDNSResponder negative cache on the DJ's own Mac only). One
// observation returns structured evidence; callers own retry policy so DNS
// propagation can never block certificate activation.
func observeResolver(ctx context.Context, host, lanIP string) ResolverObservation {
	res := &net.Resolver{PreferGo: true}
	addrs, err := res.LookupHost(ctx, host)
	obs := ResolverObservation{Host: host, ExpectedIP: lanIP, Addrs: addrs, Err: err, At: time.Now()}
	if err == nil {
		for _, a := range addrs {
			if a == lanIP {
				obs.Matches = true
				break
			}
		}
	}
	return obs
}

// VerifyResolves reports nil when the network's resolver returns lanIP for host,
// using the same guest-path observation as activation.
func VerifyResolves(ctx context.Context, host, lanIP string) error {
	obs := observeResolver(ctx, host, lanIP)
	if obs.Matches {
		return nil
	}
	if obs.Err != nil {
		return obs.Err
	}
	return fmt.Errorf("%s resolves to %v, not %s", host, obs.Addrs, lanIP)
}

// ---- Cloudflare DNS API (token-scoped: Zone → DNS → Edit) ----
