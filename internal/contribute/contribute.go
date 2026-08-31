// Package contribute pushes this Mac's live audio to a remote origin, so guests
// on a client-isolated network fetch from that origin instead of reaching back
// through a tunnel to this laptop.
//
// This is the ordinary shape for live streaming: contribution, then origin, then
// fan-out. The Mac sends ONE copy out, about 0.32 Mbps, whether five people or
// five hundred are listening, and the origin does the fan-out. The alternative
// the product used before, proxying every guest request back to the Mac, put the
// laptop in the request path of every listener and could not scale past a few
// dozen no matter what was paid for it.
//
// # WHAT IS PUSHED, AND WHY IT MATTERS
//
// This forwards the Mac's OWN LL-HLS playlists and media files, byte for byte.
// It does not hand the origin a stream to re-package.
//
// That is the difference between the room's schedule working and failing
// invisibly. Every chunk carries the wall-clock time it was captured, as
// PROGRAM-DATE-TIME, and the sync contract is that a chunk stamped T plays at
// T + D. An origin that re-packaged (the RTSP shape) would stamp its OWN ingest
// time, so direct and relayed guests would each look perfectly correct alone and
// disagree only when compared. That is the worst class of bug: invisible in
// single-mode testing, obvious to a room full of people. Forwarding the playlist
// unchanged makes the stamp survive by construction rather than by hoping the
// origin propagates absolute time.
//
// It also means the audio is never re-encoded, because there is no encoder here
// at all, and that the origin needs nothing but HTTP, which lets it sit behind an
// ordinary reverse proxy alongside other services instead of demanding a raw TCP
// port of its own.
//
// internal/broadcast stays untouched: this reads the LL-HLS output that package
// already produces rather than adding a leg to its ffmpeg tee.
//
// # THE ORIGIN
//
// Because this forwards finished LL-HLS, the origin does not need MediaMTX, an
// encoder, or a raw TCP port. It needs to accept authenticated PUTs, serve the
// same bytes back to guests, hold a blocking playlist request until the
// requested part exists, and drop everything when the party ends. That is a
// small HTTP service, which is why it can sit behind an ordinary reverse proxy
// next to other services rather than demanding a box of its own.
package contribute

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"

	"partyparty/internal/schedule"
)

const (
	// pollInterval is how often the local playlist is re-read. Loopback requests
	// are effectively free, and polling well inside the part duration keeps the
	// added latency to a fraction of a part rather than a whole one.
	pollInterval = 50 * time.Millisecond

	// retryDelay bounds retry after a failed cycle. A briefly unreachable origin
	// is normal, so this reconnects steadily without hammering.
	retryDelay = 2 * time.Second

	// maxMediaBytes bounds one media file. A 500ms AAC segment is tens of KB;
	// this is a sanity ceiling, not a tuning knob.
	maxMediaBytes = 8 << 20

	maxPlaylistBytes = 1 << 20

	// uploadTimeout stops a stalled origin from wedging the push loop forever.
	uploadTimeout = 10 * time.Second
)

// Status is what the console needs to say honestly whether relayed guests are
// being served.
type Status struct {
	// Running is true while contribution is pushing successfully. It does NOT
	// prove guests can hear anything; it proves this Mac is sending.
	Running bool `json:"running"`
	// Target is the origin being pushed to, without credentials.
	Target string `json:"target,omitempty"`
	// LastError is why the most recent cycle failed, empty when healthy.
	LastError string `json:"lastError,omitempty"`
	// Failures counts consecutive failed cycles. A climbing number means
	// something is actually wrong rather than flapping.
	Failures int `json:"failures"`
	// Pushed counts media files uploaded this session.
	Pushed int `json:"pushed"`
}

// PublishedPlaylist is the name relayed guests fetch from the origin. It is
// fixed rather than derived from the source URL, because the source is the
// multivariant playlist and the thing published is the media playlist those two
// have different names, and a guest URL must not change because a muxer renamed
// something internally.
const PublishedPlaylist = "stream.m3u8"

// PublishedPage is the guest page served at the room's root by the origin. The
// Mac publishes its OWN page rather than the origin embedding one, so a relayed
// guest always gets the page that matches the version of the app they are
// listening to, and a web change ships with the app instead of needing the
// origin redeployed.
const PublishedPage = "index.html"

// Config describes one contribution.
type Config struct {
	// SourceURL is this Mac's local LL-HLS MULTIVARIANT playlist, on loopback.
	//
	// The multivariant playlist, not the media playlist, for two reasons: it is
	// the only one whose name is known ahead of time (the media playlist is named
	// by the muxer, currently audio1_stream.m3u8), and fetching it is what
	// establishes the session the media playlist then requires. Pointing this at
	// a guessed media playlist name is how contribution came to fail with a 401
	// on every cycle, which meant relayed guests received nothing at all.
	SourceURL string
	// Page returns the guest page to publish, or nil to publish none. Called once
	// per session rather than per cycle: it does not change while a party runs.
	Page func() []byte
	// Target optionally resolves this install's relay origin and publish
	// credential. Production registration changes use SetTarget so active work is
	// canceled immediately; this resolver remains for callers with a static or
	// otherwise externally synchronized destination. Returning an empty origin
	// leaves contribution without a destination.
	Target func() (originURL, token string)
	// Assets returns the static files the published page references by absolute
	// path: the DJ avatar, the event cover, the fonts. A relayed guest resolves
	// those URLs against the ORIGIN, so a page pushed without its assets renders
	// with a broken photo and a blank header - which is exactly how the gap was
	// found. Nil publishes none.
	Assets func() []Asset
	// AssetsRev is a cheap fingerprint of what Assets would return. Assets are
	// re-pushed only when it changes (avatar swapped mid-set, cover changed),
	// so the 50ms cycle never rebuilds file bytes just to compare them.
	AssetsRev func() string
	Logf      func(format string, args ...any)
}

// Asset is one static file the guest page needs, named exactly as the page
// references it (no leading slash): "dj-avatar", "covers/decks.webp".
type Asset struct {
	Name        string
	Body        []byte
	ContentType string
}

// target reads the current destination, tolerating an unset resolver.
func (c Config) target() (string, string) {
	if c.Target == nil {
		return "", ""
	}
	origin, token := c.Target()
	return normalizeTarget(origin, token)
}

func normalizeTarget(origin, token string) (string, string) {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return "", ""
	}
	return strings.TrimRight(origin, "/") + "/", token
}

// Manager supervises contribution for as long as it is enabled.
type Manager struct {
	cfg          Config
	sourceClient *http.Client
	originClient *http.Client

	mu      sync.RWMutex
	commit  sync.RWMutex
	status  Status
	enabled bool
	wake    chan struct{}

	// generation changes whenever enabled state or the resolved relay target
	// changes. Active HTTP work is registered here so a state transition can
	// cancel it, and results carry the generation they belong to so a response
	// that wins the cancellation race cannot mutate the new session.
	generation uint64
	nextActive uint64
	active     map[uint64]context.CancelFunc

	// Target is a live broker result, not static configuration. Keep one
	// normalized snapshot for an entire cycle; target-bound dedupe state is
	// discarded before the first upload to a replacement room.
	targetKnown bool
	targetBase  string
	targetToken string
	targetMu    sync.Mutex

	// pageSent records that the guest page is on the origin's current
	// incarnation; originEpoch is which incarnation that is. assetsRev is the
	// fingerprint of the page assets last pushed, empty when they need pushing.
	pageSent    bool
	originEpoch string
	assetsRev   string

	// sent tracks media already uploaded so each file is pushed exactly once.
	// Pruned against the live playlist every cycle, so a long set cannot grow it
	// without bound.
	sent map[string]bool

	// variant is the media playlist name cached from the multivariant playlist.
	// Fetching the master is what creates a MediaMTX session, and doing that
	// every 50ms cycle created a new session per fetch - hundreds a minute -
	// which flooded the log ring so completely that real failures scrolled away
	// in seconds. The master is fetched once, and again only after a failure.
	variant string

	// failStreak counts consecutive failed cycles. MediaMTX closes its HLS
	// muxer on a config reload (a certificate hot-swap does this mid-set), and
	// that invalidates the session cookie this client holds: every media
	// playlist fetch after it is a 401, forever, while the origin room starves
	// and relayed guests get a dead page. Nothing retried the SESSION - only
	// the fetch. After failResetAfter consecutive failures the cookie jar and
	// sent-state are discarded so the next cycle rebuilds the conversation
	// from the master playlist up.
	failStreak int
}

// failResetAfter is how many consecutive failed cycles trigger a full session
// reset. Two tolerates one blip mid-cycle; three in a row at 2s spacing means
// the conversation itself is broken, not the network.
const failResetAfter = 3

var errStaleCycle = errors.New("contribution state changed during cycle")

type relayTarget struct {
	base       string
	token      string
	generation uint64
}

func New(cfg Config) *Manager {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	// A cookie jar, because MediaMTX hands out a session on the multivariant
	// playlist and then REQUIRES it on the media playlist: without the cookie
	// that request is a flat 401. Reading the stream is therefore a two step
	// conversation, exactly as it is for a real player, and a client that cannot
	// hold a cookie cannot read this Mac's own stream at all.
	jar, _ := cookiejar.New(nil)
	return &Manager{
		cfg:          cfg,
		wake:         make(chan struct{}),
		active:       make(map[uint64]context.CancelFunc),
		sent:         make(map[string]bool),
		originClient: &http.Client{Timeout: uploadTimeout},
		sourceClient: newSourceClient(jar),
	}
}

func newSourceClient(jar http.CookieJar) *http.Client {
	return &http.Client{
		Jar:     jar,
		Timeout: uploadTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			return validateLoopbackSourceURL(req.URL)
		},
		Transport: &http.Transport{
			// Local MediaMTX serves the same hot-swapped cert on loopback.
			TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // #nosec G402 -- requests and redirects are restricted to loopback
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression:  true, // media is already compressed; playlists are tiny
		},
	}
}

// SetEnabled turns contribution on or off. Driven by the room mode: only RELAY
// needs it, and pushing a copy of the stream to the internet in any other mode
// would waste the DJ's uplink for nothing.
func (m *Manager) SetEnabled(on bool) {
	m.mu.Lock()
	if m.enabled == on {
		m.mu.Unlock()
		return
	}
	m.enabled = on
	cancels := m.invalidateLocked()
	if !on {
		m.status.Running = false
		m.resetTargetStateLocked() // a fresh session re-pushes what the origin needs
		m.variant = ""
		m.failStreak = 0
	}
	m.mu.Unlock()
	cancelAll(cancels)
	m.joinCommits()
}

// Snapshot returns a consistent copy for /api/status.
func (m *Manager) Snapshot() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) isEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled
}

func (m *Manager) lifecycleState() (enabled bool, generation uint64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled, m.generation
}

// resolveTarget freezes the broker's current room and credential into one
// cycle-wide value. A replacement destination owns different remote state, so
// media/page dedupe from the previous room must be cleared before any playlist
// can be published there.
func (m *Manager) resolveTarget() relayTarget {
	// Serialize the resolver call through adoption. Otherwise a caller that read
	// the old broker value just before a rotation could acquire m.mu after a
	// caller that read the new value and roll the manager back to the stale room.
	m.targetMu.Lock()
	defer m.targetMu.Unlock()

	if m.cfg.Target == nil {
		m.mu.RLock()
		target := relayTarget{base: m.targetBase, token: m.targetToken, generation: m.generation}
		m.mu.RUnlock()
		return target
	}
	base, token := m.cfg.target()
	return m.adoptTarget(base, token)
}

// SetTarget immediately adopts a broker registration's relay room and publish
// credential. It is the production path for target rotation: registration
// changes do not wait for either periodic loop to ask the resolver again.
func (m *Manager) SetTarget(origin, token string) {
	base, token := normalizeTarget(origin, token)
	m.targetMu.Lock()
	defer m.targetMu.Unlock()
	m.adoptTarget(base, token)
}

// adoptTarget runs with targetMu held. It resets all destination-bound state,
// cancels old HTTP work, wakes every loop, and joins callbacks that committed
// before the generation change.
func (m *Manager) adoptTarget(base, token string) relayTarget {
	m.mu.Lock()
	changed := !m.targetKnown || m.targetBase != base || m.targetToken != token
	var cancels []context.CancelFunc
	if changed {
		m.targetKnown = true
		m.targetBase = base
		m.targetToken = token
		cancels = m.invalidateLocked()
		m.resetTargetStateLocked()
		m.originEpoch = ""
		m.status.Running = false
		m.status.Failures = 0
		m.status.LastError = ""
		m.status.Target = redact(base)
		m.failStreak = 0
	}
	target := relayTarget{base: base, token: token, generation: m.generation}
	m.mu.Unlock()

	cancelAll(cancels)
	if changed {
		m.joinCommits()
	}
	return target
}

func (m *Manager) resetTargetStateLocked() {
	m.sent = make(map[string]bool)
	m.pageSent = false
	m.assetsRev = ""
}

// invalidateLocked advances the state generation and collects all active
// operations. The caller releases m.mu before invoking the returned cancels;
// each operation removes itself after it has actually retired.
func (m *Manager) invalidateLocked() []context.CancelFunc {
	m.generation++
	close(m.wake)
	m.wake = make(chan struct{})
	cancels := make([]context.CancelFunc, 0, len(m.active))
	for _, cancel := range m.active {
		cancels = append(cancels, cancel)
	}
	return cancels
}

// joinCommits is the writer side of the plane callback gate. Generation is
// advanced and HTTP work is canceled before this join, and no manager state
// lock is held while waiting, so callbacks may safely read manager state.
func (m *Manager) joinCommits() {
	m.commit.Lock()
	m.commit.Unlock()
}

// commitGeneration is the reader side of the plane callback gate. The final
// generation check and callback invocation are one lifecycle commit: an
// invalidation either happens first and suppresses the callback, or waits for
// the already-committed callback to finish before returning.
func (m *Manager) commitGeneration(generation uint64, callback func()) bool {
	m.commit.RLock()
	defer m.commit.RUnlock()
	m.mu.RLock()
	current := m.generation == generation
	m.mu.RUnlock()
	if !current {
		return false
	}
	callback()
	return true
}

func cancelAll(cancels []context.CancelFunc) {
	for _, cancel := range cancels {
		cancel()
	}
}

// beginOperation registers one enabled-state operation. The expected
// generation closes the gap between resolving a target and starting work: if
// another loop observed a newer target in between, this operation never starts.
func (m *Manager) beginOperation(parent context.Context, expected uint64) (context.Context, func(), uint64, bool) {
	m.mu.Lock()
	if !m.enabled || m.generation != expected {
		m.mu.Unlock()
		return nil, nil, 0, false
	}
	ctx, cancel := context.WithCancel(parent)
	m.nextActive++
	id := m.nextActive
	m.active[id] = cancel
	generation := m.generation
	m.mu.Unlock()

	finish := func() {
		cancel()
		m.mu.Lock()
		delete(m.active, id)
		m.mu.Unlock()
	}
	return ctx, finish, generation, true
}

func (m *Manager) generationIsCurrent(generation uint64, requireEnabled bool) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.generation == generation && (!requireEnabled || m.enabled)
}

// Run pushes until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		enabled, observedGeneration := m.lifecycleState()
		if !enabled {
			if !m.waitForChange(ctx, time.Second, observedGeneration) {
				return
			}
			continue
		}

		target := m.resolveTarget()
		cycleCtx, finish, generation, ok := m.beginOperation(ctx, target.generation)
		if !ok {
			continue
		}
		err := m.cycleTo(cycleCtx, target)
		if ctx.Err() != nil {
			finish()
			return
		}
		failures, recorded := m.noteCycleAt(generation, err)
		finish()
		if !recorded {
			continue
		}

		delay := pollInterval
		if err != nil {
			delay = retryDelay
			// Log the first failure and then rarely: a venue uplink that is down
			// for a minute must not write hundreds of identical lines.
			if failures == 1 || failures%30 == 0 {
				m.cfg.Logf("contribute: push failing (%d in a row): %v", failures, err)
			}
		}
		if !m.waitForChange(ctx, delay, generation) {
			return
		}
	}
}

// noteCycle records one cycle's outcome and returns the consecutive-failure
// count. On a failure the cached variant is dropped (the local conversation is
// suspect), and failResetAfter consecutive failures trigger a full session
// reset.
func (m *Manager) noteCycle(err error) int {
	failures, _ := m.recordCycle(0, false, err)
	return failures
}

// noteCycleAt records a result only while the enabled target generation that
// produced it is still current. Cancellation is cooperative, so this guard is
// what prevents a response already in hand from reviving disabled status or
// repopulating a replacement room's state.
func (m *Manager) noteCycleAt(generation uint64, err error) (int, bool) {
	return m.recordCycle(generation, true, err)
}

func (m *Manager) recordCycle(generation uint64, guarded bool, err error) (int, bool) {
	m.mu.Lock()
	if guarded && (m.generation != generation || !m.enabled) {
		m.mu.Unlock()
		return 0, false
	}
	if err != nil {
		m.status.Running = false
		m.status.Failures++
		m.status.LastError = err.Error()
		m.failStreak++
		// Whatever was cached about the local conversation is now suspect:
		// re-learn the media playlist name from the master next cycle.
		m.variant = ""
	} else {
		m.status.Running = true
		m.status.Failures = 0
		m.status.LastError = ""
		m.failStreak = 0
		m.status.Target = redact(m.targetBase)
	}
	failures := m.status.Failures
	needsReset := m.failStreak >= failResetAfter
	if needsReset {
		m.resetSessionLocked()
	}
	m.mu.Unlock()

	if needsReset {
		m.cfg.Logf("contribute: resetting session after %d consecutive failures: %v", failResetAfter, err)
	}
	return failures, true
}

// localClient returns the current MediaMTX client. It is swapped by a session
// reset, so all local stream reads go through this accessor. The
// separate origin client always performs normal TLS certificate verification.
func (m *Manager) localClient() *http.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sourceClient
}

func (m *Manager) resetSessionLocked() {
	jar, _ := cookiejar.New(nil)
	m.sourceClient = &http.Client{
		Jar:           jar,
		Timeout:       m.sourceClient.Timeout,
		Transport:     m.sourceClient.Transport,
		CheckRedirect: m.sourceClient.CheckRedirect,
	}
	m.variant = ""
	m.resetTargetStateLocked()
	m.failStreak = 0
}

func (m *Manager) waitForChange(ctx context.Context, d time.Duration, generation uint64) bool {
	m.mu.RLock()
	if m.generation != generation {
		m.mu.RUnlock()
		return true
	}
	wake := m.wake
	m.mu.RUnlock()

	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-timer.C:
		return true
	}
}

// cycle reads the local playlist, uploads anything new it references, then
// uploads the playlist itself.
//
// The order is load-bearing: media BEFORE the playlist that names it. A guest
// that fetched a playlist referencing a part the origin did not have yet would
// get a 404 mid-stream, which native players treat as fatal rather than as
// something to retry.
func (m *Manager) cycle(ctx context.Context) error {
	return m.cycleTo(ctx, m.resolveTarget())
}

func (m *Manager) cycleTo(ctx context.Context, target relayTarget) error {
	if target.base == "" {
		return errNoOrigin
	}
	if !m.generationIsCurrent(target.generation, false) {
		return errStaleCycle
	}

	// Step one: the multivariant playlist. This names the media playlist and, on
	// the same request, establishes the session the media playlist requires.
	//
	// Fetched once and cached, not per cycle: every master fetch mints a fresh
	// MediaMTX session, and at a 50ms cycle that was hundreds of sessions a
	// minute - log-ring flooding, wasted muxer state, and zero benefit, because
	// the variant name never changes while the muxer runs. A failed cycle
	// clears the cache, so recovery re-establishes the session the same way a
	// player would.
	m.mu.RLock()
	variant := m.variant
	m.mu.RUnlock()
	if variant == "" {
		master, err := m.fetch(ctx, m.cfg.SourceURL, maxPlaylistBytes)
		if err != nil {
			return fmt.Errorf("read local multivariant playlist: %w", err)
		}
		found, ok := firstVariant(master)
		if !ok {
			return errors.New("local multivariant playlist names no stream yet")
		}
		variant = found
		m.mu.Lock()
		if m.generation != target.generation {
			m.mu.Unlock()
			return errStaleCycle
		}
		m.variant = variant
		m.mu.Unlock()
	}

	// Step two: the media playlist, then the schedule. Relayed guests must run on
	// the same declared hold-back as direct guests, and the muxer advertises its
	// own raw value, so the room's schedule is authored here exactly as the direct
	// path authors it. Skipping this is not a rounding difference: it puts relayed
	// listeners at a different point in the stream from everyone else, which is
	// the one thing the schedule exists to prevent.
	playlist, err := m.fetch(ctx, m.resolveSource(variant), maxPlaylistBytes)
	if err != nil {
		return fmt.Errorf("read local media playlist: %w", err)
	}
	playlist = schedule.RewritePlaylist(playlist)

	names := mediaNames(playlist)
	if len(names) == 0 {
		return errors.New("local playlist references no media yet")
	}

	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return err
		}
		m.mu.RLock()
		if m.generation != target.generation {
			m.mu.RUnlock()
			return errStaleCycle
		}
		already := m.sent[name]
		m.mu.RUnlock()
		if already {
			continue
		}
		body, err := m.fetch(ctx, m.resolveSource(name), maxMediaBytes)
		if err != nil {
			if ctx.Err() != nil || !m.generationIsCurrent(target.generation, false) {
				return err
			}
			// A part can vanish between being listed and being fetched at the tail
			// of a live window. That is normal; skip it rather than failing the
			// whole cycle and stalling every other part behind it.
			continue
		}
		if err := m.putTo(ctx, target, name, body, "video/mp4", false); err != nil {
			return fmt.Errorf("upload %s: %w", name, err)
		}
		m.mu.Lock()
		if m.generation != target.generation {
			m.mu.Unlock()
			return errStaleCycle
		}
		m.sent[name] = true
		m.status.Pushed++
		m.mu.Unlock()
	}

	// The page. A guest who cannot reach this Mac cannot fetch a page from it
	// either, so without this the origin serves audio nobody has a player for.
	// Pushed once per origin EPOCH, not once per session: when the origin
	// restarts it drops everything, and while rolling segment names re-upload on
	// their own, the two fixed names (this page and the init segment) would
	// never be sent again and every guest would sit on a dead page for the rest
	// of the night. The epoch check on each PUT clears the sent state the moment
	// a response reveals a new incarnation.
	pagePushed, current := m.pagePushedAt(target.generation)
	if !current {
		return errStaleCycle
	}
	if !pagePushed && m.cfg.Page != nil {
		if page := m.cfg.Page(); len(page) > 0 {
			if err := m.putTo(ctx, target, PublishedPage, page, "text/html; charset=utf-8", false); err != nil {
				return fmt.Errorf("upload page: %w", err)
			}
			if !m.markPagePushedAt(target.generation) {
				return errStaleCycle
			}
		}
	}

	// The page's static dependencies: avatar, cover, fonts. Same reasoning as
	// the page itself - a relayed guest resolves "/dj-avatar" against the
	// origin, so without this the page renders with a broken DJ photo and a
	// blank event header. Pushed pinned (they must outlive the rolling live
	// window) and only when the revision changes, so an avatar swapped mid-set
	// reaches relayed guests within a cycle.
	if m.cfg.Assets != nil && m.cfg.AssetsRev != nil {
		rev := m.cfg.AssetsRev()
		m.mu.RLock()
		if m.generation != target.generation {
			m.mu.RUnlock()
			return errStaleCycle
		}
		have := m.assetsRev
		m.mu.RUnlock()
		if rev != have {
			for _, a := range m.cfg.Assets() {
				if a.Name == "" || len(a.Body) == 0 {
					continue
				}
				if err := m.putTo(ctx, target, a.Name, a.Body, a.ContentType, true); err != nil {
					return fmt.Errorf("upload asset %s: %w", a.Name, err)
				}
			}
			m.mu.Lock()
			if m.generation != target.generation {
				m.mu.Unlock()
				return errStaleCycle
			}
			m.assetsRev = rev
			m.mu.Unlock()
		}
	}

	// Forward the playlist otherwise untouched. This is what carries
	// PROGRAM-DATE-TIME, and therefore the room's schedule, to relayed guests.
	if err := m.putTo(ctx, target, PublishedPlaylist, playlist, "application/vnd.apple.mpegurl", false); err != nil {
		return fmt.Errorf("upload playlist: %w", err)
	}

	if !m.pruneSentAt(target.generation, names) {
		return errStaleCycle
	}
	return nil
}

// pruneSent drops tracking for media the playlist no longer references.
func (m *Manager) pruneSent(names []string) {
	live := make(map[string]bool, len(names))
	for _, n := range names {
		live[n] = true
	}
	m.mu.Lock()
	m.pruneSentLocked(live)
	m.mu.Unlock()
}

func (m *Manager) pruneSentAt(generation uint64, names []string) bool {
	live := make(map[string]bool, len(names))
	for _, n := range names {
		live[n] = true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.generation != generation {
		return false
	}
	m.pruneSentLocked(live)
	return true
}

func (m *Manager) pruneSentLocked(live map[string]bool) {
	for name := range m.sent {
		if !live[name] {
			delete(m.sent, name)
		}
	}
}

func (m *Manager) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if err := validateLoopbackSourceURL(req.URL); err != nil {
		return nil, err
	}
	resp, err := m.localClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func validateLoopbackSourceURL(target *url.URL) error {
	if target == nil || (target.Scheme != "http" && target.Scheme != "https") {
		return errors.New("local MediaMTX source must use HTTP or HTTPS on loopback")
	}
	host := target.Hostname()
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("local MediaMTX source host %q is not loopback", host)
	}
	return nil
}

func (m *Manager) upload(ctx context.Context, name string, body []byte, contentType string) error {
	return m.putTo(ctx, m.resolveTarget(), name, body, contentType, false)
}

func (m *Manager) putTo(ctx context.Context, target relayTarget, name string, body []byte, contentType string, pin bool) error {
	if target.base == "" {
		return errors.New("no relay origin yet")
	}
	if !m.generationIsCurrent(target.generation, false) {
		return errStaleCycle
	}
	requestURL, err := joinURL(target.base, name)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, requestURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	if pin {
		req.Header.Set("X-PP-Pin", "1")
	}
	if target.token != "" {
		req.Header.Set("Authorization", "Bearer "+target.token)
	}
	resp, err := m.originClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if !m.observeEpochAt(target.generation, resp.Header.Get("X-PP-Room-Epoch")) {
		return errStaleCycle
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

func (m *Manager) resolveSource(name string) string {
	if resolved, err := joinURL(baseOf(m.cfg.SourceURL), name); err == nil {
		return resolved
	}
	return name
}

// firstVariant returns the first stream URI a multivariant playlist names.
//
// A multivariant playlist is a run of #EXT-X-STREAM-INF tags each followed by a
// bare URI line. There is only ever one audio rendition here, so the first URI
// is the stream. A body that is already a media playlist has no STREAM-INF and
// yields nothing, which is treated as "not ready" rather than misread as media.
func firstVariant(master []byte) (string, bool) {
	wantURI := false
	for _, line := range strings.Split(string(master), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			wantURI = true
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		if wantURI {
			return line, true
		}
	}
	return "", false
}

// mediaNames returns every media URI the playlist references, in order.
//
// It parses generically rather than assuming the muxer's file naming: any
// non-comment line is a URI, and EXT-X-MAP, EXT-X-PART, and EXT-X-PRELOAD-HINT
// carry theirs in a URI attribute. That keeps this correct if MediaMTX's naming
// changes.
func mediaNames(playlist []byte) []string {
	var names []string
	seen := make(map[string]bool)
	add := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" || strings.Contains(raw, "://") || seen[raw] {
			return
		}
		seen[raw] = true
		names = append(names, raw)
	}
	for _, line := range strings.Split(string(playlist), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			add(line) // a full segment
			continue
		}
		// EXT-X-MAP is the initialization segment. Missing it is not a degraded
		// stream, it is an undecodable one, so it must be forwarded like any
		// other media file.
		if strings.HasPrefix(line, "#EXT-X-MAP:") ||
			strings.HasPrefix(line, "#EXT-X-PART:") ||
			strings.HasPrefix(line, "#EXT-X-PRELOAD-HINT:") {
			if uri, ok := attrValue(line, "URI"); ok {
				add(uri)
			}
		}
	}
	return names
}

// attrValue pulls a quoted attribute out of an EXT tag.
func attrValue(line, want string) (string, bool) {
	colon := strings.Index(line, ":")
	if colon < 0 {
		return "", false
	}
	for _, attr := range splitAttrs(line[colon+1:]) {
		name, value, ok := strings.Cut(attr, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), want) {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"`), true
	}
	return "", false
}

// splitAttrs splits on commas outside quotes, because a URI can contain a comma.
func splitAttrs(s string) []string {
	var out []string
	var cur strings.Builder
	inQuotes := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuotes = !inQuotes
			cur.WriteRune(r)
		case r == ',' && !inQuotes:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func baseOf(rawURL string) string {
	if i := strings.LastIndex(rawURL, "/"); i >= 0 {
		return rawURL[:i+1]
	}
	return rawURL
}

// joinURL appends one path element to a base, refusing anything that would
// escape it. A media name comes out of a playlist, so it is data, and data must
// never be able to aim an upload somewhere else.
func joinURL(base, name string) (string, error) {
	if strings.Contains(name, "://") || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("unsafe media name %q", name)
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	rel, err := url.Parse(name)
	if err != nil {
		return "", err
	}
	if rel.IsAbs() || rel.Host != "" {
		return "", fmt.Errorf("unsafe media name %q", name)
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed.ResolveReference(rel).String(), nil
}

// redact strips any userinfo from a URL before it reaches a log or the console.
func redact(raw string) string {
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return raw
	}
	scheme := ""
	if i := strings.Index(raw, "://"); i >= 0 {
		scheme = raw[:i+3]
	}
	return scheme + "***@" + raw[at+1:]
}

func (m *Manager) pagePushedAt(generation uint64) (bool, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.generation != generation {
		return false, false
	}
	return m.pageSent, true
}

func (m *Manager) markPagePushedAt(generation uint64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.generation != generation {
		return false
	}
	m.pageSent = true
	return true
}

// observeEpoch notices the origin restarting. Every PUT response carries the
// room's epoch; a change means the store behind those successful-looking
// uploads was emptied, so everything this side believes it already sent,
// including the fixed-name page and init segment, must be sent again.
func (m *Manager) observeEpochAt(generation uint64, header string) bool {
	header = strings.TrimSpace(header)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.generation != generation {
		return false
	}
	if header == "" {
		return true // an origin too old to say; assume continuity rather than churn
	}
	if m.originEpoch == header {
		return true
	}
	first := m.originEpoch == ""
	m.originEpoch = header
	if first {
		return true // first sight of this origin, nothing was lost
	}
	m.resetTargetStateLocked()
	m.cfg.Logf("contribute: origin restarted (epoch %s); re-sending fixed-name assets", header)
	return true
}
