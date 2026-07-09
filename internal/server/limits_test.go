package server

import (
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
