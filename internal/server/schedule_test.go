package server

import (
	"fmt"
	"strings"
	"testing"

	"partyparty/internal/broadcast"
	"partyparty/internal/schedule"
)

// TestRoomDelayNeverRespondsToConditions is the load-bearing test of the whole
// sync design. The room's published delay must be identical no matter what any
// listener is doing, so one slow phone can never lengthen the delay for anyone
// else. The product previously had the opposite behavior, where a struggling
// peer moved room health and healthy players moved with it.
//
// This guards the property that latencyTarget deliberately ignores both of its
// arguments. If someone later makes the target a function of health, this fails.
func TestRoomDelayNeverRespondsToConditions(t *testing.T) {
	env := newTestEnv(t, nil)

	want := env.srv.latencyTarget(broadcast.Status{}, "")
	if want != roomLatencyTarget {
		t.Fatalf("baseline target = %v, want %v", want, roomLatencyTarget)
	}

	states := []string{"", "idle", "starting", "live", "stopping", "error"}
	healths := []string{"", "good", "fair", "congested", "bad", "unknown"}
	bitrates := []int{0, 64, 128, 320}
	listenerCounts := []int{0, 1, 20, 500}

	for _, state := range states {
		for _, health := range healths {
			for _, bitrate := range bitrates {
				for _, listeners := range listenerCounts {
					status := broadcast.Status{State: state, Bitrate: bitrateText(bitrate)}
					got := env.srv.latencyTarget(status, health)
					if got != want {
						t.Fatalf("room delay moved to %v for state=%q health=%q bitrate=%d listeners=%d; "+
							"a room-wide value must never track conditions",
							got, state, health, bitrate, listeners)
					}
				}
			}
		}
	}

	if scheduleDelay() != roomLatencyTarget {
		t.Fatalf("published schedule delay = %v, want %v", scheduleDelay(), roomLatencyTarget)
	}
}

func bitrateText(kbps int) string {
	if kbps == 0 {
		return ""
	}
	switch kbps {
	case 64:
		return "64k"
	case 128:
		return "128k"
	default:
		return "320k"
	}
}

// TestScheduleDeclaresHoldBack proves the schedule is authored by us rather than
// negotiated with the player: the distance from the live edge in what we serve is
// the one we intend, so a conforming player lands on the schedule by construction.
func TestScheduleDeclaresHoldBack(t *testing.T) {
	in := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:9",
		"#EXT-X-TARGETDURATION:1",
		"#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.45000,CAN-SKIP-UNTIL=6.00000",
		"#EXT-X-PART-INF:PART-TARGET=0.15000",
		"#EXT-X-PROGRAM-DATE-TIME:2026-07-29T00:00:00.000Z",
		"#EXTINF:0.50000,",
		"seg0.mp4",
		"",
	}, "\n")

	out := string(rewriteLivePlaylist([]byte(in)))

	if !strings.Contains(out, fmt.Sprintf("PART-HOLD-BACK=%.5f", schedule.PartHoldBack)) {
		t.Fatalf("declared hold-back missing:\n%s", out)
	}
	// Everything that carries the audio or its timeline must survive untouched.
	for _, keep := range []string{
		"CAN-BLOCK-RELOAD=YES",
		"CAN-SKIP-UNTIL=6.00000",
		"#EXT-X-PART-INF:PART-TARGET=0.15000",
		"#EXT-X-PROGRAM-DATE-TIME:2026-07-29T00:00:00.000Z",
		"#EXTINF:0.50000,",
		"seg0.mp4",
	} {
		if !strings.Contains(out, keep) {
			t.Fatalf("playlist lost %q:\n%s", keep, out)
		}
	}
	if strings.Contains(out, "PART-HOLD-BACK=0.45000") {
		t.Fatalf("old hold-back still present:\n%s", out)
	}
}

// TestScheduleNeverShortensUpstreamHoldBack: MediaMTX derives its value from the
// real part duration, so a shorter declaration is a promise the stream cannot
// keep. A player honoring it would sit closer to the edge than parts exist,
// starve, and stall. Declaring more room is always safe; declaring less is not.
func TestScheduleNeverShortensUpstreamHoldBack(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.00000\n"
	out := string(rewriteLivePlaylist([]byte(in)))
	if !strings.Contains(out, "PART-HOLD-BACK=3.00000") {
		t.Fatalf("a longer upstream hold-back must be preserved:\n%s", out)
	}
}

// TestScheduleLeavesOtherPlaylistsAlone: the multivariant playlist carries no
// server-control line, and media segments are bytes we must never touch.
func TestScheduleLeavesOtherPlaylistsAlone(t *testing.T) {
	multivariant := "#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-STREAM-INF:BANDWIDTH=320000\nstream.m3u8\n"
	if got := string(rewriteLivePlaylist([]byte(multivariant))); got != multivariant {
		t.Fatalf("multivariant playlist was modified:\n%s", got)
	}
	// EXT-X-START pins the attachment point in MEDIA playlists only; a
	// multivariant playlist must never grow one.
	if strings.Contains(string(rewriteLivePlaylist([]byte(multivariant))), "#EXT-X-START:") {
		t.Fatal("multivariant playlist must not carry EXT-X-START")
	}
}
