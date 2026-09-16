package schedule

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestClockRangesAreBoundedAccurateAndIdempotent(t *testing.T) {
	start := time.Date(2026, 9, 16, 12, 0, 0, 255000000, time.UTC)
	var in strings.Builder
	in.WriteString("#EXTM3U\n#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=0.90000\n")
	for i := 0; i < 48; i++ {
		fmt.Fprintf(&in, "#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:0.512,\nseg%d.mp4\n", start.Add(time.Duration(i)*512*time.Millisecond).Format(time.RFC3339Nano), i)
	}
	body := []byte(in.String())
	out := string(RewritePlaylist(body))
	if n := strings.Count(out, "#EXT-X-DATERANGE:"); n < 12 || n > 13 {
		t.Fatalf("expected one marker per two-second bucket, got %d", n)
	}
	if !strings.Contains(out, fmt.Sprintf(`X-PP-TIME="%d"`, start.UnixMilli())) {
		t.Fatal("fractional source timestamp lost")
	}
	var preserved []string
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "#EXT-X-DATERANGE:") {
			preserved = append(preserved, line)
		}
	}
	if strings.Join(preserved, "\n") != in.String() {
		t.Fatal("timing metadata changed media or playlist geometry")
	}
	if string(RewritePlaylist([]byte(out))) != out {
		t.Fatal("repeated rewrites changed clock markers")
	}
}

func TestClockRangesIgnoreInvalidDatesAndPreserveOtherMetadata(t *testing.T) {
	in := `#EXTM3U
#EXT-X-DATERANGE:ID="track-title",START-DATE="2026-09-16T12:00:00Z",X-TITLE="Track"
#EXT-X-PROGRAM-DATE-TIME:not-a-date
`
	if string(ClockRanges([]byte(in))) != in {
		t.Fatal("unknown metadata or invalid dates changed")
	}
}
