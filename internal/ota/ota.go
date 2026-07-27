// Package ota is the over-the-air payload system: the Mac keeps the served web
// content (the guest player, the DJ console, vendored libs, and a config.json
// of tunables/flags) current WITHOUT a signed app update. Most of what we ship
// is web content — playback, sync, recovery, UI, the recorder all live in the
// pages — so making that layer updatable over the wire means a fix reaches
// every DJ's Mac and their guests within minutes, with no relaunch.
//
// One visible app version, two internal compatibility counters:
//
//   - RuntimeVersion (this file, a const) is the native container/API floor:
//     its server API. It changes only when the app changes how it talks to
//     clients, and it moves only via a signed Sparkle update (Apple won't run
//     downloaded native code any other way).
//   - payloadVersion is the web bundle/content counter. It advances freely over
//     the air. Each payload declares the minRuntime it needs; the Mac adopts it
//     only when minRuntime <= RuntimeVersion, so content that depends on a new
//     server route waits for the Sparkle update that ships that route.
//
// The product-facing version combines the native major version with the active
// payload counter. If the app has downloaded payload 55, the UI says 35.55 and
// behaves as 35.55; the lower-level counters exist only to keep OTA content
// compatible with the native runtime that is actually installed.
//
// Security is not optional here: a payload is executable JavaScript we hand to
// guests' phones, so an unverified payload is remote code execution. Every
// payload is authenticated by an ed25519 signature over its manifest (whose
// private key never leaves the release machine), and the bundle bytes are
// pinned by a SHA-256 that the signed manifest carries. The Mac verifies both
// before a payload is ever served, refuses to downgrade, and always falls back
// to the embedded copy it shipped with.
package ota

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RuntimeVersion is the container/protocol version. Bump it (and ship a signed
// app update) only when the native app changes how it talks to clients or the
// server API in a way a new payload would depend on. A cloud payload that
// declares a higher minRuntime is NOT adopted until this is raised — that is
// exactly the "major logic change requires a relaunch, everything else is just
// downloaded" boundary.
//
// Versions 2-5 are retained as the compatibility floor for payloads already
// published to direct-distribution installs. Their retired feature history is
// intentionally not part of the current architecture.
const RuntimeVersion = 5

// payloadSigningKeyB64 is the ed25519 PUBLIC key every OTA manifest must be
// signed with. The private half lives only on the release machine (never in
// the repo). Rotating it is itself a RuntimeVersion-gated app update.
const payloadSigningKeyB64 = "MhPpfOyJ6XdNeY8/MnsQFfHZ3dXc3+Q8CV4ciQ1wgZc="

// Extraction limits — a signed payload is trusted, but defend in depth against
// a decompression bomb or a malformed archive regardless.
const (
	maxBundleBytes  = 64 << 20 // 64 MiB compressed download ceiling
	maxPayloadBytes = 96 << 20 // 96 MiB extracted ceiling
	maxPayloadFiles = 2000
)

var errBadSig = errors.New("ota: manifest signature does not verify")

type manifest struct {
	PayloadVersion int    `json:"payloadVersion"`
	MinRuntime     int    `json:"minRuntime"`
	URL            string `json:"url"`
	SHA256         string `json:"sha256"`
	Sig            string `json:"sig"`
}

// signedMessage is the exact byte string the ed25519 signature covers. Fixed
// field order, newline-delimited — deterministic, with no JSON-canonicalization
// ambiguity. The SHA-256 is inside the signed message, so authenticating the
// manifest transitively authenticates the bundle bytes it pins.
func (m manifest) signedMessage() []byte {
	return []byte(fmt.Sprintf("partyparty-payload-v1\n%d\n%d\n%s\n%s",
		m.PayloadVersion, m.MinRuntime, m.URL, m.SHA256))
}

// Store is an fs.FS whose Open() delegates to whichever content is current —
// the embedded copy the app shipped with, or a verified newer cached payload.
// Because both the page handler and the /vendor/ FileServer read through this
// one FS, a payload swap takes effect for every path at once, live.
type Store struct {
	embedded     fs.FS
	embeddedVer  int
	stateDir     string
	manifestURL  string
	subscribeURL string
	appVersion   string // this app build, sent to /content/subscribe as `av`
	pub          ed25519.PublicKey
	client       *http.Client
	diag         func(string, ...any)

	refreshMu sync.Mutex // serializes Refresh so the subscribe push and the periodic floor can't download/extract/swap the same payload dir concurrently

	mu        sync.RWMutex
	active    fs.FS
	version   int
	appUpdate bool // the cloud advertises a newer app build — surfaced so Sparkle can pull it now
}

// Open wires a Store around the embedded content. embeddedVer is the payload
// version the binary shipped with (the adoption floor — a cloud payload older
// than this is never adopted). contentBase is the cloud content root (e.g.
// https://partyparty.party/content); "" disables all fetching (serves embedded
// only). appVersion is this build, sent to the subscribe endpoint so a newer
// app build can be pushed. A previously-cached, newer payload is adopted
// immediately so a restart doesn't regress to embedded.
func Open(embedded fs.FS, embeddedVer int, stateDir, contentBase, appVersion string, diag func(string, ...any)) (*Store, error) {
	pub, err := base64.StdEncoding.DecodeString(payloadSigningKeyB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("ota: bad embedded signing key")
	}
	if diag == nil {
		diag = func(string, ...any) {}
	}
	manifestURL, subscribeURL := "", ""
	if contentBase != "" {
		base := strings.TrimRight(contentBase, "/")
		manifestURL = base + "/manifest.json"
		subscribeURL = base + "/subscribe"
	}
	s := &Store{
		embedded: embedded, embeddedVer: embeddedVer,
		stateDir: stateDir, manifestURL: manifestURL, subscribeURL: subscribeURL, appVersion: appVersion,
		pub:    ed25519.PublicKey(pub),
		client: &http.Client{Timeout: 35 * time.Second},
		diag:   diag,
		active: embedded, version: embeddedVer,
	}
	s.loadCached()
	return s, nil
}

// OpenEmbedded creates a Store that can only serve assets shipped inside the
// app. Mac App Store builds use this path so downloaded or previously cached
// web payloads can never alter the reviewed product.
func OpenEmbedded(embedded fs.FS, embeddedVer int, appVersion string, diag func(string, ...any)) (*Store, error) {
	pub, err := base64.StdEncoding.DecodeString(payloadSigningKeyB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("ota: bad embedded signing key")
	}
	if diag == nil {
		diag = func(string, ...any) {}
	}
	return &Store{
		embedded: embedded, embeddedVer: embeddedVer,
		appVersion: appVersion,
		pub:        ed25519.PublicKey(pub),
		client:     &http.Client{Timeout: 35 * time.Second},
		diag:       diag,
		active:     embedded, version: embeddedVer,
	}, nil
}

// Open implements fs.FS, delegating to the currently-active content.
func (s *Store) Open(name string) (fs.File, error) {
	s.mu.RLock()
	a := s.active
	s.mu.RUnlock()
	return a.Open(name)
}

// Version returns the effective version stamped into served pages and reported
// to clients: "<major>.<increment>" where major is the code/container version
// (from the app build) and increment is the CURRENT payload version — the
// running OTA content number, embedded or the newer cloud payload now served.
// So the second number bumps on every OTA push and the first only on a native
// app update, and a page self-refreshes whenever either moves. appVersion with
// no "." (e.g. a "dev" build) passes through unchanged.
func (s *Store) Version(appVersion string) string {
	s.mu.RLock()
	v := s.version
	s.mu.RUnlock()
	if i := strings.IndexByte(appVersion, '.'); i >= 0 {
		return appVersion[:i] + "." + strconv.Itoa(v)
	}
	return appVersion
}

// PayloadVersion is the active payload version (for logging/status).
func (s *Store) PayloadVersion() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version
}

// Config returns the current config.json (tunables + feature flags) from the
// active payload, or nil if absent/invalid. Surfaced to clients via /api/status
// so flags can be flipped over the air with the rest of the payload.
func (s *Store) Config() json.RawMessage {
	data, err := fs.ReadFile(s, "config.json")
	if err != nil || !json.Valid(data) {
		return nil
	}
	return json.RawMessage(data)
}

// AppUpdateAvailable reports whether the cloud advertises a newer app build than
// this one. Surfaced in /api/status so the Swift app can ask Sparkle to pull it
// immediately instead of waiting for Sparkle's own timer.
func (s *Store) AppUpdateAvailable() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.appUpdate
}

// Run drives updates aggressively: a long-poll SUBSCRIBE that returns the
// instant the cloud has a newer payload or app build (push-then-pull), plus a
// slow periodic Refresh as a floor in case the subscribe wedges. Cheap at rest —
// the subscribe mostly sits parked on the server; each return triggers at most a
// small verified pull.
func (s *Store) Run(ctx context.Context) {
	if s.manifestURL == "" {
		return
	}
	go s.subscribeLoop(ctx)

	refresh := func() {
		c, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		if adopted, err := s.Refresh(c); adopted {
			s.diag("ota: adopted payload %d (minRuntime ok)", s.PayloadVersion())
		} else if err != nil {
			s.diag("ota: refresh: %v", err)
		}
	}
	select {
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
		return
	}
	refresh()
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			refresh()
		}
	}
}

// subscribeLoop holds a long-poll to the cloud that returns as soon as a newer
// payload or app build exists, then immediately acts and reconnects — so a
// publish reaches this Mac in seconds. Errors (e.g. an older Worker with no
// subscribe route) back off exponentially; the periodic Refresh floor still
// covers updates meanwhile.
func (s *Store) subscribeLoop(ctx context.Context) {
	if s.subscribeURL == "" {
		return
	}
	// Track the newest versions we've been TOLD about — not just what we run —
	// and send those as the subscribe baseline. Otherwise a version we can't
	// apply yet (an app update not installed, or a payload gated by minRuntime /
	// failing to download) keeps the server returning "changed" on every
	// reconnect, and the loop spins hammering the Worker. Advancing the baseline
	// on notice means we hold until something GENUINELY newer appears; a fresh
	// process (after an app update) or the periodic Refresh floor picks up
	// anything we deferred.
	seenPayload := s.PayloadVersion()
	seenApp := s.appVersion
	backoff := 2 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		if pv := s.PayloadVersion(); pv > seenPayload {
			seenPayload = pv // adopted by the periodic floor in the meantime
		}
		respPayload, respApp, err := s.subscribeOnce(ctx, seenPayload, seenApp)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff *= 2; backoff > 60*time.Second {
				backoff = 60 * time.Second
			}
			continue
		}
		backoff = 2 * time.Second
		if respPayload > seenPayload {
			seenPayload = respPayload
		}
		if respApp != "" {
			seenApp = respApp
		}
		// A small floor between reconnects: even with baseline tracking, never
		// let a clean-but-instant return become a tight loop.
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// subscribeOnce opens one long-poll with the caller's baseline (cv/av). It
// resolves when the cloud advertises something newer or after the server's hold
// window; then it acts (a verified payload Refresh and/or flagging an app
// update) and returns the versions the cloud reported so the loop can advance
// its baseline.
func (s *Store) subscribeOnce(ctx context.Context, cv int, av string) (int, string, error) {
	c, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	u := fmt.Sprintf("%s?cv=%d&av=%s", s.subscribeURL, cv, url.QueryEscape(av))
	req, err := http.NewRequestWithContext(c, http.MethodGet, u, nil)
	if err != nil {
		return 0, "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, "", fmt.Errorf("ota: subscribe http %d", resp.StatusCode)
	}
	var st struct {
		PayloadVersion int    `json:"payloadVersion"`
		AppVersion     string `json:"appVersion"`
		Changed        bool   `json:"changed"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<10)).Decode(&st); err != nil {
		return 0, "", err
	}
	if st.PayloadVersion > s.PayloadVersion() {
		s.diag("ota: subscribe — payload %d available, pulling", st.PayloadVersion)
		if adopted, rerr := s.Refresh(ctx); adopted {
			s.diag("ota: adopted payload %d", s.PayloadVersion())
		} else if rerr != nil {
			s.diag("ota: refresh after subscribe: %v", rerr)
		}
	}
	// Only flag an app update when the advertised build is genuinely NEWER — not
	// merely different — so a rolled-back or reformatted marker can't send every
	// Mac chasing a Sparkle check for a version it already runs or is older.
	if versionNewer(st.AppVersion, s.appVersion) {
		s.mu.Lock()
		wasNew := !s.appUpdate
		s.appUpdate = true
		s.mu.Unlock()
		if wasNew {
			s.diag("ota: subscribe — app build %s available (this is %s); Sparkle will pull it", st.AppVersion, s.appVersion)
		}
	}
	return st.PayloadVersion, st.AppVersion, nil
}

// versionNewer reports whether dotted version a is strictly greater than b
// (e.g. "0.38.0" > "0.37.0"). Both are parsed component-wise as integers; if
// either doesn't parse cleanly it falls back to string inequality (err toward a
// harmless extra Sparkle check rather than missing a real update).
func versionNewer(a, b string) bool {
	if a == "" {
		return false
	}
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return a != b
	}
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parseVersion(v string) ([]int, bool) {
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// Refresh fetches the manifest, and if it names a newer compatible payload,
// verifies its signature, downloads and hash-checks the bundle, extracts it
// atomically, and swaps it in. Returns (adopted, err). Any failure leaves the
// currently-served content untouched — never worse than what was already up.
func (s *Store) Refresh(ctx context.Context) (bool, error) {
	// Serialize adoptions: the subscribe push and the periodic floor can both
	// call Refresh at once, and the filesystem swap (download/extract/rename into
	// the shared p<v> dir) is not otherwise safe to run twice concurrently — one
	// goroutine could RemoveAll the dir another just made live. Whoever wins
	// re-reads the version below, so the loser no-ops instead of re-downloading.
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	m, err := s.fetchManifest(ctx)
	if err != nil {
		return false, err
	}
	sig, err := base64.StdEncoding.DecodeString(m.Sig)
	if err != nil || !ed25519.Verify(s.pub, m.signedMessage(), sig) {
		return false, errBadSig
	}
	s.mu.RLock()
	cur := s.version
	s.mu.RUnlock()
	if m.PayloadVersion <= cur {
		return false, nil // not newer — nothing to do (also refuses a downgrade)
	}
	if m.MinRuntime > RuntimeVersion {
		// Needs a newer container than this app is: wait for the signed app
		// update that raises RuntimeVersion, then this payload will apply.
		s.diag("ota: payload %d needs runtime %d > %d — waiting for app update", m.PayloadVersion, m.MinRuntime, RuntimeVersion)
		return false, nil
	}
	dir, err := s.downloadAndExtract(ctx, m)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	s.active = os.DirFS(dir)
	s.version = m.PayloadVersion
	s.mu.Unlock()
	s.writeCurrent(m.PayloadVersion, m.MinRuntime)
	return true, nil
}

func (s *Store) fetchManifest(ctx context.Context) (manifest, error) {
	var m manifest
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.manifestURL, nil)
	if err != nil {
		return m, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return m, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return m, fmt.Errorf("ota: manifest http %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&m); err != nil {
		return m, err
	}
	if m.URL == "" || m.SHA256 == "" || m.Sig == "" || m.PayloadVersion <= 0 {
		return m, errors.New("ota: incomplete manifest")
	}
	return m, nil
}

// downloadAndExtract streams the bundle, verifies its SHA-256 against the
// (already signature-verified) manifest, and extracts it zip-slip-safely into
// a temp dir it then renames into place. Returns the final directory.
func (s *Store) downloadAndExtract(ctx context.Context, m manifest) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ota: bundle http %d", resp.StatusCode)
	}

	root := filepath.Join(s.stateDir, "payload")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(root, fmt.Sprintf("p%d-", m.PayloadVersion))
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		if cleanup {
			os.RemoveAll(tmp)
		}
	}()

	// Hash the compressed bytes as they stream through to the gunzip reader, so
	// the SHA-256 we check is exactly what came off the wire.
	h := sha256.New()
	tee := io.TeeReader(io.LimitReader(resp.Body, maxBundleBytes+1), h)
	gz, err := gzip.NewReader(tee)
	if err != nil {
		return "", err
	}
	defer gz.Close()

	if err := extractTar(gz, tmp); err != nil {
		return "", err
	}
	// Drain any trailing bytes so the hash covers the whole bundle.
	if _, err := io.Copy(io.Discard, tee); err != nil {
		return "", err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, m.SHA256) {
		return "", fmt.Errorf("ota: bundle sha256 mismatch (want %s got %s)", m.SHA256, got)
	}

	final := filepath.Join(root, fmt.Sprintf("p%d", m.PayloadVersion))
	os.RemoveAll(final)
	if err := os.Rename(tmp, final); err != nil {
		return "", err
	}
	cleanup = false
	s.pruneOld(root, m.PayloadVersion)
	return final, nil
}

// extractTar unpacks a tar stream into dir, rejecting anything that would
// escape it (absolute paths, "..", symlinks) and enforcing size/count caps.
func extractTar(r io.Reader, dir string) error {
	tr := tar.NewReader(r)
	cleanDir := filepath.Clean(dir)
	var total int64
	var files int
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Name == "" {
			continue
		}
		// Canonical zip-slip guard: Join cleans the result, and anything that
		// tried to climb out of dir with "../" or an absolute path lands outside
		// dir and fails the prefix check — rejected, not silently neutralized.
		dest := filepath.Join(cleanDir, filepath.FromSlash(hdr.Name))
		if dest != cleanDir && !strings.HasPrefix(dest, cleanDir+string(os.PathSeparator)) {
			return fmt.Errorf("ota: path escapes bundle: %q", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			files++
			if files > maxPayloadFiles {
				return errors.New("ota: too many files in bundle")
			}
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			n, err := io.Copy(f, io.LimitReader(tr, maxPayloadBytes-total+1))
			f.Close()
			if err != nil {
				return err
			}
			total += n
			if total > maxPayloadBytes {
				return errors.New("ota: bundle too large")
			}
		default:
			// Skip symlinks, devices, etc. — payloads are plain files only.
		}
	}
}

// loadCached adopts a previously-downloaded payload on startup if it is newer
// than embedded and still on disk (it was signature+hash verified when written).
func (s *Store) loadCached() {
	c, err := s.readCurrent()
	if err != nil || c.Version <= s.embeddedVer {
		return
	}
	// Refuse a cached payload this runtime is too old for — otherwise a downgrade
	// to an older binary would serve a payload that needs a newer server than it
	// is (Refresh gates on minRuntime; the on-disk cache must too). A legacy
	// current.json without minRuntime reads 0, which passes — correct, since
	// every payload shipped so far requires runtime 1.
	if c.MinRuntime > RuntimeVersion {
		s.diag("ota: cached payload %d needs runtime %d > %d — ignoring", c.Version, c.MinRuntime, RuntimeVersion)
		return
	}
	dir := filepath.Join(s.stateDir, "payload", fmt.Sprintf("p%d", c.Version))
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return
	}
	s.mu.Lock()
	s.active = os.DirFS(dir)
	s.version = c.Version
	s.mu.Unlock()
	s.diag("ota: serving cached payload %d", c.Version)
}

func (s *Store) currentPath() string {
	return filepath.Join(s.stateDir, "payload", "current.json")
}

type currentRec struct {
	Version    int `json:"version"`
	MinRuntime int `json:"minRuntime"`
}

func (s *Store) readCurrent() (currentRec, error) {
	var c currentRec
	data, err := os.ReadFile(s.currentPath())
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	return c, nil
}

func (s *Store) writeCurrent(v, minRuntime int) {
	data, _ := json.Marshal(currentRec{Version: v, MinRuntime: minRuntime})
	tmp := s.currentPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.currentPath()) // atomic pointer swap
}

// pruneOld removes cached payload dirs other than the one now current (and the
// embedded floor), so the cache doesn't accumulate every version ever fetched.
func (s *Store) pruneOld(root string, keep int) {
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "p") {
			continue
		}
		if v, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "p")); err == nil && v != keep {
			os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
}
