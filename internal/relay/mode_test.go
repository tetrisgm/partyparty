package relay

import (
	"testing"
	"time"
)

func boolPtr(v bool) *bool { return &v }

// TestDecideTable pins the whole room-mode state machine. Every combination that
// can occur in the field is here, so a later change cannot quietly turn an
// unserviceable network into a hopeful "checking" or hand a guest a link that
// cannot work.
func TestDecideTable(t *testing.T) {
	cases := []struct {
		name       string
		ev         Evidence
		wantMode   string
		wantReason string
	}{
		// --- Startup ------------------------------------------------------
		{
			name:     "before the first broker attempt nothing is claimed",
			ev:       Evidence{HaveDirectURL: true},
			wantMode: ModeChecking, wantReason: ReasonStarting,
		},
		{
			name:     "an override cannot declare a verdict before we have looked",
			ev:       Evidence{Override: OverrideRelay},
			wantMode: ModeChecking, wantReason: ReasonStarting,
		},

		// --- Automatic, internet available -------------------------------
		{
			name:     "online, nothing proven yet, waits for a guest",
			ev:       Evidence{NetTried: true, InternetOK: true, ResolverOK: true, HaveDirectURL: true},
			wantMode: ModeChecking, wantReason: ReasonAwaitingProbe,
		},
		{
			name:     "online, guest reached us",
			ev:       Evidence{NetTried: true, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(true)},
			wantMode: ModeDirect, wantReason: ReasonProbeDirect,
		},
		{
			name:     "online, guest could not reach us, relay carries it",
			ev:       Evidence{NetTried: true, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(false)},
			wantMode: ModeRelay, wantReason: ReasonProbeIsolated,
		},
		{
			name: "online and isolated still relays without a local resolver, because the relay does not need one",
			ev:   Evidence{NetTried: true, InternetOK: true, ResolverOK: false, HaveDirectURL: true, Probe: boolPtr(false)},
			// A resolver that does not answer locally is irrelevant once traffic
			// goes through the relay origin.
			wantMode: ModeRelay, wantReason: ReasonProbeIsolated,
		},
		{
			name:     "online, reachable, but no secure link yet",
			ev:       Evidence{NetTried: true, InternetOK: true, ResolverOK: true, Probe: boolPtr(true)},
			wantMode: ModeChecking, wantReason: ReasonNoSecureLink,
		},

		// --- Automatic, no internet --------------------------------------
		{
			name:     "offline with a resolver that answers is a working local party",
			ev:       Evidence{NetTried: true, ResolverOK: true, HaveDirectURL: true},
			wantMode: ModeLocal, wantReason: ReasonOfflineLocal,
		},
		{
			name: "offline with a resolver that does not answer is unserviceable",
			ev:   Evidence{NetTried: true, ResolverOK: false, HaveDirectURL: true},
			// The old behavior degraded to DIRECT here and guests silently failed.
			wantMode: ModeNoPath, wantReason: ReasonResolverBad,
		},
		{
			name:     "offline with no cached certificate cannot serve at all",
			ev:       Evidence{NetTried: true, ResolverOK: true},
			wantMode: ModeNoPath, wantReason: ReasonNoSecureLink,
		},
		{
			name:     "offline, nothing works",
			ev:       Evidence{NetTried: true},
			wantMode: ModeNoPath, wantReason: ReasonNoSecureLink,
		},

		// --- Overrides, which must never lie -----------------------------
		{
			name:     "prefer relay without internet reports no path instead of pretending",
			ev:       Evidence{NetTried: true, Override: OverrideRelay, ResolverOK: true, HaveDirectURL: true},
			wantMode: ModeNoPath, wantReason: ReasonRelayNoNet,
		},
		{
			name:     "prefer relay with internet relays without waiting for a probe",
			ev:       Evidence{NetTried: true, Override: OverrideRelay, InternetOK: true},
			wantMode: ModeRelay, wantReason: ReasonOverride,
		},
		{
			name:     "prefer direct never relays even when a guest proved isolation",
			ev:       Evidence{NetTried: true, Override: OverrideDirect, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(false)},
			wantMode: ModeDirect, wantReason: ReasonOverride,
		},
		{
			name:     "prefer direct offline is simply local",
			ev:       Evidence{NetTried: true, Override: OverrideDirect, ResolverOK: true, HaveDirectURL: true},
			wantMode: ModeLocal, wantReason: ReasonOverride,
		},
		{
			name:     "prefer direct without a resolver is honest about failing",
			ev:       Evidence{NetTried: true, Override: OverrideDirect, InternetOK: true, HaveDirectURL: true},
			wantMode: ModeNoPath, wantReason: ReasonResolverBad,
		},
		{
			name:     "local only keeps guests off the cloud even with internet",
			ev:       Evidence{NetTried: true, Override: OverrideLocal, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(false)},
			wantMode: ModeLocal, wantReason: ReasonOverride,
		},
		{
			name:     "local only without a secure link waits rather than claiming success",
			ev:       Evidence{NetTried: true, Override: OverrideLocal, ResolverOK: true},
			wantMode: ModeChecking, wantReason: ReasonNoSecureLink,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mode, reason := decide(tc.ev)
			if mode != tc.wantMode || reason != tc.wantReason {
				t.Fatalf("decide() = %s/%s, want %s/%s", mode, reason, tc.wantMode, tc.wantReason)
			}
			if messageFor(mode, reason) == "" {
				t.Fatalf("mode %s reason %s has no DJ-facing message", mode, reason)
			}
		})
	}
}

// TestNoPathIsOnlyForUnserviceableNetworks guards the state that matters most:
// NO PATH tells the DJ to stop troubleshooting and change something, so it must
// never appear while a working path exists.
func TestNoPathIsOnlyForUnserviceableNetworks(t *testing.T) {
	for _, ev := range []Evidence{
		{NetTried: true, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(true)},
		{NetTried: true, InternetOK: true, ResolverOK: true, HaveDirectURL: true, Probe: boolPtr(false)},
		{NetTried: true, InternetOK: true, ResolverOK: false, HaveDirectURL: false, Probe: boolPtr(false)},
		{NetTried: true, ResolverOK: true, HaveDirectURL: true},
	} {
		if mode, reason := decide(ev); mode == ModeNoPath {
			t.Fatalf("evidence %+v is serviceable but decided %s/%s", ev, mode, reason)
		}
	}
}

// TestLocalNeverAdvertisesACloudLink is the offline invariant: a QR that points
// at the public bootstrap is useless with no internet, so LOCAL and NO PATH must
// never use it.
func TestLocalNeverAdvertisesACloudLink(t *testing.T) {
	for _, mode := range []string{ModeLocal, ModeNoPath, ModeChecking} {
		if usesCloud(mode) {
			t.Fatalf("mode %s must not advertise the cloud bootstrap", mode)
		}
	}
	for _, mode := range []string{ModeDirect, ModeRelay} {
		if !usesCloud(mode) {
			t.Fatalf("mode %s should use the bootstrap when one is registered", mode)
		}
	}
}

func TestValidOverride(t *testing.T) {
	for _, ok := range []string{OverrideAuto, OverrideDirect, OverrideRelay, OverrideLocal} {
		if !validOverride(ok) {
			t.Fatalf("%q should be a valid override", ok)
		}
	}
	for _, bad := range []string{"", "off", "cloud", "AUTO"} {
		if validOverride(bad) {
			t.Fatalf("%q should not be a valid override", bad)
		}
	}
}

// TestModeObserverFiresOnlyOnChange is what drives contribution. Getting this
// wrong is expensive in both directions: a missed RELAY notification means
// relayed guests hear nothing, and a spurious one in LOCAL or DIRECT spends the
// DJ's uplink pushing a copy of the stream nobody will fetch.
func TestModeObserverFiresOnlyOnChange(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	var seen []string
	m := New(Config{OnMode: func(mode string) { seen = append(seen, mode) }})

	// Startup: a secure link appears, but nothing is decided yet.
	m.SetDirectURL("https://disco.party.partyparty.party:8443/")
	if len(seen) != 0 {
		t.Fatalf("mode fired before anything was decided: %v", seen)
	}

	// Internet is reachable and a guest reports isolation: this room relays.
	m.mu.Lock()
	m.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/", "wss://partyparty.party/connect", "net-1")}
	m.netTried, m.internetOK, m.resolverOK = true, true, true
	m.mu.Unlock()
	m.applyProbe("net-1", false)

	// A repeated identical probe must not re-fire; contribution is already on.
	m.applyProbe("net-1", false)

	// The venue turns out to be fine after all.
	m.applyProbe("net-1", true)

	want := []string{ModeRelay, ModeDirect}
	if len(seen) != len(want) {
		t.Fatalf("observer saw %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("observer saw %v, want %v", seen, want)
		}
	}
}

// TestModeObserverMayCallBackIntoTheManager: an observer that reads status is
// the obvious thing a caller writes, and it must not deadlock.
func TestModeObserverMayCallBackIntoTheManager(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	done := make(chan string, 4)
	var m *Manager
	m = New(Config{OnMode: func(mode string) {
		done <- m.Snapshot().Mode // re-enters the manager's lock
	}})

	m.SetDirectURL("https://disco.party.partyparty.party:8443/")
	m.mu.Lock()
	m.netTried, m.internetOK, m.resolverOK = true, false, true
	m.mu.Unlock()
	m.noteRegistrationFailure()

	select {
	case got := <-done:
		if got != ModeLocal {
			t.Fatalf("observer saw %q, want %q", got, ModeLocal)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("observer deadlocked calling back into the manager")
	}
}

// TestRelayGuestIsNotBouncedBetweenOriginAndBootstrap guards a loop that would
// kill audio every few seconds.
//
// joinUrl is the BOOTSTRAP, not the room. A relayed guest that compared its own
// origin against joinUrl would navigate to the bootstrap, which redirects back to
// the relay origin, forever. The status payload therefore carries relayOrigin
// separately, and the listener moves guests to THAT.
func TestRelayGuestIsNotBouncedBetweenOriginAndBootstrap(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := New(Config{})
	m.SetDirectURL("https://disco.party.partyparty.party:8443/")
	m.mu.Lock()
	m.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/",    // bootstrap
		"https://room.relay.partyparty.party", // where guests are actually served
		"net-1")}
	m.netTried, m.internetOK, m.resolverOK = true, true, true
	m.mu.Unlock()
	m.applyProbe("net-1", false)

	got := m.Snapshot()
	if got.Mode != ModeRelay {
		t.Fatalf("mode = %s, want relay", got.Mode)
	}
	if got.RelayOrigin != "https://room.relay.partyparty.party" {
		t.Fatalf("relayOrigin = %q; without it a relayed guest cannot tell it has already arrived", got.RelayOrigin)
	}
	if got.RelayOrigin == got.JoinURL {
		t.Fatal("relayOrigin must differ from the bootstrap, or the guard is meaningless")
	}
	if got.DirectURL == "" {
		t.Fatal("directUrl must be published so a guest can be sent home when the room leaves relay")
	}
}

// TestCheckingStillPublishesAScannableQR guards the deadlock that shipped in
// 125.0 and left the console on "creating secure guest link" forever.
//
// The mode cannot leave CHECKING until a guest probes, and a guest cannot probe
// until it scans the QR. So withholding the QR during CHECKING is not caution,
// it is a guarantee that the room never starts.
func TestCheckingStillPublishesAScannableQR(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := New(Config{})
	m.SetDirectURL("https://disco.party.partyparty.party:8443/")
	m.mu.Lock()
	m.netTried, m.internetOK, m.resolverOK = true, true, true
	m.mu.Unlock()
	m.applyRegistration(registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/", "https://room.relay.partyparty.party", "net-1")})

	got := m.Snapshot()
	if got.Mode != ModeChecking {
		t.Fatalf("mode = %s, want checking before any probe", got.Mode)
	}
	if got.JoinURL == "" {
		t.Fatal("checking published no QR, so no guest can ever probe and the room never starts")
	}
	if got.JoinURL != "https://r-room.partyparty.party/" {
		t.Fatalf("checking must publish the bootstrap, got %q", got.JoinURL)
	}

	// And once a guest does probe, the room settles without the QR changing.
	m.applyProbe("net-1", true)
	if after := m.Snapshot(); after.Mode != ModeDirect || after.JoinURL != got.JoinURL {
		t.Fatalf("after probe = %+v", after)
	}
}

// TestCheckingWithoutABootstrapAdvertisesNothing: the direct URL has not been
// proven on this network yet, so handing it out during CHECKING would send a
// guest to a page that may not load. Offline installs reach LOCAL instead, which
// does publish it.
func TestCheckingWithoutABootstrapAdvertisesNothing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := New(Config{})
	m.SetDirectURL("https://disco.party.partyparty.party:8443/")
	if got := m.Snapshot(); got.JoinURL != "" {
		t.Fatalf("an unproven direct URL was advertised during checking: %+v", got)
	}
}
