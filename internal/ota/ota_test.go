package ota

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"testing/fstest"
)

// buildBundle returns a gzip'd tar of the given files and its hex sha256.
func buildBundle(t *testing.T, files map[string]string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:])
}

// harness spins a server serving a manifest+bundle signed with a test key, and
// a Store wired to that key and a fresh state dir.
type harness struct {
	priv          ed25519.PrivateKey
	pub           ed25519.PublicKey
	srv           *httptest.Server
	store         *Store
	bundle        []byte
	man           manifest
	manJSON       func(manifest) []byte
	subAppVersion string // what /subscribe advertises as the latest app build
}

func newHarness(t *testing.T, embeddedVer, payloadVer, minRuntime int, files map[string]string) *harness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	bundle, sha := buildBundle(t, files)

	h := &harness{priv: priv, pub: pub, bundle: bundle}
	mux := http.NewServeMux()
	mux.HandleFunc("/bundle.tgz", func(w http.ResponseWriter, r *http.Request) { w.Write(h.bundle) })
	mux.HandleFunc("/manifest.json", func(w http.ResponseWriter, r *http.Request) {
		w.Write(h.manJSON(h.man))
	})
	// /subscribe advertises the current manifest's payload version and whatever
	// app version the test set on the harness (h.subAppVersion). Returns at once.
	mux.HandleFunc("/subscribe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"payloadVersion": h.man.PayloadVersion,
			"appVersion":     h.subAppVersion,
			"changed":        true,
		})
	})
	h.srv = httptest.NewServer(mux)

	h.man = manifest{PayloadVersion: payloadVer, MinRuntime: minRuntime, URL: h.srv.URL + "/bundle.tgz", SHA256: sha}
	h.man.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, h.man.signedMessage()))
	h.manJSON = func(m manifest) []byte { b, _ := json.Marshal(m); return b }

	embedded := fstest.MapFS{
		"listener.html": {Data: []byte("EMBEDDED v" + strconv.Itoa(embeddedVer))},
		"config.json":   {Data: []byte(`{"src":"embedded"}`)},
	}
	h.store = &Store{
		embedded: embedded, embeddedVer: embeddedVer,
		stateDir: t.TempDir(), manifestURL: h.srv.URL + "/manifest.json", subscribeURL: h.srv.URL + "/subscribe",
		appVersion: "1.0.0",
		pub:        pub, client: h.srv.Client(), diag: func(f string, a ...any) { t.Logf(f, a...) },
		active: embedded, version: embeddedVer,
	}
	t.Cleanup(h.srv.Close)
	return h
}

func read(t *testing.T, f fs.FS, name string) string {
	t.Helper()
	data, err := fs.ReadFile(f, name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func TestAdoptsNewerSignedPayload(t *testing.T) {
	h := newHarness(t, 35, 36, 1, map[string]string{
		"listener.html": "PAYLOAD 36",
		"config.json":   `{"src":"ota","flag":true}`,
	})
	adopted, err := h.store.Refresh(context.Background())
	if err != nil || !adopted {
		t.Fatalf("expected adoption, got adopted=%v err=%v", adopted, err)
	}
	if got := read(t, h.store, "listener.html"); got != "PAYLOAD 36" {
		t.Fatalf("served embedded not payload: %q", got)
	}
	if h.store.PayloadVersion() != 36 {
		t.Fatalf("version not bumped: %d", h.store.PayloadVersion())
	}
	if got := string(h.store.Config()); got != `{"src":"ota","flag":true}` {
		t.Fatalf("config not from payload: %q", got)
	}
	if v := h.store.Version("0.36.0"); v != "0.36.0/p36" {
		t.Fatalf("effective version wrong: %q", v)
	}
}

func TestSubscribePushTriggersVerifiedPull(t *testing.T) {
	// Embedded 35, cloud advertises payload 36 + a newer app build. One
	// subscribe round must pull+verify+adopt the payload AND flag the app update.
	h := newHarness(t, 35, 36, 1, map[string]string{"listener.html": "PUSHED 36"})
	h.subAppVersion = "2.0.0" // newer than the store's appVersion "1.0.0"
	np, na, err := h.store.subscribeOnce(context.Background(), 35, "1.0.0")
	if err != nil {
		t.Fatalf("subscribeOnce: %v", err)
	}
	if np != 36 || na != "2.0.0" {
		t.Fatalf("subscribeOnce returned (%d,%q), want (36,\"2.0.0\")", np, na)
	}
	if h.store.PayloadVersion() != 36 {
		t.Fatalf("push did not adopt payload: version=%d", h.store.PayloadVersion())
	}
	if got := read(t, h.store, "listener.html"); got != "PUSHED 36" {
		t.Fatalf("served content not the pushed payload: %q", got)
	}
	if !h.store.AppUpdateAvailable() {
		t.Fatal("app-update hint not set after a newer app build was advertised")
	}
}

func TestSubscribeNoAppUpdateWhenSameVersion(t *testing.T) {
	// Cloud advertises the SAME app version we run — no false app-update hint.
	h := newHarness(t, 35, 35, 1, map[string]string{"listener.html": "x"}) // payload == embedded (no pull)
	h.subAppVersion = "1.0.0"                                              // == store.appVersion
	if _, _, err := h.store.subscribeOnce(context.Background(), 35, "1.0.0"); err != nil {
		t.Fatalf("subscribeOnce: %v", err)
	}
	if h.store.AppUpdateAvailable() {
		t.Fatal("app-update hint wrongly set for the same app version")
	}
}

func TestVersionNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.38.0", "0.37.0", true},
		{"0.37.1", "0.37.0", true},
		{"0.37.0", "0.37.0", false}, // equal is not newer
		{"0.36.0", "0.37.0", false}, // older (rollback) must not trigger
		{"1.0.0", "0.37.0", true},
		{"", "0.37.0", false},           // empty never triggers
		{"0.37", "0.37.0", false},       // 0.37 == 0.37.0 (trailing zero)
		{"weird", "0.37.0", true},       // unparseable falls back to != (safe extra check)
		{"0.37.0", "0.37.0-beta", true}, // b unparseable, differs -> fallback !=
	}
	for _, c := range cases {
		if got := versionNewer(c.a, c.b); got != c.want {
			t.Errorf("versionNewer(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestVersionIsBareOnStockContent(t *testing.T) {
	// No payload adopted: the served version must equal the app version exactly
	// (no "/pN"), so stock content looks identical to pre-OTA behavior.
	h := newHarness(t, 35, 36, 1, map[string]string{"listener.html": "x"})
	if v := h.store.Version("0.36.0"); v != "0.36.0" {
		t.Fatalf("stock version should be bare app version, got %q", v)
	}
}

func TestRefusesDowngrade(t *testing.T) {
	// Cloud advertises an OLDER payload than embedded — must not adopt.
	h := newHarness(t, 40, 36, 1, map[string]string{"listener.html": "OLD 36"})
	adopted, err := h.store.Refresh(context.Background())
	if adopted || err != nil {
		t.Fatalf("downgrade should be a silent no-op, got adopted=%v err=%v", adopted, err)
	}
	if got := read(t, h.store, "listener.html"); got != "EMBEDDED v40" {
		t.Fatalf("served payload over embedded on downgrade: %q", got)
	}
}

func TestGatesOnMinRuntime(t *testing.T) {
	// Newer payload, but it needs a runtime this app doesn't have yet.
	h := newHarness(t, 35, 50, RuntimeVersion+1, map[string]string{"listener.html": "NEEDS NEW APP"})
	adopted, err := h.store.Refresh(context.Background())
	if adopted || err != nil {
		t.Fatalf("incompatible payload must wait, got adopted=%v err=%v", adopted, err)
	}
	if got := read(t, h.store, "listener.html"); got != "EMBEDDED v35" {
		t.Fatalf("adopted an incompatible payload: %q", got)
	}
}

func TestRejectsBadSignature(t *testing.T) {
	h := newHarness(t, 35, 36, 1, map[string]string{"listener.html": "EVIL"})
	// Tamper: re-sign the manifest with a DIFFERENT key (attacker without our private key).
	_, evil, _ := ed25519.GenerateKey(nil)
	h.man.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(evil, h.man.signedMessage()))
	adopted, err := h.store.Refresh(context.Background())
	if adopted || err != errBadSig {
		t.Fatalf("bad signature must be rejected, got adopted=%v err=%v", adopted, err)
	}
	if got := read(t, h.store, "listener.html"); got != "EMBEDDED v35" {
		t.Fatalf("served an unsigned payload: %q", got)
	}
}

func TestRejectsTamperedBundle(t *testing.T) {
	h := newHarness(t, 35, 36, 1, map[string]string{"listener.html": "GOOD"})
	// Manifest is validly signed, but the bundle bytes are swapped after signing.
	evil, _ := buildBundle(t, map[string]string{"listener.html": "TAMPERED"})
	h.bundle = evil
	adopted, err := h.store.Refresh(context.Background())
	if adopted || err == nil {
		t.Fatalf("sha256 mismatch must be rejected, got adopted=%v err=%v", adopted, err)
	}
	if got := read(t, h.store, "listener.html"); got != "EMBEDDED v35" {
		t.Fatalf("served a tampered bundle: %q", got)
	}
}

func TestRejectsZipSlip(t *testing.T) {
	// A signed bundle is trusted, but extraction must still refuse path escape.
	// extractTar consumes an already-decompressed tar stream.
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	body := "PWNED"
	tw.WriteHeader(&tar.Header{Name: "../escape.html", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
	tw.Write([]byte(body))
	tw.Close()
	if err := extractTar(bytes.NewReader(buf.Bytes()), t.TempDir()); err == nil {
		t.Fatal("extractTar accepted a path-escaping entry")
	}
}

func TestCachedPayloadSurvivesRestart(t *testing.T) {
	h := newHarness(t, 35, 36, 1, map[string]string{"listener.html": "PAYLOAD 36"})
	if adopted, err := h.store.Refresh(context.Background()); err != nil || !adopted {
		t.Fatalf("adopt: %v %v", adopted, err)
	}
	// A fresh Store over the same state dir must serve the cached payload, not embedded.
	embedded := fstest.MapFS{"listener.html": {Data: []byte("EMBEDDED v35")}}
	restarted := &Store{
		embedded: embedded, embeddedVer: 35, stateDir: h.store.stateDir,
		pub: h.pub, client: h.srv.Client(), diag: func(string, ...any) {},
		active: embedded, version: 35,
	}
	restarted.loadCached()
	if got := read(t, restarted, "listener.html"); got != "PAYLOAD 36" {
		t.Fatalf("cached payload not restored after restart: %q", got)
	}
	if restarted.PayloadVersion() != 36 {
		t.Fatalf("cached version not restored: %d", restarted.PayloadVersion())
	}
}
