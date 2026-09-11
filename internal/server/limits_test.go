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

// A full table bounds MEMORY. It must never decide who is allowed to speak.
//
// This used to assert the opposite: that the 4096th entry was the last one, and
// everyone after it was refused. That turned the bound into a second denial of
// service. One phone rotating identities filled the table, and from then on
// every guest the limiter had not already seen was rejected, so a guest who
// joined the party during a flood could not post at all, and the attacker could
// hold them out by refilling it. Now the oldest entry is evicted instead.
func TestLimiterBoundsRotatingIdentitiesWithoutLockingAnyoneOut(t *testing.T) {
	now := time.Unix(100, 0)
	l := newLimiter()
	l.now = func() time.Time { return now }
	for i := 0; i < maxLimitEntries; i++ {
		if !l.allow(strconv.Itoa(i), "post") {
			t.Fatalf("entry %d was rejected before the cap", i)
		}
		now = now.Add(time.Millisecond) // distinct timestamps, so "oldest" is well defined
	}

	// The table stays bounded, and a guest the limiter has never seen is still
	// served rather than refused.
	if !l.allow("a-guest-who-just-arrived", "post") {
		t.Fatal("a full limiter refused a guest it had never seen; that is the lockout this test exists to prevent")
	}
	if len(l.last) > maxLimitEntries {
		t.Fatalf("rotating identities grew the limiter to %d entries", len(l.last))
	}

	// The victim of the eviction is the least recently used key, not an
	// arbitrary one: entry "0" was first and has not been touched since.
	if _, stillThere := l.last["post\x00"+strconv.Itoa(0)]; stillThere {
		t.Fatal("eviction did not remove the oldest entry")
	}

	// And the real rate limit still applies to the guest in front of it.
	if l.allow("a-guest-who-just-arrived", "post") {
		t.Fatal("a second immediate post was allowed; the interval is not being enforced")
	}

	now = now.Add(limitEntryTTL + time.Second)
	if !l.allow("replacement", "post") || len(l.last) != 1 {
		t.Fatalf("expired limiter entries were not reclaimed: %d", len(l.last))
	}
}

// The limit key must be something the guest cannot choose.
//
// Keying on the cid meant a guest sending a fresh cid per request was never
// rate limited: every interval in this file simply did not apply to them.
func TestGuestLimitKeyIgnoresTheClientChosenIdentity(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "192.168.1.55:51000"

	first := guestLimitKey("cid-one", req)
	second := guestLimitKey("cid-two", req)
	if first != second {
		t.Fatalf("rotating the cid changed the limit key (%q -> %q); the limiter can be walked around", first, second)
	}
	if first != "192.168.1.55" {
		t.Fatalf("limit key = %q, want the client address", first)
	}

	// A different phone on the same Wi-Fi is still its own identity.
	other := httptest.NewRequest("GET", "/", nil)
	other.RemoteAddr = "192.168.1.56:51000"
	if guestLimitKey("cid-one", other) == first {
		t.Fatal("two different phones shared a limit key")
	}
}

// Relayed writes are all synthesized with one address, so there the cid is the
// only discriminator available and must still be used, clipped.
func TestGuestLimitKeyFallsBackToTheCidOnlyForRelayedWrites(t *testing.T) {
	relayed := httptest.NewRequest("GET", "/", nil)
	relayed.RemoteAddr = relayGuestAddr

	a := guestLimitKey("relay-guest-a", relayed)
	b := guestLimitKey("relay-guest-b", relayed)
	if a == b {
		t.Fatal("two relayed guests collapsed onto one limit key and would throttle each other")
	}
	if got := guestLimitKey(strings.Repeat("x", 1000), relayed); len(got) != 64 {
		t.Fatalf("relayed guest limit key length = %d, want 64", len(got))
	}
	if guestLimitKey("", relayed) == "" {
		t.Fatal("a relayed write with no cid produced an empty key")
	}
}
