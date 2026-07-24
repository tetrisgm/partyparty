package server

import (
	"testing"

	"partyparty/internal/activate"
)

// A real guest connection is the only proof the LAN room works: markGuestReach
// records it, and it drives the observed "confirmed" LAN state.
func TestGuestReachDrivesConfirmed(t *testing.T) {
	env := newTestEnv(t, nil)
	if env.srv.guestSeenRecently() {
		t.Fatal("no guest seen yet, but guestSeenRecently() is true")
	}
	env.srv.markGuestReach()
	if !env.srv.guestSeenRecently() {
		t.Fatal("after markGuestReach, guestSeenRecently() should be true")
	}

	// With a cert/host present, a recent real guest => confirmed (ground truth).
	env.srv.SetActivationResult(activate.Result{CertReady: true, Host: "seth-live.party.partyparty.party"})
	if st := env.srv.lanStateSnapshot(); st.State != lanConfirmed {
		t.Fatalf("lan state = %q, want confirmed after a real guest connection", st.State)
	}
}
