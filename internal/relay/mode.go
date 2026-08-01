package relay

import (
	"encoding/json"
	"os"
	"path/filepath"

	"partyparty/internal/activate"
)

// Room connection modes. The Mac owns this decision for the whole room; a guest
// page never chooses for itself.
//
// The mode is not a setting. It falls out of two independent facts about the
// network plus the DJ's override:
//
//	A: can guests reach the Mac here?   (resolver answers + guest probe succeeds)
//	B: is the internet reachable?       (broker registration succeeds)
//
//	              | B: internet      | B: no internet
//	  A: reachable| DIRECT           | LOCAL
//	  A: isolated | RELAY            | NO PATH
//
// LOCAL and DIRECT are the same data path: guests fetch HTTPS LL-HLS straight
// from this Mac. They differ only in which supporting services are reachable.
// NO PATH is genuinely unserviceable: guests cannot reach the Mac and there is
// no internet to relay through. It is reported honestly instead of leaving the
// console on "checking" forever.
const (
	ModeChecking = "checking"
	ModeLocal    = "local"
	ModeDirect   = "direct"
	ModeRelay    = "relay"
	ModeNoPath   = "no_path"
)

// DJ override. Automatic is the default; the rest are preferences with honest
// fallback, never forced dead ends. Asking for relay without internet reports
// NO PATH rather than pretending.
const (
	OverrideAuto   = "auto"
	OverrideDirect = "direct" // never relay
	OverrideRelay  = "relay"  // relay whenever it is possible
	OverrideLocal  = "local"  // never touch the cloud at all, not even the bootstrap
)

// Stable machine reason codes. Text may change; codes may not.
const (
	ReasonStarting      = "starting"
	ReasonAwaitingProbe = "awaiting_probe"
	ReasonProbeDirect   = "probe_direct"
	ReasonProbeIsolated = "probe_isolated"
	ReasonOfflineLocal  = "offline_local"
	ReasonNoSecureLink  = "no_secure_link"
	ReasonResolverBad   = "resolver_mismatch"
	ReasonRelayNoNet    = "relay_needs_internet"
	ReasonOriginDown    = "origin_unreachable"
	ReasonOverride      = "override"
)

// Evidence is everything the mode decision depends on. Keeping it a plain value
// makes decide a pure function, so the whole state machine is table-testable.
type Evidence struct {
	NetTried      bool   // at least one broker registration attempt has completed
	InternetOK    bool   // broker registration is currently succeeding
	ResolverOK    bool   // this network's resolver returns our LAN IP for our host
	HaveDirectURL bool   // a certificate-backed LAN URL exists (cached cert is enough)
	Probe         *bool  // guest reachability report; nil until a guest reports
	OriginDown    bool   // the relay origin's health endpoint is failing
	Override      string // one of the Override constants; "" means auto
}

// normalizeOverride maps an unset or unknown value to auto.
func normalizeOverride(v string) string {
	if validOverride(v) && v != "" {
		return v
	}
	return OverrideAuto
}

func validOverride(v string) bool {
	switch v {
	case OverrideAuto, OverrideDirect, OverrideRelay, OverrideLocal:
		return true
	}
	return false
}

// canServeLocally reports whether guests could reach this Mac with no internet
// involved at all: we need something to serve (a certificate-backed URL) and a
// resolver on this network that actually answers for that name.
func (e Evidence) canServeLocally() bool { return e.HaveDirectURL && e.ResolverOK }

// decide maps evidence to one room mode plus a stable reason code.
func decide(e Evidence) (mode string, reason string) {
	// Until we have actually tried to reach the broker, "no internet" is unknown
	// rather than false. Claiming NO PATH here would tell a DJ their network is
	// hopeless while startup is still in flight.
	if !e.NetTried {
		return ModeChecking, ReasonStarting
	}

	switch e.Override {
	case OverrideLocal:
		if !e.HaveDirectURL {
			return ModeChecking, ReasonNoSecureLink
		}
		if !e.ResolverOK {
			return ModeNoPath, ReasonResolverBad
		}
		return ModeLocal, ReasonOverride

	case OverrideDirect:
		if !e.HaveDirectURL {
			return ModeChecking, ReasonNoSecureLink
		}
		if !e.ResolverOK {
			return ModeNoPath, ReasonResolverBad
		}
		if !e.InternetOK {
			return ModeLocal, ReasonOverride
		}
		return ModeDirect, ReasonOverride

	case OverrideRelay:
		// A forced relay without internet has nowhere to go. Say so.
		if !e.InternetOK {
			return ModeNoPath, ReasonRelayNoNet
		}
		if e.OriginDown {
			return ModeNoPath, ReasonOriginDown
		}
		return ModeRelay, ReasonOverride
	}

	// Automatic.
	if e.InternetOK {
		// The bootstrap can prove the path, so wait for a guest to report rather
		// than guessing. Relay is available either way, so this is never a dead end.
		switch {
		case e.Probe == nil:
			return ModeChecking, ReasonAwaitingProbe
		case *e.Probe && e.HaveDirectURL:
			return ModeDirect, ReasonProbeDirect
		case *e.Probe:
			// Reachable, but we have no secure link to hand out yet.
			return ModeChecking, ReasonNoSecureLink
		case e.OriginDown:
			// Guests cannot reach the Mac and the relay origin is not answering.
			// Claiming RELAY here hands every guest a dead page: the mode used to
			// prove the Mac's side of the path and simply assume the relay's.
			return ModeNoPath, ReasonOriginDown
		default:
			return ModeRelay, ReasonProbeIsolated
		}
	}

	// No internet: there is no bootstrap to probe with and no relay to fall back
	// on, so the resolver observation is the whole answer.
	switch {
	case !e.HaveDirectURL:
		return ModeNoPath, ReasonNoSecureLink
	case !e.ResolverOK:
		return ModeNoPath, ReasonResolverBad
	default:
		return ModeLocal, ReasonOfflineLocal
	}
}

// usesCloud reports whether a mode involves the internet in the guest path. The
// QR uses the public bootstrap only when this is true; LOCAL hands out the
// direct URL so a guest never depends on a service that is not reachable.
func usesCloud(mode string) bool { return mode == ModeDirect || mode == ModeRelay }

// Messages are DJ-facing. They state what is happening and, when something is
// wrong, what would fix it. They never blame the venue and never imply
// PartyParty can change router settings.
const (
	checkingMessage = "Checking whether guests can connect directly on this Wi-Fi. Scan the QR code once to finish the check."
	localMessage    = "No internet here, so guests are connecting straight to this Mac on this Wi-Fi."
	directMessage   = "Guests are connecting directly to this Mac on the venue Wi-Fi."
	relayMessage    = "The direct Wi-Fi connection is not available, so PartyParty is using an internet relay. This may increase the delay between the DJ and listeners."

	noPathResolverMessage = "This Wi-Fi is not resolving the Mac's secure hostname, and there is no internet relay available. Guests can use the emergency local HTTP link, but locked-screen playback is not guaranteed. On a router you control, add a local DNS rule for the PartyParty hostname."
	noPathRelayMessage    = "Internet relay is selected but there is no internet connection. Switch to Automatic, or connect this Mac to the internet."
	noPathLinkMessage     = "The secure guest link is not ready and there is no internet to set it up. Connect this Mac to the internet once to finish setup."
	noPathOriginMessage   = "This Wi-Fi keeps guests from connecting directly, and the internet relay service is not responding right now. Guests cannot connect until the relay recovers or you use a different Wi-Fi."
)

func messageFor(mode, reason string) string {
	switch mode {
	case ModeLocal:
		return localMessage
	case ModeDirect:
		return directMessage
	case ModeRelay:
		return relayMessage
	case ModeNoPath:
		switch reason {
		case ReasonRelayNoNet:
			return noPathRelayMessage
		case ReasonNoSecureLink:
			return noPathLinkMessage
		case ReasonOriginDown:
			return noPathOriginMessage
		default:
			return noPathResolverMessage
		}
	default:
		return checkingMessage
	}
}

// --- Override persistence -------------------------------------------------
//
// The DJ's preference outlives a restart, so a venue that always needs the same
// choice is set once. Stored beside the network verdicts in the activation state
// directory.

func overridePath() string {
	dir, err := activate.StateDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "connection-mode.json")
}

func loadOverride() string {
	path := overridePath()
	if path == "" {
		return OverrideAuto
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return OverrideAuto
	}
	var p struct {
		Override string `json:"override"`
	}
	if json.Unmarshal(data, &p) != nil || !validOverride(p.Override) {
		return OverrideAuto
	}
	return p.Override
}

func saveOverride(value string) {
	path := overridePath()
	if path == "" || !validOverride(value) {
		return
	}
	data, err := json.Marshal(map[string]string{"override": value})
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(data, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}
