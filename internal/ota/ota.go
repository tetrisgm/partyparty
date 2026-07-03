// Package ota is the over-the-air payload system: the Mac keeps the served web
// content (the guest player, the DJ console, vendored libs, and a config.json
// of tunables/flags) current WITHOUT a signed app update. Most of what we ship
// is web content — playback, sync, recovery, UI, the recorder all live in the
// pages — so making that layer updatable over the wire means a fix reaches
// every DJ's Mac and their guests within minutes, with no relaunch.
//
// Two version lines, one compatibility contract:
//
//   - RuntimeVersion (this file, a const) is the CONTAINER: the native app and
//     its server API. It changes only when the app changes how it talks to
//     clients, and it moves only via a signed Sparkle update (Apple won't run
//     downloaded native code any other way). This is the floor.
//   - payloadVersion is the CONTENT: the web bundle. It advances freely over
//     the air. Each payload declares the minRuntime it needs; the Mac adopts a
//     payload only when minRuntime <= RuntimeVersion, so a payload that depends
//     on a new server route simply waits for the Sparkle update that ships it.
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
const RuntimeVersion = 1

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
	embedded    fs.FS
	embeddedVer int
	stateDir    string
	manifestURL string
	pub         ed25519.PublicKey
	client      *http.Client
	diag        func(string, ...any)

	mu      sync.RWMutex
	active  fs.FS
	version int
}

// Open wires a Store around the embedded content. embeddedVer is the payload
// version the binary shipped with (the adoption floor — a cloud payload older
// than this is never adopted). manifestURL "" disables fetching (serves
// embedded only). A previously-cached, newer payload is adopted immediately so
// a restart doesn't regress to embedded.
func Open(embedded fs.FS, embeddedVer int, stateDir, manifestURL string, diag func(string, ...any)) (*Store, error) {
	pub, err := base64.StdEncoding.DecodeString(payloadSigningKeyB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("ota: bad embedded signing key")
	}
	if diag == nil {
		diag = func(string, ...any) {}
	}
	s := &Store{
		embedded: embedded, embeddedVer: embeddedVer,
		stateDir: stateDir, manifestURL: manifestURL,
		pub:    ed25519.PublicKey(pub),
		client: &http.Client{Timeout: 30 * time.Second},
		diag:   diag,
		active: embedded, version: embeddedVer,
	}
	s.loadCached()
	return s, nil
}

// Open implements fs.FS, delegating to the currently-active content.
func (s *Store) Open(name string) (fs.File, error) {
	s.mu.RLock()
	a := s.active
	s.mu.RUnlock()
	return a.Open(name)
}

// Version returns the effective content version stamped into served pages and
// reported to clients: the app version plus the payload version, so a page
// self-refreshes when EITHER the app or the payload changes.
func (s *Store) Version(appVersion string) string {
	s.mu.RLock()
	v := s.version
	s.mu.RUnlock()
	return appVersion + "/p" + strconv.Itoa(v)
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

// Loop refreshes shortly after boot, then every 15 minutes. Cheap: a single
// small GET that no-ops unless a newer compatible payload exists.
func (s *Store) Loop(ctx context.Context) {
	if s.manifestURL == "" {
		return
	}
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

// Refresh fetches the manifest, and if it names a newer compatible payload,
// verifies its signature, downloads and hash-checks the bundle, extracts it
// atomically, and swaps it in. Returns (adopted, err). Any failure leaves the
// currently-served content untouched — never worse than what was already up.
func (s *Store) Refresh(ctx context.Context) (bool, error) {
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
	s.writeCurrent(m.PayloadVersion)
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
	v, err := s.readCurrent()
	if err != nil || v <= s.embeddedVer {
		return
	}
	dir := filepath.Join(s.stateDir, "payload", fmt.Sprintf("p%d", v))
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return
	}
	s.mu.Lock()
	s.active = os.DirFS(dir)
	s.version = v
	s.mu.Unlock()
	s.diag("ota: serving cached payload %d", v)
}

func (s *Store) currentPath() string {
	return filepath.Join(s.stateDir, "payload", "current.json")
}

func (s *Store) readCurrent() (int, error) {
	data, err := os.ReadFile(s.currentPath())
	if err != nil {
		return 0, err
	}
	var c struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return 0, err
	}
	return c.Version, nil
}

func (s *Store) writeCurrent(v int) {
	data, _ := json.Marshal(struct {
		Version int `json:"version"`
	}{v})
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
