package activate

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCachedCertReadyBYOHostFromLocalFiles(t *testing.T) {
	setupStateDir(t)
	writeCachedLiveCert(t, "dj.example.net", renewWindow+24*time.Hour)

	res, ok := CachedCertReady("dj.example.net")
	if !ok || !res.OK {
		t.Fatalf("CachedCertReady = (%+v, %v), want usable result", res, ok)
	}
	if res.Host != "dj.example.net" {
		t.Fatalf("Host = %q, want dj.example.net", res.Host)
	}
	if filepath.Base(res.CertFile) != "live-cert.pem" || filepath.Base(res.KeyFile) != "live-key.pem" {
		t.Fatalf("cert/key files = %q %q", res.CertFile, res.KeyFile)
	}

	if res, ok := CachedCertReady("other.example.net"); ok || res.OK {
		t.Fatalf("CachedCertReady for wrong host = (%+v, %v), want not usable", res, ok)
	}
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
		id:     "install-id",
		secret: "install-secret",
		base:   "pp.example.net",
		slug:   "disco42",
	}
	if err := b.rememberHost(dir, "disco42.party.example.net"); err != nil {
		t.Fatal(err)
	}
	if got := BrokerHost(); got != "disco42.party.example.net" {
		t.Fatalf("BrokerHost after rememberHost = %q, want disco42.party.example.net", got)
	}
	if b.base != "party.example.net" {
		t.Fatalf("broker base = %q, want party.example.net", b.base)
	}
}

func TestCachedCertReadyAcceptsNearExpiry(t *testing.T) {
	dir := setupStateDir(t)
	writeCachedLiveCert(t, "dj.example.net", renewWindow-time.Hour)

	res, ok := CachedCertReady("dj.example.net")
	if !ok || !res.OK {
		t.Fatalf("CachedCertReady near expiry = (%+v, %v), want usable until close to expiry", res, ok)
	}
	if certUsable(filepath.Join(dir, "live-cert.pem"), "dj.example.net") {
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
	certFile, err := os.Create(filepath.Join(dir, "live-cert.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(certFile, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		certFile.Close()
		t.Fatal(err)
	}
	if err := certFile.Close(); err != nil {
		t.Fatal(err)
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyFile, err := os.OpenFile(filepath.Join(dir, "live-key.pem"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(keyFile, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}); err != nil {
		keyFile.Close()
		t.Fatal(err)
	}
	if err := keyFile.Close(); err != nil {
		t.Fatal(err)
	}
}
