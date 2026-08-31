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
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRegisterRelayRejectsNonLANAddress(t *testing.T) {
	for _, address := range []string{"", "127.0.0.1", "169.254.1.2", "::1", "not-an-ip"} {
		if _, err := RegisterRelay(context.Background(), "https://partyparty.party", address, "", "", nil); err == nil {
			t.Fatalf("RegisterRelay accepted %q", address)
		}
	}
}

func TestCachedCertReadyBYOHostFromLocalFiles(t *testing.T) {
	setupStateDir(t)
	writeCachedLiveCert(t, "dj.example.net", renewWindow+24*time.Hour)

	res, ok := CachedCertReady("dj.example.net")
	if !ok || !res.OK || !res.CertReady {
		t.Fatalf("CachedCertReady = (%+v, %v), want usable result", res, ok)
	}
	if res.Host != "dj.example.net" {
		t.Fatalf("Host = %q, want dj.example.net", res.Host)
	}
	if res.CertFile != res.KeyFile || filepath.Dir(res.CertFile) != filepath.Join(dirForResult(t), certificatePairsDirName) {
		t.Fatalf("cert/key snapshot files = %q %q", res.CertFile, res.KeyFile)
	}

	if res, ok := CachedCertReady("other.example.net"); ok || res.OK {
		t.Fatalf("CachedCertReady for wrong host = (%+v, %v), want not usable", res, ok)
	}
}

func dirForResult(t *testing.T) string {
	t.Helper()
	dir, err := stateDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestCachedCertReadyBrokerHostFromInstallJSON(t *testing.T) {
	dir := setupStateDir(t)
	rec := map[string]string{
		"ID":     "install-id",
		"Secret": "install-secret",
		"Base":   "pp.example.net",
		"Slug":   "disco42",
	}
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "install.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	host := BrokerHost()
	if host != "disco42.pp.example.net" {
		t.Fatalf("BrokerHost = %q, want disco42.pp.example.net", host)
	}
	writeCachedLiveCert(t, host, renewWindow+24*time.Hour)

	res, ok := CachedCertReady(host)
	if !ok || !res.OK || res.Host != host {
		t.Fatalf("CachedCertReady = (%+v, %v), want usable broker host result", res, ok)
	}
}

func TestBrokerRememberHostUpdatesCachedBase(t *testing.T) {
	dir := setupStateDir(t)
	b := &brokerClient{
		id:        "install-id",
		secret:    "install-secret",
		base:      "pp.example.net",
		hostLabel: "disco42",
	}
	if err := b.rememberHost(context.Background(), dir, "disco42.party.example.net"); err != nil {
		t.Fatal(err)
	}
	if got := BrokerHost(); got != "disco42.party.example.net" {
		t.Fatalf("BrokerHost after rememberHost = %q, want disco42.party.example.net", got)
	}
	if b.base != "party.example.net" {
		t.Fatalf("broker base = %q, want party.example.net", b.base)
	}
}

func TestBrokerRegistrationMustBelongToCurrentBroker(t *testing.T) {
	for _, tc := range []struct {
		broker string
		base   string
		want   bool
	}{
		{"https://partyparty.party", "party.partyparty.party", true},
		{"https://partyparty.party", "partyparty.party", true},
		{"https://partyparty.party", "party.example.net", false},
		{"https://partyparty.party", "notpartyparty.party", false},
	} {
		if got := brokerOwnsBase(tc.broker, tc.base); got != tc.want {
			t.Errorf("brokerOwnsBase(%q, %q) = %v, want %v", tc.broker, tc.base, got, tc.want)
		}
	}
}

func TestCachedCertReadyAcceptsNearExpiry(t *testing.T) {
	dir := setupStateDir(t)
	writeCachedLiveCert(t, "dj.example.net", renewWindow-time.Hour)

	res, ok := CachedCertReady("dj.example.net")
	if !ok || !res.OK {
		t.Fatalf("CachedCertReady near expiry = (%+v, %v), want usable until close to expiry", res, ok)
	}
	if certUsable(filepath.Join(dir, "live-cert.pem"), filepath.Join(dir, "live-key.pem"), "dj.example.net") {
		t.Fatalf("certUsable near expiry = true, want false so online activation renews")
	}
}

func TestCachedCertReadyRejectsExpired(t *testing.T) {
	setupStateDir(t)
	writeCachedLiveCert(t, "dj.example.net", -time.Hour)

	res, ok := CachedCertReady("dj.example.net")
	if ok || res.OK {
		t.Fatalf("CachedCertReady expired = (%+v, %v), want not usable", res, ok)
	}
}

func setupStateDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	dir, err := stateDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeCachedLiveCert(t *testing.T, host string, validFor time.Duration) {
	t.Helper()
	dir, err := stateDir()
	if err != nil {
		t.Fatal(err)
	}
	certPEM, keyPEM := makeLiveCertPair(t, host, validFor)
	if err := installCertificatePair(
		filepath.Join(dir, "live-cert.pem"),
		filepath.Join(dir, "live-key.pem"),
		certPEM,
		keyPEM,
	); err != nil {
		t.Fatal(err)
	}
}

func makeLiveCertPair(t *testing.T, host string, validFor time.Duration) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(validFor),
		DNSNames:     []string{host},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	var certPEM bytes.Buffer
	if err := pem.Encode(&certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		t.Fatal(err)
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	var keyPEM bytes.Buffer
	if err := pem.Encode(&keyPEM, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}); err != nil {
		t.Fatal(err)
	}
	return certPEM.Bytes(), keyPEM.Bytes()
}

// ------------------------------------------------- disowned install recovery

// A Mac only ever registered when its own install.json was missing, so an
// install the broker had forgotten kept presenting the same id and getting
// refused forever: no DNS, no cert, no relay, and nothing on screen. These
// cover the recovery and, just as importantly, the failures that must NOT
// trigger it - a Mac that renamed itself on every hiccup would move the guest
// link out from under a room mid-party.

func TestUnknownInstallIsDistinctFromEveryOtherRefusal(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		unknown bool
	}{
		{"forgotten", 403, `{"error":"unknown install","reregister":true}`, true},
		{"wrong secret", 403, `{"error":"bad credentials"}`, false},
		{"opaque refusal", 403, `{"error":"bad install auth"}`, false},
		{"broker on fire", 500, `{"error":"boom"}`, false},
		{"nothing useful", 502, ``, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			b := &brokerClient{url: server.URL, id: "aabbccddeeff", secret: "s"}
			err := b.post(context.Background(), "/api/broker/a", map[string]any{}, nil)
			if got := errors.Is(err, errUnknownInstall); got != tc.unknown {
				t.Fatalf("errUnknownInstall = %v, want %v (err %v)", got, tc.unknown, err)
			}
		})
	}
}

func TestForgottenInstallRegistersAgainAndCarriesOn(t *testing.T) {
	dir := setupStateDir(t)
	if err := os.WriteFile(filepath.Join(dir, "install.json"), []byte(
		`{"id":"aaaaaaaaaaaa","secret":"old","base":"127.0.0.1","hostLabel":"stale"}`,
	), 0o600); err != nil {
		t.Fatal(err)
	}

	var relayCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ ID string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/api/broker/register":
			_, _ = w.Write([]byte(`{"id":"bbbbbbbbbbbb","secret":"new","base":"127.0.0.1","hostLabel":"freshname"}`))
		case "/api/broker/relay/register":
			relayCalls++
			if body.ID == "aaaaaaaaaaaa" {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"unknown install","reregister":true}`))
				return
			}
			_, _ = w.Write([]byte(`{"joinUrl":"https://x.partyparty.party/j/abc","networkKey":"k"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	out, err := RegisterRelay(context.Background(), server.URL, "192.168.1.44", "https://d", "", nil)
	if err != nil {
		t.Fatalf("RegisterRelay: %v", err)
	}
	if out.JoinURL == "" {
		t.Fatal("recovered but returned nothing usable")
	}
	if relayCalls != 2 {
		t.Fatalf("expected one refusal then one success, got %d calls", relayCalls)
	}

	// The new identity is on disk, so the next launch does not repeat this.
	data, err := os.ReadFile(filepath.Join(dir, "install.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rec installRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.ID != "bbbbbbbbbbbb" || rec.label() != "freshname" {
		t.Fatalf("install.json still holds %+v", rec)
	}
}

func TestABadSecretNeverThrowsTheIdentityAway(t *testing.T) {
	dir := setupStateDir(t)
	original := `{"id":"aaaaaaaaaaaa","secret":"old","base":"127.0.0.1","hostLabel":"keepme"}`
	if err := os.WriteFile(filepath.Join(dir, "install.json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	var registers int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/broker/register" {
			registers++
		}
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":"bad credentials"}`))
	}))
	defer server.Close()

	if _, err := RegisterRelay(context.Background(), server.URL, "192.168.1.44", "https://d", "", nil); err == nil {
		t.Fatal("a refused secret should surface as an error, not a silent rename")
	}
	if registers != 0 {
		t.Fatal("a wrong secret must never mint a new identity")
	}
	data, _ := os.ReadFile(filepath.Join(dir, "install.json"))
	if string(data) != original {
		t.Fatalf("install.json was touched: %s", data)
	}
}
