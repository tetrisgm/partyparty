package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/stats"
)

type testEnv struct {
	srv    *Srv
	bc     *broadcast.Broadcaster
	runDir string
}

// newTestEnv builds a Srv over a stub ffmpeg, a temp run dir, an in-memory web
// FS, and no MediaMTX (MTX nil → LL-HLS unavailable).
func newTestEnv(t *testing.T, mutate func(*config.Config)) *testEnv {
	t.Helper()
	dir := t.TempDir()
	stub := filepath.Join(dir, "pp-ffmpeg-stub")
	script := "#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile :; do sleep 0.1; done\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(dir, "run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Port: 8000, TLSPort: 8443, Name: "partyparty",
		Bitrate: "320k", Codec: "aac", Channels: 2, SampleRate: 48000,
		HLSTime: 1, HLSList: 24, FFmpeg: stub,
		Delivery: "hls", RTSPPort: 8554, HLSPort: 8888, StreamPath: "party",
	}
	if mutate != nil {
		mutate(&cfg)
	}
	bc := broadcast.New(cfg, runDir, "", "")
	web := fstest.MapFS{
		"listener.html": {Data: []byte("<html>listener __PP_VERSION__</html>")},
		"dj.html":       {Data: []byte("<html>dj __PP_VERSION__</html>")},
		"vendor/hls.js": {Data: []byte("// hls.js stub")},
	}
	s := New(Deps{
		Config:      cfg,
		Broadcaster: bc,
		Listeners:   stats.New(15 * time.Second),
		RunDir:      runDir,
		Web:         web,
		MTX:         nil,
		Version:     "test-1.2.3",
	})
	t.Cleanup(func() {
		bc.Stop()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) && bc.Status().State != "idle" {
			time.Sleep(20 * time.Millisecond)
		}
	})
	return &testEnv{srv: s, bc: bc, runDir: runDir}
}

func do(s *Srv, method, target, remoteAddr string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func decodeJSON(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("response is not valid JSON: %v\n%s", err, w.Body.String())
	}
	return m
}

func waitIdle(t *testing.T, bc *broadcast.Broadcaster) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if bc.Status().State == "idle" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("broadcaster never returned to idle (state %q)", bc.Status().State)
}

func TestStatusEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)
	w := do(env.srv, "GET", "/api/status", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q", ct)
	}
	body := decodeJSON(t, w)
	if body["name"] != "partyparty" || body["appVersion"] != "test-1.2.3" {
		t.Errorf("name/appVersion wrong: %v / %v", body["name"], body["appVersion"])
	}
	bc, ok := body["broadcast"].(map[string]any)
	if !ok {
		t.Fatalf("broadcast is not an object: %T", body["broadcast"])
	}
	if bc["state"] != "idle" {
		t.Errorf("broadcast.state = %v, want idle", bc["state"])
	}
	if body["streamUrl"] != "/hls/stream.m3u8" {
		t.Errorf("streamUrl = %v", body["streamUrl"])
	}
	if body["llhlsAvailable"] != false {
		t.Errorf("llhlsAvailable = %v, want false (MTX nil)", body["llhlsAvailable"])
	}
	if body["llhlsUrl"] != "" {
		t.Errorf("llhlsUrl = %v, want empty", body["llhlsUrl"])
	}
	if body["delivery"] != "hls" {
		t.Errorf("delivery = %v", body["delivery"])
	}
	if body["latencyTarget"] != 10.0 { // plain HLS, 1s segments: 3*1+7
		t.Errorf("latencyTarget = %v, want 10", body["latencyTarget"])
	}
	urls, ok := body["urls"].(map[string]any)
	if !ok {
		t.Fatalf("urls is not an object: %T", body["urls"])
	}
	if p, _ := urls["primary"].(string); !strings.HasPrefix(p, "http://") {
		t.Errorf("primary url = %q, want http:// before activation", p)
	}
	act, ok := body["activation"].(map[string]any)
	if !ok || act["ready"] != false {
		t.Errorf("activation = %v, want ready:false", body["activation"])
	}
	if _, ok := body["health"].(map[string]any); !ok {
		t.Errorf("health missing/not an object: %v", body["health"])
	}
	if _, ok := body["roster"]; !ok {
		t.Error("roster missing")
	}
}

func TestPostOnlyEndpoints(t *testing.T) {
	env := newTestEnv(t, nil)
	for _, p := range []string{"/api/start", "/api/stop", "/api/delivery", "/api/shutdown", "/api/open-settings"} {
		w := do(env.srv, "GET", p, "")
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d, want 405", p, w.Code)
		}
		if body := decodeJSON(t, w); body["error"] != "POST required" {
			t.Errorf("GET %s error = %v", p, body["error"])
		}
	}
}

func TestShutdownRejectedFromLAN(t *testing.T) {
	env := newTestEnv(t, nil)
	// NOTE: the loopback success path calls os.Exit and is untestable in-process
	// by design; only the rejection is covered here.
	w := do(env.srv, "POST", "/api/shutdown", "192.168.1.44:3333")
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if body := decodeJSON(t, w); body["error"] != "localhost only" {
		t.Errorf("error = %v", body["error"])
	}
}

func TestStartValidationAndLifecycle(t *testing.T) {
	env := newTestEnv(t, nil)

	w := do(env.srv, "POST", "/api/start", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("start without device = %d, want 400", w.Code)
	}
	if body := decodeJSON(t, w); body["error"] != "device required" {
		t.Errorf("error = %v", body["error"])
	}

	// Real device before activation: rejected (no secure guest link yet).
	w = do(env.srv, "POST", "/api/start?device=0", "")
	if w.Code != http.StatusConflict {
		t.Fatalf("start real device without cert = %d, want 409", w.Code)
	}
	if env.bc.Status().State != "idle" {
		t.Fatal("broadcaster should not have started")
	}

	// The test tone is always allowed — the DJ's own rehearsal.
	w = do(env.srv, "POST", "/api/start?device=test&bitrate=999k", "")
	if w.Code != http.StatusOK {
		t.Fatalf("start test tone = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	st := env.bc.Status()
	if st.State != "starting" {
		t.Fatalf("state = %q, want starting", st.State)
	}
	if st.Bitrate != "320k" { // 999k fails the allowlist → config default
		t.Errorf("bitrate = %q, want default 320k (bad value must not pass through)", st.Bitrate)
	}

	w = do(env.srv, "POST", "/api/stop", "")
	if w.Code != http.StatusOK {
		t.Fatalf("stop = %d", w.Code)
	}
	waitIdle(t, env.bc)

	// After activation the real-device gate opens.
	env.srv.SetActivation("party.example.net")
	w = do(env.srv, "POST", "/api/start?device=0&mono=1", "")
	if w.Code != http.StatusOK {
		t.Fatalf("start real device after activation = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	st = env.bc.Status()
	if st.State != "starting" || st.Channels != 1 {
		t.Fatalf("state/channels = %q/%d, want starting/1 (mono)", st.State, st.Channels)
	}
	do(env.srv, "POST", "/api/stop", "")
	waitIdle(t, env.bc)
}

func TestDeliveryEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)

	w := do(env.srv, "POST", "/api/delivery?mode=bogus", "")
	if w.Code != http.StatusBadRequest {
		t.Errorf("bogus mode = %d, want 400", w.Code)
	}

	// MTX is nil → llhls is structurally unavailable.
	w = do(env.srv, "POST", "/api/delivery?mode=llhls", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("llhls without mediamtx = %d, want 400", w.Code)
	}
	if body := decodeJSON(t, w); !strings.Contains(body["error"].(string), "low-latency unavailable") {
		t.Errorf("error = %v", body["error"])
	}

	w = do(env.srv, "POST", "/api/delivery?mode=hls", "")
	if w.Code != http.StatusOK {
		t.Fatalf("hls mode = %d, want 200", w.Code)
	}
	if env.bc.Delivery() != "hls" {
		t.Errorf("delivery = %q", env.bc.Delivery())
	}
}

func TestHLSPlaylistInjection(t *testing.T) {
	playlist := "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nseg_00001.ts\n"

	t.Run("plain HLS injects the room target", func(t *testing.T) {
		env := newTestEnv(t, nil)
		if err := os.WriteFile(filepath.Join(env.runDir, "stream.m3u8"), []byte(playlist), 0o644); err != nil {
			t.Fatal(err)
		}
		w := do(env.srv, "GET", "/hls/stream.m3u8", "")
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/vnd.apple.mpegurl" {
			t.Errorf("content-type = %q", ct)
		}
		body := w.Body.String()
		// base 3*1+7 = 10 with zero adaptive delta
		if !strings.Contains(body, "#EXT-X-START:TIME-OFFSET=-10.0,PRECISE=YES") {
			t.Errorf("EXT-X-START tag missing/wrong:\n%s", body)
		}
		if !strings.HasPrefix(body, "#EXTM3U\n#EXT-X-START") {
			t.Errorf("tag not injected directly after #EXTM3U:\n%s", body)
		}
	})

	t.Run("llhls delivery leaves the fallback playlist untouched", func(t *testing.T) {
		env := newTestEnv(t, func(c *config.Config) { c.Delivery = "llhls" })
		if err := os.WriteFile(filepath.Join(env.runDir, "stream.m3u8"), []byte(playlist), 0o644); err != nil {
			t.Fatal(err)
		}
		w := do(env.srv, "GET", "/hls/stream.m3u8", "")
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d", w.Code)
		}
		if strings.Contains(w.Body.String(), "#EXT-X-START") {
			t.Errorf("llhls fallback playlist must not get an injected offset:\n%s", w.Body.String())
		}
	})

	t.Run("explicit start-offset overrides", func(t *testing.T) {
		env := newTestEnv(t, func(c *config.Config) { c.StartOffset = 2.5 })
		if err := os.WriteFile(filepath.Join(env.runDir, "stream.m3u8"), []byte(playlist), 0o644); err != nil {
			t.Fatal(err)
		}
		w := do(env.srv, "GET", "/hls/stream.m3u8", "")
		if !strings.Contains(w.Body.String(), "#EXT-X-START:TIME-OFFSET=-2.5,PRECISE=YES") {
			t.Errorf("start-offset override not injected:\n%s", w.Body.String())
		}
	})
}

func TestHLSFileFiltering(t *testing.T) {
	env := newTestEnv(t, nil)

	for _, p := range []string{
		"/hls/evil.txt",
		"/hls/seg_abc.ts",
		"/hls/other.m3u8",
		"/hls/../../etc/passwd",
	} {
		if w := do(env.srv, "GET", p, ""); w.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, w.Code)
		}
	}

	// Well-formed but absent → 404 from the file server.
	if w := do(env.srv, "GET", "/hls/seg_99999.ts", ""); w.Code != http.StatusNotFound {
		t.Errorf("missing segment = %d, want 404", w.Code)
	}

	// A real segment is served with never-cache headers.
	if err := os.WriteFile(filepath.Join(env.runDir, "seg_00001.ts"), []byte("tsdata"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := do(env.srv, "GET", "/hls/seg_00001.ts", "")
	if w.Code != http.StatusOK {
		t.Fatalf("segment = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "video/mp2t" {
		t.Errorf("content-type = %q", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store", cc)
	}
}

func TestWebPagesAndRouting(t *testing.T) {
	env := newTestEnv(t, nil)

	w := do(env.srv, "GET", "/", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET / = %d", w.Code)
	}
	if body := w.Body.String(); !strings.Contains(body, "test-1.2.3") || strings.Contains(body, "__PP_VERSION__") {
		t.Errorf("version not stamped into page: %s", body)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("cache-control = %q", cc)
	}

	if w := do(env.srv, "GET", "/dj", ""); !strings.Contains(w.Body.String(), "dj") {
		t.Errorf("GET /dj body = %s", w.Body.String())
	}
	if w := do(env.srv, "GET", "/dj/", ""); w.Code != http.StatusOK {
		t.Errorf("GET /dj/ = %d", w.Code)
	}
	if w := do(env.srv, "GET", "/favicon.ico", ""); w.Code != http.StatusNoContent {
		t.Errorf("favicon = %d, want 204", w.Code)
	}
	w = do(env.srv, "GET", "/vendor/hls.js", "")
	if w.Code != http.StatusOK {
		t.Errorf("vendor = %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=3600" {
		t.Errorf("vendor cache-control = %q", cc)
	}
	if w := do(env.srv, "GET", "/no-such-page", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown path (captive off) = %d, want 404", w.Code)
	}
	if w := do(env.srv, "GET", "/api/no-such", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown api = %d, want 404", w.Code)
	}

	captive := newTestEnv(t, func(c *config.Config) { c.Captive = true })
	w = do(captive.srv, "GET", "/no-such-page", "")
	if w.Code != http.StatusFound {
		t.Fatalf("unknown path (captive on) = %d, want 302", w.Code)
	}
	if loc := w.Header().Get("Location"); !strings.HasPrefix(loc, "http://") {
		t.Errorf("redirect location = %q", loc)
	}
}

func TestCaptiveProbes(t *testing.T) {
	env := newTestEnv(t, nil) // captive OFF: answer "online", never hijack
	if w := do(env.srv, "GET", "/generate_204", ""); w.Code != http.StatusNoContent {
		t.Errorf("android probe = %d, want 204", w.Code)
	}
	if w := do(env.srv, "GET", "/hotspot-detect.html", ""); !strings.Contains(w.Body.String(), "Success") {
		t.Errorf("apple probe body = %s", w.Body.String())
	}
	if w := do(env.srv, "GET", "/ncsi.txt", ""); w.Body.String() != "Microsoft NCSI" {
		t.Errorf("windows probe body = %q", w.Body.String())
	}

	captive := newTestEnv(t, func(c *config.Config) { c.Captive = true })
	w := do(captive.srv, "GET", "/generate_204", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Open the player") {
		t.Errorf("captive landing = %d %q", w.Code, w.Body.String())
	}
}

func TestHeartbeatAndRoster(t *testing.T) {
	env := newTestEnv(t, nil)
	// Loopback RemoteAddr keeps friendlyName from spawning a reverse-DNS lookup.
	w := do(env.srv, "GET", "/api/heartbeat?cid=abc&lat=250&plat=hls&del=llhls&rate=1&buf=3.5", "127.0.0.1:5000")
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat = %d", w.Code)
	}

	body := decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	if body["listeners"] != 1.0 {
		t.Errorf("listeners = %v, want 1", body["listeners"])
	}
	if body["listenersTotal"] != 1.0 {
		t.Errorf("listenersTotal = %v, want 1", body["listenersTotal"])
	}
	roster, ok := body["roster"].([]any)
	if !ok || len(roster) != 1 {
		t.Fatalf("roster = %v, want 1 entry", body["roster"])
	}
	entry := roster[0].(map[string]any)
	if entry["latencyMs"] != 250.0 || entry["hasLatency"] != true {
		t.Errorf("roster entry latency = %v/%v", entry["latencyMs"], entry["hasLatency"])
	}
	if entry["platform"] != "hls" || entry["delivery"] != "llhls" {
		t.Errorf("roster entry platform/delivery = %v/%v", entry["platform"], entry["delivery"])
	}
	lat, ok := body["latency"].(map[string]any)
	if !ok || lat["count"] != 1.0 {
		t.Errorf("latency spread = %v", body["latency"])
	}
}

func TestActivationFlow(t *testing.T) {
	env := newTestEnv(t, func(c *config.Config) { c.Delivery = "llhls" })

	body := decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	if act := body["activation"].(map[string]any); act["ready"] != false {
		t.Fatalf("activation before setup = %v", act)
	}
	if body["llhlsUrl"] != "" {
		t.Errorf("llhlsUrl before activation = %v, want empty", body["llhlsUrl"])
	}

	env.srv.SetActivationPending("waiting for the certificate")
	body = decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	if act := body["activation"].(map[string]any); act["reason"] != "waiting for the certificate" {
		t.Errorf("pending reason = %v", act["reason"])
	}

	env.srv.SetActivation("party.example.net")
	body = decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	act := body["activation"].(map[string]any)
	if act["ready"] != true || act["reason"] != "" {
		t.Errorf("activation after SetActivation = %v", act)
	}
	urls := body["urls"].(map[string]any)
	if urls["primary"] != "https://party.example.net:8443/" {
		t.Errorf("primary url = %v", urls["primary"])
	}
	if body["llhlsUrl"] != "https://party.example.net:8888/party/index.m3u8" {
		t.Errorf("llhlsUrl = %v", body["llhlsUrl"])
	}

	// A late "pending" must not regress a completed activation.
	env.srv.SetActivationPending("stale reason")
	body = decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	act = body["activation"].(map[string]any)
	if act["ready"] != true || act["reason"] != "" {
		t.Errorf("activation regressed by late pending: %v", act)
	}
}

func TestTimeEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)
	body := decodeJSON(t, do(env.srv, "GET", "/api/time", ""))
	ts, ok := body["t"].(float64)
	if !ok || ts <= 0 {
		t.Fatalf("t = %v", body["t"])
	}
	if drift := time.Since(time.UnixMilli(int64(ts))); drift < 0 || drift > 10*time.Second {
		t.Errorf("clock drift = %v", drift)
	}
}
