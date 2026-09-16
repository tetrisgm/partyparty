package schedule

import (
	"fmt"
	"strings"
	"time"
)

// ClockRanges pairs source wall time with a native HLS DataCue.startTime.
// WebKit rounds getStartDate() to whole seconds; its date-range cue mapping
// preserves the fractional origin. These markers change no media timestamps,
// segment durations, attachment hints, or encoded audio.
func ClockRanges(body []byte) []byte {
	text := string(body)
	if !strings.Contains(text, "#EXT-X-PROGRAM-DATE-TIME:") {
		return body
	}
	var out []string
	var bucket int64
	haveBucket := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, `#EXT-X-DATERANGE:ID="pp-clock-`) {
			continue // idempotent on direct + contribution rewrites
		}
		out = append(out, line)
		if !strings.HasPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:") {
			continue
		}
		date := strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:"))
		stamp, err := time.Parse(time.RFC3339Nano, date)
		if err != nil {
			continue
		}
		// One cue per two-second bucket keeps manifest and metadata growth small.
		// The existing window carries several references even for a late join.
		next := stamp.UnixMilli() / 2000
		if haveBucket && next == bucket {
			continue
		}
		bucket, haveBucket = next, true
		out = append(out, fmt.Sprintf(`#EXT-X-DATERANGE:ID="pp-clock-%d",CLASS="fm.partyparty.clock",START-DATE="%s",DURATION=0.050,X-PP-TIME="%d"`, stamp.UnixMilli(), date, stamp.UnixMilli()))
	}
	return []byte(strings.Join(out, "\n"))
}
