package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Where publish credentials come from.
//
// The broker mints one publish token per install, at registration, and hands it
// to that Mac. That is what makes the system self-serve: a DJ installs the app
// and can publish, with nothing configured by hand and no way to publish into
// somebody else's room.
//
// The origin therefore cannot know credentials ahead of time, and an origin that
// consults only a static file can accept nothing but rooms someone placed there
// by hand. It refused every real install with a 403 while looking perfectly
// healthy, because the file it was reading is not where credentials live. The
// static file remains supported for local runs and tests; the broker is the
// authority.
//
// The origin ASKS WHETHER A PRESENTED TOKEN IS CORRECT rather than asking what
// the correct token is. The broker therefore never hands a publish credential to
// anything but the Mac that owns it, and this box stores no secret capable of
// publishing to a room. Guessing is not a threat at 192 bits.
//
// Answers are cached briefly, because a publish happens once per part and an
// uncached check would mean several broker requests a second per room.

const (
	// verifyCacheTTL bounds how stale an accepted credential can be. Short enough
	// that a revoked install stops publishing promptly, long enough that a live
	// party costs the broker a handful of requests per minute.
	verifyCacheTTL = 2 * time.Minute

	// verifyNegativeTTL is how long a rejection is remembered. Deliberately short:
	// a Mac that registers a moment after its first publish attempt should start
	// working on its own rather than after a restart.
	verifyNegativeTTL = 10 * time.Second

	verifyTimeout = 6 * time.Second
)

type verdictEntry struct {
	ok      bool
	expires time.Time
}

// brokerTokens answers whether a Mac may publish to a room, asking the broker
// that minted the credential and falling back to a static file for local runs.
type brokerTokens struct {
	brokerURL string
	static    *roomTokens
	client    *http.Client

	mu    sync.Mutex
	cache map[string]verdictEntry
}

func newBrokerTokens(brokerURL string, static *roomTokens) *brokerTokens {
	return &brokerTokens{
		brokerURL: strings.TrimRight(strings.TrimSpace(brokerURL), "/"),
		static:    static,
		client:    &http.Client{Timeout: verifyTimeout},
		cache:     map[string]verdictEntry{},
	}
}

// verify reports whether presented is the publish credential for room.
func (b *brokerTokens) verify(room, presented string) bool {
	room = strings.TrimSpace(room)
	presented = strings.TrimSpace(presented)
	if room == "" || presented == "" {
		return false
	}
	// A hand-placed credential wins, so a local or test origin needs no broker.
	if b.static != nil {
		if want, ok := b.static.lookup(room); ok && want != "" && want == presented {
			return true
		}
	}
	if b.brokerURL == "" {
		return false
	}

	key := cacheKey(room, presented)
	if entry, ok := b.cached(key); ok {
		return entry.ok
	}

	ok, err := b.ask(room, presented)
	if err != nil {
		// Do not cache an unreachable broker: that would turn a blip into minutes
		// of refused publishes for a party that is otherwise fine.
		return false
	}
	ttl := verifyCacheTTL
	if !ok {
		ttl = verifyNegativeTTL
	}
	b.mu.Lock()
	b.cache[key] = verdictEntry{ok: ok, expires: time.Now().Add(ttl)}
	if len(b.cache) > 4096 {
		b.evictExpiredLocked()
	}
	b.mu.Unlock()
	return ok
}

// cacheKey hashes the credential so it is not held in memory in the clear.
func cacheKey(room, presented string) string {
	sum := sha256.Sum256([]byte(room + "\x00" + presented))
	return hex.EncodeToString(sum[:])
}

func (b *brokerTokens) cached(key string) (verdictEntry, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	entry, ok := b.cache[key]
	if !ok || time.Now().After(entry.expires) {
		return verdictEntry{}, false
	}
	return entry, true
}

func (b *brokerTokens) evictExpiredLocked() {
	now := time.Now()
	for key, entry := range b.cache {
		if now.After(entry.expires) {
			delete(b.cache, key)
		}
	}
}

func (b *brokerTokens) ask(room, presented string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), verifyTimeout)
	defer cancel()

	body, _ := json.Marshal(map[string]string{"room": room, "token": presented})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		b.brokerURL+"/api/broker/relay/verify", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusForbidden, http.StatusNotFound:
		return false, nil // a real answer, not a failure
	default:
		return false, errBrokerUnavailable
	}
}

var errBrokerUnavailable = &brokerError{"broker unavailable"}

type brokerError struct{ msg string }

func (e *brokerError) Error() string { return e.msg }
