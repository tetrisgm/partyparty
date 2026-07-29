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
	// Target resolves this install's relay origin and publish credential. They
	// come from the broker at registration rather than from static configuration,
	// so every install gets its own and a Mac can only publish to its own room.
	// Returning an empty origin disables contribution.
	Target func() (originURL, token string)
	Logf   func(format string, args ...any)
}

// target reads the current destination, tolerating an unset resolver.
func (c Config) target() (string, string) {
	if c.Target == nil {
		return "", ""
	}
	origin, token := c.Target()
	if origin == "" {
		return "", ""
	}
	return strings.TrimRight(origin, "/") + "/", token
}

// Manager supervises contribution for as long as it is enabled.
type Manager struct {
	cfg    Config
	client *http.Client

	mu      sync.RWMutex
	status  Status
	enabled bool
	wake    chan struct{}

	// sent tracks media already uploaded so each file is pushed exactly once.
	// Pruned against the live playlist every cycle, so a long set cannot grow it
	// without bound.
	sent map[string]bool
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
		cfg:  cfg,
		wake: make(chan struct{}, 1),
		sent: make(map[string]bool),
		client: &http.Client{
			Jar:     jar,
			Timeout: uploadTimeout,
			Transport: &http.Transport{
				// Local MediaMTX serves the same hot-swapped cert on loopback.
				TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
				MaxIdleConns:        16,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     90 * time.Second,
				DisableCompression:  true, // media is already compressed; playlists are tiny
			},
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
	if !on {
		m.status.Running = false
		m.sent = make(map[string]bool) // a fresh session re-pushes what the origin needs
	}
	m.mu.Unlock()
	m.signal()
}

// Snapshot returns a consistent copy for /api/status.
func (m *Manager) Snapshot() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) signal() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) isEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled
}

// Run pushes until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if !m.isEnabled() {
			if !m.wait(ctx, time.Second) {
				return
			}
			continue
		}

		err := m.cycle(ctx)
		if ctx.Err() != nil {
			return
		}

		m.mu.Lock()
		if err != nil {
			m.status.Running = false
			m.status.Failures++
			m.status.LastError = err.Error()
		} else {
			m.status.Running = true
			m.status.Failures = 0
			m.status.LastError = ""
			base, _ := m.cfg.target()
			m.status.Target = redact(base)
		}
		failures := m.status.Failures
		m.mu.Unlock()

		delay := pollInterval
		if err != nil {
			delay = retryDelay
			// Log the first failure and then rarely: a venue uplink that is down
			// for a minute must not write hundreds of identical lines.
			if failures == 1 || failures%30 == 0 {
				m.cfg.Logf("contribute: push failing (%d in a row): %v", failures, err)
			}
		}
		if !m.wait(ctx, delay) {
			return
		}
	}
}

func (m *Manager) wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-m.wake:
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
	// Step one: the multivariant playlist. This names the media playlist and, on
	// the same request, establishes the session the media playlist requires.
	master, err := m.fetch(ctx, m.cfg.SourceURL, maxPlaylistBytes)
	if err != nil {
		return fmt.Errorf("read local multivariant playlist: %w", err)
	}
	variant, ok := firstVariant(master)
	if !ok {
		return errors.New("local multivariant playlist names no stream yet")
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
		m.mu.RLock()
		already := m.sent[name]
		m.mu.RUnlock()
		if already {
			continue
		}
		body, err := m.fetch(ctx, m.resolveSource(name), maxMediaBytes)
		if err != nil {
			// A part can vanish between being listed and being fetched at the tail
			// of a live window. That is normal; skip it rather than failing the
			// whole cycle and stalling every other part behind it.
			continue
		}
		if err := m.upload(ctx, name, body, "video/mp4"); err != nil {
			return fmt.Errorf("upload %s: %w", name, err)
		}
		m.mu.Lock()
		m.sent[name] = true
		m.status.Pushed++
		m.mu.Unlock()
	}

	// Forward the playlist otherwise untouched. This is what carries
	// PROGRAM-DATE-TIME, and therefore the room's schedule, to relayed guests.
	if err := m.upload(ctx, PublishedPlaylist, playlist, "application/vnd.apple.mpegurl"); err != nil {
		return fmt.Errorf("upload playlist: %w", err)
	}

	m.pruneSent(names)
	return nil
}

// pruneSent drops tracking for media the playlist no longer references.
func (m *Manager) pruneSent(names []string) {
	live := make(map[string]bool, len(names))
	for _, n := range names {
		live[n] = true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
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
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func (m *Manager) upload(ctx context.Context, name string, body []byte, contentType string) error {
	base, token := m.cfg.target()
	if base == "" {
		return errors.New("no relay origin yet")
	}
	target, err := joinURL(base, name)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
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
