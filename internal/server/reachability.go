package server

import (
	"context"
	"os"
	"strings"
	"time"

	"partyparty/internal/activate"
)

const (
	reachabilityOK       = "ok"
	reachabilityDegraded = "degraded"
	reachabilityPrompt   = "prompt"

	reachabilityPromptGrace = 20 * time.Second
	reachabilityFastPoll    = 25 * time.Second
	reachabilitySlowPoll    = 2 * time.Minute
	reachabilityGuestTTL    = 2 * time.Minute
)

type reachabilityStatus struct {
	State     string `json:"state"`
	Reason    string `json:"reason"`
	GuestSeen bool   `json:"guestSeen"`
}

// SetActivationResult records the latest online activation attempt without
// applying it. The watchdog uses this cached result instead of rerunning
// activation or inferring from console state.
func (s *Srv) SetActivationResult(res activate.Result) {
	s.actMu.Lock()
	s.actLast = res
	s.actLastSet = true
	s.actMu.Unlock()
	s.updateReachability(time.Now(), nil, false)
}

// StartReachabilityWatchdog observes activation, netcheck, and heartbeat
// signals. It only updates /api/status; it never switches network mode.
func (s *Srv) StartReachabilityWatchdog(ctx context.Context) {
	go s.runReachabilityWatchdog(ctx)
}

func (s *srv) runReachabilityWatchdog(ctx context.Context) {
	stableOK := 0
	interval := reachabilityFastPoll
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			broker := os.Getenv("PARTYPARTY_BROKER")
			if broker == "" {
				broker = "https://party.ramine.net"
			}
			s.updateReachability(time.Now(), runNetChecks(broker), true)
			if s.reachability().State == reachabilityOK {
				stableOK++
			} else {
				stableOK = 0
			}
			if stableOK >= 2 {
				interval = reachabilitySlowPoll
			} else {
				interval = reachabilityFastPoll
			}
			timer.Reset(interval)
		}
	}
}

func (s *srv) markGuestReach(stalled bool) {
	now := time.Now()
	s.reachMu.Lock()
	s.guestSeenUntil = now.Add(reachabilityGuestTTL)
	if stalled {
		s.guestStalledUntil = now.Add(reachabilityGuestTTL)
	}
	s.reachMu.Unlock()
	s.updateReachability(now, nil, false)
}

func (s *srv) reachability() reachabilityStatus {
	s.updateReachability(time.Now(), nil, false)
	s.reachMu.Lock()
	defer s.reachMu.Unlock()
	state := s.reachState
	if state == "" {
		state = reachabilityOK
	}
	return reachabilityStatus{
		State:     state,
		Reason:    s.reachReason,
		GuestSeen: time.Now().Before(s.guestSeenUntil),
	}
}

func (s *srv) updateReachability(now time.Time, checks []netCheck, fullNetcheckCycle bool) {
	if s.Listeners.Active() > 0 {
		s.reachMu.Lock()
		s.setReachabilityLocked(reachabilityOK, "", now)
		s.reachMu.Unlock()
		return
	}

	reliable, reason := s.activationReachabilitySignal()
	if ok, netReason := netcheckReachabilitySignal(checks); ok {
		reliable, reason = true, netReason
	}
	if s.guestStalledRecent(now) && s.broadcastShownToGuests() {
		reliable, reason = true, "This Wi-Fi may be blocking guests from reaching you"
	}

	s.reachMu.Lock()
	defer s.reachMu.Unlock()
	if !reliable {
		if checks == nil && !s.lastActivationOK() {
			return
		}
		s.setReachabilityLocked(reachabilityOK, "", now)
		return
	}

	if s.reachState != reachabilityDegraded && s.reachState != reachabilityPrompt {
		s.reachState = reachabilityDegraded
		s.reachReason = reason
		s.reachDegradedAt = now
		s.reachDegradedCycles = 0
		return
	}

	if fullNetcheckCycle {
		s.reachDegradedCycles++
	}
	if s.reachReason == "" {
		s.reachReason = reason
	}
	if s.reachState == reachabilityPrompt {
		return
	}
	if s.broadcastShownToGuests() && s.reachDegradedCycles >= 1 && now.Sub(s.reachDegradedAt) >= reachabilityPromptGrace {
		s.reachState = reachabilityPrompt
		return
	}
	s.reachState = reachabilityDegraded
}

func (s *srv) setReachabilityLocked(state, reason string, now time.Time) {
	s.reachState = state
	s.reachReason = reason
	s.reachDegradedAt = now
	s.reachDegradedCycles = 0
}

func (s *srv) activationReachabilitySignal() (bool, string) {
	s.actMu.Lock()
	last, ok := s.actLast, s.actLastSet
	s.actMu.Unlock()
	if !ok || last.OK || !activationReasonIsResolution(last.Reason) {
		return false, ""
	}
	return true, "This Wi-Fi may be blocking guests from reaching you"
}

func (s *srv) lastActivationOK() bool {
	s.actMu.Lock()
	defer s.actMu.Unlock()
	return s.actLastSet && s.actLast.OK
}

func (s *srv) guestStalledRecent(now time.Time) bool {
	s.reachMu.Lock()
	defer s.reachMu.Unlock()
	return now.Before(s.guestStalledUntil)
}

func activationReasonIsResolution(reason string) bool {
	r := strings.ToLower(reason)
	return strings.Contains(r, "resolution check") ||
		strings.Contains(r, "rebind") ||
		strings.Contains(r, "resolves to") ||
		strings.Contains(r, "lookup ") ||
		strings.Contains(r, "no such host")
}

func netcheckReachabilitySignal(checks []netCheck) (bool, string) {
	if len(checks) == 0 {
		return false, ""
	}
	partyDNSFailed := false
	leDNSFailed := false
	for _, c := range checks {
		switch c.Name {
		case netCheckPartyDNS:
			partyDNSFailed = !c.OK
		case netCheckLEDNS:
			leDNSFailed = !c.OK
		}
	}
	if !partyDNSFailed {
		return false, ""
	}
	if leDNSFailed {
		return true, "This Wi-Fi has no internet"
	}
	return true, "This Wi-Fi may be blocking guests from reaching you"
}

func (s *srv) broadcastShownToGuests() bool {
	st := s.Broadcaster.Status()
	return st.State == "starting" || st.State == "live"
}

func clientEventLooksStalled(kind string) bool {
	k := strings.ToLower(kind)
	switch k {
	case "join-stuck", "play-failed", "media", "stall", "stalled", "reconnect", "offline":
		return true
	default:
		return strings.Contains(k, "join stuck") ||
			strings.Contains(k, "join-stuck") ||
			strings.Contains(k, "play failed") ||
			strings.Contains(k, "play-failed") ||
			strings.Contains(k, "stalled") ||
			strings.Contains(k, "stalling")
	}
}
