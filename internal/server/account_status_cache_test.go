package server

import (
	"testing"
	"time"

	"partyparty/internal/activate"
)

func TestAccountStatusCacheLookupCachesAndFreshBypasses(t *testing.T) {
	now := time.Unix(100, 0)
	cache := newAccountStatusCache(15 * time.Second)
	hits := 0
	source := func() (activate.AccountState, error) {
		hits++
		return activate.AccountState{
			OK:        true,
			Linked:    hits >= 2,
			CheckedMS: int64(hits),
		}, nil
	}
	clock := func() time.Time { return now }

	status, refreshed, err := cache.lookup(clock, false, source)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed || hits != 1 || status.CheckedMS != 1 {
		t.Fatalf("initial lookup = status %d refreshed %v hits %d, want status 1 refreshed true hits 1", status.CheckedMS, refreshed, hits)
	}

	now = now.Add(2 * time.Second)
	status, refreshed, err = cache.lookup(clock, false, source)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed || hits != 1 || status.CheckedMS != 1 {
		t.Fatalf("cached lookup = status %d refreshed %v hits %d, want cached status 1 refreshed false hits 1", status.CheckedMS, refreshed, hits)
	}

	status, refreshed, err = cache.lookup(clock, true, source)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed || hits != 2 || status.CheckedMS != 2 || !status.Linked {
		t.Fatalf("fresh lookup = status %d linked %v refreshed %v hits %d, want status 2 linked true refreshed true hits 2", status.CheckedMS, status.Linked, refreshed, hits)
	}

	now = now.Add(16 * time.Second)
	status, refreshed, err = cache.lookup(clock, false, source)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed || hits != 3 || status.CheckedMS != 3 {
		t.Fatalf("expired lookup = status %d refreshed %v hits %d, want status 3 refreshed true hits 3", status.CheckedMS, refreshed, hits)
	}

	now = now.Add(2 * time.Second)
	cache.clear()
	status, refreshed, err = cache.lookup(clock, false, source)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed || hits != 4 || status.CheckedMS != 4 {
		t.Fatalf("lookup after clear = status %d refreshed %v hits %d, want status 4 refreshed true hits 4", status.CheckedMS, refreshed, hits)
	}
}
