// Package schedule owns the room's playback schedule.
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
// This lives in its own package because the schedule has to be identical on
// every path a guest can arrive by, and there is more than one such path: the
// Mac serves direct guests itself, and pushes the same stream to a relay origin
// for guests on a network that isolates devices. When only the direct path
// applied the rewrite, relayed guests silently ran on the muxer's raw hold-back
// instead of the declared one, which is exactly the disagreement the schedule
// exists to prevent. One implementation, imported by both, makes that
// impossible rather than merely unlikely.
//
// Two properties are non-negotiable and are enforced by tests:
//
//  1. D NEVER responds to listener conditions. A slow device, or a hundred slow
//     devices, must never lengthen the delay for anyone else. The product has
//     already been burned once by a room-wide value that tracked room health,
//     which made healthy players move whenever a struggling peer changed it.
//  2. Devices that fall behind are corrected strictly per device, by the
//     visible-only forward governor, which never runs while locked or
//     backgrounded and never touches a peer.
//
// What the schedule buys is coherence, not adaptation: every device targets the
// same declared point instead of independently choosing one, which removes
// spread without adding latency.
package schedule

import (
	"fmt"
	"strconv"
	"strings"
)

// PartHoldBack is the distance from the live edge that we declare to players,
// in seconds. It is the one lever that sets where a conforming player starts,
// and it is self-enforcing: a player that ignores it starves, so it respects it
// out of self-interest. This is why the schedule leans on it rather than on
// EXT-X-START, which is purely advisory and may be silently ignored.
//
// It is a constant of the design, not a tuning knob, and specifically not a
// function of anybody's network. It must also stay INSIDE the region where
// parts exist (the spec sizes it around 3x the part duration): raising it to
// 2.9 to deepen the room asked players to hold a part-based position where
// only whole segments live, and AVPlayer coped briefly, then snapped to the
// oldest edge of the window - a listener rolled back to 24.8s behind, live,
// 2026-08-05. Depth comes from Start below; this stays the modest floor.
const PartHoldBack = 0.9

// Start is the declared attachment point: EXT-X-START:TIME-OFFSET=-Delay.
// The spec calls the tag advisory, but AVPlayer honors it in practice, and it
// is the only lever that can place a player deeper than the parts region -
// exactly what the stability target requires. A player that ignores it joins
// nearer the edge and simply gets corrected to target by the per-device
// governor; nothing starves either way, because hold-back stays honest.
//
// The SIZE of the delay is the stability decision (2026-08-05, owner): the
// room is radio, and the cushion is sized so ordinary venue Wi-Fi stalls pass
// silently instead of reaching ears. At the Shack15 re-test, phones riding
// ~1s heard every burst while a phone at ~2.6s heard none of the same
// afternoon (largest observed stall ~2.6s); the edge was the knife, and
// nobody needs to live on it.

// Delay is the room's published D: what a guest should expect between a sound
// leaving the DJ and reaching a listener. It is the declared hold-back plus the
// fixed pipeline floor (capture, AAC encode, packaging), which is a property of
// the path rather than of the venue.
const Delay = 3.0

// RewritePlaylist authors the schedule into a media playlist: it declares
// PART-HOLD-BACK and pins the attachment point with EXT-X-START at -Delay.
// Everything else about the playlist is passed through unmodified: media
// bytes, timestamps, segment and part URIs, and PROGRAM-DATE-TIME, which is
// the stamp the whole schedule is built on.
//
// Only the media playlist carries EXT-X-SERVER-CONTROL, so a multivariant
// playlist is returned untouched.
func RewritePlaylist(body []byte) []byte {
	text := string(body)
	if !strings.Contains(text, "#EXT-X-SERVER-CONTROL:") {
		return body
	}
	lines := strings.Split(text, "\n")
	startLine := fmt.Sprintf("#EXT-X-START:TIME-OFFSET=-%.5f", Delay)
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-START:") {
			continue // ours is authoritative; drop any upstream declaration
		}
		kept = append(kept, line)
	}
	lines = kept
	for i, line := range lines {
		if !strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:") {
			continue
		}
		if rewritten, ok := setPartHoldBack(line, PartHoldBack); ok {
			lines[i] = rewritten
		}
		lines = append(lines[:i+1], append([]string{startLine}, lines[i+1:]...)...)
		break
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
