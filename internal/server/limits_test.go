package server

import (
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLimiterAllowIntervals(t *testing.T) {
	now := time.Unix(100, 0)
	l := newLimiter()
	l.now = func() time.Time { return now }

	if !l.allow("guest-1", "post") {
		t.Fatal("first post should be allowed")
	}
	if l.allow("guest-1", "post") {
		t.Fatal("second post inside the interval should be denied")
	}
	now = now.Add(postLimitInterval)
	if !l.allow("guest-1", "post") {
		t.Fatal("post after the interval should be allowed")
	}
}

func TestLimiterBoundsRotatingIdentities(t *testing.T) {
	now := time.Unix(100, 0)
	l := newLimiter()
	l.now = func() time.Time { return now }
	for i := 0; i < maxLimitEntries; i++ {
		if !l.allow(strconv.Itoa(i), "post") {
			t.Fatalf("entry %d was rejected before the cap", i)
		}
	}
	if l.allow("overflow", "post") || len(l.last) != maxLimitEntries {
		t.Fatalf("rotating identities grew the limiter to %d entries", len(l.last))
	}

	now = now.Add(limitEntryTTL + time.Second)
	if !l.allow("replacement", "post") || len(l.last) != 1 {
		t.Fatalf("expired limiter entries were not reclaimed: %d", len(l.last))
	}
}

func TestGuestLimitKeyClipsClientIdentity(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	if got := guestLimitKey(strings.Repeat("x", 1000), req); len(got) != 64 {
		t.Fatalf("guest limit key length = %d, want 64", len(got))
	}
}
