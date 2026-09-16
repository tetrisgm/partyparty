// Package schedule owns the fixed room target and shared playlist metadata.
//
// All paths retain the source PROGRAM-DATE-TIME and carry the same hints. HLS
// hints do not schedule speakers: real AVPlayer tests show that EXT-X-START
// does not enforce Delay. ClockRanges supplies a precise native media-clock
// reference so the listener can position a muted attachment against source time.
//
// The target never adapts to individual listeners. See docs/PLAYBACK-CONTRACT.md
// for the release checks and docs/synchronization.md for measured limitations.
package schedule

import (
	"fmt"
	"strconv"
	"strings"
)

// PartHoldBack is a lower bound on the upstream part hold-back. The historical
// multivariant EXT-X-START hint is retained for compatibility; it does not
// establish a shared presentation deadline on native AVPlayer. The HTTP-only
// pin/hold-back experiments are in docs/receipts/soak-lab-20260911/.
const PartHoldBack = 0.9

// Delay is the room's fixed published D: what a guest should expect between a
// sound leaving the DJ and reaching a listener. Direct, local, and relay expose
// this same target; it is not recomputed from path or listener conditions.
const Delay = 3.0

// RewritePlaylist authors the schedule into whichever playlist tier it is
// given. A multivariant playlist gains the EXT-X-START attachment pin; a
// media playlist gets the PART-HOLD-BACK floor and clock-reference date ranges.
// Media bytes, timestamps, segment/part URIs and PROGRAM-DATE-TIME are preserved.
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
		return ClockRanges(body)
	}
	return ClockRanges([]byte(strings.Join(lines, "\n")))
}

// rewriteMultivariant retains the legacy preferred-start hint. Ours is
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
