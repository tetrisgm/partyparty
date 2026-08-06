package origin_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"partyparty/internal/contribute"
	"partyparty/internal/mediamtx"
	"partyparty/internal/origin"
)

// This test runs the REAL MediaMTX binary with the app's REAL generated config,
// publishes real audio into it with the bundled ffmpeg, and runs the real
// contributor against it. It exists because every fake of MediaMTX this repo
// ever wrote was more permissive than the real thing, and the difference
// shipped: contribution pointed at a playlist path MediaMTX does not serve, got
// 401 on every cycle, and relayed guests received nothing while the whole suite
// stayed green. A fake cannot catch the fake being wrong. This can.
//
// Skipped in -short and when the bundled binaries are absent, so unit runs and
// foreign checkouts lose nothing.

func repoAsset(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "assets", name))
	if err != nil {
		t.Skipf("cannot resolve assets dir: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("bundled %s not present at %s", name, path)
	}
	return path
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("no free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestRealMediaMTXContributionEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("real-binary integration test")
	}
	mtxBin := repoAsset(t, "mediamtx")
	ffmpegBin := repoAsset(t, "ffmpeg")

	dir := t.TempDir()
	rtspPort, hlsPort := freePort(t), freePort(t)

	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if err := mediamtx.GenerateSelfSignedCert(certPath, keyPath, []string{"127.0.0.1"}, nil); err != nil {
		t.Fatalf("cert: %v", err)
	}
	cfgPath := filepath.Join(dir, "mediamtx.yml")
	// The exact shape main.go writes, so the contract under test is the
	// production contract: LL-HLS, TLS, sessions, the muxer's own file naming.
	if err := mediamtx.WriteConfig(cfgPath, mediamtx.ConfigOpts{
		RTSPPort: rtspPort, HLSPort: hlsPort, Path: "party",
		CertPath: certPath, KeyPath: keyPath,
		SegDur: "500ms", PartDur: "180ms", SegCount: 8,
	}); err != nil {
		t.Fatalf("config: %v", err)
	}

	mtx := mediamtx.NewServer(mtxBin, cfgPath, os.Stderr)
	if err := mtx.Start(); err != nil {
		t.Fatalf("mediamtx start: %v", err)
	}
	defer mtx.Stop()
	if err := mtx.EnsureReady(rtspPort, hlsPort, 15*time.Second); err != nil {
		t.Fatalf("mediamtx never became ready: %v", err)
	}

	// Real audio in: a sine published over RTSP, exactly the leg the broadcast
	// tee feeds in production.
	publish := exec.Command(ffmpegBin,
		"-hide_banner", "-loglevel", "error",
		"-re", "-f", "lavfi", "-i", "sine=frequency=440",
		"-c:a", "aac", "-b:a", "128k",
		"-f", "rtsp", "-rtsp_transport", "tcp",
		fmt.Sprintf("rtsp://127.0.0.1:%d/party", rtspPort))
	publish.Stdin = nil
	if err := publish.Start(); err != nil {
		t.Fatalf("ffmpeg publish: %v", err)
	}
	defer func() {
		_ = publish.Process.Kill()
		_, _ = publish.Process.Wait()
	}()

	store := origin.NewStore()
	originSrv := httptest.NewServer(origin.NewHandler(origin.Config{
		Tokens: func(room string) (string, bool) { return "secret", room == "room1" },
	}, store))
	defer originSrv.Close()

	pusher := contribute.New(contribute.Config{
		SourceURL: fmt.Sprintf("https://127.0.0.1:%d/party/index.m3u8", hlsPort),
		Page:      func() []byte { return []byte("<html>party</html>") },
		Target:    func() (string, string) { return originSrv.URL + "/r/room1/", "secret" },
		Logf:      t.Logf,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx)
	pusher.SetEnabled(true)

	// A relayed guest fetches the playlist the Mac published. Getting here at
	// all proves the contributor speaks real MediaMTX: the master playlist, the
	// session cookie the media playlist demands, the muxer's own file names.
	guest := originSrv.Client()
	var playlist string
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := guest.Get(originSrv.URL + "/r/room1/stream.m3u8")
		if err == nil {
			buf := new(strings.Builder)
			_, _ = copyAll(buf, resp)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && strings.Contains(buf.String(), "#EXT-X-MAP") {
				playlist = buf.String()
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if playlist == "" {
		t.Fatal("no playlist ever reached a relayed guest from real MediaMTX")
	}

	// The room's declared schedule, not the muxer's raw hold-back.
	if !strings.Contains(playlist, "PART-HOLD-BACK=2.90000") {
		t.Fatalf("relayed playlist is not on the declared schedule:\n%s", playlist)
	}
	// The stamp the whole sync design rides on.
	if !strings.Contains(playlist, "#EXT-X-PROGRAM-DATE-TIME:") {
		t.Fatalf("PROGRAM-DATE-TIME missing; the room schedule cannot survive:\n%s", playlist)
	}

	// Every media file the playlist names must be fetchable, including the
	// fixed-name init segment, and must be real bytes rather than empty objects.
	for _, name := range mediaNamesFromPlaylist(playlist) {
		resp, err := guest.Get(originSrv.URL + "/r/room1/" + name)
		if err != nil {
			t.Fatalf("guest fetch %s: %v", name, err)
		}
		buf := new(strings.Builder)
		n, _ := copyAll(buf, resp)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK && n > 0 {
			continue
		}
		if resp.StatusCode == http.StatusNotFound && !strings.Contains(name, "init") {
			continue // a part can age out of the live window between listing and fetching
		}
		t.Fatalf("guest fetch %s = %d (%d bytes)", name, resp.StatusCode, n)
	}
}

// mediaNamesFromPlaylist pulls every URI out of a media playlist the way a
// player would, without reusing the contributor's own parser: an assertion that
// shares code with the thing it checks can only agree with it.
func mediaNamesFromPlaylist(playlist string) []string {
	var names []string
	for _, line := range strings.Split(playlist, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXT-X-MAP:") || strings.HasPrefix(line, "#EXT-X-PART:"):
			if i := strings.Index(line, `URI="`); i >= 0 {
				rest := line[i+len(`URI="`):]
				if j := strings.IndexByte(rest, '"'); j >= 0 {
					names = append(names, rest[:j])
				}
			}
		case strings.HasPrefix(line, "#"):
		default:
			names = append(names, line)
		}
	}
	return names
}
