package server

import "testing"

func TestReduceLanState(t *testing.T) {
	// A fully-passing online baseline; each case overrides what it exercises.
	pass := lanInputs{
		CertReady: true, Host: "seth-live.party.partyparty.party", ExpectedIP: "192.168.4.30",
		DNSPublished: true, ResolverMatches: true, ListenerTLS: true, GuestPathTLS: true,
		ChecksComplete: true, CloudFallback: true,
	}
	with := func(f func(*lanInputs)) lanInputs { c := pass; f(&c); return c }

	cases := []struct {
		name string
		in   lanInputs
		want string
	}{
		{"no cert -> unavailable", with(func(i *lanInputs) { i.CertReady = false }), lanUnavailable},
		{"no host -> unavailable", with(func(i *lanInputs) { i.Host = "" }), lanUnavailable},
		{"cert loaded, checks not run -> checking", with(func(i *lanInputs) { i.ChecksComplete = false }), lanChecking},
		{"all checks pass, no guest -> ready", pass, lanReady},
		{"all pass + recent guest -> confirmed", with(func(i *lanInputs) { i.GuestConfirmed = true }), lanConfirmed},
		{"broker DNS failure -> cloud_fallback", with(func(i *lanInputs) { i.DNSPublished = false }), lanCloudFallback},
		{"resolver mismatch -> cloud_fallback", with(func(i *lanInputs) { i.ResolverMatches = false }), lanCloudFallback},
		{"direct TLS fails -> cloud_fallback", with(func(i *lanInputs) { i.ListenerTLS = false }), lanCloudFallback},
		{"guest-path TLS fails -> cloud_fallback", with(func(i *lanInputs) { i.GuestPathTLS = false }), lanCloudFallback},
		{"offline, local DNS+TLS pass -> offline_ready", with(func(i *lanInputs) {
			i.OfflineMode = true
			i.DNSPublished = false // offline never publishes to Cloudflare; must not matter
		}), lanOfflineReady},
		{"offline, resolver unproven -> offline_unverified", with(func(i *lanInputs) {
			i.OfflineMode = true
			i.ResolverMatches = false
		}), lanOfflineUnverified},
		{"offline, listener TLS fails -> offline_unverified", with(func(i *lanInputs) {
			i.OfflineMode = true
			i.ListenerTLS = false
		}), lanOfflineUnverified},
	}
	for _, c := range cases {
		if got := reduceLanState(c.in).State; got != c.want {
			t.Errorf("%s: state = %q, want %q", c.name, got, c.want)
		}
	}

	// cloudFallback=true is orthogonal to LAN success: it is reported even in ready.
	if s := reduceLanState(pass); !s.CloudFallback || s.State != lanReady {
		t.Errorf("cloudFallback should coexist with ready: got state=%q cloud=%v", s.State, s.CloudFallback)
	}
	// unavailable must not depend on cloud availability.
	if s := reduceLanState(with(func(i *lanInputs) { i.CertReady = false; i.CloudFallback = false })); s.State != lanUnavailable {
		t.Errorf("no cert = %q, want unavailable", s.State)
	}
}

// /api/status must expose the cached lan object. With no activation in the test
// env there is no cert, so refreshLanState reduces to `unavailable` and runs no
// network probes.
func TestStatusIncludesLanObject(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.refreshLanState()
	w := do(env.srv, "GET", "/api/status", "")
	body := decodeJSON(t, w)
	lan, ok := body["lan"].(map[string]any)
	if !ok {
		t.Fatalf("/api/status has no lan object: %v", body["lan"])
	}
	if lan["state"] != lanUnavailable {
		t.Errorf("lan.state = %v, want %q", lan["state"], lanUnavailable)
	}
}
