package server

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	postLimitInterval     = 5 * time.Second
	commentLimitInterval  = 2 * time.Second
	reactionLimitInterval = time.Second
	trackIDLimitInterval  = 3 * time.Second
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
		return false
	}
	l.last[mapKey] = now
	return true
}

func guestLimitKey(cid string, r *http.Request) string {
	if cid = strings.TrimSpace(cid); cid != "" {
		return clipStr(cid, 64)
	}
	return clientIP(r)
}
