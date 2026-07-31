package server

import (
	"testing"

	"partyparty/internal/activate"
)

// SetActivation must NOT drop the structured LAN evidence that SetActivationResult
// recorded - the reducer needs CertReady/DNSPublished/ResolverMatches/ExpectedIP
// to render a truthful state instead of a spurious "unavailable" post-activation.
func TestSetActivationPreservesEvidence(t *testing.T) {
	env := newTestEnv(t, nil)
	full := activate.Result{
		OK: true, Host: "seth-live.party.partyparty.party", CertReady: true,
		ExpectedIP: "192.168.1.9", DNSPublished: true, ResolverMatches: true,
	}
	env.srv.SetActivationResult(full)
	env.srv.SetActivation(full.Host)

	env.srv.actMu.Lock()
	got := env.srv.actLast
	env.srv.actMu.Unlock()

	if !got.OK || got.Host != full.Host {
		t.Fatalf("engaged flags lost: OK=%v host=%q", got.OK, got.Host)
	}
	if !got.CertReady || !got.DNSPublished || !got.ResolverMatches || got.ExpectedIP != "192.168.1.9" {
		t.Errorf("SetActivation dropped evidence: %+v", got)
	}
}

func TestFailedRefreshPreservesCachedEvidence(t *testing.T) {
	env := newTestEnv(t, nil)
	full := activate.Result{
		OK: true, Host: "offline-live.party.partyparty.party", CertReady: true,
		ExpectedIP: "192.168.1.9", DNSPublished: true, ResolverMatches: true,
	}
	env.srv.SetActivationResult(full)
	env.srv.SetActivationResult(activate.Result{Reason: "broker: unavailable"})

	env.srv.actMu.Lock()
	got := env.srv.actLast
	env.srv.actMu.Unlock()
	if !got.CertReady || got.Host != full.Host || got.ExpectedIP != full.ExpectedIP ||
		!got.DNSPublished || !got.ResolverMatches {
		t.Fatalf("failed refresh discarded usable activation evidence: %+v", got)
	}
}

func TestFailedRefreshWithNewIPClearsStaleResolverEvidence(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.SetActivationResult(activate.Result{
		OK: true, Host: "offline-live.party.partyparty.party", CertReady: true,
		ExpectedIP: "192.168.1.9", DNSPublished: true, ResolverMatches: true,
	})
	env.srv.SetActivationResult(activate.Result{ExpectedIP: "192.168.1.22", Reason: "broker: unavailable"})

	env.srv.actMu.Lock()
	got := env.srv.actLast
	env.srv.actMu.Unlock()
	if got.ExpectedIP != "192.168.1.22" || got.DNSPublished || got.ResolverMatches || got.ResolverObserved {
		t.Fatalf("new IP retained stale resolver evidence: %+v", got)
	}
}
