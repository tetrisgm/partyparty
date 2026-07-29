package origin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"partyparty/internal/contribute"
	"partyparty/internal/origin"
)

// This is the whole relay path with nothing stubbed between the two halves: a
// fake MediaMTX on loopback, the real contribution pusher, the real origin, and
// a guest reading over HTTP. It is the test that would have caught the missing
// initialization segment, and it is what proves the room schedule survives the
// relay rather than merely that each half compiles.

const macPlaylistV1 = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.90000
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

// fakeMac serves what a DJ Mac's MediaMTX serves on loopback.
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
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".m3u8") {
			f.mu.Lock()
			body := f.playlist
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(body))
			return
		}
		// Media bytes are unique per file so the guest side can prove it received
		// exactly what the Mac produced.
		name := r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("bytes-of-" + name))
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
		SourceURL:  macSrv.URL + "/party/stream.m3u8",
		TargetBase: originSrv.URL + "/r/room1/",
		Token:      "publish-secret",
		Logf:       func(string, ...any) {},
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
	if body != macPlaylistV1 {
		t.Fatalf("guest playlist differs from the Mac's.\n--- got ---\n%s\n--- want ---\n%s", body, macPlaylistV1)
	}
	if !strings.Contains(body, "#EXT-X-PROGRAM-DATE-TIME:2026-07-29T21:14:03.250Z") {
		t.Fatal("the capture stamp did not survive the relay, so the room schedule cannot")
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
