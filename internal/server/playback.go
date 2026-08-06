package server

import "partyparty/internal/schedule"

// roomLatencyTarget is the single client-side playout target and is the
// schedule's published D by definition - one number, declared once. Native
// AVPlayer joins at the declared hold-back and the visible-only governor
// corrects sustained drift toward this target without touching
// locked/background playback.
const roomLatencyTarget = schedule.Delay
