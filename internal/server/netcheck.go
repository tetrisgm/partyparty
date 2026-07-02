package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// /api/netcheck (DJ-only): one button in the console runs the exact network
// path activation needs — from THIS Mac, on THIS Wi-Fi — and reports each hop.
// Built for the field failure where Let's Encrypt returned 503 on one venue's
// network and nobody could tell whether the blocker was the Wi-Fi, DNS, our
// broker, or Let's Encrypt itself.

type netCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	MS     int64  `json:"ms"`
}

const leDirectory = "https://acme-v02.api.letsencrypt.org/directory"

func runNetChecks(brokerBase string) []netCheck {
	cl := &http.Client{Timeout: 8 * time.Second}
	checks := []struct {
		name string
		run  func() (string, error)
	}{
		{"Find the partyparty service (DNS)", func() (string, error) { return lookup("party.ramine.net") }},
		{"Reach the partyparty service", func() (string, error) { return get(cl, brokerBase+"/api/broker/ping") }},
		{"Find Let's Encrypt (DNS)", func() (string, error) { return lookup("acme-v02.api.letsencrypt.org") }},
		{"Reach Let's Encrypt", func() (string, error) { return get(cl, leDirectory) }},
		{"Let's Encrypt accepts requests", func() (string, error) { return leNonce(cl) }},
	}
	out := make([]netCheck, len(checks))
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		go func(i int, name string, run func() (string, error)) {
			defer wg.Done()
			t0 := time.Now()
			detail, err := run()
			nc := netCheck{Name: name, MS: time.Since(t0).Milliseconds()}
			if err != nil {
				nc.Detail = err.Error()
			} else {
				nc.OK = true
				nc.Detail = detail
			}
			out[i] = nc
		}(i, c.name, c.run)
	}
	wg.Wait()
	return out
}

func lookup(host string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	// PreferGo sidesteps macOS mDNSResponder's negative cache (the same trap
	// the activation self-check hit) — this tests the NETWORK, not the cache.
	r := &net.Resolver{PreferGo: true}
	ips, err := r.LookupHost(ctx, host)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("no addresses")
	}
	return ips[0], nil
}

func get(cl *http.Client, url string) (string, error) {
	resp, err := cl.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return fmt.Sprintf("HTTP %d", resp.StatusCode), nil
}

// leNonce exercises the endpoint family ACME registration actually POSTs to —
// a directory fetch can succeed while new-acct/new-nonce is throttled (that IS
// the field failure: register → 503).
func leNonce(cl *http.Client) (string, error) {
	resp, err := cl.Get(leDirectory)
	if err != nil {
		return "", err
	}
	var dir struct {
		NewNonce string `json:"newNonce"`
	}
	err = json.NewDecoder(resp.Body).Decode(&dir)
	resp.Body.Close()
	if err != nil || dir.NewNonce == "" {
		return "", fmt.Errorf("directory unreadable")
	}
	req, err := http.NewRequest(http.MethodHead, dir.NewNonce, nil)
	if err != nil {
		return "", err
	}
	r2, err := cl.Do(req)
	if err != nil {
		return "", err
	}
	r2.Body.Close()
	if r2.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", r2.StatusCode)
	}
	return fmt.Sprintf("HTTP %d", r2.StatusCode), nil
}
