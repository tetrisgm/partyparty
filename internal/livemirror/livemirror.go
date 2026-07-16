// Package livemirror ships the live set to the cloud for remote (off-LAN)
// guests. The broadcaster tees a third, isolated plain-HLS leg (stream-copy of
// the already-encoded AAC — see internal/broadcast) into a scratch dir; this
// package watches that dir and, for each go-live session, PUTs new segments and
// the rewritten media playlist to the party.ramine.net broker, which fans them
// out from R2 (zero egress) to a plain <audio> element.
//
// Two invariants make the mirror safe for a live guest to fetch mid-set:
//
//  1. A segment is uploaded BEFORE any playlist that names it, and the playlist
//     is only uploaded once every segment it references is already up — so a
//     remote guest never sees a playlist pointing at a segment the cloud lacks.
//  2. Everything is best-effort and logged, never fatal: a failing upload just
//     skips this tick and retries on the next. The LAN/RTSP leg is a separate,
//     onfail=ignore-isolated tee output and is never touched by this package.
//
// Objects are keyed by the event slug + a per-go-live session id so a fresh set
// never collides with a previous one in R2.
package livemirror

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Broker endpoints (contract). The Worker side implements these later, so a call
// may 404 until then — that is handled like any other upload failure (logged,
// non-fatal, retried next tick).
const (
	segmentPath  = "/api/broker/live-segment"
	playlistPath = "/api/broker/live-playlist"
	playlistName = "live.m3u8"
)

// Creds authenticate uploads to the broker — this install's identity, exactly
// the id/secret pair internal/publish and internal/activate already use.
type Creds struct {
	ID     string
	Secret string
}

// Config wires a Mirror to its broker, scratch dir, and event identity.
type Config struct {
	Base       string        // broker URL, e.g. https://party.ramine.net
	Creds      Creds         // this install's broker identity
	ScratchDir string        // where the broadcaster's HLS tee writes live.m3u8 + segments
	SlugFn     func() string // resolves the current event slug lazily (per session)
	Logf       func(format string, args ...any)
	HTTPClient *http.Client // nil -> a sane default
	// PollInterval overrides how often the scratch dir is polled for new
	// segments (default 1s — the tee emits a 3s segment, so 1s catches each
	// promptly). Exposed mainly for tests.
	PollInterval time.Duration
}

// Mirror uploads one broadcaster's live scratch dir to the broker.
type Mirror struct {
	cfg    Config
	client *http.Client
}

// New builds a Mirror from cfg.
func New(cfg Config) *Mirror {
	client := cfg.HTTPClient
	if client == nil {
		// A generous per-request timeout: a 3s segment is small, but a slow
		// uplink must not wedge the loop forever.
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &Mirror{cfg: cfg, client: client}
}

func (m *Mirror) logf(format string, args ...any) {
	if m.cfg.Logf != nil {
		m.cfg.Logf(format, args...)
	}
}

// Run mirrors the scratch dir for one go-live session until ctx is cancelled
// (the broadcast ended). It is best-effort throughout: nothing it does can fail
// the broadcast. On return it clears the scratch dir so the next session starts
// clean. session is a stable per-go-live id (e.g. the go-live timestamp).
func (m *Mirror) Run(ctx context.Context, session string) {
	if m.cfg.ScratchDir == "" || m.cfg.Base == "" {
		return // nothing configured — mirror off
	}
	interval := m.cfg.PollInterval
	if interval <= 0 {
		interval = time.Second
	}
	m.logf("livemirror: session %s started (scratch %s)", session, m.cfg.ScratchDir)

	// uploaded remembers segment basenames already shipped this session so we
	// never re-PUT a segment (or forget one when computing whether the playlist
	// is safe to push). Bounded by the set length — trivial even for a 4h set.
	uploaded := map[string]bool{}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.cleanup()
			m.logf("livemirror: session %s ended (%d segments)", session, len(uploaded))
			return
		case <-ticker.C:
			m.syncOnce(ctx, session, uploaded)
		}
	}
}

// syncOnce reads the current playlist and, if there is new work, uploads any
// new segments (in playlist order) and then the playlist. It upholds the two
// invariants: segments before the playlist, and the playlist only after every
// referenced segment is up.
func (m *Mirror) syncOnce(ctx context.Context, session string, uploaded map[string]bool) {
	playlistFile := filepath.Join(m.cfg.ScratchDir, playlistName)
	data, err := os.ReadFile(playlistFile)
	if err != nil {
		return // the tee hasn't written a playlist yet (or it was cleaned) — nothing to do
	}
	segs, err := parsePlaylist(data)
	if err != nil {
		m.logf("livemirror: skipping malformed playlist: %v", err)
		return
	}
	if len(segs) == 0 {
		return
	}
	slug := ""
	if m.cfg.SlugFn != nil {
		slug = m.cfg.SlugFn()
	}
	if slug == "" {
		m.logf("livemirror: no event slug yet — deferring upload")
		return
	}

	// 1. Upload every referenced-but-unshipped segment FIRST, in playlist order.
	//    If one fails, stop here and DON'T touch the playlist — the cloud keeps
	//    serving its previous, self-consistent window until the next tick retries.
	for _, name := range segs {
		if uploaded[name] {
			continue
		}
		body, rerr := os.ReadFile(filepath.Join(m.cfg.ScratchDir, name))
		if rerr != nil {
			// Referenced by the playlist but not readable yet (a delete_segments
			// prune race, or mid-rotation). Leave it unshipped; without it the
			// playlist won't be uploaded this tick, preserving invariant (1).
			return
		}
		if perr := m.put(ctx, segmentPath, slug, session, name, "audio/mp2t", body); perr != nil {
			m.logf("livemirror: segment %s upload failed (retrying next tick): %v", name, perr)
			return
		}
		uploaded[name] = true
	}

	// 2. Every referenced segment is now up — safe to publish the playlist. It is
	//    uploaded verbatim (relative segment names resolve under the same cloud
	//    prefix); no-store on the serve side keeps remote guests at the live edge.
	for _, name := range segs {
		if !uploaded[name] {
			return // defensive: a segment slipped out — wait for the next tick
		}
	}
	if perr := m.put(ctx, playlistPath, slug, session, playlistName, "application/vnd.apple.mpegurl", data); perr != nil {
		m.logf("livemirror: playlist upload failed (retrying next tick): %v", perr)
	}
}

// put PUTs body to the broker with the same header-auth pattern publish.go uses,
// plus the session id and the target filename. A non-200 is an error the caller
// treats as a retryable, non-fatal miss.
func (m *Mirror) put(ctx context.Context, endpoint, slug, session, file, ctype string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimRight(m.cfg.Base, "/")+endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(body))
	req.Header.Set("content-type", ctype)
	req.Header.Set("x-pp-id", m.cfg.Creds.ID)
	req.Header.Set("x-pp-secret", m.cfg.Creds.Secret)
	req.Header.Set("x-pp-slug", slug)
	req.Header.Set("x-pp-session", session)
	req.Header.Set("x-pp-file", file)
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("broker: " + resp.Status)
	}
	return nil
}

// cleanup removes the scratch playlist + segments at session end so a stale
// window can never be re-read at the start of the next go-live. Best-effort.
func (m *Mirror) cleanup() {
	entries, err := os.ReadDir(m.cfg.ScratchDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if n == playlistName || strings.HasSuffix(n, ".ts") {
			_ = os.Remove(filepath.Join(m.cfg.ScratchDir, n))
		}
	}
}

// parsePlaylist extracts the ordered segment basenames referenced by an HLS
// media playlist. URIs are reduced to their basename (the tee writes relative
// names already, but this is defensive against an absolute/nested URI). It
// returns an error only when the data isn't an HLS playlist at all.
func parsePlaylist(data []byte) ([]string, error) {
	text := string(data)
	if !strings.HasPrefix(strings.TrimSpace(text), "#EXTM3U") {
		return nil, errors.New("not an HLS playlist (missing #EXTM3U)")
	}
	var segs []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue // tags and blanks — only URI lines name segments
		}
		segs = append(segs, path.Base(line))
	}
	return segs, nil
}

// mediaSequence reads #EXT-X-MEDIA-SEQUENCE from a playlist (0 if absent). Kept
// for the uploader's window bookkeeping and covered by tests.
func mediaSequence(data []byte) int {
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if v, ok := strings.CutPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				return n
			}
		}
	}
	return 0
}
