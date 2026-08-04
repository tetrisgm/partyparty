// Package origin is the relay origin: it accepts a Mac's pushed LL-HLS and
// serves it to guests.
//
// It exists because the old relay put the DJ's laptop in the request path of
// every listener. Here the Mac uploads each part once and the origin fans it out,
// so a 500 person room costs the Mac exactly what a 5 person room costs.
//
// Three properties shape the implementation:
//
//  1. BYTES ARE NEVER REWRITTEN. Whatever the Mac pushed is what a guest gets,
//     including PROGRAM-DATE-TIME. The room's schedule says a chunk stamped T
//     plays at T + D, and if this service regenerated playlists it would stamp
//     its own time and relayed guests would silently disagree with direct ones.
//  2. BLOCKING PLAYLIST RELOADS ARE HONORED. Low-latency HLS clients ask for a
//     playlist that contains a part that does not exist yet, and expect the
//     server to hold the request until it does. Answering immediately with a
//     stale playlist turns a low-latency stream into a polling one.
//  3. NOTHING IS RETAINED. State is in memory, bounded, and dropped when a room
//     goes quiet. The product has no cloud party storage, no replays, and no
//     history, and this service must never quietly become the place that has one.
package origin

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"partyparty/internal/roomplane"
)

const (
	// roomIdleTimeout is how long a room survives with no upload. A party that
	// ends, or a Mac that goes away, must not leave its audio sitting here.
	roomIdleTimeout = 2 * time.Minute

	// maxMediaPerRoom bounds how many media files a room holds. The live window
	// is 48 segments plus their parts, so this is generous while still making
	// unbounded growth impossible over a long set.
	maxMediaPerRoom = 512

	// maxBlockWait bounds a blocking playlist request. Apple's guidance is to
	// answer within about three target durations; holding longer than this ties
	// up a connection for a client that has probably given up.
	maxBlockWait = 5 * time.Second

	// maxUploadBytes bounds one upload.
	maxUploadBytes = 8 << 20
)

type object struct {
	body        []byte
	contentType string
}

// Room is one party's live window on the origin.
type Room struct {
	// epoch is set once at creation and never changes; see Epoch.
	epoch int64

	// pinned names are exempt from live-window eviction; see Pin. sticky names
	// are pinned for the life of the room and survive Pin's set replacement;
	// see PinSticky.
	pinned map[string]bool
	sticky map[string]bool

	mu   sync.Mutex
	cond *sync.Cond

	media map[string]*object
	order []string // insertion order, for eviction

	playlistName string
	playlist     []byte
	photos       []string
	// version increments on every playlist publish, so a blocked reader can tell
	// "something changed" from a spurious wakeup.
	version int64

	lastPublish time.Time
	plane       *roomplane.Room
}

func newRoom(now time.Time) *Room {
	r := &Room{
		media:       make(map[string]*object),
		pinned:      map[string]bool{"index.html": true},
		lastPublish: now,
		plane:       roomplane.New(),
		epoch:       now.UnixNano(),
	}
	r.cond = sync.NewCond(&r.mu)
	return r
}

// Epoch identifies this in-memory incarnation of the room. A new value means
// everything previously uploaded is gone, however recently. The Mac compares it
// across pushes to notice a restart, because from its side a restarted origin is
// indistinguishable from a healthy one: uploads keep succeeding, only the store
// behind them is empty.
func (r *Room) Epoch() int64 { return r.epoch }

// Plane exposes the room API state so the HTTP layer can serve guest reads and
// queue guest writes without the Mac being involved per request.
func (r *Room) Plane() *roomplane.Room { return r.plane }

// PutMedia stores one media file exactly as uploaded.
func (r *Room) PutMedia(name string, body []byte, contentType string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.media[name]; !exists {
		r.order = append(r.order, name)
		// Evict oldest beyond the window, SKIPPING pinned names. Rolling media
		// falling off the back of a live stream is correct: a guest that asks for
		// it must reattach. But the guest page and the init segment are uploaded
		// ONCE, at the start of a set, which makes them the oldest objects in the
		// room by definition. The plain oldest-first eviction deleted exactly
		// those two the moment a set outlived the window, about three minutes in:
		// from then on every new guest got a 404 page and, worse, an undecodable
		// stream, while the room looked perfectly healthy. Found by a phone
		// showing "not in the live window" where the party should have been.
		evictable := len(r.order) - r.pinnedCount()
		for evictable > maxMediaPerRoom {
			oldest := r.order[0]
			r.order = r.order[1:]
			if r.pinned[oldest] {
				r.order = append(r.order, oldest) // rotate pinned names to safety
				continue
			}
			delete(r.media, oldest)
			evictable--
		}
	}
	r.media[name] = &object{body: body, contentType: contentType}
	r.lastPublish = time.Now()
}

// PutPhoto keeps a small bounded set of guest photos outside rolling HLS
// eviction. Photos are secondary to music, so the cap is deliberately small.
func (r *Room) PutPhoto(name string, body []byte, contentType string) {
	r.PutMedia(name, body, contentType)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pinned[name] = true
	r.photos = append(r.photos, name)
	for len(r.photos) > 32 {
		oldest := r.photos[0]
		r.photos = r.photos[1:]
		delete(r.pinned, oldest)
		delete(r.media, oldest)
		for i, candidate := range r.order {
			if candidate == oldest {
				r.order = append(r.order[:i], r.order[i+1:]...)
				break
			}
		}
	}
}

// pinnedCount counts pinned names still present in order. Caller holds mu.
func (r *Room) pinnedCount() int {
	n := 0
	for name := range r.pinned {
		if _, ok := r.media[name]; ok {
			n++
		}
	}
	return n
}

// Pin marks names that must survive live-window eviction: the fixed-name
// assets a set uploads once. Replaces the previous pin set, so a regenerated
// stream with a new init segment name does not grow it forever. Names are
// pinned whether or not they have arrived yet. Sticky pins survive the
// replacement.
func (r *Room) Pin(names []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make(map[string]bool, len(names)+len(r.sticky))
	for name := range r.sticky {
		next[name] = true
	}
	for _, name := range names {
		if name != "" {
			next[name] = true
		}
	}
	r.pinned = next
}

// PinSticky pins one name permanently for the life of the room. Page assets
// (avatar, cover, fonts) are pushed once per revision, not named by any
// playlist, and must never be evicted with the rolling live window - and the
// playlist-driven Pin above replaces its whole set on every playlist PUT, so
// they need a set of their own that replacement folds back in.
func (r *Room) PinSticky(name string) {
	if name == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sticky == nil {
		r.sticky = make(map[string]bool)
	}
	r.sticky[name] = true
	r.pinned[name] = true
}

// PutPlaylist stores the playlist and wakes every blocked reader.
func (r *Room) PutPlaylist(name string, body []byte) {
	r.mu.Lock()
	r.playlistName = name
	r.playlist = body
	r.version++
	r.lastPublish = time.Now()
	r.mu.Unlock()
	// Broadcast outside the lock is not required by sync.Cond, but every waiter
	// re-checks its own condition on wake, so a spurious wake is harmless.
	r.cond.Broadcast()
}

// Media returns a stored file.
func (r *Room) Media(name string) (*object, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	obj, ok := r.media[name]
	return obj, ok
}

// Playlist returns the current playlist, blocking until it contains the
// requested media sequence and part when the client asked for one.
//
// This is what makes the relay low-latency rather than merely working. A native
// player asks for a part that does not exist yet and expects to be held; if the
// origin answered immediately with what it has, every client would poll and sit
// a part or more further behind.
func (r *Room) Playlist(wantMSN, wantPart int64, deadline time.Time) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for {
		if len(r.playlist) == 0 {
			return nil, errNotReady
		}
		if wantMSN < 0 || playlistHas(r.playlist, wantMSN, wantPart) {
			out := make([]byte, len(r.playlist))
			copy(out, r.playlist)
			return out, nil
		}
		if !time.Now().Before(deadline) {
			// Timed out waiting. Return what we have rather than an error: a
			// slightly stale playlist keeps a client playing, where an error can
			// end the stream on a native player.
			out := make([]byte, len(r.playlist))
			copy(out, r.playlist)
			return out, nil
		}
		// Wake this waiter when the deadline passes even if no publish arrives,
		// so a stalled Mac cannot pin connections open.
		r.waitUntil(deadline)
	}
}

// waitUntil parks on the condition with a wall-clock bound. sync.Cond has no
// timed wait, so a timer broadcasts to unpark us.
func (r *Room) waitUntil(deadline time.Time) {
	timer := time.AfterFunc(time.Until(deadline), func() { r.cond.Broadcast() })
	r.cond.Wait()
	timer.Stop()
}

var errNotReady = errors.New("room has no playlist yet")

// playlistHas reports whether the playlist already contains the requested media
// sequence and part.
//
// Media sequence numbering: EXT-X-MEDIA-SEQUENCE gives the sequence of the first
// segment listed. Each EXTINF closes a segment and advances the sequence, and the
// EXT-X-PART lines before a given EXTINF belong to that segment. Parts appearing
// after the final EXTINF belong to the next, still incomplete, segment.
func playlistHas(playlist []byte, wantMSN, wantPart int64) bool {
	msn := int64(0)
	parts := int64(0)
	sawSequence := false

	for _, line := range strings.Split(string(playlist), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			if v, err := strconv.ParseInt(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64); err == nil {
				msn = v
				sawSequence = true
			}
		case strings.HasPrefix(line, "#EXT-X-PART:"):
			parts++
		case strings.HasPrefix(line, "#EXTINF:"):
			// This segment is complete; anything at or below it is available.
			if wantMSN <= msn {
				return true
			}
			msn++
			parts = 0
		}
	}
	if !sawSequence && wantMSN > 0 {
		return false
	}
	// The trailing, incomplete segment: available up to the parts published.
	if wantMSN < msn {
		return true
	}
	if wantMSN == msn {
		if wantPart < 0 {
			return false // asked for a whole segment that has not closed yet
		}
		return wantPart < parts
	}
	return false
}

// Store holds every active room.
type Store struct {
	mu    sync.Mutex
	rooms map[string]*Room
	now   func() time.Time
}

func NewStore() *Store {
	return &Store{rooms: make(map[string]*Room), now: time.Now}
}

// Room returns an existing room, creating it on first upload.
func (s *Store) Room(token string, create bool) (*Room, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[token]
	if !ok && create {
		room = newRoom(s.now())
		s.rooms[token] = room
		ok = true
	}
	return room, ok
}

// Sweep drops rooms that have gone quiet. A party that ended leaves nothing
// behind, which is the no-retained-content invariant enforced rather than
// promised.
func (s *Store) Sweep() int {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	dropped := 0
	for token, room := range s.rooms {
		room.mu.Lock()
		idle := now.Sub(room.lastPublish)
		room.mu.Unlock()
		if idle > roomIdleTimeout {
			room.plane.Reset()
			delete(s.rooms, token)
			dropped++
		}
	}
	return dropped
}

// Stats is the health payload: aggregates only, never party content.
type Stats struct {
	Rooms      int `json:"rooms"`
	MediaFiles int `json:"mediaFiles"`
}

func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Stats{Rooms: len(s.rooms)}
	for _, room := range s.rooms {
		room.mu.Lock()
		out.MediaFiles += len(room.media)
		room.mu.Unlock()
	}
	return out
}

// parseBlocking pulls the LL-HLS blocking-reload directives off a request.
// Returns (-1, -1) when the client did not ask to be held.
func parseBlocking(q map[string][]string) (msn, part int64) {
	msn, part = -1, -1
	if v := first(q["_HLS_msn"]); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			msn = n
		}
	}
	if v := first(q["_HLS_part"]); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			part = n
		}
	}
	return msn, part
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// contentTypeFor keeps guests receiving the same content types the Mac served,
// so a native player is never handed a playlist it does not recognize.
func contentTypeFor(name, uploaded string) string {
	if uploaded != "" {
		return uploaded
	}
	switch {
	case strings.HasSuffix(name, ".m3u8"):
		return "application/vnd.apple.mpegurl"
	case strings.HasSuffix(name, ".mp4"), strings.HasSuffix(name, ".m4s"):
		return "video/mp4"
	case strings.HasSuffix(name, ".aac"):
		return "audio/aac"
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

// noStore marks live surfaces uncacheable. A cached playlist is a stalled
// stream, and a cached room API response is a party that appears frozen.
func noStore(h http.Header) {
	h.Set("Cache-Control", "no-store")
}
