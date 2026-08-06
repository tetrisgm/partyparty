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
// parts exist (the spec sizes it around 3x the part duration).
//
// STABILITY DELIVERY (2026-08-05, third attempt, BENCHED FIRST): the owner's
// fixed 3s cushion ships as EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES in the
// MULTIVARIANT playlist - the exact form the July D=3 era ran live for weeks
// (commit affebd3), recovered by reading that code instead of paraphrasing
// it. Both details matter: the tag lives in the multivariant playlist, and
// PRECISE=YES. The two failed forms are never-again: PART-HOLD-BACK=2.9
// points outside the parts region (AVPlayer snapped a listener to the
// window's oldest edge), and the tag in the MEDIA playlist without PRECISE
// measured 25.00s from the edge on the soak harness - AVPlayer applied the
// offset from the wrong end. The shipped form measured 3.11s flat on a muted
// real AVPlayer against the live stream (scratchpad soak-july-form.log)
// BEFORE upload, per the contract's soak rule.
const PartHoldBack = 0.9

// Delay is the room's published D: what a guest should expect between a sound
// leaving the DJ and reaching a listener. It is the declared hold-back plus the
// fixed pipeline floor (capture, AAC encode, packaging), which is a property of
// the path rather than of the venue.
const Delay = 3.0

// RewritePlaylist authors the schedule into whichever playlist tier it is
// given. A multivariant playlist gains the EXT-X-START attachment pin; a
// media playlist gets the declared PART-HOLD-BACK. Everything else passes
// through unmodified: media bytes, timestamps, segment and part URIs, and
// PROGRAM-DATE-TIME, which is the stamp the whole schedule is built on.
func RewritePlaylist(body []byte) []byte {
	text := string(body)
	if strings.Contains(text, "#EXT-X-STREAM-INF") {
		return rewriteMultivariant(text)
	}
	if !strings.Contains(text, "#EXT-X-SERVER-CONTROL:") {
		return body
	}
	lines := strings.Split(text, "\n")
	changed := false
	for i, line := range lines {
		if !strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:") {
			continue
		}
		rewritten, ok := setPartHoldBack(line, PartHoldBack)
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

// rewriteMultivariant pins the room's attachment point. Ours is
// authoritative: any upstream EXT-X-START is dropped, and the pin lands
// directly after EXT-X-VERSION so it reads as part of the header.
func rewriteMultivariant(text string) []byte {
	startLine := fmt.Sprintf("#EXT-X-START:TIME-OFFSET=-%.3f,PRECISE=YES", Delay)
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-START:") {
			continue
		}
		kept = append(kept, line)
	}
	lines = kept
	insertAfter := func(match func(string) bool) ([]byte, bool) {
		for i, line := range lines {
			if match(line) {
				out := append([]string{}, lines[:i+1]...)
				out = append(out, startLine)
				out = append(out, lines[i+1:]...)
				return []byte(strings.Join(out, "\n")), true
			}
		}
		return nil, false
	}
	// After EXT-X-VERSION, matching the soaked form exactly; EXTM3U is the
	// fallback for a version-less playlist.
	if out, ok := insertAfter(func(l string) bool { return strings.HasPrefix(l, "#EXT-X-VERSION:") }); ok {
		return out
	}
	if out, ok := insertAfter(func(l string) bool { return l == "#EXTM3U" }); ok {
		return out
	}
	return []byte(strings.Join(append([]string{startLine}, lines...), "\n"))
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
