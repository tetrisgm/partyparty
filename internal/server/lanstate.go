package server

import (
	"context"
	"time"
)

// LAN readiness states (execution-plan §6). These are the honest, mutually
// exclusive answers to "can a guest on THIS Wi-Fi reach the low-latency room?"
const (
	lanUnavailable       = "unavailable"        // no usable cert or no LAN host/address
	lanChecking          = "checking"           // cert may be loaded, current-network checks not yet complete
	lanReady             = "ready"              // cert + DNS + resolver + both TLS checks pass for this network
	lanConfirmed         = "confirmed"          // ready, plus a real guest recently reached the machine host
	lanCloudFallback     = "cloud_fallback"     // online, but a publication/resolver/TLS check failed
	lanOfflineReady      = "offline_ready"      // explicit controlled-offline: cached cert + local DNS + TLS pass
	lanOfflineUnverified = "offline_unverified" // cached cert exists, local DNS route to guests unproven
)

// lanInputs is the current-network evidence the reducer consumes. Every field is
// a fact observed independently — none is inferred from another.
type lanInputs struct {
	CertReady       bool   // a usable certificate/key exists for Host
	Host            string // the machine hostname (empty => no LAN identity)
	ExpectedIP      string // the current LAN IP that should be published
	DNSPublished    bool   // the broker returned a VERIFIED Cloudflare A receipt
	ResolverMatches bool   // this network's resolver returns ExpectedIP for Host
	ListenerTLS     bool   // directListenerTLS passed (listener+cert+port+hostname)
	GuestPathTLS    bool   // guestPathTLS passed (system-resolver path reaches the listener)
	GuestConfirmed  bool   // a real guest connection was seen recently
	OfflineMode     bool   // explicit controlled-offline network (captive/bridge)
	ChecksComplete  bool   // the current-network checks have run at least once
	CloudFallback   bool   // the public handle route has a usable cloud/event destination
	ReasonCode      string // stable code from activation/DNS when a check failed
	Reason          string // human-readable detail (log/console)
}

// lanState is the authoritative /api/status `lan` object (execution-plan §6).
type lanState struct {
	State             string `json:"state"`
	Host              string `json:"host,omitempty"`
	ExpectedIP        string `json:"expectedIp,omitempty"`
	GuestPort         int    `json:"guestPort,omitempty"`
	CertReady         bool   `json:"certReady"`
	DNSPublished      bool   `json:"dnsPublished"`
	ResolverMatches   bool   `json:"resolverMatches"`
	ListenerTLSReady  bool   `json:"listenerTlsReady"`
	GuestPathTLSReady bool   `json:"guestPathTlsReady"`
	GuestConfirmed    bool   `json:"guestConfirmed"`
	CloudFallback     bool   `json:"cloudFallback"`
	ReasonCode        string `json:"reasonCode,omitempty"`
	Reason            string `json:"reason,omitempty"`
	CheckedAtMs       int64  `json:"checkedAtMs,omitempty"`
}

// reduceLanState maps evidence to exactly one state with deterministic
// precedence (execution-plan §6). Unknown is never success: an uninitialized or
// mid-flight state renders as `checking`, and any failed required online check
// renders as `cloud_fallback` — never `ready`. cloudFallback=true only reports
// that the public route has a cloud destination; it does not mean the LAN failed
// and may be true in the `ready`/`confirmed` states.
func reduceLanState(in lanInputs) lanState {
	st := lanState{
		Host:              in.Host,
		ExpectedIP:        in.ExpectedIP,
		CertReady:         in.CertReady,
		DNSPublished:      in.DNSPublished,
		ResolverMatches:   in.ResolverMatches,
		ListenerTLSReady:  in.ListenerTLS,
		GuestPathTLSReady: in.GuestPathTLS,
		GuestConfirmed:    in.GuestConfirmed,
		CloudFallback:     in.CloudFallback,
		ReasonCode:        in.ReasonCode,
		Reason:            in.Reason,
	}

	// 1. No cert or host -> unavailable.
	if !in.CertReady || in.Host == "" {
		st.State = lanUnavailable
		return st
	}
	// 2. Explicit controlled-offline mode: only local DNS + listener TLS decide.
	if in.OfflineMode {
		if in.ResolverMatches && in.ListenerTLS {
			st.State = lanOfflineReady
		} else {
			st.State = lanOfflineUnverified
		}
		return st
	}
	// 3. Online checks incomplete -> checking (unknown is not success).
	if !in.ChecksComplete {
		st.State = lanChecking
		return st
	}
	// 4. Any required online check failed -> cloud_fallback.
	if !in.DNSPublished || !in.ResolverMatches || !in.ListenerTLS || !in.GuestPathTLS {
		st.State = lanCloudFallback
		return st
	}
	// 5/6. All checks passed: confirmed if a real guest reached us, else ready.
	if in.GuestConfirmed {
		st.State = lanConfirmed
	} else {
		st.State = lanReady
	}
	return st
}

// guestSeenRecently reports whether a real guest connection was observed within
// the reachability TTL — the "confirmed" proof signal (a guest connection beats
// any predictive self-check).
func (s *srv) guestSeenRecently() bool {
	s.reachMu.Lock()
	defer s.reachMu.Unlock()
	return time.Now().Before(s.guestSeenUntil)
}

// refreshLanState recomputes the cached LAN readiness from current evidence: the
// cached activation result, the two INDEPENDENT TLS self-probes, and the
// recent-guest signal. It runs off the reachability watchdog (background) and is
// bounded so a slow probe can't wedge the tick. /api/status only ever copies the
// cached result — it must never call this inline.
func (s *srv) refreshLanState() {
	s.actMu.Lock()
	res := s.actLast
	ran := s.actLastSet
	s.actMu.Unlock()

	port := s.Config.TLSPort
	in := lanInputs{
		CertReady:       res.CertReady,
		Host:            res.Host,
		ExpectedIP:      res.ExpectedIP,
		DNSPublished:    res.DNSPublished,
		ResolverMatches: res.ResolverMatches,
		GuestConfirmed:  s.guestSeenRecently(),
		ChecksComplete:  ran,
		CloudFallback:   true, // the public handle route always has a cloud/event destination
		ReasonCode:      res.ReasonCode,
		Reason:          res.Reason,
	}
	// The two independent TLS self-checks are only meaningful once a cert exists.
	if res.CertReady && res.Host != "" && port > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		in.ListenerTLS = directListenerTLS(ctx, res.ExpectedIP, port, res.Host).OK
		in.GuestPathTLS = guestPathTLS(ctx, res.Host, port).OK
		cancel()
	}
	st := reduceLanState(in)
	st.GuestPort = port
	st.CheckedAtMs = time.Now().UnixMilli()

	s.lanMu.Lock()
	s.lanCached = st
	s.lanMu.Unlock()
}

// lanStateSnapshot returns the last computed LAN state (a cheap copy for
// /api/status; never runs probes).
func (s *srv) lanStateSnapshot() lanState {
	s.lanMu.Lock()
	defer s.lanMu.Unlock()
	return s.lanCached
}
