// Package activate implements the "real cert on a LAN" story that unlocks
// LL-HLS for iPhones (the Plex *.plex.direct pattern):
//
//  1. a publicly-trusted certificate for a host you control (Let's Encrypt,
//     DNS-01 via the Cloudflare API - never needs inbound reachability), and
//  2. a public A record pointing that host at the Mac's current LAN IP, so
//     guests on the same Wi-Fi resolve it locally (RFC1918 in public DNS -
//     exactly what Plex does).
//
// Optional self-managed configuration (normal installs use the anonymous install broker):
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
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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

	// install is the immutable identity snapshot that produced this result. It
	// stays private so neither the install secret nor its generation can escape
	// through JSON, logs, or status responses. CommitResult is the only consumer.
	install installSnapshot
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

	// install carries the exact credentials used for this broker response. Relay
	// consumers commit the response and credentials together through
	// CommitRelayRegistration instead of rereading a potentially newer file.
	install installSnapshot
}

type installGeneration [sha256.Size]byte

type installSnapshot struct {
	id         string
	secret     string
	base       string
	hostLabel  string
	generation installGeneration
}

func snapshotFromRecord(rec installRecord) installSnapshot {
	rec.HostLabel = rec.label()
	rec.Slug = ""
	data, _ := json.Marshal(rec) // a fixed struct cannot fail to marshal
	return installSnapshot{
		id:         rec.ID,
		secret:     rec.Secret,
		base:       rec.Base,
		hostLabel:  rec.HostLabel,
		generation: sha256.Sum256(data),
	}
}

func (s installSnapshot) valid() bool {
	return s.id != "" && s.secret != "" && s.hostLabel != "" && s.generation != (installGeneration{})
}

func (b *brokerClient) snapshot() installSnapshot {
	return snapshotFromRecord(installRecord{ID: b.id, Secret: b.secret, Base: b.base, HostLabel: b.hostLabel})
}

func (b *brokerClient) result(res Result) Result {
	res.install = b.snapshot()
	return res
}

// InstallID returns the non-secret install identifier that produced r. BYO and
// pre-registration results return "". It lets a successful activation start
// peer discovery from the same immutable identity snapshot.
func (r Result) InstallID() string { return r.install.id }

// RegisterRelay ensures this install has a stable, unguessable public join
// address. The broker combines the venue's public address with the Mac's LAN
// subnet into an opaque network key so the app can remember a proven direct or
// isolated verdict without storing Wi-Fi names.
func RegisterRelay(ctx context.Context, brokerURL, lanIP, directURL, partyID string, logf Logf) (RelayRegistration, error) {
	parsedLANIP := net.ParseIP(strings.TrimSpace(lanIP))
	if parsedLANIP == nil || parsedLANIP.To4() == nil || parsedLANIP.IsLoopback() || parsedLANIP.IsLinkLocalUnicast() {
		return RelayRegistration{}, errors.New("no LAN IP yet")
	}
	dir, err := stateDir()
	if err != nil {
		return RelayRegistration{}, err
	}
	logf = nonNilLogf(logf)
	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return RelayRegistration{}, err
	}
	var out RelayRegistration
	register := func() error {
		return b.post(ctx, "/api/broker/relay/register", map[string]any{
			"id": b.id, "secret": b.secret, "lanIp": lanIP, "directUrl": directURL,
			// Which party this Mac is playing, so the join page can fall back to
			// another Mac in the SAME party when this one leaves.
			"partyId": partyID,
		}, &out)
	}
	if err := register(); errors.Is(err, errUnknownInstall) {
		// Registered again under a new identity, then straight back to what we
		// came here to do. A room filling up must not wait for a restart.
		if b, err = recoverUnknownInstall(ctx, brokerURL, dir, b, logf); err != nil {
			return RelayRegistration{}, err
		}
		if err := register(); err != nil {
			return RelayRegistration{}, err
		}
	} else if err != nil {
		return RelayRegistration{}, err
	}
	join, joinErr := url.Parse(out.JoinURL)
	if joinErr != nil || join.Scheme != "https" || join.Host == "" ||
		out.NetworkKey == "" {
		return RelayRegistration{}, errors.New("relay registration: malformed response")
	}
	out.install = b.snapshot()
	if err := requireCurrentInstall(ctx, dir, b); err != nil {
		return RelayRegistration{}, err
	}
	return out, nil
}

// TryBroker is the zero-config activation path (the Plex pattern): the install
// registers with the PartyParty.party cert broker once and gets a MEMORABLE
// hostname (disco42.pp.example.net - no IP-encoded eyesores), caches the shared
// broker-provisioned wildcard certificate/key, and upserts the single A record
// to the current venue IP at every launch. Fails soft like Try.
func TryBroker(brokerURL, lanIP string, logf Logf) Result {
	logf = nonNilLogf(logf)
	if lanIP == "" {
		return Result{Reason: "no LAN IP yet"}
	}
	dir, err := stateDir()
	if err != nil {
		return Result{Reason: "no state dir: " + err.Error()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), brokerAttemptTimeout)
	defer cancel()

	b, err := loadOrRegisterInstall(ctx, brokerURL, dir, logf)
	if err != nil {
		return Result{Reason: "broker: " + err.Error()}
	}
	finish := func(res Result) Result {
		res = b.result(res)
		if err := requireCurrentInstall(ctx, dir, b); err != nil {
			return b.result(Result{ExpectedIP: lanIP, Reason: "broker: " + err.Error()})
		}
		return res
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
	if errors.Is(postErr, errUnknownInstall) {
		// A new identity means a new machine name, so the cert on disk is for a
		// host this Mac no longer answers to; the wildcard fetch below sees that
		// through certUsable and pulls a fresh one.
		if b, err = recoverUnknownInstall(ctx, brokerURL, dir, b, logf); err != nil {
			return Result{Reason: "broker: " + err.Error()}
		}
		aResp = struct {
			OK       bool   `json:"ok"`
			Host     string `json:"host"`
			IP       string `json:"ip"`
			Verified bool   `json:"verified"`
			Reason   string `json:"reason"`
		}{}
		postErr = b.post(ctx, "/api/broker/a", map[string]any{"id": b.id, "secret": b.secret, "ip": lanIP}, &aResp)
	}
	host := aResp.Host
	if host == "" {
		host = b.hostLabel + "." + b.base
	}
	if err := b.rememberHost(ctx, dir, host); errors.Is(err, errInstallChanged) {
		return finish(Result{ExpectedIP: lanIP, Reason: "broker: " + err.Error()})
	} else if err != nil {
		logf("activate: could not persist broker host %s: %v", host, err)
	}
	dnsPublished := postErr == nil && aResp.OK && aResp.Verified

	// The shared machine wildcard (*.party.<base>) is the ONLY cert path for
	// broker installs: one cert covers every machine host under the base, so
	// there is no per-Mac ACME and no Let's Encrypt rate limit. It is fetched
	// over the authed broker endpoint and validated as a complete keypair before
	// it is installed. No fallback by design: a transient fetch failure leaves
	// the cert not-yet-ready and the refresh loop retries; the renew window gives
	// a buffer before any real expiry, and once fetched the cert is cached locally
	// so later parties run offline.
	certFile, keyFile, fetchedCert, certErr := ensureWildcardCertificate(ctx, b, dir, host)
	if certErr != nil {
		return finish(Result{Host: host, ExpectedIP: lanIP, ReasonCode: ReasonCert, Reason: "wildcard cert: " + certErr.Error()})
	}
	if fetchedCert {
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
		return finish(res)
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
	return finish(res)
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
		var e struct {
			Error      string `json:"error"`
			Reregister bool   `json:"reregister"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		// The broker has no record of this install. Not a network problem and
		// not a wrong secret - the identity itself is gone, and retrying it
		// will be refused forever.
		if e.Reregister {
			return errUnknownInstall
		}
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

// errUnknownInstall is the broker saying it has never heard of this install.
// Distinct from every other failure on purpose: a network error, a 500 or a
// wrong secret must all be retried with the identity we have, and only this one
// means the identity is worthless.
var errUnknownInstall = errors.New("broker: unknown install")

var errInstallChanged = errors.New("install identity changed during broker operation")

var installStateGate = func() chan struct{} {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return gate
}()

func lockInstallState(ctx context.Context, dir string) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-installStateGate:
	}
	lockFile, err := os.OpenFile(filepath.Join(dir, ".install.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		installStateGate <- struct{}{}
		return nil, err
	}
	if err := lockFile.Chmod(0o600); err != nil {
		_ = lockFile.Close()
		installStateGate <- struct{}{}
		return nil, err
	}
	for {
		err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return lockFile, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = lockFile.Close()
			installStateGate <- struct{}{}
			return nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			_ = lockFile.Close()
			installStateGate <- struct{}{}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func unlockInstallState(lockFile *os.File) {
	_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
	_ = lockFile.Close()
	installStateGate <- struct{}{}
}

func nonNilLogf(logf Logf) Logf {
	if logf == nil {
		return func(string, ...any) {}
	}
	return logf
}

type pendingLogEntry struct {
	format string
	args   []any
}

type pendingLogs []pendingLogEntry

func (p *pendingLogs) add(format string, args ...any) {
	copyArgs := append([]any(nil), args...)
	*p = append(*p, pendingLogEntry{format: format, args: copyArgs})
}

func (p pendingLogs) replay(logf Logf) {
	logf = nonNilLogf(logf)
	for _, entry := range p {
		logf(entry.format, entry.args...)
	}
}

// loadOrRegisterInstall returns this Mac's broker identity, registering on
// first use and persisting it (install.json, 0600).
func loadOrRegisterInstall(ctx context.Context, brokerURL, dir string, logf Logf) (*brokerClient, error) {
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return nil, err
	}
	cleanupStaleAtomicTemps(dir, []string{".install.json.tmp-"}, time.Now(), time.Hour, 32)
	var pending pendingLogs
	b, loadErr := loadOrRegisterInstallLocked(ctx, brokerURL, dir, pending.add)
	unlockInstallState(lockFile)
	pending.replay(logf)
	return b, loadErr
}

func loadOrRegisterInstallLocked(ctx context.Context, brokerURL, dir string, logf Logf) (*brokerClient, error) {
	path := filepath.Join(dir, "install.json")
	var rec installRecord
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &rec) == nil &&
		rec.ID != "" && rec.Secret != "" && rec.label() != "" && brokerOwnsBase(brokerURL, rec.Base) {
		label := rec.label()
		needsMigration := rec.HostLabel != label || rec.Slug != ""
		rec.HostLabel = label
		rec.Slug = ""
		if needsMigration {
			_ = writeInstallRecord(path, rec)
		} else {
			repairPrivateRegularFile(path)
		}
		return brokerFromRecord(brokerURL, rec), nil
	}
	if rec.ID != "" && rec.label() != "" {
		logf("activate: retired broker registration %s.%s does not belong to %s; registering this install with the current broker", rec.label(), rec.Base, brokerURL)
	}
	return registerInstallLocked(ctx, brokerURL, path, logf)
}

func registerInstallLocked(ctx context.Context, brokerURL, path string, logf Logf) (*brokerClient, error) {
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
	rec := installRecord{ID: out.ID, Secret: out.Secret, Base: out.Base, HostLabel: out.HostLabel}
	if err := writeInstallRecord(path, rec); err != nil {
		return nil, err
	}
	logf("activate: registered install %s → %s.%s", out.ID, out.HostLabel, out.Base)
	b.id, b.secret, b.base, b.hostLabel = out.ID, out.Secret, out.Base, out.HostLabel
	return b, nil
}

// recoverUnknownInstall replaces stale credentials only after the replacement
// registration has succeeded. Concurrent broker users that were refused at the
// same time reuse the first replacement instead of minting competing identities.
func recoverUnknownInstall(ctx context.Context, brokerURL, dir string, stale *brokerClient, logf Logf) (*brokerClient, error) {
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return nil, err
	}
	cleanupStaleAtomicTemps(dir, []string{".install.json.tmp-"}, time.Now(), time.Hour, 32)
	var pending pendingLogs
	path := filepath.Join(dir, "install.json")

	var rec installRecord
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &rec) == nil &&
		rec.ID != "" && rec.Secret != "" && rec.label() != "" && brokerOwnsBase(brokerURL, rec.Base) &&
		(rec.ID != stale.id || rec.Secret != stale.secret) {
		repairPrivateRegularFile(path)
		b := brokerFromRecord(brokerURL, rec)
		unlockInstallState(lockFile)
		return b, nil
	}

	pending.add("activate: the broker no longer knows this install; registering again")
	b, registerErr := registerInstallLocked(ctx, brokerURL, path, pending.add)
	unlockInstallState(lockFile)
	pending.replay(logf)
	return b, registerErr
}

func brokerFromRecord(brokerURL string, rec installRecord) *brokerClient {
	snapshot := snapshotFromRecord(rec)
	return &brokerClient{url: brokerURL, id: snapshot.id, secret: snapshot.secret, base: snapshot.base, hostLabel: snapshot.hostLabel}
}

func requireCurrentInstall(ctx context.Context, dir string, b *brokerClient) error {
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return err
	}
	defer unlockInstallState(lockFile)
	var rec installRecord
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil || snapshotFromRecord(rec).generation != b.snapshot().generation {
		return errInstallChanged
	}
	return nil
}

// CommitResult makes validation and application one install-generation
// transaction. A replacement identity cannot land between the check and the
// callback, including when another PartyParty process is running. Results that
// do not come from the anonymous broker (BYO certificates) commit directly.
func CommitResult(ctx context.Context, res Result, commit func()) (bool, error) {
	if commit == nil {
		return false, errors.New("activation result commit callback is nil")
	}
	if !res.install.valid() {
		commit()
		return true, nil
	}
	dir, err := stateDir()
	if err != nil {
		return false, err
	}
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return false, err
	}
	defer unlockInstallState(lockFile)
	var current installRecord
	data, readErr := os.ReadFile(filepath.Join(dir, "install.json"))
	if readErr != nil || json.Unmarshal(data, &current) != nil ||
		snapshotFromRecord(current).generation != res.install.generation {
		return false, nil
	}
	commit()
	return true, nil
}

// CommitRelayRegistration atomically commits a broker response with the exact
// install credentials used to obtain it. The credentials are supplied only to
// the callback and are never reread from install.json after validation.
func CommitRelayRegistration(ctx context.Context, registration RelayRegistration, commit func(id, secret string)) (bool, error) {
	if commit == nil {
		return false, errors.New("relay registration commit callback is nil")
	}
	if !registration.install.valid() {
		return false, errors.New("relay registration has no install snapshot")
	}
	dir, err := stateDir()
	if err != nil {
		return false, err
	}
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return false, err
	}
	defer unlockInstallState(lockFile)
	var current installRecord
	data, readErr := os.ReadFile(filepath.Join(dir, "install.json"))
	if readErr != nil || json.Unmarshal(data, &current) != nil ||
		snapshotFromRecord(current).generation != registration.install.generation {
		return false, nil
	}
	commit(registration.install.id, registration.install.secret)
	return true, nil
}

func writeInstallRecord(path string, rec installRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o600)
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

func (b *brokerClient) rememberHost(ctx context.Context, dir, host string) error {
	base, ok := brokerBaseFromHost(host, b.hostLabel)
	if !ok {
		return nil
	}
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return err
	}
	defer unlockInstallState(lockFile)

	path := filepath.Join(dir, "install.json")
	var current installRecord
	if data, readErr := os.ReadFile(path); readErr == nil && json.Unmarshal(data, &current) == nil && current.ID != "" {
		if snapshotFromRecord(current).generation != b.snapshot().generation {
			return errInstallChanged
		}
	} else if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	rec := installRecord{ID: b.id, Secret: b.secret, Base: base, HostLabel: b.hostLabel}
	if current.ID == rec.ID && current.Secret == rec.Secret && current.Base == rec.Base &&
		current.HostLabel == rec.HostLabel && current.Slug == "" {
		b.base = base
		repairPrivateRegularFile(path)
		return nil
	}
	if err := writeInstallRecord(path, rec); err != nil {
		return err
	}
	b.base = base
	return nil
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
	pairFile, err := cachedCertificateSnapshot(context.Background(), dir, "", time.Hour)
	if err != nil {
		return "", "", false // expired / not-yet-valid - don't serve it
	}
	return pairFile, pairFile, true
}

// CachedCertReady returns the local live cert/key when they are immediately
// valid for host. Certificate readiness is network-free; when a LAN IP exists,
// the result also includes one bounded observation of the local resolver so an
// offline party can select its guest path without waiting for the broker.
func CachedCertReady(host string) (Result, bool) {
	return cachedCertReadyForResult(Result{}, host)
}

// CachedCertReadyForResult gives a cached fallback the same immutable install
// generation as the broker attempt that selected its host. This closes the gap
// where a replacement identity could otherwise turn an old broker hostname
// into an apparently unowned (BYO) cached result.
func CachedCertReadyForResult(source Result, host string) (Result, bool) {
	return cachedCertReadyForResult(source, host)
}

func cachedCertReadyForResult(source Result, host string) (Result, bool) {
	if host == "" {
		return Result{Reason: "no cached activation host"}, false
	}
	dir, err := stateDir()
	if err != nil {
		return Result{Host: host, Reason: "no state dir: " + err.Error()}, false
	}
	pairFile, pairErr := cachedCertificateSnapshot(context.Background(), dir, host, time.Hour)
	if pairErr != nil {
		return Result{Host: host, Reason: "cached certificate is missing, expired, or for a different host"}, false
	}
	res := Result{OK: true, Host: host, CertFile: pairFile, KeyFile: pairFile, CertReady: true}
	if source.install.valid() {
		res.install = source.install
	} else if snapshot, ok := currentInstallSnapshotForHost(context.Background(), dir, host); ok {
		res.install = snapshot
	}
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

func currentInstallSnapshotForHost(ctx context.Context, dir, host string) (installSnapshot, bool) {
	lockFile, err := lockInstallState(ctx, dir)
	if err != nil {
		return installSnapshot{}, false
	}
	defer unlockInstallState(lockFile)
	var rec installRecord
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil || json.Unmarshal(data, &rec) != nil || rec.ID == "" || rec.Secret == "" {
		return installSnapshot{}, false
	}
	snapshot := snapshotFromRecord(rec)
	wantHost := snapshot.hostLabel + "." + snapshot.base
	if !strings.EqualFold(wantHost, strings.TrimSuffix(strings.TrimSpace(host), ".")) {
		return installSnapshot{}, false
	}
	return snapshot, true
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
	dir := filepath.Join(base, "PartyParty")
	legacy := filepath.Join(base, "partyparty")
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		if st, legacyErr := os.Stat(legacy); legacyErr == nil && st.IsDir() {
			_ = os.Rename(legacy, dir)
		}
	}
	return dir, os.MkdirAll(dir, 0o700)
}

// StateDir is the app's per-user state directory (certs, install creds, the OTA
// payload cache) - ~/Library/Application Support/PartyParty. Exported so other
// packages can cache alongside without re-deriving the path.
func StateDir() (string, error) { return stateDir() }

// certUsable reports whether the cached pair covers host and has >renewWindow left.
func certUsable(certFile, keyFile, host string) bool {
	return certificatePairValid(certFile, keyFile, host, renewWindow)
}

func certificatePairValid(certFile, keyFile, host string, minRemaining time.Duration) bool {
	cert, err := readCertificatePair(certFile, keyFile)
	if err != nil {
		return false
	}
	return certificateValid(cert, host, minRemaining)
}

func readCertificatePair(certFile, keyFile string) (*x509.Certificate, error) {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}
	return parseCertificatePair(certPEM, keyPEM)
}

func parseCertificatePair(certPEM, keyPEM []byte) (*x509.Certificate, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	if len(pair.Certificate) == 0 {
		return nil, errors.New("certificate chain is empty")
	}
	return x509.ParseCertificate(pair.Certificate[0])
}

func certificateValid(cert *x509.Certificate, host string, minRemaining time.Duration) bool {
	if host != "" {
		if err := cert.VerifyHostname(host); err != nil {
			return false
		}
	}
	now := time.Now()
	if now.Before(cert.NotBefore) {
		return false
	}
	return cert.NotAfter.Sub(now) > minRemaining
}

// ensureWildcardCertificate pulls the shared *.party.<base> machine cert+key
// when the cached pair needs renewal. Concurrent activation attempts share the
// first completed fetch instead of downloading and rewriting the same pair.
func ensureWildcardCertificate(ctx context.Context, b *brokerClient, dir, host string) (string, string, bool, error) {
	if err := lockCertificateFetch(ctx); err != nil {
		return "", "", false, err
	}
	defer unlockCertificateFetch()
	if pairFile, err := cachedCertificateSnapshot(ctx, dir, host, renewWindow); err == nil {
		return pairFile, pairFile, false, nil
	} else if ctx.Err() != nil {
		return "", "", false, ctx.Err()
	}

	var out struct {
		Cert string `json:"cert"`
		Key  string `json:"key"`
	}
	if err := b.post(ctx, "/api/broker/wildcard-cert", map[string]any{"id": b.id, "secret": b.secret}, &out); err != nil {
		return "", "", false, err
	}
	if out.Cert == "" || out.Key == "" {
		return "", "", false, errors.New("empty wildcard cert response")
	}
	certPEM, keyPEM := []byte(out.Cert), []byte(out.Key)
	cert, err := parseCertificatePair(certPEM, keyPEM)
	if err != nil {
		return "", "", false, fmt.Errorf("invalid wildcard certificate/key: %w", err)
	}
	if !certificateValid(cert, host, renewWindow) {
		return "", "", false, fmt.Errorf("wildcard certificate not usable for %s", host)
	}
	lockFile, err := lockCertificateState(ctx, dir)
	if err != nil {
		return "", "", false, err
	}
	defer unlockCertificateState(lockFile)
	// Another process may have completed the same refresh while this process was
	// fetching. Prefer that complete generation and avoid a redundant manifest
	// rewrite.
	if pairFile, cachedCert, cachedErr := currentCertificatePairLocked(dir); cachedErr == nil &&
		certificateValid(cachedCert, host, renewWindow) {
		return pairFile, pairFile, false, nil
	}
	pairFile, err := publishCertificatePairLocked(dir, certPEM, keyPEM)
	if err != nil {
		return "", "", false, err
	}
	return pairFile, pairFile, true, nil
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
