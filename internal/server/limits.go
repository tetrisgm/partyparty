package server

import (
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	postLimitInterval     = 5 * time.Second
	commentLimitInterval  = 2 * time.Second
	reactionLimitInterval = time.Second
	trackIDLimitInterval  = 3 * time.Second
	profileLimitInterval  = 2 * time.Second
	limitEntryTTL         = time.Minute
	maxLimitEntries       = 4096
)

type limiter struct {
	mu          sync.Mutex
	last        map[string]time.Time
	intervals   map[string]time.Duration
	lastCleanup time.Time
	now         func() time.Time
}

func newLimiter() *limiter {
	return &limiter{
		last: make(map[string]time.Time),
		intervals: map[string]time.Duration{
			"post":     postLimitInterval,
			"comment":  commentLimitInterval,
			"reaction": reactionLimitInterval,
			"track-id": trackIDLimitInterval,
			"profile":  profileLimitInterval,
		},
		now: time.Now,
	}
}

func (l *limiter) allow(key, kind string) bool {
	interval, ok := l.intervals[kind]
	if !ok || interval <= 0 {
		return true
	}
	key = strings.TrimSpace(key)
	if key == "" {
		key = "unknown"
	}
	mapKey := kind + "\x00" + key
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	if now.Sub(l.lastCleanup) > limitEntryTTL {
		for k, t := range l.last {
			if now.Sub(t) > limitEntryTTL {
				delete(l.last, k)
			}
		}
		l.lastCleanup = now
	}

	if last, ok := l.last[mapKey]; ok && now.Sub(last) < interval {
		return false
	}
	if _, exists := l.last[mapKey]; !exists && len(l.last) >= maxLimitEntries {
		// A FULL TABLE MUST NOT MEAN "DENY EVERYONE".
		//
		// This used to return false, which turned the bound into a second denial
		// of service: once 4096 keys were resident, every guest the limiter had
		// not seen before was refused, so a phone that filled the table locked
		// out everyone who joined afterwards until the next sweep, and could hold
		// them out indefinitely by refilling it. The cap exists to bound memory,
		// not to decide who may speak.
		//
		// Drop the oldest entry instead. The worst case is that whoever has been
		// quiet longest loses their interval and gets one free write, which is
		// the mild failure; being unable to post at your own party is not.
		l.evictOldestLocked()
	}
	l.last[mapKey] = now
	return true
}

// evictOldestLocked removes the least recently used entry. Called only when the
// table is full, so the linear scan runs at most once per accepted write in a
// flood and never on an ordinary party.
func (l *limiter) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for k, t := range l.last {
		if oldestKey == "" || t.Before(oldest) {
			oldestKey, oldest = k, t
		}
	}
	if oldestKey != "" {
		delete(l.last, oldestKey)
	}
}

// guestLimitKey picks the identity a guest write is rate limited on.
//
// It used to prefer the cid from the request body and fall back to the client
// address only when that was empty. The cid is generated in the browser and
// echoed back by the client on every write, so a guest who sent a fresh cid per
// request was not rate limited at all: the 5-second post interval, the 2-second
// comment interval and the rest simply never applied to them. The only thing
// left standing between one phone and the whole wall was the 4096-entry table
// bound, and hitting that bound used to lock out every other guest.
//
// The transport address is the part a guest cannot choose. On the direct path
// that is the phone's own address on the party Wi-Fi, which is exactly the
// identity wanted.
//
// The relay path cannot use it. ApplyRelayWrite synthesizes every relayed write
// with one fixed RemoteAddr (relayGuestAddr), so the address cannot tell two
// relayed guests apart, and keying on it would make them share a single budget
// and throttle each other. There the cid is the only discriminator that exists,
// which means cid rotation still defeats this limiter for relayed guests. That
// is a real gap and it is not closable here: the place that sees a relayed
// guest's actual connection is the origin, so bounding them belongs there.
func guestLimitKey(cid string, r *http.Request) string {
	if ip := clientIP(r); ip != "" && ip != relayGuestIP {
		return ip
	}
	if cid = strings.TrimSpace(cid); cid != "" {
		return clipStr(cid, 64)
	}
	return "unknown"
}

// uploadDiskFloor is the free space an upload may never take the Mac below.
const uploadDiskFloor = 2 << 30

// uploadBudget is how many bytes one upload may write into dir before the disk
// would drop under uploadDiskFloor. ok is false when there is no room at all.
// If free space cannot be read, uploads are not blocked on it.
func uploadBudget(dir string) (int64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 1 << 62, true
	}
	free := int64(st.Bavail) * int64(st.Bsize)
	if free <= uploadDiskFloor {
		return 0, false
	}
	return free - uploadDiskFloor, true
}
