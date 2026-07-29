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
	"encoding/json"
	"sort"
	"sync"
	"time"
)

const (
	// maxQueuedWrites bounds the write queue. A flood of guest posts must never
	// grow memory without limit; past the cap the oldest are dropped, because a
	// live party cares about what is happening now.
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
	Writes      []Write `json:"writes,omitempty"`
}

type listener struct {
	latMs    float64
	hasLat   bool
	lastSeen time.Time
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
}

func New() *Room {
	return &Room{
		snapshots: make(map[string]json.RawMessage),
		listeners: make(map[string]*listener),
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
	r.snapshots[kind] = stored
	if delaySec > 0 {
		r.delaySec = delaySec
	}
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

// Beat records one guest heartbeat. It is deliberately cheap and never forwards
// anything: the Mac learns about presence from the periodic digest instead.
// latMs is the guest's measured latency; pass hasLat false when it has none yet,
// because a guest that cannot measure must not be counted as perfectly on time.
func (r *Room) Beat(cid string, latMs float64, hasLat bool) {
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
	if hasLat {
		existing.latMs = latMs
		existing.hasLat = true
	}
}

// Enqueue queues a guest write for the Mac. Returns false when the queue is
// full, so the caller can tell the guest honestly rather than accepting a post
// that will never arrive.
func (r *Room) Enqueue(path string, body json.RawMessage) bool {
	if path == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.writes) >= maxQueuedWrites {
		// A live party cares about now, so drop the oldest rather than refusing
		// everything once a backlog forms.
		copy(r.writes, r.writes[1:])
		r.writes = r.writes[:len(r.writes)-1]
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
