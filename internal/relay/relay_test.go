package relay

import (
	"encoding/json"
	"testing"
	"time"

	"partyparty/internal/activate"
)

func TestManagerOwnsOneModeForTheNetwork(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/",
		"https://room.relay.partyparty.party",
		"network-1",
	)}
	manager.directURL = "https://disco.party.partyparty.party:8443/"
	manager.netTried, manager.internetOK, manager.resolverOK = true, true, true
	manager.status = Status{Mode: ModeChecking}
	manager.mu.Unlock()

	manager.applyProbe("another-network", false)
	if got := manager.Snapshot().Mode; got != ModeChecking {
		t.Fatalf("wrong network changed mode to %q", got)
	}
	manager.applyProbe("network-1", false)
	status := manager.Snapshot()
	if status.Mode != ModeRelay || status.JoinURL != "https://r-room.partyparty.party/" || !status.KnownNetwork {
		t.Fatalf("relay status = %+v", status)
	}
	manager.applyProbe("network-1", true)
	status = manager.Snapshot()
	if status.Mode != ModeDirect || status.JoinURL != "https://r-room.partyparty.party/" {
		t.Fatalf("direct status = %+v", status)
	}
}

func TestNetworkTransitionReturnsToChecking(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.reg = registration{RelayRegistration: activateRegistration(
		"https://r-room.partyparty.party/",
		"https://room.relay.partyparty.party",
		"network-1",
	)}
	manager.directURL = "https://disco.party.partyparty.party:8443/"
	manager.netTried, manager.internetOK, manager.resolverOK = true, true, true
	manager.status = Status{
		Mode:         ModeDirect,
		JoinURL:      "https://r-room.partyparty.party/",
		DirectURL:    manager.directURL,
		KnownNetwork: true,
		Message:      directMessage,
	}
	manager.mu.Unlock()

	manager.noteNetworkTransition()
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.KnownNetwork {
		t.Fatalf("transition status = %+v", status)
	}
	if status.JoinURL != "" || status.DirectURL != manager.directURL {
		t.Fatalf("transition URLs = %+v", status)
	}

	// Losing the broker is LOCAL, not a faked DIRECT: guests still get the direct
	// link, and the console says the internet is gone rather than implying the
	// cloud check passed.
	manager.noteRegistrationFailure()
	status = manager.Snapshot()
	if status.Mode != ModeLocal || status.JoinURL != manager.directURL {
		t.Fatalf("offline transition status = %+v", status)
	}
}

func TestDirectURLDoesNotBypassInitialCheck(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.SetDirectURL("https://disco.party.partyparty.party:8443/")
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.JoinURL != "" {
		t.Fatalf("initial status = %+v", status)
	}
}

func TestExpiredRelayVerdictIsRechecked(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := New(Config{})
	manager.mu.Lock()
	manager.verdicts["network-1"] = verdict{
		Mode:      ModeRelay,
		UpdatedAt: time.Now().Add(-verdictMaxAge - time.Minute).UnixMilli(),
	}
	manager.mu.Unlock()

	manager.applyRegistration(registration{
		RelayRegistration: activateRegistration(
			"https://r-room.partyparty.party/",
			"https://room.relay.partyparty.party",
			"network-1",
		),
	})
	status := manager.Snapshot()
	if status.Mode != ModeChecking || status.KnownNetwork {
		t.Fatalf("expired verdict status = %+v", status)
	}
}

func TestUsableLANIP(t *testing.T) {
	for _, value := range []string{"192.168.1.4", "10.0.0.2", "172.16.8.9"} {
		if !usableLANIP(value) {
			t.Fatalf("%q should be usable", value)
		}
	}
	for _, value := range []string{"", "127.0.0.1", "169.254.1.2", "::1", "invalid"} {
		if usableLANIP(value) {
			t.Fatalf("%q should not be usable", value)
		}
	}
}

func activateRegistration(join, relayURL, network string) activate.RelayRegistration {
	return activate.RelayRegistration{JoinURL: join, RelayURL: relayURL, NetworkKey: network}
}

func jsonUnmarshal(data []byte, out any) error {
	return json.Unmarshal(data, out)
}
