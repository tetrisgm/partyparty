package server

import (
	"testing"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/broadcast"
)

func TestReachabilityReliableSignalsDegrade(t *testing.T) {
	cases := []struct {
		name   string
		apply  func(*Srv, time.Time)
		reason string
	}{
		{
			name: "activation resolution failure",
			apply: func(s *Srv, _ time.Time) {
				s.SetActivationResult(activate.Result{Host: "party.example.net", Reason: "resolution check: party.example.net resolves to [10.0.0.1], not 192.168.1.9"})
			},
			reason: "This Wi-Fi may be blocking guests from reaching you",
		},
		{
			name: "party DNS netcheck failure",
			apply: func(s *Srv, now time.Time) {
				s.updateReachability(now, []netCheck{
					{Name: netCheckPartyDNS, OK: false, Detail: "lookup partyparty.party: no such host"},
					{Name: netCheckLEDNS, OK: true, Detail: "1.1.1.1"},
				}, true)
			},
			reason: "This Wi-Fi may be blocking guests from reaching you",
		},
		{
			name: "party and public DNS netcheck failure",
			apply: func(s *Srv, now time.Time) {
				s.updateReachability(now, []netCheck{
					{Name: netCheckPartyDNS, OK: false, Detail: "no resolver"},
					{Name: netCheckLEDNS, OK: false, Detail: "no resolver"},
				}, true)
			},
			reason: "This Wi-Fi has no internet",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t, nil)
			tc.apply(env.srv, time.Now())
			got := env.srv.reachability()
			if got.State != reachabilityDegraded || got.Reason != tc.reason {
				t.Fatalf("reachability = %+v, want degraded %q", got, tc.reason)
			}
		})
	}
}

func TestReachabilityPromptRequiresLiveZeroHeartbeatsAndHysteresis(t *testing.T) {
	env := newTestEnv(t, nil)
	start := time.Now()

	env.srv.SetActivationResult(activate.Result{Reason: "resolution check: lookup party.example.net: no such host"})
	env.bc.Start("test", "Test tone", broadcast.Options{})

	env.srv.updateReachability(start.Add(reachabilityPromptGrace+time.Second), nil, false)
	if got := env.srv.reachability(); got.State != reachabilityDegraded {
		t.Fatalf("before a full netcheck cycle, state = %+v, want degraded", got)
	}

	env.srv.updateReachability(start.Add(reachabilityPromptGrace+reachabilityFastPoll), nil, true)
	if got := env.srv.reachability(); got.State != reachabilityPrompt {
		t.Fatalf("after degraded cycle with live zero-heartbeats, state = %+v, want prompt", got)
	}
}

func TestReachabilityHeartbeatResetsPrompt(t *testing.T) {
	env := newTestEnv(t, nil)
	start := time.Now()

	env.srv.SetActivationResult(activate.Result{Reason: "resolution check: lookup party.example.net: no such host"})
	env.bc.Start("test", "Test tone", broadcast.Options{})
	env.srv.updateReachability(start.Add(reachabilityPromptGrace+reachabilityFastPoll), nil, true)
	if got := env.srv.reachability(); got.State != reachabilityPrompt {
		t.Fatalf("setup state = %+v, want prompt", got)
	}

	env.srv.Listeners.Heartbeat("guest-1", false, false, 0, false, "hls")
	env.srv.updateReachability(time.Now(), nil, false)
	if got := env.srv.reachability(); got.State != reachabilityOK || got.Reason != "" {
		t.Fatalf("after heartbeat, state = %+v, want ok", got)
	}
}

func TestReachabilityGuestStallMarksSeenAndDegradesWhileLive(t *testing.T) {
	env := newTestEnv(t, nil)
	env.bc.Start("test", "Test tone", broadcast.Options{})

	env.srv.markGuestReach(true)
	got := env.srv.reachability()
	if got.State != reachabilityDegraded || !got.GuestSeen {
		t.Fatalf("guest-stall reachability = %+v, want degraded with guestSeen", got)
	}
}

func TestReachabilitySingleNetcheckFlapDoesNotPrompt(t *testing.T) {
	env := newTestEnv(t, nil)
	start := time.Now()
	env.bc.Start("test", "Test tone", broadcast.Options{})

	env.srv.updateReachability(start, []netCheck{
		{Name: netCheckPartyDNS, OK: false, Detail: "temporary lookup failure"},
		{Name: netCheckLEDNS, OK: true, Detail: "1.1.1.1"},
	}, true)
	if got := env.srv.reachability(); got.State != reachabilityDegraded {
		t.Fatalf("first failed cycle = %+v, want degraded", got)
	}

	env.srv.updateReachability(start.Add(reachabilityPromptGrace+reachabilityFastPoll), []netCheck{
		{Name: netCheckPartyDNS, OK: true, Detail: "192.0.2.10"},
		{Name: netCheckLEDNS, OK: true, Detail: "1.1.1.1"},
	}, true)
	if got := env.srv.reachability(); got.State != reachabilityOK {
		t.Fatalf("recovered second cycle = %+v, want ok", got)
	}
}
