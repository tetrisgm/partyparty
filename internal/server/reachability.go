package server

import (
	"time"

	"partyparty/internal/activate"
)

// recentGuestTTL keeps the LAN room in the "confirmed" state for a short window
// after a real guest's last heartbeat, bridging the gap between heartbeats and
// the console's status poll. A real guest connection is the only proof the LAN
// room works — the Mac cannot self-probe the guest-side network.
const recentGuestTTL = 2 * time.Minute

// SetActivationResult caches the latest online activation attempt (cert / host /
// LAN IP) for lanStateSnapshot to read. It never switches network mode.
func (s *Srv) SetActivationResult(res activate.Result) {
	s.actMu.Lock()
	s.actLast = res
	s.actLastSet = true
	s.actMu.Unlock()
}

// markGuestReach records that a real guest connection was just observed — the
// ground-truth signal that the LAN room works, fed from guest heartbeats and
// client events.
func (s *srv) markGuestReach() {
	s.reachMu.Lock()
	s.guestSeenUntil = time.Now().Add(recentGuestTTL)
	s.reachMu.Unlock()
}
