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

func TestUnknownRoomRootWaitsForPublication(t *testing.T) {
	h, _ := testHandler()
	w := get(t, h, "")
	if w.Code != http.StatusOK {
		t.Fatalf("unpublished room root = %d, want a retrying join page", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "Connecting to the DJ") ||
		!strings.Contains(body, "location.reload()") ||
		strings.Contains(body, "room is not live") {
		t.Fatalf("unexpected waiting page: %q", body)
	}

	put(t, h, "index.html", "<html>party ready</html>", "text/html", publishToken)
	w = get(t, h, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "party ready") {
		t.Fatalf("published room root = %d %q", w.Code, w.Body.String())
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

// The listener page long-polls with wait=1 and breathes 150ms between answers,
// because on the Mac's own server the parked request IS the pacing. An origin
// that answers instantly turns every relayed guest into a 7-requests-a-second
// hot loop. So: a guest that proves what it already has (If-None-Match) parks
// until the content changes, and a guest without proof is answered immediately.
func TestRoomAPIParksLongPollUntilContentChanges(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	room, _ := store.Room(roomToken, false)
	room.Plane().Publish("feed", json.RawMessage(`{"posts":1}`), 1.0)

	// No proof of current content: answered immediately, with a validator.
	first := get(t, h, "api/feed?wait=1")
	if first.Code != http.StatusOK {
		t.Fatalf("first poll = %d", first.Code)
	}
	tag := first.Header().Get("ETag")
	if tag == "" {
		t.Fatal("no ETag on a room read; the page cannot prove what it has")
	}

	// Proof of current content: the request parks until the feed changes.
	released := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/r/"+roomToken+"/api/feed?wait=1", nil)
		req.Header.Set("If-None-Match", tag)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		released <- w
	}()
	select {
	case w := <-released:
		t.Fatalf("poll with current ETag answered instantly with %q; the hot loop is back", w.Body.String())
	case <-time.After(200 * time.Millisecond):
	}

	room.Plane().Publish("feed", json.RawMessage(`{"posts":2}`), 1.0)
	select {
	case w := <-released:
		if w.Body.String() != `{"posts":2}` {
			t.Fatalf("released with stale feed: %q", w.Body.String())
		}
		if w.Header().Get("ETag") == tag {
			t.Fatal("new content served under the old validator")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a feed change never released the parked poll")
	}
}

// A set longer than the live window must not lose its fixed-name assets. The
// page and the init segment are uploaded once at the start of a set, which
// makes them the OLDEST objects in the room, and oldest-first eviction deleted
// exactly those two a few minutes in: every guest joining after that got a 404
// page and an undecodable stream while the room looked healthy. Found live, on
// a phone, showing "not in the live window" where the party should have been.
func TestLongSetsKeepThePageAndInitSegment(t *testing.T) {
	h, store := testHandler()
	put(t, h, "index.html", "<html>party</html>", "text/html", publishToken)
	put(t, h, "party_init.mp4", "init-bytes", "video/mp4", publishToken)
	put(t, h, "stream.m3u8", "#EXTM3U\n#EXT-X-MAP:URI=\"party_init.mp4\"\nseg0.mp4\n", "", publishToken)

	// Three windows' worth of rolling media: everything older should age out,
	// except what a new guest permanently needs.
	for i := 0; i < 1600; i++ {
		put(t, h, "seg"+itoa(i)+".mp4", "media", "video/mp4", publishToken)
	}

	if w := get(t, h, "index.html"); w.Code != http.StatusOK {
		t.Fatalf("the guest page aged out of a live set: %d", w.Code)
	}
	if w := get(t, h, "party_init.mp4"); w.Code != http.StatusOK {
		t.Fatalf("the init segment aged out; every new guest is undecodable: %d", w.Code)
	}
	if w := get(t, h, "seg0.mp4"); w.Code != http.StatusNotFound {
		t.Fatalf("rolling media did not age out: %d", w.Code)
	}
	room, _ := store.Room(roomToken, false)
	if s := store.Stats(); s.MediaFiles > 520 {
		t.Fatalf("window not enforced: %d files", s.MediaFiles)
	}
	_ = room
}

// The listener page sends heartbeats as GET (a fetch with no method), and the
// Mac's server accepts that. The origin matched POST only, so every relayed
// heartbeat bounced and a phone audibly playing counted as nobody, all night.
// The page's actual wire format is the contract; this pins it.
func TestHeartbeatArrivesTheWayThePageSendsIt(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)
	room, _ := store.Room(roomToken, false)

	req := httptest.NewRequest(http.MethodGet,
		"/r/"+roomToken+"/api/heartbeat?stalled=0&paused=1&cid=phone1&lat=1100&name=Seth&emoji=headphones&dj=dj-2", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("GET heartbeat = %d; the page's real heartbeat is refused", w.Code)
	}
	digest := room.Plane().Drain()
	if digest.Listeners != 1 {
		t.Fatalf("a heartbeating phone counts as %d listeners", digest.Listeners)
	}
	if len(digest.Roster) != 1 || digest.Roster[0].Name != "Seth" ||
		digest.Roster[0].DJID != "dj-2" || !digest.Roster[0].Paused {
		t.Fatalf("heartbeat roster = %+v", digest.Roster)
	}
}

func TestRelayPhotoUploadReturnsMediaAndQueuesMacTransfer(t *testing.T) {
	h, store := testHandler()
	put(t, h, "stream.m3u8", livePlaylist, "", publishToken)

	req := httptest.NewRequest(http.MethodPost, "/r/"+roomToken+"/api/upload", strings.NewReader("jpeg-bytes"))
	req.Host = roomToken + ".relay.partyparty.party"
	req.Header.Set("Content-Type", "image/jpeg")
	req.Header.Set("X-PP-Name", "party.jpg")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("photo upload = %d %q", w.Code, w.Body.String())
	}
	var media struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if json.Unmarshal(w.Body.Bytes(), &media) != nil || media.ID == "" || media.Type != "image" {
		t.Fatalf("photo response = %q", w.Body.String())
	}
	got := get(t, h, media.ID)
	if got.Code != http.StatusOK || got.Body.String() != "jpeg-bytes" {
		t.Fatalf("photo fetch = %d %q", got.Code, got.Body.String())
	}
	room, _ := store.Room(roomToken, false)
	digest := room.Plane().Drain()
	if len(digest.Writes) != 1 || digest.Writes[0].Path != "relay-upload" ||
		!strings.Contains(string(digest.Writes[0].Body), "/media/"+media.ID) {
		t.Fatalf("photo transfer action = %+v", digest.Writes)
	}

	req = httptest.NewRequest(http.MethodPost, "/r/"+roomToken+"/api/upload", strings.NewReader("video"))
	req.Header.Set("Content-Type", "video/mp4")
	req.Header.Set("X-PP-Name", "party.mp4")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("relay video upload = %d, want conflict", w.Code)
	}
}

// Relayed guests are exactly the ones on congested venue networks, and the
// guest page is ~200KB of HTML. The Mac's own server has always gzipped it;
// the origin must not make the constrained path pay four times the bytes.
func TestOriginGzipsThePageButNeverMedia(t *testing.T) {
	h, _ := testHandler()
	big := "<html>" + strings.Repeat("party ", 2000) + "</html>"
	put(t, h, "index.html", big, "text/html", publishToken)
	put(t, h, "seg1.mp4", strings.Repeat("m", 4096), "video/mp4", publishToken)

	req := httptest.NewRequest(http.MethodGet, "/r/"+roomToken+"/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("page served raw to a gzip-capable guest (%d bytes)", w.Body.Len())
	}
	if w.Body.Len() >= len(big)/2 {
		t.Fatalf("gzip did not meaningfully shrink the page: %d of %d", w.Body.Len(), len(big))
	}

	req = httptest.NewRequest(http.MethodGet, "/r/"+roomToken+"/seg1.mp4", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("Content-Encoding") == "gzip" {
		t.Fatal("media must never be recompressed on the serving path")
	}
}
