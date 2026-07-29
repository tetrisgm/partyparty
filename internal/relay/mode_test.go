package relay

import "testing"

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
