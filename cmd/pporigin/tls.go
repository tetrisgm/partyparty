package main

import (
	"crypto/tls"
	"errors"
	"os"
	"sync"
	"time"
)

// certKeeper serves the TLS certificate from disk and picks up renewals without
// a restart.
//
// This matters more than it looks. Certbot renews on its own schedule, and a
// service that only reads its certificate at startup keeps serving the expired
// one until somebody notices, which for a relay means every guest gets a
// security warning at a party. Reloading on a timer makes renewal a non-event.
type certKeeper struct {
	certPath string
	keyPath  string

	mu       sync.RWMutex
	cert     *tls.Certificate
	loadedAt time.Time
	modTime  time.Time
}

func newCertKeeper(certPath, keyPath string) (*certKeeper, error) {
	k := &certKeeper{certPath: certPath, keyPath: keyPath}
	if err := k.reload(); err != nil {
		return nil, err
	}
	return k, nil
}

// GetCertificate is the tls.Config hook. It re-reads at most once a minute, and
// only when the file on disk has actually changed, so a busy party does not turn
// into a stat storm.
func (k *certKeeper) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	k.mu.RLock()
	cert, loadedAt := k.cert, k.loadedAt
	k.mu.RUnlock()

	if time.Since(loadedAt) > time.Minute {
		if info, err := os.Stat(k.certPath); err == nil {
			k.mu.RLock()
			changed := info.ModTime().After(k.modTime)
			k.mu.RUnlock()
			if changed {
				if err := k.reload(); err == nil {
					k.mu.RLock()
					cert = k.cert
					k.mu.RUnlock()
				}
			} else {
				k.mu.Lock()
				k.loadedAt = time.Now()
				k.mu.Unlock()
			}
		}
	}
	if cert == nil {
		return nil, errors.New("no certificate loaded")
	}
	return cert, nil
}

func (k *certKeeper) reload() error {
	cert, err := tls.LoadX509KeyPair(k.certPath, k.keyPath)
	if err != nil {
		return err
	}
	info, statErr := os.Stat(k.certPath)
	k.mu.Lock()
	k.cert = &cert
	k.loadedAt = time.Now()
	if statErr == nil {
		k.modTime = info.ModTime()
	}
	k.mu.Unlock()
	return nil
}

// tlsConfig is the server profile: modern only, and HTTP/2 advertised so a guest
// fetching many small parts reuses one connection instead of opening one per part.
func tlsConfig(k *certKeeper) *tls.Config {
	return &tls.Config{
		GetCertificate: k.GetCertificate,
		MinVersion:     tls.VersionTLS12,
		NextProtos:     []string{"h2", "http/1.1"},
	}
}
