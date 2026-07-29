package server

import (
	"fmt"
	"strconv"
	"strings"
)

// The room schedule.
//
// Every chunk of audio carries the wall-clock time it was captured, as
// EXT-X-PROGRAM-DATE-TIME. The room publishes one delay D, and the contract is
// simply: a chunk stamped T is played at T + D. Direct, local, and relayed
// guests all obey the same absolute instant, so they agree by construction
// rather than by coincidence.
//
// D is DECLARED, never discovered. It is the pipeline floor plus the hold-back
// we write into the playlist, and both terms are ours. A conforming player
// riding the live edge of a playlist we author is therefore on schedule without
// honoring any advisory tag, without us commanding AVPlayer, and without anyone
// measuring a venue first.
//
// Two properties are non-negotiable and are enforced by tests:
//
//  1. D NEVER responds to listener conditions. A slow device, or a hundred slow
//     devices, must never lengthen the delay for anyone else. The product has
//     already been burned once by a room-wide value that tracked room health,
//     which made healthy players move whenever a struggling peer changed it.
//     latencyTarget accepts broadcast status and health and discards both; that
//     is deliberate and must stay that way.
//  2. Devices that fall behind are corrected strictly per device, by the
//     visible-only forward governor, which never runs while locked or
//     backgrounded and never touches a peer.
//
// What the schedule buys is coherence, not adaptation: every device targets the
// same declared point instead of independently choosing one, which removes
// spread without adding latency.

// schedulePartHoldBack is the distance from the live edge that we declare to
// players, in seconds. It is the one lever that sets where a conforming player
// starts, and it is self-enforcing: a player that ignores it starves, so it
// respects it out of self-interest. This is why the schedule leans on it rather
// than on EXT-X-START, which is purely advisory and may be silently ignored.
//
// It is a constant of the design, not a tuning knob, and specifically not a
// function of anybody's network.
const schedulePartHoldBack = 0.9

// scheduleDelay is the room's published D: what a guest should expect between a
// sound leaving the DJ and reaching a listener. It is the declared hold-back
// plus the fixed pipeline floor (capture, AAC encode, packaging), which is a
// property of the path rather than of the venue.
func scheduleDelay() float64 { return roomLatencyTarget }

// rewriteLivePlaylist authors the schedule into a media playlist by declaring
// PART-HOLD-BACK. Everything else about the playlist is passed through
// unmodified: media bytes, timestamps, segment and part URIs, and
// PROGRAM-DATE-TIME, which is the stamp the whole schedule is built on.
//
// Only the media playlist carries EXT-X-SERVER-CONTROL, so a multivariant
// playlist is returned untouched.
func rewriteLivePlaylist(body []byte) []byte {
	text := string(body)
	if !strings.Contains(text, "#EXT-X-SERVER-CONTROL:") {
		return body
	}
	lines := strings.Split(text, "\n")
	changed := false
	for i, line := range lines {
		if !strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:") {
			continue
		}
		rewritten, ok := setPartHoldBack(line, schedulePartHoldBack)
		if ok {
			lines[i] = rewritten
			changed = true
		}
	}
	if !changed {
		return body
	}
	return []byte(strings.Join(lines, "\n"))
}

// setPartHoldBack replaces the PART-HOLD-BACK attribute on an
// EXT-X-SERVER-CONTROL line, leaving every other attribute alone.
//
// It never lowers what MediaMTX advertised. MediaMTX derives its value from the
// real part duration, and a value below that is not deliverable: a player that
// tried to honor it would sit closer to the edge than the parts actually exist,
// starve, and stall. Declaring a longer distance is always safe; declaring a
// shorter one is a promise the stream cannot keep.
func setPartHoldBack(line string, want float64) (string, bool) {
	const prefix = "#EXT-X-SERVER-CONTROL:"
	attrs := strings.Split(strings.TrimPrefix(line, prefix), ",")
	found := false
	for i, attr := range attrs {
		name, value, ok := strings.Cut(attr, "=")
		if !ok || strings.TrimSpace(name) != "PART-HOLD-BACK" {
			continue
		}
		found = true
		current, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err == nil && current > want {
			return line, false // upstream already demands more room; never shorten it
		}
		attrs[i] = "PART-HOLD-BACK=" + formatHoldBack(want)
	}
	if !found {
		return line, false
	}
	return prefix + strings.Join(attrs, ","), true
}

func formatHoldBack(v float64) string { return fmt.Sprintf("%.5f", v) }

// scheduleState is the room's declared schedule plus how well the room is
// holding it, for the DJ console and the session analyzer.
//
// deviationMs is how far the worst listener is from the declared delay, and
// spreadMs is how far apart the listeners are from each other. Both are
// TELEMETRY ONLY. Neither is an input to delaySec or holdBackSec, and nothing
// in this payload may ever become one: the moment a room-wide value tracks a
// listener, one slow phone starts lengthening the delay for everyone.
func (s *srv) scheduleState() map[string]any {
	latency := s.Listeners.LatencySpread()
	deviationMs := 0.0
	if latency.Count > 0 {
		deviationMs = latency.MaxMs - scheduleDelay()*1000
		if deviationMs < 0 {
			deviationMs = 0
		}
	}
	return map[string]any{
		"delaySec":    scheduleDelay(),
		"holdBackSec": schedulePartHoldBack,
		"listeners":   latency.Count,
		"spreadMs":    latency.SpreadMs,
		"deviationMs": deviationMs,
	}
}
