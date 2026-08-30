// Package roomplane is the origin-side room state for relayed parties.
//
// Media and room data scale very differently, so they are carried differently.
// Audio is pushed once by the Mac and fanned out by the origin. The room API
// (status, feed, presence, posts) is interactive, and the naive version of it
// does not scale: 500 guests polling status every 3 seconds and beating every 2
// is roughly 575 requests per second, and proxying each one back to a laptop is
// the same placement mistake that capped the old relay at a few dozen listeners.
//
// So the origin is a read replica and an aggregator, and the Mac stays the
// writer:
//
//	READS   are served from memory here. The Mac publishes a snapshot when
//	        something changes; a guest read never touches the Mac, so read cost
//	        is O(1) in listener count rather than O(N).
//	BEATS   are aggregated. 500 guests beating produces one periodic digest for
//	        the Mac (count, spread, worst deviation) instead of 500 requests.
//	        This is the single change that makes 500 listeners cost the Mac the
//	        same as 5.
//	WRITES  (posts, reactions) are queued here and drained by the Mac over its
//	        existing connection. They are proportional to what guests actually
//	        do, which is rare, rather than to how many are listening.
//
// Nothing here is durable. State lives in memory, is bounded, and is dropped
// when the Mac disconnects or the party ends. The product has no cloud party
// storage, no replays, and no retained history, and this package must never
// become the place that quietly acquires one.
package roomplane

import (
	"bytes"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

const (
	// maxQueuedWrites bounds the write queue. A flood of guest posts must never
	// grow memory without limit; past the cap new writes are refused so callers
	// can report that they were not accepted.
	maxQueuedWrites = 512

	// maxTrackedListeners bounds presence tracking. Well above any real room, and
	// a hard stop against a client that rotates its id to grow the map forever.
	maxTrackedListeners = 2048

	// listenerTTL is how long a listener counts as present after its last beat.
	listenerTTL = 12 * time.Second

	// maxSnapshotBytes bounds one published snapshot.
	maxSnapshotBytes = 256 << 10
)

// Write is one guest action queued for the Mac.
type Write struct {
	Path string          `json:"path"`
	Body json.RawMessage `json:"body,omitempty"`
	At   int64           `json:"at"`
}

// Digest is the periodic summary the origin sends the Mac in place of every
// individual heartbeat. This is telemetry: it reports how the room is doing and
// is never an input to the room's declared delay, because a room-wide value that
// tracks listeners lets one slow phone lengthen everyone's delay.
type Digest struct {
	Listeners   int     `json:"listeners"`
	SpreadMs    float64 `json:"spreadMs"`
	MedianMs    float64 `json:"medianMs"`
	DeviationMs float64 `json:"deviationMs"`
	Roster      []Guest `json:"roster,omitempty"`
	Writes      []Write `json:"writes,omitempty"`
}

// Guest is the live identity and channel assignment carried by a heartbeat.
// It is kept only in this in-memory room and disappears with the room.
type Guest struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Emoji  string `json:"emoji,omitempty"`
	DJID   string `json:"djId,omitempty"`
	Paused bool   `json:"paused,omitempty"`
}

type listener struct {
	latMs    float64
	hasLat   bool
	lastSeen time.Time
	guest    Guest
}

// Room is one relayed party's origin-side state.
type Room struct {
	// delaySec is the room's declared schedule, published by the Mac. The origin
	// only reports deviation against it; it never adjusts it.
	delaySec float64

	mu        sync.RWMutex
	snapshots map[string]json.RawMessage
	listeners map[string]*listener
	writes    []Write
	now       func() time.Time

	// versions assigns each kind a number that changes exactly when its bytes
	// change. It is what lets a guest ask "has this changed since I looked"
	// and lets the origin PARK that question instead of answering "here is the
	// same thing again" seven times a second. Version numbers come from one
	// room-global counter that survives Reset, so a version can never be reused
	// for different bytes within a room's lifetime.
	verCounter uint64
	versions   map[string]uint64
	// wake is closed and replaced whenever any snapshot's content changes.
	// Parked readers re-check their kind's version and re-park if it was a
	// different kind that changed.
	wake chan struct{}
}

func New() *Room {
	return &Room{
		snapshots: make(map[string]json.RawMessage),
		listeners: make(map[string]*listener),
		versions:  make(map[string]uint64),
		wake:      make(chan struct{}),
		now:       time.Now,
	}
}

// Publish records a snapshot the Mac pushed. Guests read this without the Mac
// being involved at all, which is what keeps read cost flat as a room grows.
func (r *Room) Publish(kind string, body json.RawMessage, delaySec float64) bool {
	if kind == "" || len(body) == 0 || len(body) > maxSnapshotBytes || !json.Valid(body) {
		return false
	}
	stored := make(json.RawMessage, len(body))
	copy(stored, body)
	r.mu.Lock()
	if delaySec > 0 {
		r.delaySec = delaySec
	}
	if bytes.Equal(r.snapshots[kind], stored) {
		// Same bytes: no version bump and nobody parked on this is woken. The
		// Mac republishes snapshots on a timer whether or not anything changed,
		// and treating each republish as news would turn every parked guest
		// read into a once-per-second poll.
		r.mu.Unlock()
		return true
	}
	r.snapshots[kind] = stored
	r.verCounter++
	r.versions[kind] = r.verCounter
	close(r.wake)
	r.wake = make(chan struct{})
	r.mu.Unlock()
	return true
}

// Read serves a guest read from memory. ok is false when the Mac has not
// published this kind yet, which the caller must surface as "not ready" rather
// than as an empty room.
func (r *Room) Read(kind string) (json.RawMessage, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	body, ok := r.snapshots[kind]
	return body, ok
}

// ReadVersioned is Read plus the kind's content version, for callers that will
// come back and ask "changed yet?".
func (r *Room) ReadVersioned(kind string) (json.RawMessage, uint64, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	body, ok := r.snapshots[kind]
	return body, r.versions[kind], ok
}

// WaitFor parks until kind's content differs from the version the caller
// already has, or the deadline passes, and returns the current state either
// way. This is what turns a guest's "poll until something happens" into one
// held request, the same shape the Mac's own long-poll gives direct guests.
func (r *Room) WaitFor(kind string, since uint64, deadline time.Time) (json.RawMessage, uint64, bool) {
	for {
		r.mu.RLock()
		body, ok := r.snapshots[kind]
		version := r.versions[kind]
		wake := r.wake
		r.mu.RUnlock()
		if !ok || version != since {
			return body, version, ok
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return body, version, ok
		}
		timer := time.NewTimer(remaining)
		select {
		case <-wake:
			timer.Stop()
		case <-timer.C:
			return body, version, ok
		}
	}
}

// Beat records one guest heartbeat. It is deliberately cheap and never forwards
// anything: the Mac learns about presence from the periodic digest instead.
// latMs is the guest's measured latency; pass hasLat false when it has none yet,
// because a guest that cannot measure must not be counted as perfectly on time.
func (r *Room) Beat(guest Guest, latMs float64, hasLat bool) {
	cid := guest.ID
	if cid == "" {
		return
	}
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	existing, known := r.listeners[cid]
	if !known {
		if len(r.listeners) >= maxTrackedListeners {
			r.evictExpiredLocked(now)
			if len(r.listeners) >= maxTrackedListeners {
				return // hard stop: a rotating id cannot grow this without bound
			}
		}
		existing = &listener{}
		r.listeners[cid] = existing
	}
	existing.lastSeen = now
	existing.guest = guest
	if hasLat {
		existing.latMs = latMs
		existing.hasLat = true
	}
}

// Enqueue queues a guest write for the Mac. It returns false without changing
// the queue when path is empty or the queue is full, so the caller can tell the
// guest honestly rather than accepting a post that will never arrive.
func (r *Room) Enqueue(path string, body json.RawMessage) bool {
	if path == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.writes) >= maxQueuedWrites {
		return false
	}
	stored := make(json.RawMessage, len(body))
	copy(stored, body)
	r.writes = append(r.writes, Write{Path: path, Body: stored, At: r.now().UnixMilli()})
	return true
}

// Drain returns the periodic digest for the Mac and clears the write queue. One
// call per interval replaces every individual heartbeat and write request, so
// the Mac's inbound rate is set by the digest interval rather than by how many
// people are at the party.
func (r *Room) Drain() Digest {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictExpiredLocked(now)

	latencies := make([]float64, 0, len(r.listeners))
	for _, l := range r.listeners {
		if l.hasLat {
			latencies = append(latencies, l.latMs)
		}
	}
	digest := Digest{Listeners: len(r.listeners)}
	digest.Roster = make([]Guest, 0, len(r.listeners))
	for _, l := range r.listeners {
		digest.Roster = append(digest.Roster, l.guest)
	}
	sort.Slice(digest.Roster, func(i, j int) bool {
		return digest.Roster[i].ID < digest.Roster[j].ID
	})
	if len(latencies) > 0 {
		sort.Float64s(latencies)
		digest.SpreadMs = latencies[len(latencies)-1] - latencies[0]
		digest.MedianMs = median(latencies)
		if deviation := latencies[len(latencies)-1] - r.delaySec*1000; deviation > 0 {
			digest.DeviationMs = deviation
		}
	}
	if len(r.writes) > 0 {
		digest.Writes = r.writes
		r.writes = nil
	}
	return digest
}

// Reset drops all room state. Called when the Mac disconnects or the party ends,
// so nothing about a party outlives it here.
func (r *Room) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshots = make(map[string]json.RawMessage)
	r.listeners = make(map[string]*listener)
	r.writes = nil
	r.delaySec = 0
	// verCounter deliberately survives, so a post-reset version can never
	// collide with an ETag a guest is still holding. Wake parked readers: their
	// kind is gone and they should answer "not ready" rather than sit out the
	// full deadline on a dead room.
	r.versions = make(map[string]uint64)
	close(r.wake)
	r.wake = make(chan struct{})
}

func (r *Room) evictExpiredLocked(now time.Time) {
	for cid, l := range r.listeners {
		if now.Sub(l.lastSeen) > listenerTTL {
			delete(r.listeners, cid)
		}
	}
}

func median(sorted []float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return sorted[n/2]
	}
	return (sorted[n/2-1] + sorted[n/2]) / 2
}
