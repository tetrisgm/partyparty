package origin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"partyparty/internal/contribute"
	"partyparty/internal/origin"
	"partyparty/internal/schedule"
)

// This is the whole relay path with nothing stubbed between the two halves: a
// fake MediaMTX on loopback, the real contribution pusher, the real origin, and
// a guest reading over HTTP. It is the test that would have caught the missing
// initialization segment, and it is what proves the room schedule survives the
// relay rather than merely that each half compiles.

// The multivariant playlist MediaMTX serves, naming a media playlist whose name
// this side does not get to choose.
const macMaster = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-STREAM-INF:BANDWIDTH=327500,CODECS="mp4a.40.2"
audio1_stream.m3u8
`

// PART-HOLD-BACK here is the muxer's own value, derived from the real part
// duration. The room's declared hold-back is longer, and the contribution path
// is responsible for authoring it, exactly as the direct path does. A relayed
// guest running on this raw number would sit at a different point in the stream
// from every direct guest, which is the disagreement the schedule exists to
// prevent.
const macPlaylistV1 = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.42750
#EXT-X-PART-INF:PART-TARGET=0.15000
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z
#EXT-X-PART:DURATION=0.15000,URI="seg7_part0.mp4"
#EXTINF:0.50000,
seg7.mp4
#EXT-X-PART:DURATION=0.15000,URI="seg8_part0.mp4"
`

const macPlaylistV2 = macPlaylistV1 + `#EXT-X-PART:DURATION=0.15000,URI="seg8_part1.mp4"
`

// fakeMac serves what a DJ Mac's MediaMTX actually serves on loopback, including
// the parts that are inconvenient.
//
// Two behaviours here are not decoration. MediaMTX answers 401 for any path it
// does not recognise, and it REQUIRES a session cookie on the media playlist
// while handing that cookie out on the multivariant one. An earlier version of
// this fake served any URL ending in .m3u8 to anyone, so contribution passed
// every test while pointing at a path that does not exist and would have been
// refused even if it did. Relayed guests received nothing, and nothing here
// noticed. A fake that is more permissive than the real thing tests only itself.
type fakeMac struct {
	mu       sync.Mutex
	playlist string
}

func (f *fakeMac) setPlaylist(p string) {
	f.mu.Lock()
	f.playlist = p
	f.mu.Unlock()
}

func (f *fakeMac) handler() http.Handler {
	const sessionCookie = "mediamtx-session"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
		switch {
		case name == "index.m3u8":
			http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "s1", Path: "/"})
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(macMaster))
		case name == "audio1_stream.m3u8":
			if c, err := r.Cookie(sessionCookie); err != nil || c.Value == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			f.mu.Lock()
			body := f.playlist
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(body))
		case strings.HasSuffix(name, ".m3u8"):
			// Any other playlist name is not a thing MediaMTX serves.
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		default:
			// Media bytes are unique per file so the guest side can prove it received
			// exactly what the Mac produced.
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("bytes-of-" + name))
		}
	})
}

func TestRelayPathEndToEnd(t *testing.T) {
	mac := &fakeMac{playlist: macPlaylistV1}
	macSrv := httptest.NewServer(mac.handler())
	defer macSrv.Close()

	store := origin.NewStore()
	originSrv := httptest.NewServer(origin.NewHandler(origin.Config{
		Tokens: func(room string) (string, bool) {
			if room == "room1" {
				return "publish-secret", true
			}
			return "", false
		},
	}, store))
	defer originSrv.Close()

	pusher := contribute.New(contribute.Config{
		SourceURL: macSrv.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return originSrv.URL + "/r/room1/", "publish-secret" },
		Logf:      func(string, ...any) {},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx)
	pusher.SetEnabled(true)

	guest := originSrv.Client()
	playlistURL := originSrv.URL + "/r/room1/stream.m3u8"

	// 1. A guest eventually receives the Mac's playlist, byte for byte.
	var body string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := guest.Get(playlistURL)
		if err == nil {
			buf := new(strings.Builder)
			_, _ = copyAll(buf, resp)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				body = buf.String()
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	want := string(schedule.RewritePlaylist([]byte(macPlaylistV1)))
	if body != want {
		t.Fatalf("guest playlist differs from the Mac's.\n--- got ---\n%s\n--- want ---\n%s", body, want)
	}
	if !strings.Contains(body, "#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z") {
		t.Fatal("the capture stamp did not survive the relay, so the room schedule cannot")
	}
	// The declared hold-back, not the muxer's raw one. A relayed guest that ran on
	// the raw value would sit at a different point in the stream from every direct
	// guest, and the two would only disagree when someone stood between them.
	if !strings.Contains(body, "PART-HOLD-BACK=0.90000") {
		t.Fatalf("relayed guests are not on the room's declared schedule:\n%s", body)
	}

	// 2. Every media file the playlist names is fetchable, including the
	//    initialization segment. Without init.mp4 the stream is undecodable, which
	//    presents as guests hearing nothing at all.
	for _, name := range []string{"init.mp4", "seg7_part0.mp4", "seg7.mp4", "seg8_part0.mp4"} {
		resp, err := guest.Get(originSrv.URL + "/r/room1/" + name)
		if err != nil {
			t.Fatalf("guest fetch %s: %v", name, err)
		}
		buf := new(strings.Builder)
		_, _ = copyAll(buf, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("guest fetch %s = %d", name, resp.StatusCode)
		}
		if buf.String() != "bytes-of-"+name {
			t.Fatalf("%s arrived altered: %q", name, buf.String())
		}
	}

	// 3. A blocking reload for a part that does not exist yet is held, then
	//    released by the Mac publishing it. This is what keeps the relay
	//    low-latency instead of turning every client into a poller.
	released := make(chan string, 1)
	go func() {
		resp, err := guest.Get(playlistURL + "?_HLS_msn=8&_HLS_part=1")
		if err != nil {
			released <- ""
			return
		}
		buf := new(strings.Builder)
		_, _ = copyAll(buf, resp)
		resp.Body.Close()
		released <- buf.String()
	}()

	select {
	case <-released:
		t.Fatal("the blocking reload returned before the part existed")
	case <-time.After(200 * time.Millisecond):
	}

	mac.setPlaylist(macPlaylistV2)
	select {
	case got := <-released:
		if !strings.Contains(got, "seg8_part1.mp4") {
			t.Fatalf("blocking reload released with a stale playlist: %s", got)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("publishing the part never released the blocked guest")
	}

	// 4. The Mac's uplink stays flat: each media file is uploaded once no matter
	//    how many times the playlist is re-pushed.
	if pushed := pusher.Snapshot().Pushed; pushed > 8 {
		t.Fatalf("uploaded %d media files for a 5-file window; the dedupe is not working", pushed)
	}
}

func TestRelayPhotoQueuedSourceEndToEnd(t *testing.T) {
	store := origin.NewStore()
	originSrv := httptest.NewTLSServer(origin.NewHandler(origin.Config{
		BaseDomain: "example.com",
		Tokens: func(room string) (string, bool) {
			return "publish-secret", room == "room1"
		},
	}, store))
	defer originSrv.Close()

	port := originSrv.Listener.Addr().(*net.TCPAddr).Port
	roomURL := fmt.Sprintf("https://room1.example.com:%d", port)
	originAddr := originSrv.Listener.Addr().String()
	transport := originSrv.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, originAddr)
	}
	client := &http.Client{Transport: transport}

	publish, err := http.NewRequest(http.MethodPut, roomURL+"/stream.m3u8", strings.NewReader(macPlaylistV1))
	if err != nil {
		t.Fatal(err)
	}
	publish.Header.Set("Authorization", "Bearer publish-secret")
	publishResp, err := client.Do(publish)
	if err != nil {
		t.Fatalf("publish room: %v", err)
	}
	publishResp.Body.Close()
	if publishResp.StatusCode != http.StatusNoContent {
		t.Fatalf("publish room = %d", publishResp.StatusCode)
	}

	upload, err := http.NewRequest(http.MethodPost, roomURL+"/api/upload", strings.NewReader("jpeg-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	upload.Header.Set("Content-Type", "image/jpeg")
	upload.Header.Set("X-PP-Name", "party.jpg")
	uploadResp, err := client.Do(upload)
	if err != nil {
		t.Fatalf("upload photo: %v", err)
	}
	uploadResp.Body.Close()
	if uploadResp.StatusCode != http.StatusOK {
		t.Fatalf("upload photo = %d", uploadResp.StatusCode)
	}

	room, _ := store.Room("room1", false)
	digest := room.Plane().Drain()
	if len(digest.Writes) != 1 || digest.Writes[0].Path != "relay-upload" {
		t.Fatalf("photo transfer action = %+v", digest.Writes)
	}
	var action struct {
		Source string `json:"source"`
	}
	if err := json.Unmarshal(digest.Writes[0].Body, &action); err != nil || action.Source == "" {
		t.Fatalf("decode photo transfer action %q: %v", digest.Writes[0].Body, err)
	}

	photoResp, err := client.Get(action.Source)
	if err != nil {
		t.Fatalf("GET queued source %q: %v", action.Source, err)
	}
	photoBody, err := io.ReadAll(photoResp.Body)
	photoResp.Body.Close()
	if err != nil {
		t.Fatalf("read queued source %q: %v", action.Source, err)
	}
	if photoResp.StatusCode != http.StatusOK || string(photoBody) != "jpeg-bytes" {
		t.Fatalf("GET queued source %q = %d %q", action.Source, photoResp.StatusCode, photoBody)
	}
}

func copyAll(dst *strings.Builder, resp *http.Response) (int, error) {
	buf := make([]byte, 4096)
	total := 0
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			dst.Write(buf[:n])
			total += n
		}
		if err != nil {
			return total, nil
		}
	}
}

// An origin restart mid-party empties the store while the Mac's uploads keep
// succeeding, so from the Mac everything looks fine. Rolling segment names
// recover on their own; the two FIXED names (the init segment named by
// EXT-X-MAP and the guest page) are deduped by the Mac and would never be sent
// again. Without init.mp4 the stream is undecodable, so every guest joining
// after the restart hears nothing for the rest of the night. The room epoch on
// PUT responses is what lets the Mac notice and re-send.
func TestOriginRestartRecoversFixedNameAssets(t *testing.T) {
	mac := &fakeMac{playlist: macPlaylistV1}
	macSrv := httptest.NewServer(mac.handler())
	defer macSrv.Close()

	store := origin.NewStore()
	cfg := origin.Config{Tokens: func(room string) (string, bool) { return "secret", room == "room1" }}
	originSrv := httptest.NewServer(origin.NewHandler(cfg, store))
	defer originSrv.Close()

	pusher := contribute.New(contribute.Config{
		SourceURL: macSrv.URL + "/party/index.m3u8",
		Page:      func() []byte { return []byte("<html>party</html>") },
		Target:    func() (string, string) { return originSrv.URL + "/r/room1/", "secret" },
		Logf:      func(string, ...any) {},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx)
	pusher.SetEnabled(true)

	guest := originSrv.Client()
	waitFor200 := func(name string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			resp, err := guest.Get(originSrv.URL + "/r/room1/" + name)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return
				}
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("%s never became fetchable", name)
	}
	waitFor200("init.mp4")
	waitFor200("index.html")

	// The restart: same address, empty store. Uploads keep succeeding.
	*store = *origin.NewStore()

	waitFor200("init.mp4")
	waitFor200("index.html")
}
