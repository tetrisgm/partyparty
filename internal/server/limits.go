package server

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	uploadLimitInterval   = 3 * time.Second
	postLimitInterval     = 5 * time.Second
	commentLimitInterval  = 2 * time.Second
	reactionLimitInterval = time.Second
	requestLimitInterval  = 15 * time.Second
	trackIDLimitInterval  = 3 * time.Second
	limitEntryTTL         = time.Minute
)

type limiter struct {
	uploads chan struct{}

	mu          sync.Mutex
	last        map[string]time.Time
	intervals   map[string]time.Duration
	lastCleanup time.Time
	now         func() time.Time
}

func newLimiter() *limiter {
	return &limiter{
		uploads: make(chan struct{}, 2),
		last:    make(map[string]time.Time),
		intervals: map[string]time.Duration{
			"upload":   uploadLimitInterval,
			"post":     postLimitInterval,
			"comment":  commentLimitInterval,
			"reaction": reactionLimitInterval,
			"request":  requestLimitInterval,
			"track-id": trackIDLimitInterval,
		},
		now: time.Now,
	}
}

func (l *limiter) acquireUpload() bool {
	select {
	case l.uploads <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *limiter) releaseUpload() {
	select {
	case <-l.uploads:
	default:
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
	l.last[mapKey] = now
	return true
}

func guestLimitKey(cid string, r *http.Request) string {
	if cid = strings.TrimSpace(cid); cid != "" {
		return cid
	}
	return clientIP(r)
}

func uploadLimitKey(r *http.Request) string {
	if cid := strings.TrimSpace(r.URL.Query().Get("cid")); cid != "" {
		return cid
	}
	if cid := strings.TrimSpace(r.Header.Get("X-Party-CID")); cid != "" {
		return cid
	}
	return clientIP(r)
}
