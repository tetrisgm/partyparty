package activate

import (
	"context"
	"net"
	"testing"
	"time"
)

// dohResolves is the disambiguator that keeps a rebind-protecting venue
// resolver (one that hides private-IP answers) from blocking activation: a
// local mismatch is cross-checked against authoritative DNS over DoH, and only
// a genuinely wrong record still fails. Verified against Cloudflare's
// permanently stable one.one.one.one → 1.1.1.1 record; skipped offline.
func TestDohResolves(t *testing.T) {
	c, err := net.DialTimeout("tcp", "1.1.1.1:443", 2*time.Second)
	if err != nil {
		t.Skipf("no internet: %v", err)
	}
	c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if !dohResolves(ctx, "one.one.one.one", "1.1.1.1") {
		t.Error("dohResolves(one.one.one.one, 1.1.1.1) = false, want true")
	}
	if dohResolves(ctx, "one.one.one.one", "203.0.113.9") {
		t.Error("dohResolves with a wrong IP = true, want false")
	}
}
