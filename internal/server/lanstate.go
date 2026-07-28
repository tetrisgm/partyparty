package server

import (
	"time"
)

// LAN readiness is based on the secure local listener and real guest heartbeats.
const (
	lanUnavailable = "unavailable" // no usable cert/host yet - the setup card owns this window
	lanReady       = "ready"       // secure link up, listener serving, no guest has joined yet
	lanConfirmed   = "confirmed"   // real guests are on the LAN room right now (or were, within the TTL)
)

// lanInputs is the observed evidence the reducer consumes.
type lanInputs struct {
	CertReady       bool   // a usable certificate/key exists for Host
	Host            string // the machine hostname (empty => no LAN identity yet)
	ExpectedIP      string // the current LAN IP guests would use
	DNSPublished    bool   // broker verified the current A record
	ResolverMatches bool   // this Mac's active resolver returns ExpectedIP
	ChecksComplete  bool   // activation has run at least once
	LanListeners    int    // guests connected to the LAN room right now (this Mac)
}

// lanState is the /api/status `lan` object the DJ console reads.
type lanState struct {
	State           string `json:"state"`
	Host            string `json:"host,omitempty"`
	ExpectedIP      string `json:"expectedIp,omitempty"`
	GuestPort       int    `json:"guestPort,omitempty"`
	CertReady       bool   `json:"certReady"`
	DNSPublished    bool   `json:"dnsPublished"`
	ResolverMatches bool   `json:"resolverMatches"`
	LanListeners    int    `json:"lanListeners"`
	CheckedAtMs     int64  `json:"checkedAtMs,omitempty"`
}

// reduceLanState maps observed evidence to exactly one state, most-informative
// first. Ground truth (a real LAN connection) always beats a guess.
func reduceLanState(in lanInputs) lanState {
	st := lanState{
		Host:            in.Host,
		ExpectedIP:      in.ExpectedIP,
		CertReady:       in.CertReady,
		DNSPublished:    in.DNSPublished,
		ResolverMatches: in.ResolverMatches,
		LanListeners:    in.LanListeners,
	}
	switch {
	case in.LanListeners > 0:
		// A real guest heartbeat is the strongest possible venue proof.
		st.State = lanConfirmed
	case !in.CertReady || in.Host == "" || in.ExpectedIP == "" || !in.DNSPublished:
		// The secure link isn't up yet; the console's setup card covers this.
		st.State = lanUnavailable
	default:
		// The broker has verified the exact A record and the certificate is
		// usable. This Mac's resolver is diagnostic only: its cache, VPN, or
		// encrypted-DNS policy can disagree even while guest phones resolve the
		// freshly published record correctly.
		st.State = lanReady
	}
	return st
}

// lanStateSnapshot computes the LAN state inline from observed reality - cached
// activation (cert/host) and live LAN listener count. All
// cheap in-memory reads (no network probes), so /api/status calls it directly.
func (s *srv) lanStateSnapshot() lanState {
	s.actMu.Lock()
	res := s.actLast
	ran := s.actLastSet
	s.actMu.Unlock()

	lan := 0
	if s.Listeners != nil {
		lan = s.Listeners.Active()
	}
	st := reduceLanState(lanInputs{
		CertReady:       res.CertReady,
		Host:            res.Host,
		ExpectedIP:      res.ExpectedIP,
		DNSPublished:    res.DNSPublished,
		ResolverMatches: res.ResolverMatches,
		ChecksComplete:  ran,
		LanListeners:    lan,
	})
	st.GuestPort = s.Config.TLSPort
	st.CheckedAtMs = time.Now().UnixMilli()
	return st
}
