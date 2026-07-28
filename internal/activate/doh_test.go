package activate

import (
	"context"
	"net"
	"testing"
	"time"
)

// observeResolver is the structured guest-path resolver check that replaced the
// old DoH rebind classifier: it records what the network's own resolver returns
// and whether the expected IP is among the answers - no rebind judgement.
// Verified against Cloudflare's permanently stable one.one.one.one → 1.1.1.1
// record; skipped offline.
func TestObserveResolver(t *testing.T) {
	c, err := net.DialTimeout("tcp", "1.1.1.1:443", 2*time.Second)
	if err != nil {
		t.Skipf("no internet: %v", err)
	}
	c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	ok := observeResolver(ctx, "one.one.one.one", "1.1.1.1")
	if !ok.Matches {
		t.Errorf("observeResolver(one.one.one.one, 1.1.1.1).Matches = false, want true (addrs=%v err=%v)", ok.Addrs, ok.Err)
	}
	if VerifyResolves(ctx, "one.one.one.one", "1.1.1.1") != nil {
		t.Error("VerifyResolves(one.one.one.one, 1.1.1.1) != nil, want nil")
	}

	// A wrong expected IP must NOT match, and must NOT be classified as anything
	// other than a plain mismatch (there is no rebind verdict any more).
	miss := observeResolver(ctx, "one.one.one.one", "203.0.113.9")
	if miss.Matches {
		t.Error("observeResolver with a wrong IP = Matches, want false")
	}
	if VerifyResolves(ctx, "one.one.one.one", "203.0.113.9") == nil {
		t.Error("VerifyResolves with a wrong IP = nil, want error")
	}
}
