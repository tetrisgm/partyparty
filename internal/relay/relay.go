// Package relay provides the isolated-Wi-Fi fallback. The Mac always owns the
// room mode. In direct mode guests use the certificate-backed LAN URL. In relay
// mode one authenticated outbound WebSocket carries the existing guest HTTP
// surface through Cloudflare without changing the HLS stream or audio engine.
package relay

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"partyparty/internal/activate"
	"partyparty/internal/netinfo"
)

const (
	maxVerdicts = 32

	lanPollInterval             = 2 * time.Second
	registrationRefreshInterval = 30 * time.Second
	registrationRetryInterval   = 15 * time.Second
	verdictMaxAge               = 24 * time.Hour
)

// Status is the one authoritative room connection state exposed to the Mac
// console and menu bar.
type Status struct {
	Mode       string `json:"mode"`
	Reason     string `json:"reason,omitempty"` // stable machine code; see mode.go
	Override   string `json:"override,omitempty"`
	Reach      string `json:"reach"`
	PushWanted bool   `json:"pushWanted"`
	InternetOK bool   `json:"internetOk"`
	JoinURL    string `json:"joinUrl,omitempty"`
	// RelayOrigin is where a relayed guest is served. The listener needs it to
	// tell "I should move to the relay" from "I am already there": joinUrl is the
	// bootstrap, so a guest comparing against that would navigate back to the
	// bootstrap, which would send it here again, forever.
	RelayOrigin  string `json:"relayOrigin,omitempty"`
	DirectURL    string `json:"directUrl,omitempty"`
	KnownNetwork bool   `json:"knownNetwork"`
	Message      string `json:"message"`
}

// Config contains only local runtime details. Install authentication remains in
// the activation state directory and is never exposed through /api/status.
type Config struct {
	BrokerURL string
	OriginURL string
	Version   string
	Logf      func(format string, args ...any)

	// OnMode is called whenever the room mode changes. It is how contribution
	// learns to start and stop: only RELAY needs the Mac to push a copy of the
	// stream to the internet, and doing it in any other mode would spend the DJ's
	// uplink for nothing. Called without the manager's lock held, so it is safe
	// to call back into this package.
	OnMode func(mode string)
	// OnPush fires when the media-push decision changes: relay mode always
	// pushes; a Wi-Fi + cloud room also pushes whenever the internet is up,
	// so remote guests and isolated-Wi-Fi guests always have a stream.
	OnPush func(enabled bool)

	// PartyID reports the party this Mac is currently playing, so the broker can
	// tell which live Macs are the SAME party. It is read at each registration
	// rather than pushed, because the party can change under us - a Mac that
	// goes live where a DJ is already playing adopts that party's id - and a
	// stale value here sends new guests to a room nobody is in. Nil is fine; the
	// party then has one member as before.
	PartyID func() string
}

type registration struct {
	activate.RelayRegistration
	InstallID string
	Secret    string
}

type verdict struct {
	Mode      string `json:"mode"`
	UpdatedAt int64  `json:"updatedAt"`
}

type verdictFile struct {
	Networks map[string]verdict `json:"networks"`
}

// Manager supervises registration, network verdict persistence, and the
// outbound relay connection.
type Manager struct {
	cfg Config

	mu        sync.RWMutex
	status    Status
	reg       registration
	verdicts  map[string]verdict
	directURL string

	// Evidence behind the mode decision (see mode.go). Guarded by mu.
	netTried      bool
	netFailStreak int // consecutive registration failures; the verdict settles at two
	originDown    bool
	internetOK    bool
	pendingMode   string
	pendingPush   *bool
	pushSignaled  bool
	resolverOK    bool
	probe         *bool
	override      string
	reach         string

	regChanged   chan struct{}
	stateChanged chan struct{}
}

// New creates a manager. Start must be called after the guest-only loopback
// origin is listening.
func New(cfg Config) *Manager {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	m := &Manager{
		cfg:          cfg,
		verdicts:     loadVerdicts(),
		regChanged:   make(chan struct{}, 1),
		stateChanged: make(chan struct{}, 1),
		override:     loadOverride(),
		reach:        loadReach(),
		status: Status{
			Mode:    ModeChecking,
			Reason:  ReasonStarting,
			Message: checkingMessage,
		},
	}
	m.status.Override = m.override
	return m
}

// Start runs until ctx is canceled.
func (m *Manager) Start(ctx context.Context) {
	go m.registrationLoop(ctx)
}

// SetDirectURL supplies the currently activated certificate-backed LAN URL.
func (m *Manager) SetDirectURL(directURL string) {
	directURL = strings.TrimSpace(directURL)
	m.mu.Lock()
	if m.directURL == directURL {
		m.mu.Unlock()
		return
	}
	m.directURL = directURL
	m.recomputeLocked()
	m.mu.Unlock()
	m.flushModeChange()
	m.signal(m.stateChanged)
}

// SetResolverOK records whether THIS network's own resolver answers for our
// hostname with our LAN IP. It is the evidence that decides whether guests can
// find this Mac with no internet at all, and it is the difference between "your
// router is not resolving us" and "this Wi-Fi isolates devices" when nobody can
// connect. Sourced from activate.observeResolver.
func (m *Manager) SetResolverOK(ok bool) {
	m.mu.Lock()
	if m.resolverOK == ok {
		m.mu.Unlock()
		return
	}
	m.resolverOK = ok
	m.recomputeLocked()
	m.mu.Unlock()
	m.flushModeChange()
	m.signal(m.stateChanged)
}

// SetOverride records the DJ's connection-mode preference and persists it.
func (m *Manager) SetOverride(value string) {
	if !validOverride(value) {
		return
	}
	m.mu.Lock()
	if m.override == value {
		m.mu.Unlock()
		return
	}
	m.override = value
	m.recomputeLocked()
	m.mu.Unlock()
	saveOverride(value)
	m.flushModeChange()
	m.signal(m.stateChanged)
}

// Override returns the current DJ preference.
func (m *Manager) Override() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return normalizeOverride(m.override)
}

// SetReach records the DJ's streaming-reach choice and persists it.
func (m *Manager) SetReach(value string) {
	if !validReach(value) {
		return
	}
	m.mu.Lock()
	if m.reach == value {
		m.mu.Unlock()
		return
	}
	m.reach = value
	m.recomputeLocked()
	m.mu.Unlock()
	saveReach(value)
	m.flushModeChange()
	m.signal(m.stateChanged)
}

// Reach returns the current streaming-reach choice.
func (m *Manager) Reach() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if validReach(m.reach) {
		return m.reach
	}
	return ReachWiFi
}

// recomputeLocked re-derives the room mode from current evidence. It is the ONE
// place mode is decided, so no code path can set a mode that the evidence does
// not support. Caller holds mu.
func (m *Manager) recomputeLocked() {
	previous := m.status.Mode
	mode, reason := decide(Evidence{
		NetTried:      m.netTried,
		InternetOK:    m.internetOK,
		ResolverOK:    m.resolverOK,
		HaveDirectURL: m.directURL != "",
		Probe:         m.probe,
		OriginDown:    m.originDown,
		Override:      m.override,
		WiFiOnly:      m.reach == ReachWiFi,
	})
	m.status.Mode = mode
	m.status.Reason = reason
	m.status.Override = normalizeOverride(m.override)
	m.status.InternetOK = m.internetOK
	m.status.DirectURL = m.directURL
	m.status.RelayOrigin = m.reg.RelayURL
	m.status.KnownNetwork = m.probe != nil
	m.status.Message = messageFor(mode, reason)
	m.status.JoinURL = m.joinURLLocked(mode)
	m.status.Reach = m.reach
	if !validReach(m.status.Reach) {
		m.status.Reach = ReachWiFi
	}
	pushWanted := mode == ModeRelay ||
		(m.reach != ReachWiFi && m.netTried && m.internetOK && !m.originDown)
	if pushWanted != m.status.PushWanted || !m.pushSignaled {
		m.status.PushWanted = pushWanted
		m.pushSignaled = true
		m.pendingPush = &pushWanted
	}
	if mode != previous && m.cfg.OnMode != nil {
		// Deferred past the lock: an observer that touches this manager would
		// otherwise deadlock, and that is an easy mistake for a caller to make.
		m.pendingMode = mode
	}
}

// flushModeChange delivers a pending mode notification. Callers invoke it after
// releasing the lock.
func (m *Manager) flushModeChange() {
	m.mu.Lock()
	mode := m.pendingMode
	m.pendingMode = ""
	push := m.pendingPush
	m.pendingPush = nil
	m.mu.Unlock()
	if mode != "" && m.cfg.OnMode != nil {
		m.cfg.OnMode(mode)
	}
	if push != nil && m.cfg.OnPush != nil {
		m.cfg.OnPush(*push)
	}
}

// Snapshot returns a consistent copy for /api/status.
func (m *Manager) Snapshot() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) registrationLoop(ctx context.Context) {
	var lastIP string
	lanIP := netinfo.PrimaryLanIP()
	for {
		if lastIP != "" && lanIP != lastIP {
			m.noteNetworkTransition()
		}
		lastIP = lanIP
		if !usableLANIP(lanIP) {
			// We cannot register without a LAN address, and "we have not tried
			// yet" would otherwise stay true for as long as that lasts, pinning
			// the room on CHECKING and the console on a spinner. Recording the
			// failure lets the mode settle on the honest answer for a Mac with
			// no usable address instead of an endless "starting".
			m.noteRegistrationFailure()
			var ok bool
			lanIP, ok = waitForRegistrationRefresh(ctx, lastIP, lanPollInterval)
			if !ok {
				return
			}
			continue
		}

		attemptCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		registered, err := activate.RegisterRelay(attemptCtx, m.brokerURL(), lanIP, m.currentDirectURL(), m.currentPartyID(), m.cfg.Logf)
		cancel()
		if currentIP := netinfo.PrimaryLanIP(); currentIP != lanIP {
			lanIP = currentIP
			continue
		}
		nextDelay := registrationRefreshInterval
		if err != nil {
			settled := m.noteRegistrationFailure()
			m.cfg.Logf("relay: registration unavailable: %v", err)
			nextDelay = registrationRetryInterval
			if !settled {
				// One failure has not settled the verdict; retry in seconds so a
				// launch-time blip resolves quietly instead of at the refresh pace.
				nextDelay = 2 * time.Second
			}
		} else {
			id, secret := activate.InstallCreds()
			if id == "" || secret == "" {
				m.noteRegistrationFailure()
				nextDelay = 5 * time.Second
			} else {
				next := registration{
					RelayRegistration: registered,
					InstallID:         id,
					Secret:            secret,
				}
				// Registration succeeding proves the BROKER answers; it says
				// nothing about the origin that would actually serve relayed
				// guests. Probe the origin returned by this registration, not the
				// previous registration, then associate the verdict with this exact
				// state generation. At most one small request per refresh cycle.
				m.applyRegistrationWithOriginProbe(ctx, next)
				status := m.Snapshot()
				if status.Mode == ModeChecking && status.Reason == ReasonAwaitingProbe {
					nextDelay = 2 * time.Second
				}
			}
		}

		var ok bool
		lanIP, ok = waitForRegistrationRefresh(ctx, lastIP, nextDelay)
		if !ok {
			return
		}
	}
}

func usableLANIP(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	return ip != nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}

func waitForRegistrationRefresh(ctx context.Context, currentIP string, maximum time.Duration) (string, bool) {
	timer := time.NewTimer(maximum)
	ticker := time.NewTicker(lanPollInterval)
	defer timer.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", false
		case <-timer.C:
			return netinfo.PrimaryLanIP(), true
		case <-ticker.C:
			if nextIP := netinfo.PrimaryLanIP(); nextIP != currentIP {
				return nextIP, true
			}
		}
	}
}

func (m *Manager) noteNetworkTransition() {
	m.mu.Lock()
	m.probe = nil // a new network proves nothing until a guest reports again
	m.recomputeLocked()
	m.mu.Unlock()
	m.flushModeChange()
	m.signal(m.stateChanged)
}

func (m *Manager) brokerURL() string {
	if strings.TrimSpace(m.cfg.BrokerURL) != "" {
		return strings.TrimRight(strings.TrimSpace(m.cfg.BrokerURL), "/")
	}
	return "https://partyparty.party"
}

func (m *Manager) applyRegistration(next registration) {
	m.mu.Lock()
	previousRelay := m.reg.RelayURL
	networkChanged := m.reg.NetworkKey != next.NetworkKey
	m.reg = next
	m.netTried = true
	m.netFailStreak = 0
	m.internetOK = true
	if networkChanged {
		// A cached direct success for this exact network stands in for a fresh
		// probe so a returning venue does not re-run the whole check. A timeout
		// is weak evidence: the phone may have scanned while DNS, TLS, or the app
		// was still settling. Never persist that as 24 hours of "isolation".
		m.probe = nil
		if cached, ok := m.verdicts[next.NetworkKey]; ok &&
			time.Since(time.UnixMilli(cached.UpdatedAt)) <= verdictMaxAge &&
			cached.Mode == ModeDirect {
			reachable := true
			m.probe = &reachable
		} else {
			delete(m.verdicts, next.NetworkKey)
		}
	}
	m.recomputeLocked()
	networkKey := m.reg.NetworkKey
	m.mu.Unlock()

	m.flushModeChange()
	m.signal(m.stateChanged)
	// A guest's verdict rides the registration response now that there is no
	// socket for the browser to push it over.
	if next.Probe != nil {
		m.applyProbe(networkKey, *next.Probe)
	}
	if previousRelay != next.RelayURL {
		m.signal(m.regChanged)
	}
}

// ApplyRegistrationForTest puts the manager in the state it reaches after one
// successful broker registration. It exists so tests in other packages can
// assert what a registered install actually publishes, rather than only what an
// install that has never reached the broker publishes. The distinction matters:
// a status-layer bug that blanked the join URL for every registered CHECKING
// install shipped twice while the tests only ever exercised the unregistered
// case and stayed green.
func (m *Manager) ApplyRegistrationForTest(joinURL, networkKey string) {
	m.applyRegistration(registration{RelayRegistration: activate.RelayRegistration{
		JoinURL:    joinURL,
		NetworkKey: networkKey,
	}})
}

// applyRegistrationWithOriginProbe installs one broker response and checks the
// relay origin returned by that same response.
func (m *Manager) applyRegistrationWithOriginProbe(ctx context.Context, next registration) {
	m.applyRegistration(next)
	m.probeRegistrationOrigin(ctx, next)
}

// probeRegistrationOrigin asks the origin returned by next whether it is alive.
// The result is committed only if next is still the current registration: a
// slower probe from an older refresh must not overwrite a newer origin's health.
func (m *Manager) probeRegistrationOrigin(ctx context.Context, next registration) {
	origin := strings.TrimSpace(next.RelayURL)
	if origin == "" {
		return
	}
	m.setOriginDownForRegistration(next, !probeOrigin(ctx, origin))
}

// setOriginDownForRegistration records whether one registered relay origin is
// answering. The registration comparison and health update share the manager
// lock, so a stale probe result cannot become the verdict for a newer room.
func (m *Manager) setOriginDownForRegistration(probed registration, down bool) {
	m.mu.Lock()
	if !sameRegistration(m.reg, probed) {
		m.mu.Unlock()
		return
	}
	if m.originDown == down {
		m.mu.Unlock()
		return
	}
	m.originDown = down
	m.recomputeLocked()
	m.mu.Unlock()
	m.flushModeChange()
	m.signal(m.stateChanged)
}

func sameRegistration(a, b registration) bool {
	return a.InstallID == b.InstallID &&
		a.Secret == b.Secret &&
		a.JoinURL == b.JoinURL &&
		a.NetworkKey == b.NetworkKey &&
		a.RelayURL == b.RelayURL &&
		a.PublishToken == b.PublishToken &&
		a.Room == b.Room
}

// probeOrigin asks the relay origin whether it is alive. One bounded GET of the
// health endpoint; anything but a 200 is down.
func probeOrigin(ctx context.Context, originURL string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet,
		strings.TrimRight(originURL, "/")+"/__pp/health", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	return resp.StatusCode == http.StatusOK
}

// noteRegistrationFailure records that a broker attempt failed. It no longer
// pretends the room is DIRECT: with no internet the mode is LOCAL when this
// network can resolve us and NO PATH when it cannot, which is the difference
// between a working forest party and a silent one.
//
// One failed attempt is not that evidence, though. The first try races the
// network stack right at launch, and that single blip used to swing the room
// to its harshest verdict - amber warning, emergency HTTP link - on a
// perfectly good Wi-Fi, until a leisurely retry corrected it a minute later.
// A never-settled verdict therefore settles only on the SECOND consecutive
// failure; until then the room honestly stays CHECKING. Once any registration
// has succeeded, a later failure is real evidence (the stack is long since up)
// and flips the verdict immediately, so a mid-party outage is never hidden.
// Reports whether the verdict is settled so the caller can pace retries.
func (m *Manager) noteRegistrationFailure() (settled bool) {
	m.mu.Lock()
	m.netFailStreak++
	if m.netFailStreak >= 2 {
		m.netTried = true
	}
	m.internetOK = false
	settled = m.netTried
	m.recomputeLocked()
	m.mu.Unlock()
	m.flushModeChange()
	m.signal(m.stateChanged)
	return settled
}

// joinURLLocked picks what the QR encodes, from the mode alone.
//
// CHECKING must still publish the bootstrap when one is registered. The
// bootstrap is HOW the path gets proven: a guest scans it, probes the Mac, and
// reports the verdict that decides the mode. Withholding the QR until the mode
// is known deadlocks the whole thing, because the mode cannot be known until a
// guest scans the QR. That regression shipped in 125.0 and presented as the
// console sitting on "creating secure guest link" forever.
//
// The bootstrap is tied to the install, not the network, so it stays valid
// across a venue change and is safe to publish the moment registration succeeds.
//
// While CHECKING we do NOT fall back to the direct URL: it has not been proven
// on this network yet, and handing a guest an unproven link is how they land on
// a dead page. LOCAL publishes it because there, a bootstrap that needs internet
// is the guaranteed failure instead. Caller holds mu.
func (m *Manager) joinURLLocked(mode string) string {
	switch mode {
	case ModeNoPath:
		return ""
	case ModeLocal:
		return m.directURL
	case ModeChecking:
		return m.reg.JoinURL
	default:
		if m.reg.JoinURL != "" {
			return m.reg.JoinURL
		}
		return m.directURL
	}
}

func (m *Manager) applyProbe(networkKey string, reachable bool) {
	m.mu.Lock()
	if networkKey == "" || networkKey != m.reg.NetworkKey {
		m.mu.Unlock()
		return
	}
	// Once a guest has proved this network can reach the Mac, a later failed
	// bootstrap probe is not enough to move the whole room to relay. It may be a
	// phone joining during TLS/DNS startup or a transient Wi-Fi loss. A network
	// transition clears the successful probe and reopens this decision; until
	// then, preserve the proven direct path for every listener.
	if !reachable && m.status.Mode == ModeDirect && m.probe != nil && *m.probe {
		m.mu.Unlock()
		m.cfg.Logf("relay: ignoring a failed probe after direct reachability was proven")
		return
	}
	m.probe = &reachable
	m.recomputeLocked()
	mode := m.status.Mode
	// Successful reachability is durable evidence. A failed browser fetch is
	// not: startup timing, DNS convergence, and transient Wi-Fi loss all look
	// identical to client isolation from JavaScript.
	if mode == ModeDirect {
		m.verdicts[networkKey] = verdict{Mode: mode, UpdatedAt: time.Now().UnixMilli()}
	} else {
		delete(m.verdicts, networkKey)
	}
	copyForSave := cloneVerdicts(m.verdicts)
	m.mu.Unlock()

	saveVerdicts(copyForSave)
	m.flushModeChange()
	m.cfg.Logf("relay: this network is now %s", mode)
	m.signal(m.stateChanged)
}

func (m *Manager) signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// currentDirectURL is sent to the broker so the stateless bootstrap page can
// hand it to a guest without holding a live connection to this Mac.
func (m *Manager) currentDirectURL() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.directURL
}

// currentPartyID asks for the party at the moment of registration. The callback
// runs without the manager's lock so it may reach back into the app.
func (m *Manager) currentPartyID() string {
	if m.cfg.PartyID == nil {
		return ""
	}
	return strings.TrimSpace(m.cfg.PartyID())
}

// Relay returns this install's own relay room and publish credential, minted by
// the broker. Empty until registration succeeds.
func (m *Manager) Relay() (originURL, token string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reg.RelayURL, m.reg.PublishToken
}

func verdictPath() string {
	dir, err := activate.StateDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "network-verdicts.json")
}

func loadVerdicts() map[string]verdict {
	out := make(map[string]verdict)
	path := verdictPath()
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var file verdictFile
	if json.Unmarshal(data, &file) != nil {
		return out
	}
	cutoff := time.Now().Add(-verdictMaxAge).UnixMilli()
	for key, item := range file.Networks {
		if key != "" && item.UpdatedAt >= cutoff && item.Mode == ModeDirect {
			out[key] = item
		}
	}
	return out
}

func saveVerdicts(networks map[string]verdict) {
	path := verdictPath()
	if path == "" {
		return
	}
	type entry struct {
		key string
		verdict
	}
	items := make([]entry, 0, len(networks))
	for key, item := range networks {
		items = append(items, entry{key: key, verdict: item})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
	if len(items) > maxVerdicts {
		items = items[:maxVerdicts]
	}
	trimmed := make(map[string]verdict, len(items))
	for _, item := range items {
		trimmed[item.key] = item.verdict
	}
	data, err := json.Marshal(verdictFile{Networks: trimmed})
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(data, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func cloneVerdicts(src map[string]verdict) map[string]verdict {
	out := make(map[string]verdict, len(src))
	for key, item := range src {
		out[key] = item
	}
	return out
}
