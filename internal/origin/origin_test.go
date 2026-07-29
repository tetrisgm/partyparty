package origin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const roomToken = "room1"
const publishToken = "publish-secret"

func testHandler() (*Handler, *Store) {
	store := NewStore()
	h := NewHandler(Config{
		Tokens: func(room string) (string, bool) {
			if room == roomToken {
				return publishToken, true
			}
			return "", false
		},
	}, store)
	return h, store
}

func put(t *testing.T, h *Handler, name, body, contentType, auth string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/r/"+roomToken+"/"+name, strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func get(t *testing.T, h *Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/r/"+roomToken+"/"+path, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

const livePlaylist = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.90000
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z
#EXT-X-PART:DURATION=0.15000,URI="seg7_part0.mp4"
#EXTINF:0.50000,
seg7.mp4
#EXT-X-PART:DURATION=0.15000,URI="seg8_part0.mp4"
`

// TestPlaylistIsServedByteForByte is the property the room schedule depends on.
// If this service ever regenerated a playlist it would stamp its own time, and
// relayed guests would drift away from direct ones without anything looking
// broken in either mode alone.
func TestPlaylistIsServedByteForByte(t *testing.T) {
	h, _ := testHandler()
	if w := put(t, h, "stream.m3u8", livePlaylist, "application/vnd.apple.mpegurl", publishToken); w.Code != http.StatusNoContent {
		t.Fatalf("upload = %d", w.Code)
	}

	w := get(t, h, "stream.m3u8")
	if w.Code != http.StatusOK {
		t.Fatalf("fetch = %d", w.Code)
	}
	if w.Body.String() != livePlaylist {
		t.Fatalf("playlist was altered.\n--- got ---\n%s\n--- want ---\n%s", w.Body.String(), livePlaylist)
	}
	if !strings.Contains(w.Body.String(), "2026-07-29T21:14:03.250Z") {
		t.Fatal("the capture stamp did not survive")
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("a live playlist must never be cached, got %q", cc)
	}
}

// TestOnlyTheRoomsMacMayPublish: anyone able to publish could hijack a party.
func TestOnlyTheRoomsMacMayPublish(t *testing.T) {
	h, _ := testHandler()
	for _, auth := range []string{"", "wrong-token"} {
		if w := put(t, h, "stream.m3u8", livePlaylist, "", auth); w.Code != http.StatusForbidden {
			t.Fatalf("auth %q was accepted with %d", auth, w.Code)
		}
	}
	// An unknown room must not be distinguishable from a bad credential.
	req := httptest.NewRequest(http.MethodPut, "/r/other-room/stream.m3u8", strings.NewReader("x"))
	req.Header.Set("Authorization", "Bearer "+publishToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("unknown room returned %d, which leaks which rooms exist", w.Code)
	}
}

// TestGuestsNeverNeedACredential: a guest with no account is the product.
func TestGuestsNeverNeedACredential(t *testing.T) {
	h, _ := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	put(t, h, "seg7.mp4", "audio-bytes", "video/mp4", publishToken)

	if w := get(t, h, "stream.m3u8"); w.Code != http.StatusOK {
		t.Fatalf("unauthenticated playlist read = %d", w.Code)
	}
	w := get(t, h, "seg7.mp4")
	if w.Code != http.StatusOK || w.Body.String() != "audio-bytes" {
		t.Fatalf("unauthenticated media read = %d %q", w.Code, w.Body.String())
	}
}

// TestBlockingReloadHoldsUntilThePartExists is what makes this relay
// low-latency rather than merely functional. Answering immediately with a stale
// playlist would push every client a part or more further behind.
func TestBlockingReloadHoldsUntilThePartExists(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)

	room, _ := store.Room(roomToken, false)
	done := make(chan []byte, 1)
	go func() {
		// Ask for a part that does not exist yet: segment 8, part 1.
		body, err := room.Playlist(8, 1, time.Now().Add(3*time.Second))
		if err != nil {
			done <- nil
			return
		}
		done <- body
	}()

	select {
	case <-done:
		t.Fatal("the request returned before the requested part existed")
	case <-time.After(150 * time.Millisecond):
	}

	next := strings.Replace(livePlaylist,
		`#EXT-X-PART:DURATION=0.15000,URI="seg8_part0.mp4"`,
		"#EXT-X-PART:DURATION=0.15000,URI=\"seg8_part0.mp4\"\n#EXT-X-PART:DURATION=0.15000,URI=\"seg8_part1.mp4\"", 1)
	put(t, h, "stream.m3u8", next, "", publishToken)

	select {
	case body := <-done:
		if body == nil || !strings.Contains(string(body), "seg8_part1.mp4") {
			t.Fatalf("released with the wrong playlist: %s", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("publishing the part never released the blocked request")
	}
}

// TestBlockingReloadTimesOutWithAPlaylist: a stalled Mac must not pin guest
// connections open, and must not hand a native player an error, which ends the
// stream rather than causing a retry.
func TestBlockingReloadTimesOutWithAPlaylist(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	room, _ := store.Room(roomToken, false)

	start := time.Now()
	body, err := room.Playlist(99, 0, time.Now().Add(200*time.Millisecond))
	if err != nil {
		t.Fatalf("timeout returned an error instead of a playlist: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("timeout returned an empty playlist")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("blocked for %v, past the deadline", elapsed)
	}
}

func TestPlaylistHasCountsSequencesAndParts(t *testing.T) {
	pl := []byte(livePlaylist)
	// Segment 7 is complete, so it and anything before it are available.
	for _, msn := range []int64{6, 7} {
		if !playlistHas(pl, msn, -1) {
			t.Fatalf("segment %d should be available", msn)
		}
	}
	// Segment 8 is open with exactly one part published.
	if !playlistHas(pl, 8, 0) {
		t.Fatal("segment 8 part 0 should be available")
	}
	if playlistHas(pl, 8, 1) {
		t.Fatal("segment 8 part 1 has not been published yet")
	}
	if playlistHas(pl, 9, 0) {
		t.Fatal("segment 9 does not exist yet")
	}
}

// TestUnknownRoomAndAgedMediaAre404: both mean the guest should reattach rather
// than retry one file forever.
func TestUnknownRoomAndAgedMediaAre404(t *testing.T) {
	h, _ := testHandler()
	req := httptest.NewRequest(http.MethodGet, "/r/nope/stream.m3u8", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown room = %d", w.Code)
	}

	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	if w := get(t, h, "gone.mp4"); w.Code != http.StatusNotFound {
		t.Fatalf("missing media = %d", w.Code)
	}
}

// TestTraversalIsRefused: names arrive in URLs and are attacker controlled.
func TestTraversalIsRefused(t *testing.T) {
	h, _ := testHandler()
	for _, bad := range []string{"../secret", "a/../../b"} {
		if w := put(t, h, bad, "x", "", publishToken); w.Code != http.StatusBadRequest {
			t.Fatalf("upload accepted %q with %d", bad, w.Code)
		}
	}
}

// TestMediaWindowIsBounded: a long set must not grow memory without limit.
func TestMediaWindowIsBounded(t *testing.T) {
	h, store := testHandler()
	for i := 0; i < maxMediaPerRoom+50; i++ {
		put(t, h, "part"+itoa(i)+".mp4", "x", "video/mp4", publishToken)
	}
	room, _ := store.Room(roomToken, false)
	room.mu.Lock()
	held := len(room.media)
	room.mu.Unlock()
	if held > maxMediaPerRoom {
		t.Fatalf("room holds %d media files, past the %d cap", held, maxMediaPerRoom)
	}
}

// TestIdleRoomsAreDropped is the no-retained-content invariant enforced rather
// than promised: a party that ended leaves nothing behind.
func TestIdleRoomsAreDropped(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	if store.Stats().Rooms != 1 {
		t.Fatal("room was not created")
	}

	now := time.Now().Add(roomIdleTimeout + time.Minute)
	store.now = func() time.Time { return now }
	if dropped := store.Sweep(); dropped != 1 {
		t.Fatalf("swept %d rooms, want 1", dropped)
	}
	if s := store.Stats(); s.Rooms != 0 || s.MediaFiles != 0 {
		t.Fatalf("state survived the party: %+v", s)
	}
	if w := get(t, h, "stream.m3u8"); w.Code != http.StatusNotFound {
		t.Fatalf("a dropped room still serves audio: %d", w.Code)
	}
}

// TestRoomAPIServesReadsWithoutTheMac is the scaling property of the room plane:
// guest reads come from what the Mac last published, so they cost the Mac nothing.
func TestRoomAPIServesReadsWithoutTheMac(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	room, _ := store.Room(roomToken, false)

	if w := get(t, h, "api/status"); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unpublished status should be not-ready, got %d", w.Code)
	}

	room.Plane().Publish("status", json.RawMessage(`{"live":true}`), 1.0)
	w := get(t, h, "api/status")
	if w.Code != http.StatusOK || w.Body.String() != `{"live":true}` {
		t.Fatalf("status read = %d %q", w.Code, w.Body.String())
	}
}

// TestRoomAPIAggregatesBeatsAndQueuesWrites: beats become one digest and writes
// wait for the Mac, so neither scales the Mac's load with attendance.
func TestRoomAPIAggregatesBeatsAndQueuesWrites(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	room, _ := store.Room(roomToken, false)
	room.Plane().Publish("status", json.RawMessage(`{}`), 1.0)

	for i := 0; i < 50; i++ {
		req := httptest.NewRequest(http.MethodPost,
			"/r/"+roomToken+"/api/heartbeat?cid=guest"+itoa(i)+"&lat=1100", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusNoContent {
			t.Fatalf("heartbeat = %d", w.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/r/"+roomToken+"/api/post", strings.NewReader(`{"text":"hi"}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("post = %d", w.Code)
	}

	digest := room.Plane().Drain()
	if digest.Listeners != 50 {
		t.Fatalf("listeners = %d, want 50", digest.Listeners)
	}
	if len(digest.Writes) != 1 || digest.Writes[0].Path != "post" {
		t.Fatalf("writes = %+v", digest.Writes)
	}
}

// TestHostRoutingKeepsGuestPathsAbsolute: serving a room on its own hostname is
// what lets guest pages use the same absolute paths they use on the LAN.
func TestHostRoutingKeepsGuestPathsAbsolute(t *testing.T) {
	store := NewStore()
	h := NewHandler(Config{
		BaseDomain: "relay.example",
		Tokens:     func(string) (string, bool) { return publishToken, true },
	}, store)

	req := httptest.NewRequest(http.MethodPut, "/stream.m3u8", strings.NewReader(livePlaylist))
	req.Host = roomToken + ".relay.example"
	req.Header.Set("Authorization", "Bearer "+publishToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("host-routed upload = %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/stream.m3u8", nil)
	req.Host = roomToken + ".relay.example"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != livePlaylist {
		t.Fatalf("host-routed read = %d", w.Code)
	}
}

// TestHealthExposesOnlyAggregates: an operational endpoint must never leak party
// content.
func TestHealthExposesOnlyAggregates(t *testing.T) {
	h, _ := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	put(t, h, "seg7.mp4", "audio-bytes", "video/mp4", publishToken)

	req := httptest.NewRequest(http.MethodGet, "/__pp/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("health = %d", w.Code)
	}
	body := w.Body.String()
	for _, leak := range []string{roomToken, "audio-bytes", "PROGRAM-DATE-TIME", publishToken} {
		if strings.Contains(body, leak) {
			t.Fatalf("health leaked %q: %s", leak, body)
		}
	}
	var stats Stats
	if err := json.Unmarshal([]byte(body), &stats); err != nil || stats.Rooms != 1 {
		t.Fatalf("health payload = %s (%v)", body, err)
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var digits []byte
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	return string(digits)
}
