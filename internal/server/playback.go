package server

import "partyparty/internal/schedule"

// roomLatencyTarget publishes the room's fixed intended delay. It is not proof
// that AVPlayer honors that deadline; native attachment and measured latency
// are documented separately in docs/synchronization.md.
const roomLatencyTarget = schedule.Delay
