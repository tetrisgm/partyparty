package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"partyparty/internal/activate"
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

const (
	netCheckPartyDNS = "Find the guest link (DNS)"
	netCheckLEDNS    = "Find Let's Encrypt (DNS)"
)

type netCheckOptions struct {
	BrokerBase string
	GuestHost  string
	GuestURL   string
}

func (s *srv) netCheckOptions() netCheckOptions {
	broker := os.Getenv("PARTYPARTY_BROKER")
	if broker == "" {
		broker = "https://partyparty.party"
	}
	host := s.liveDomain()
	if host == "" {
		host = activate.BrokerHost()
	}
	return netCheckOptions{
		BrokerBase: broker,
		GuestHost:  host,
		GuestURL:   s.urls().Primary,
	}
}

func runNetChecks(opts netCheckOptions) []netCheck {
	brokerBase := opts.BrokerBase
	if brokerBase == "" {
		brokerBase = "https://partyparty.party"
	}
	cl := &http.Client{Timeout: 8 * time.Second}
	var checks []struct {
		name string
		run  func() (string, error)
	}
	guestHost := strings.TrimSpace(opts.GuestHost)
	if guestHost == "" {
		guestHost = hostFromURL(brokerBase)
	}
	if guestHost != "" {
		checks = append(checks, struct {
			name string
			run  func() (string, error)
		}{netCheckPartyDNS, func() (string, error) { return lookup(guestHost) }})
	}
	if opts.GuestURL != "" {
		checks = append(checks, struct {
			name string
			run  func() (string, error)
		}{"Open the guest link from this Mac", func() (string, error) { return get(cl, opts.GuestURL) }})
	}
	checks = append(checks,
		struct {
			name string
			run  func() (string, error)
		}{"Reach the partyparty service", func() (string, error) { return get(cl, brokerBase+"/api/broker/ping") }},
		struct {
			name string
			run  func() (string, error)
		}{netCheckLEDNS, func() (string, error) { return lookup("acme-v02.api.letsencrypt.org") }},
		struct {
			name string
			run  func() (string, error)
		}{"Reach Let's Encrypt", func() (string, error) { return get(cl, leDirectory) }},
		struct {
			name string
			run  func() (string, error)
		}{"Let's Encrypt accepts requests", func() (string, error) { return leNonce(cl) }},
	)
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

func hostFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func lookup(host string) (string, error) {
	return lookupWithResolver(host, &net.Resolver{PreferGo: true})
}

func lookupWithServer(host, server string) (string, error) {
	return lookupWithResolver(host, &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, server)
	}})
}

func lookupWithResolver(host string, r *net.Resolver) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
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
