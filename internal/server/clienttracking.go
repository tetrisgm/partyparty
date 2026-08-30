package server

import (
	"sync"
	"sync/atomic"
)

const (
	maxSeenClientIDs       int32 = 2048
	maxHostCacheEntries    int32 = 2048
	maxClientDiagnosticIDs int32 = 20000
)

// cappedLoadOrStore inserts into a process-lifetime sync.Map without allowing
// attacker-chosen keys to grow it forever. The counter reserves capacity before
// insertion; a concurrent winner releases the redundant reservation.
func cappedLoadOrStore(m *sync.Map, entries *int32, limit int32, key string, value any) (actual any, loaded, accepted bool) {
	if actual, loaded = m.Load(key); loaded {
		return actual, true, true
	}
	if atomic.AddInt32(entries, 1) > limit {
		atomic.AddInt32(entries, -1)
		return nil, false, false
	}
	actual, loaded = m.LoadOrStore(key, value)
	if loaded {
		atomic.AddInt32(entries, -1)
	}
	return actual, loaded, true
}
