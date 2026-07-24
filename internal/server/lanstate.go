package server

import (
	"time"
)

// LAN readiness states. The honest question is "are guests reaching the
// low-latency LAN room on this Mac, the cloud stream, or nothing yet?" These are
// answered from OBSERVED reality — real listener counts — not from predictive
// self-probes. A probe running on the Mac can always reach the Mac, so it can't
// see the guest-side failures (AP/client isolation, venue firewall) that
// actually send guests to the cloud; a real guest connection is the only proof.
const (
	lanUnavailable   = "unavailable"    // no usable cert/host yet — the setup card owns this window
	lanReady         = "ready"          // secure link up, listener serving, no guest has joined yet
	lanConfirmed     = "confirmed"      // real guests are on the LAN room right now (or were, within the TTL)
	lanCloudFallback = "cloud_fallback" // guests are here, but on the cloud stream — not the LAN room
)

// lanInputs is the observed evidence the reducer consumes.
type lanInputs struct {
	CertReady      bool   // a usable certificate/key exists for Host
	Host           string // the machine hostname (empty => no LAN identity yet)
	ExpectedIP     string // the current LAN IP guests would use
	ChecksComplete bool   // activation has run at least once
	LanListeners   int    // guests connected to the LAN room right now (this Mac)
	CloudListeners int    // guests connected to the cloud mirror right now (the Worker)
}

// lanState is the /api/status `lan` object the DJ console reads.
type lanState struct {
	State          string `json:"state"`
	Host           string `json:"host,omitempty"`
	ExpectedIP     string `json:"expectedIp,omitempty"`
	GuestPort      int    `json:"guestPort,omitempty"`
	CertReady      bool   `json:"certReady"`
	LanListeners   int    `json:"lanListeners"`
	CloudListeners int    `json:"cloudListeners"`
	CheckedAtMs    int64  `json:"checkedAtMs,omitempty"`
}

// reduceLanState maps observed evidence to exactly one state, most-informative
// first. Ground truth (a real LAN connection) always beats a guess.
func reduceLanState(in lanInputs) lanState {
	st := lanState{
		Host:           in.Host,
		ExpectedIP:     in.ExpectedIP,
		CertReady:      in.CertReady,
		LanListeners:   in.LanListeners,
		CloudListeners: in.CloudListeners,
	}
	switch {
	case !in.CertReady || in.Host == "":
		// The secure link isn't up yet; the console's setup card covers this.
		st.State = lanUnavailable
	case in.LanListeners > 0:
		// Observed: guests are on the LAN room right now. Proof, not prediction —
		// this count is fed only by guest heartbeats (/api/heartbeat), never the
		// console's own traffic.
		st.State = lanConfirmed
	case in.CloudListeners > 0:
		// Observed: guests found the party but landed on the cloud stream.
		st.State = lanCloudFallback
	default:
		// Cert up, listener serving, nobody has tried yet — honest "ready".
		st.State = lanReady
	}
	return st
}

// lanStateSnapshot computes the LAN state inline from observed reality — cached
// activation (cert/host), live LAN listener count, and cloud listener count. All
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
		CertReady:      res.CertReady,
		Host:           res.Host,
		ExpectedIP:     res.ExpectedIP,
		ChecksComplete: ran,
		LanListeners:   lan,
		CloudListeners: int(s.webListeners.Load()),
	})
	st.GuestPort = s.Config.TLSPort
	st.CheckedAtMs = time.Now().UnixMilli()
	return st
}
