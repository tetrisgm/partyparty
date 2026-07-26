package server

// roomLatencyTarget is the one production playout contract. MediaMTX's emitted
// playlist has a one-second EXT-X-TARGETDURATION, so three seconds is the
// nearest standards-safe EXT-X-START offset from the live edge. The server pin
// gives native AVPlayer clients a common start without client-side startup
// seeks, preserving lock-screen playback.
const roomLatencyTarget = 3.0

func (s *srv) syncTarget() float64 { return roomLatencyTarget }
