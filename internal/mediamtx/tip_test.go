package mediamtx

import "testing"

const tipPlaylistA = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-MEDIA-SEQUENCE:41
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=2.5
#EXT-X-PART-INF:PART-TARGET=1.0
#EXTINF:2.000,
seg41.mp4
#EXT-X-PART:DURATION=1.000,URI="part_42_0.mp4"
#EXT-X-PART:DURATION=1.000,URI="part_42_1.mp4"
#EXTINF:2.000,
seg42.mp4
#EXT-X-PART:DURATION=1.000,URI="part_43_0.mp4"
`

func TestPlaylistTipTokenTracksNewestPart(t *testing.T) {
	a := playlistTipToken(tipPlaylistA)
	if a != "41|part_43_0.mp4" {
		t.Fatalf("tip = %q, want 41|part_43_0.mp4", a)
	}
	// A new part emission MUST change the token even when the media sequence
	// hasn't rolled - that change is what the cadence heartbeat times.
	b := playlistTipToken(tipPlaylistA + "#EXT-X-PART:DURATION=1.000,URI=\"part_43_1.mp4\"\n")
	if b == a {
		t.Fatal("new part did not change the tip token")
	}
	// A segment roll (sequence bump) changes it too.
	c := playlistTipToken("#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-PART:DURATION=1.000,URI=\"part_43_0.mp4\"\n")
	if c == a {
		t.Fatal("sequence bump did not change the tip token")
	}
	// Identical playlist → identical token (no false advances).
	if playlistTipToken(tipPlaylistA) != a {
		t.Fatal("token is not stable for identical playlists")
	}
}

func TestPlaylistTipTokenPlainHLSFallsBackToSegments(t *testing.T) {
	plain := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2.000,\nseg7.ts\n#EXTINF:2.000,\nseg8.ts\n"
	if got := playlistTipToken(plain); got != "7|seg8.ts" {
		t.Fatalf("plain-HLS tip = %q, want 7|seg8.ts", got)
	}
}
