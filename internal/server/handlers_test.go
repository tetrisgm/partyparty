package server

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"partyparty/internal/broadcast"
	"partyparty/internal/config"
	"partyparty/internal/event"
	"partyparty/internal/stats"
)

type testEnv struct {
	srv    *Srv
	bc     *broadcast.Broadcaster
	runDir string
}

const djAddr = "127.0.0.1:1234"

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
		"wall.html":     {Data: []byte("<html>wall __PP_VERSION__</html>")},
		"covers/hero.jpg": {
			Data: []byte("jpg stub"),
		},
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

func doBody(s *Srv, method, target, remoteAddr, contentType string, body *bytes.Buffer) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func multipartUpload(t *testing.T, name, contentType string) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	h.Set("Content-Type", contentType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("media bytes")); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return body, mw.FormDataContentType()
}

func rawUpload(s *Srv, remoteAddr, name, contentType string, data []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/upload", bytes.NewReader(data))
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-PP-Name", url.QueryEscape(name))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
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
	if _, ok := body["streamUrl"]; ok {
		t.Errorf("streamUrl should be gone (HTTPS-only, LL-HLS only): %v", body["streamUrl"])
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
	streamSync, ok := body["streamSync"].(map[string]any)
	if !ok || streamSync["ready"] != false || streamSync["generation"] != 0.0 {
		t.Errorf("streamSync = %#v, want idle/not-ready generation 0", body["streamSync"])
	}
	urls, ok := body["urls"].(map[string]any)
	if !ok {
		t.Fatalf("urls is not an object: %T", body["urls"])
	}
	if p, _ := urls["primary"].(string); !strings.HasPrefix(p, "http://") {
		t.Errorf("primary url = %q, want http:// before activation", p)
	}
	hotspot, ok := body["hotspot"].(map[string]any)
	if !ok {
		t.Fatalf("hotspot is not an object: %T", body["hotspot"])
	}
	if hotspot["mode"] != "online" {
		t.Errorf("hotspot.mode = %v, want online", hotspot["mode"])
	}
	if _, ok := hotspot["bridgeUp"].(bool); !ok {
		t.Errorf("hotspot.bridgeUp missing/not bool: %v", hotspot["bridgeUp"])
	}
	if _, ok := hotspot["bridgeIP"].(string); !ok {
		t.Errorf("hotspot.bridgeIP missing/not string: %v", hotspot["bridgeIP"])
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
	reach, ok := body["reachability"].(map[string]any)
	if !ok {
		t.Fatalf("reachability missing/not an object: %T", body["reachability"])
	}
	if reach["state"] != "ok" || reach["reason"] != "" || reach["guestSeen"] != false {
		t.Errorf("reachability = %v, want ok with no reason/guest", reach)
	}
}

func TestUpdateCheckEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)

	if w := do(env.srv, http.MethodGet, "/api/update/check", djAddr); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /api/update/check = %d, want 405", w.Code)
	}
	if w := do(env.srv, http.MethodPost, "/api/update/check", "192.168.1.50:1234"); w.Code != http.StatusForbidden {
		t.Fatalf("guest POST /api/update/check = %d, want 403", w.Code)
	}

	w := do(env.srv, http.MethodPost, "/api/update/check", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/update/check = %d: %s", w.Code, w.Body.String())
	}
	body := decodeJSON(t, w)
	if body["ok"] != true {
		t.Fatalf("ok = %v, want true", body["ok"])
	}
	if body["appVersion"] != "test-1.2.3" {
		t.Fatalf("appVersion = %v, want test-1.2.3", body["appVersion"])
	}
	if body["payloadChanged"] != false {
		t.Fatalf("payloadChanged = %v, want false", body["payloadChanged"])
	}
	if body["appUpdate"] != false {
		t.Fatalf("appUpdate = %v, want false", body["appUpdate"])
	}
}

func TestMediaThumbRouteServesGuardedThumb(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m, err := ev.SaveMedia("photo.jpg", strings.NewReader("original"))
	if err != nil {
		t.Fatal(err)
	}
	thumbDir := filepath.Join(ev.Dir(), "media", "thumbs")
	if err := os.WriteFile(filepath.Join(thumbDir, m.ID+".jpg"), []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})

	w := do(s, "GET", "/media/thumb/"+m.ID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("thumb route = %d, body %q", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "thumb" {
		t.Fatalf("body = %q, want thumb", got)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("Cache-Control = %q, want immutable", cc)
	}

	w = do(s, "GET", "/media/thumb/../"+m.ID, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("traversal route = %d, want 404", w.Code)
	}
}

func TestEventFeatureGatesGuestWrites(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	guest := "192.168.1.44:3333"
	postJSON := func(target, remote string, body any) *httptest.ResponseRecorder {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, target, remote, "application/json", bytes.NewBuffer(data))
	}
	assertDisabled := func(w *httptest.ResponseRecorder) {
		t.Helper()
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d, body %q; want 403", w.Code, w.Body.String())
		}
		body := decodeJSON(t, w)
		if body["disabled"] != true || body["error"] == "" {
			t.Fatalf("disabled response = %#v", body)
		}
	}

	if err := ev.SetFeature("comments", false); err != nil {
		t.Fatal(err)
	}
	assertDisabled(postJSON("/api/post", guest, map[string]any{"cid": "c1", "author": "Guest", "emoji": "🎉", "text": "hello"}))
	if err := ev.SetFeature("comments", true); err != nil {
		t.Fatal(err)
	}
	w := postJSON("/api/post", guest, map[string]any{"cid": "c1", "author": "Guest", "emoji": "🎉", "text": "hello"})
	if w.Code != http.StatusOK {
		t.Fatalf("post on status = %d, body %q", w.Code, w.Body.String())
	}
	postID, _ := decodeJSON(t, w)["id"].(string)
	if postID == "" {
		t.Fatalf("post id missing: %q", w.Body.String())
	}

	if err := ev.SetFeature("comments", false); err != nil {
		t.Fatal(err)
	}
	assertDisabled(postJSON("/api/comment", guest, map[string]any{"post": postID, "cid": "c2", "author": "Guest", "emoji": "🎉", "text": "reply"}))
	if err := ev.SetFeature("comments", true); err != nil {
		t.Fatal(err)
	}
	w = postJSON("/api/comment", guest, map[string]any{"post": postID, "cid": "c2", "author": "Guest", "emoji": "🎉", "text": "reply"})
	if w.Code != http.StatusOK {
		t.Fatalf("comment on status = %d, body %q", w.Code, w.Body.String())
	}

	if err := ev.SetFeature("uploads", false); err != nil {
		t.Fatal(err)
	}
	body, ct := multipartUpload(t, "photo.jpg", "image/jpeg")
	assertDisabled(doBody(s, http.MethodPost, "/api/upload", guest, ct, body))
	if err := ev.SetFeature("uploads", true); err != nil {
		t.Fatal(err)
	}
	body, ct = multipartUpload(t, "photo.jpg", "image/jpeg")
	w = doBody(s, http.MethodPost, "/api/upload", "192.168.1.45:3333", ct, body)
	if w.Code != http.StatusOK {
		t.Fatalf("image upload on status = %d, body %q", w.Code, w.Body.String())
	}

	if err := ev.SetFeature("videoUploads", false); err != nil {
		t.Fatal(err)
	}
	body, ct = multipartUpload(t, "clip.mp4", "video/mp4")
	assertDisabled(doBody(s, http.MethodPost, "/api/upload", "192.168.1.46:3333", ct, body))
	if err := ev.SetFeature("videoUploads", true); err != nil {
		t.Fatal(err)
	}
	body, ct = multipartUpload(t, "clip.mp4", "video/mp4")
	w = doBody(s, http.MethodPost, "/api/upload", "192.168.1.47:3333", ct, body)
	if w.Code != http.StatusOK {
		t.Fatalf("video upload on status = %d, body %q", w.Code, w.Body.String())
	}
}

func TestGuestUploadsAreNotRateLimited(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	guest := "192.168.1.44:3333"

	for _, name := range []string{"one.jpg", "two.jpg", "three.mov"} {
		body, ct := multipartUpload(t, name, "application/octet-stream")
		w := doBody(s, http.MethodPost, "/api/upload", guest, ct, body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s upload status = %d, body %q", name, w.Code, w.Body.String())
		}
	}
}

func TestRawGuestUploadPreservesOriginalBytes(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	want := bytes.Repeat([]byte{0x00, 0x1f, 0x80, 0xff, 0x42}, (2<<20)/5)
	w := rawUpload(s, "192.168.1.44:3333", "dance floor + original.mov", "video/quicktime", want)
	if w.Code != http.StatusOK {
		t.Fatalf("raw upload status = %d, body %q", w.Code, w.Body.String())
	}
	body := decodeJSON(t, w)
	id, _ := body["id"].(string)
	if id == "" || body["name"] != "dance floor + original.mov" || body["size"] != float64(len(want)) {
		t.Fatalf("raw upload response = %#v", body)
	}
	path, ok := ev.MediaPath(id)
	if !ok {
		t.Fatalf("uploaded media %q missing", id)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("stored upload changed: got %d bytes, want %d byte-for-byte", len(got), len(want))
	}
}

func TestGuestProfilePersistsWithoutKeepsakeClaim(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	profile, _ := json.Marshal(map[string]string{"cid": "phone-1", "name": "Neon Fox", "emoji": "🪩"})
	w := doBody(s, http.MethodPost, "/api/guest-profile", "192.168.1.44:3333", "application/json", bytes.NewBuffer(profile))
	if w.Code != http.StatusOK {
		t.Fatalf("guest profile status = %d, body %q", w.Code, w.Body.String())
	}
	post, _ := json.Marshal(map[string]string{"cid": "phone-1", "author": "Neon Fox", "emoji": "🪩", "text": "hello"})
	w = doBody(s, http.MethodPost, "/api/post", "192.168.1.44:3333", "application/json", bytes.NewBuffer(post))
	if w.Code != http.StatusOK {
		t.Fatalf("guest post status = %d, body %q", w.Code, w.Body.String())
	}
	if _, exists := decodeJSON(t, w)["claimUrl"]; exists {
		t.Fatalf("post response still issued a keepsake claim: %q", w.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(ev.Dir(), "guests.json"))
	if err != nil {
		t.Fatal(err)
	}
	var guests map[string]event.Guest
	if err := json.Unmarshal(data, &guests); err != nil {
		t.Fatal(err)
	}
	g := guests["phone-1"]
	if g.Pseudonym != "Neon Fox" || g.Emoji != "🪩" || g.TokenHash != "" {
		t.Fatalf("guest profile = %#v", g)
	}
}

func TestEventFeaturesDJBypass(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"wallMode", "uploads", "comments", "videoUploads"} {
		if err := ev.SetFeature(name, false); err != nil {
			t.Fatal(err)
		}
	}
	s := New(Deps{Events: ev})
	post := map[string]any{"cid": "dj", "author": "DJ", "emoji": "🎧", "text": "still posting"}
	data, _ := json.Marshal(post)
	w := doBody(s, http.MethodPost, "/api/post", "127.0.0.1:1234", "application/json", bytes.NewBuffer(data))
	if w.Code != http.StatusOK {
		t.Fatalf("DJ post status = %d, body %q", w.Code, w.Body.String())
	}
	body, ct := multipartUpload(t, "clip.mp4", "video/mp4")
	w = doBody(s, http.MethodPost, "/api/upload", "127.0.0.1:1234", ct, body)
	if w.Code != http.StatusOK {
		t.Fatalf("DJ upload status = %d, body %q", w.Code, w.Body.String())
	}
}

func TestRecapGenerateAndZipRoutes(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	media, err := ev.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ev.AddPost("cid", "Guest", "*", "approved post", []event.Media{media}, false); err != nil {
		t.Fatal(err)
	}

	guest := "192.168.1.44:3333"
	w := do(s, http.MethodPost, "/api/recap/generate", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest recap generate status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/recap/generate", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ recap generate status = %d, body %q", w.Code, w.Body.String())
	}
	body := decodeJSON(t, w)
	if body["path"] == "" {
		t.Fatalf("recap response missing path: %#v", body)
	}
	if _, err := os.Stat(filepath.Join(ev.Dir(), "recap", "index.html")); err != nil {
		t.Fatalf("recap index missing: %v", err)
	}

	w = do(s, http.MethodGet, "/api/recap.zip", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest recap zip status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodGet, "/api/recap.zip", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("recap zip status = %d, body %q", w.Code, w.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, f := range zr.File {
		got[f.Name] = true
	}
	for _, name := range []string{"index.html", "manifest.json", "assets/" + media.ID} {
		if !got[name] {
			t.Fatalf("zip missing %s; got %#v", name, got)
		}
	}
}

func TestRemovedEventLifecycleRoutesReturnNotFound(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	for _, path := range []string{
		"/api/event-retention",
		"/api/event-end",
		"/api/event-cleanup",
		"/api/event-delete",
	} {
		if w := do(s, http.MethodPost, path, "127.0.0.1:1234"); w.Code != http.StatusNotFound {
			t.Errorf("POST %s status = %d, body %q; want 404", path, w.Code, w.Body.String())
		}
	}
}

func TestEventFeaturesEndpointAndFeedExposure(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})

	w := do(s, http.MethodPost, "/api/event-features?name=requests&on=1", "192.168.1.44:3333")
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest event-features status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/event-features?name=requests&on=1", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ event-features status = %d, body %q", w.Code, w.Body.String())
	}
	w = do(s, http.MethodGet, "/api/feed", "192.168.1.44:3333")
	if w.Code != http.StatusOK {
		t.Fatalf("feed status = %d, body %q", w.Code, w.Body.String())
	}
	body := decodeJSON(t, w)
	features, ok := body["features"].(map[string]any)
	if !ok {
		t.Fatalf("features missing/not object: %#v", body["features"])
	}
	if features["requests"] != true || features["videoUploads"] != true || features["uploads"] != true {
		t.Fatalf("feed features = %#v", features)
	}
}

func TestEventLinksEndpointValidationAndExposure(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := newTestEnv(t, nil)
	env.srv.Events = ev
	s := env.srv

	postLinks := func(remote, body string) *httptest.ResponseRecorder {
		t.Helper()
		return doBody(s, http.MethodPost, "/api/event-links", remote, "application/json", bytes.NewBufferString(body))
	}
	if w := postLinks("192.168.1.44:3333", `{"links":[{"type":"instagram","url":"https://instagram.com/dj","label":"DJ"}]}`); w.Code != http.StatusForbidden {
		t.Fatalf("guest event-links status = %d, want 403", w.Code)
	}
	if w := postLinks("127.0.0.1:1234", `{"links":[{"type":"website","url":"javascript:alert(1)","label":"bad"}]}`); w.Code != http.StatusBadRequest {
		t.Fatalf("javascript link status = %d, body %q; want 400", w.Code, w.Body.String())
	}
	w := postLinks("127.0.0.1:1234", `{"links":[{"type":"instagram","url":"https://instagram.com/dj","label":"DJ <main>"},{"type":"paypal","url":"https://paypal.me/dj","label":""}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("DJ event-links status = %d, body %q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "<main>") {
		t.Fatalf("event-links response kept a custom label: %q", w.Body.String())
	}
	body := decodeJSON(t, w)
	links, ok := body["links"].([]any)
	if !ok || len(links) != 2 {
		t.Fatalf("endpoint links = %#v, want 2", body["links"])
	}
	first := links[0].(map[string]any)
	if first["type"] != "instagram" || first["url"] != "https://instagram.com/dj" || first["label"] != "Instagram" {
		t.Fatalf("first endpoint link = %#v", first)
	}
	second := links[1].(map[string]any)
	if second["label"] != "PayPal" {
		t.Fatalf("second endpoint link = %#v, want default PayPal label", second)
	}

	feed := decodeJSON(t, do(s, http.MethodGet, "/api/feed", "192.168.1.44:3333"))
	if got, ok := feed["links"].([]any); !ok || len(got) != 2 {
		t.Fatalf("feed links = %#v, want 2", feed["links"])
	}
	status := decodeJSON(t, do(s, http.MethodGet, "/api/status", "127.0.0.1:1234"))
	eventState := status["event"].(map[string]any)
	if got, ok := eventState["links"].([]any); !ok || len(got) != 2 {
		t.Fatalf("status event links = %#v, want 2", eventState["links"])
	}
}

func TestReactionsGateLimitAndFeedAggregates(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	now := time.Now()
	s.limits.now = func() time.Time { return now }

	postReaction := func(cid, typ string) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(map[string]string{"cid": cid, "type": typ})
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, "/api/reactions", "192.168.1.44:3333", "application/json", bytes.NewBuffer(data))
	}
	feed := func() map[string]any {
		t.Helper()
		w := do(s, http.MethodGet, "/api/feed", "192.168.1.44:3333")
		if w.Code != http.StatusOK {
			t.Fatalf("feed status = %d, body %q", w.Code, w.Body.String())
		}
		return decodeJSON(t, w)
	}

	w := postReaction("c1", "fire")
	if w.Code != http.StatusForbidden {
		t.Fatalf("reactions off status = %d, body %q; want 403", w.Code, w.Body.String())
	}
	if err := ev.SetFeature("reactions", true); err != nil {
		t.Fatal(err)
	}

	w = postReaction("c1", "nope")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid reaction status = %d, body %q; want 400", w.Code, w.Body.String())
	}
	w = postReaction("c1", "fire")
	if w.Code != http.StatusNoContent {
		t.Fatalf("first reaction status = %d, body %q; want 204", w.Code, w.Body.String())
	}
	w = postReaction("c1", "heart")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited reaction status = %d, body %q; want 429", w.Code, w.Body.String())
	}

	for _, cid := range []string{"c2", "c3"} {
		w = postReaction(cid, "fire")
		if w.Code != http.StatusNoContent {
			t.Fatalf("burst reaction %s status = %d, body %q; want 204", cid, w.Code, w.Body.String())
		}
	}
	body := feed()
	reactions, ok := body["reactions"].(map[string]any)
	if !ok {
		t.Fatalf("reactions missing/not object: %#v", body["reactions"])
	}
	if reactions["fire"] != float64(3) || reactions["heart"] != float64(0) {
		t.Fatalf("reactions = %#v, want fire=3 heart=0", reactions)
	}
	spikes, ok := body["spikes"].(map[string]any)
	if !ok {
		t.Fatalf("spikes missing/not object: %#v", body["spikes"])
	}
	if spikes["fire"] != float64(3) {
		t.Fatalf("spikes = %#v, want fire=3", spikes)
	}
}

func TestTrackIDGateLimitFeedAndAskCount(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	now := time.Now()
	s.limits.now = func() time.Time { return now }

	// trackId now defaults on; this test exercises the off->hidden / on->shown
	// gate explicitly, so start it from off regardless of the default.
	if err := ev.SetFeature("trackId", false); err != nil {
		t.Fatal(err)
	}

	postTrackAsk := func(cid string) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(map[string]string{"cid": cid})
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, "/api/track-id-request", "192.168.1.44:3333", "application/json", bytes.NewBuffer(data))
	}
	feed := func(target, remote string) map[string]any {
		t.Helper()
		w := do(s, http.MethodGet, target, remote)
		if w.Code != http.StatusOK {
			t.Fatalf("feed status = %d, body %q", w.Code, w.Body.String())
		}
		return decodeJSON(t, w)
	}

	if w := postTrackAsk("c1"); w.Code != http.StatusForbidden {
		t.Fatalf("track ask off status = %d, body %q; want 403", w.Code, w.Body.String())
	}
	if _, err := ev.SetCurrentTrack("Hidden Tune", "Private Artist", ""); err != nil {
		t.Fatal(err)
	}
	body := feed("/api/feed", "192.168.1.44:3333")
	if _, ok := body["nowPlaying"]; ok {
		t.Fatalf("feed exposed nowPlaying while feature off: %#v", body["nowPlaying"])
	}

	if err := ev.SetFeature("trackId", true); err != nil {
		t.Fatal(err)
	}
	body = feed("/api/feed", "192.168.1.44:3333")
	nowPlaying, ok := body["nowPlaying"].(map[string]any)
	if !ok || nowPlaying["title"] != "Hidden Tune" || nowPlaying["artist"] != "Private Artist" {
		t.Fatalf("nowPlaying = %#v, want Hidden Tune/Private Artist", body["nowPlaying"])
	}
	recent, ok := body["recentTracks"].([]any)
	if !ok || len(recent) != 0 {
		t.Fatalf("recentTracks = %#v, want empty array", body["recentTracks"])
	}

	if w := postTrackAsk("c1"); w.Code != http.StatusNoContent {
		t.Fatalf("first track ask status = %d, body %q; want 204", w.Code, w.Body.String())
	}
	if w := postTrackAsk("c1"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited track ask status = %d, body %q; want 429", w.Code, w.Body.String())
	}
	if w := postTrackAsk("c2"); w.Code != http.StatusNoContent {
		t.Fatalf("second guest track ask status = %d, body %q; want 204", w.Code, w.Body.String())
	}

	body = feed("/api/feed", "127.0.0.1:1234")
	if body["trackAsks"] != float64(2) {
		t.Fatalf("DJ trackAsks = %#v, want 2", body["trackAsks"])
	}
	body = feed("/api/feed", "192.168.1.44:3333")
	if _, ok := body["trackAsks"]; ok {
		t.Fatalf("guest feed exposed trackAsks: %#v", body["trackAsks"])
	}

	setBody := bytes.NewBufferString(`{"title":"Next Tune","artist":"Next Artist","note":"closing"}`)
	w := doBody(s, http.MethodPost, "/api/track/current", "127.0.0.1:1234", "application/json", setBody)
	if w.Code != http.StatusOK {
		t.Fatalf("DJ set track status = %d, body %q", w.Code, w.Body.String())
	}
	body = feed("/api/feed", "127.0.0.1:1234")
	nowPlaying, ok = body["nowPlaying"].(map[string]any)
	if !ok || nowPlaying["title"] != "Next Tune" || nowPlaying["artist"] != "Next Artist" {
		t.Fatalf("DJ nowPlaying = %#v, want Next Tune/Next Artist", body["nowPlaying"])
	}
	recent, ok = body["recentTracks"].([]any)
	if !ok || len(recent) != 1 {
		t.Fatalf("DJ recentTracks = %#v, want one previous track", body["recentTracks"])
	}
	prev, ok := recent[0].(map[string]any)
	if !ok || prev["title"] != "Hidden Tune" {
		t.Fatalf("previous track = %#v, want Hidden Tune", recent[0])
	}
}

func TestRequestsGateLimitPrivateAndDJList(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	now := time.Now()
	s.limits.now = func() time.Time { return now }
	guest := "192.168.1.44:3333"
	postReq := func(cid, text, note, vibe string) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(map[string]string{"cid": cid, "text": text, "note": note, "vibe": vibe})
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, "/api/requests", guest, "application/json", bytes.NewBuffer(data))
	}

	w := postReq("cid-1", "Song nobody else should see", "", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("requests off status = %d, body %q; want 403", w.Code, w.Body.String())
	}
	if err := ev.SetFeature("requests", true); err != nil {
		t.Fatal(err)
	}
	w = postReq("cid-1", "Song nobody else should see", "when it fits", "faster")
	if w.Code != http.StatusOK {
		t.Fatalf("request status = %d, body %q", w.Code, w.Body.String())
	}
	w = postReq("cid-1", "Too soon", "", "")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate status = %d, body %q; want 429", w.Code, w.Body.String())
	}
	now = now.Add(requestLimitInterval)
	w = postReq("cid-1", "Bad vibe", "", "louder")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad vibe status = %d, body %q; want 400", w.Code, w.Body.String())
	}

	w = do(s, http.MethodGet, "/api/feed?cid=cid-2", guest)
	if w.Code != http.StatusOK {
		t.Fatalf("guest feed status = %d, body %q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "Song nobody else should see") || strings.Contains(w.Body.String(), "when it fits") {
		t.Fatalf("guest feed exposed request: %s", w.Body.String())
	}

	w = do(s, http.MethodGet, "/api/requests", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest request list status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodGet, "/api/requests", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ request list status = %d, body %q", w.Code, w.Body.String())
	}
	body := decodeJSON(t, w)
	reqs, ok := body["requests"].([]any)
	if !ok || len(reqs) != 1 {
		t.Fatalf("requests payload = %#v", body["requests"])
	}
	req, ok := reqs[0].(map[string]any)
	if !ok {
		t.Fatalf("request item = %#v", reqs[0])
	}
	if req["text"] != "Song nobody else should see" || req["note"] != "when it fits" || req["vibe"] != "faster" || req["state"] != "new" {
		t.Fatalf("DJ request = %#v", req)
	}
	if _, exposed := req["cid"]; exposed {
		t.Fatalf("DJ request exposed cid: %#v", req)
	}
	id, _ := req["id"].(string)
	w = do(s, http.MethodPost, "/api/requests/state?id="+id+"&state=starred", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest state status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/requests/state?id="+id+"&state=starred", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ state status = %d, body %q", w.Code, w.Body.String())
	}
	w = do(s, http.MethodGet, "/api/requests", "127.0.0.1:1234")
	body = decodeJSON(t, w)
	reqs = body["requests"].([]any)
	req = reqs[0].(map[string]any)
	if req["state"] != "starred" {
		t.Fatalf("state after update = %#v", req)
	}
}

func TestGuestPostsAreImmediatelyVisibleAndDeleteRoutesWork(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ev.SetModerationMode(event.ModerationPreApprove); err != nil {
		t.Fatal(err)
	}
	if got := ev.Meta().ModerationMode; got != event.ModerationPostModerate {
		t.Fatalf("legacy pre-approve mode = %q, want post_moderate", got)
	}
	s := New(Deps{Events: ev})
	postJSON := func(target, remote string, body any) *httptest.ResponseRecorder {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, target, remote, "application/json", bytes.NewBuffer(data))
	}
	postsFrom := func(target, remote string) []any {
		t.Helper()
		w := do(s, http.MethodGet, target, remote)
		if w.Code != http.StatusOK {
			t.Fatalf("feed %s status = %d, body %q", target, w.Code, w.Body.String())
		}
		posts, ok := decodeJSON(t, w)["posts"].([]any)
		if !ok {
			t.Fatalf("posts missing/not array: %q", w.Body.String())
		}
		return posts
	}

	w := postJSON("/api/post", "192.168.1.44:3333", map[string]any{"cid": "c1", "author": "Guest", "emoji": "🎉", "text": "visible now"})
	if w.Code != http.StatusOK {
		t.Fatalf("post status = %d, body %q", w.Code, w.Body.String())
	}
	postID, _ := decodeJSON(t, w)["id"].(string)
	if postID == "" {
		t.Fatal("post id missing")
	}
	other := postsFrom("/api/feed?cid=c2", "192.168.1.45:3333")
	if len(other) != 1 || other[0].(map[string]any)["state"] != event.StateApproved {
		t.Fatalf("other guest immediate feed = %#v", other)
	}
	own := postsFrom("/api/feed?cid=c1", "192.168.1.44:3333")
	if len(own) != 1 || own[0].(map[string]any)["state"] != event.StateApproved {
		t.Fatalf("own immediate feed = %#v", own)
	}
	dj := postsFrom("/api/feed", "127.0.0.1:1234")
	if len(dj) != 1 || dj[0].(map[string]any)["state"] != event.StateApproved {
		t.Fatalf("DJ feed = %#v", dj)
	}
	guestOnLoopback := postsFrom("/api/feed?guest=1", "127.0.0.1:1234")
	if len(guestOnLoopback) != 1 {
		t.Fatalf("guest-forced loopback feed = %#v, want visible post", guestOnLoopback)
	}

	w = postJSON("/api/comment", "192.168.1.45:3333", map[string]any{"post": postID, "cid": "c2", "author": "Other", "emoji": "✨", "text": "visible reply"})
	if w.Code != http.StatusOK {
		t.Fatalf("comment status = %d, body %q", w.Code, w.Body.String())
	}
	commentID, _ := decodeJSON(t, w)["id"].(string)
	if commentID == "" {
		t.Fatal("comment id missing")
	}
	other = postsFrom("/api/feed?cid=c2", "192.168.1.45:3333")
	comments, _ := other[0].(map[string]any)["comments"].([]any)
	if len(comments) != 1 || comments[0].(map[string]any)["state"] != event.StateApproved {
		t.Fatalf("immediate comment feed = %#v", other)
	}
	own = postsFrom("/api/feed?cid=c1", "192.168.1.44:3333")
	if comments, _ := own[0].(map[string]any)["comments"].([]any); len(comments) != 1 {
		t.Fatalf("other guest did not see comment: %#v", own)
	}
	w = postJSON("/api/comment-delete", "127.0.0.1:1234", map[string]any{"postID": postID, "commentID": commentID})
	if w.Code != http.StatusOK {
		t.Fatalf("comment-delete status = %d, body %q", w.Code, w.Body.String())
	}
	dj = postsFrom("/api/feed", "127.0.0.1:1234")
	if comments, _ := dj[0].(map[string]any)["comments"].([]any); len(comments) != 0 {
		t.Fatalf("comment survived delete: %#v", dj)
	}
}

func TestPostOnlyEndpoints(t *testing.T) {
	env := newTestEnv(t, nil)
	for _, p := range []string{"/api/start", "/api/stop", "/api/delivery", "/api/shutdown", "/api/open-settings", "/api/link-install"} {
		w := do(env.srv, "GET", p, "")
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d, want 405", p, w.Code)
		}
		if body := decodeJSON(t, w); body["error"] != "POST required" {
			t.Errorf("GET %s error = %v", p, body["error"])
		}
	}
}

func TestStopImmediatelyClearsWebListeners(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.SetWebListeners(7)
	w := do(env.srv, http.MethodPost, "/api/stop", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("stop status = %d, body %q", w.Code, w.Body.String())
	}
	if got := env.srv.webListeners.Load(); got != 0 {
		t.Fatalf("webListeners after stop = %d, want 0", got)
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

func TestDJControlEndpointsRejectedFromLAN(t *testing.T) {
	env := newTestEnv(t, nil)
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/start?device=test"},
		{http.MethodPost, "/api/stop"},
		{http.MethodPost, "/api/delivery?mode=hls"},
		{http.MethodPost, "/api/open-settings?pane=audio"},
		{http.MethodPost, "/api/link-install"},
		{http.MethodGet, "/api/network-situation"},
		{http.MethodGet, "/api/devices"},
	} {
		w := do(env.srv, tc.method, tc.path, "192.168.1.44:3333")
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", tc.method, tc.path, w.Code)
		}
		if body := decodeJSON(t, w); body["error"] != "DJ only" {
			t.Errorf("%s %s error = %v", tc.method, tc.path, body["error"])
		}
	}
}

func TestLinkInstallRejectsBadCode(t *testing.T) {
	env := newTestEnv(t, nil)
	body := bytes.NewBufferString(`{"code":"not-a-code"}`)
	w := doBody(env.srv, "POST", "/api/link-install", djAddr, "application/json", body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("link-install bad code = %d, want 400", w.Code)
	}
	if body := decodeJSON(t, w); body["error"] != "bad code" {
		t.Errorf("error = %v", body["error"])
	}
}

func TestStartValidationAndLifecycle(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.setAccountActivated(true) // past the activation gate; this test covers device/lifecycle

	w := do(env.srv, "POST", "/api/start", djAddr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("start without device = %d, want 400", w.Code)
	}
	if body := decodeJSON(t, w); body["error"] != "device required" {
		t.Errorf("error = %v", body["error"])
	}

	// Plain HLS is the offline-safe fallback: it can start before cert activation.
	w = do(env.srv, "POST", "/api/start?device=0", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("start real device in hls without cert = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	if env.bc.Status().State != "starting" {
		t.Fatal("broadcaster should have started in hls")
	}
	w = do(env.srv, "POST", "/api/stop", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("stop after hls start = %d", w.Code)
	}
	waitIdle(t, env.bc)

	// LL-HLS still needs the real cert; otherwise iOS rejects the stream URL.
	env.bc.SetDelivery("llhls")
	w = do(env.srv, "POST", "/api/start?device=0", djAddr)
	if w.Code != http.StatusConflict {
		t.Fatalf("start llhls real device without cert = %d, want 409", w.Code)
	}
	if env.bc.Status().State != "idle" {
		t.Fatal("broadcaster should not have started")
	}
	env.bc.SetDelivery("hls")

	// The test tone is always allowed — the DJ's own rehearsal.
	w = do(env.srv, "POST", "/api/start?device=test&bitrate=999k", djAddr)
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

	w = do(env.srv, "POST", "/api/stop", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("stop = %d", w.Code)
	}
	waitIdle(t, env.bc)

	// After activation the real-device gate opens.
	env.srv.SetActivation("party.example.net")
	w = do(env.srv, "POST", "/api/start?device=0&mono=1", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("start real device after activation = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	st = env.bc.Status()
	if st.State != "starting" || st.Channels != 1 {
		t.Fatalf("state/channels = %q/%d, want starting/1 (mono)", st.State, st.Channels)
	}
	do(env.srv, "POST", "/api/stop", djAddr)
	waitIdle(t, env.bc)
}

func TestStartStopCreatesDJFeedPosts(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.setAccountActivated(true)
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ev.SetMeta("Rooftop Ritual", "Ramine", "-"); err != nil {
		t.Fatal(err)
	}
	if err := ev.SetModerationMode(event.ModerationPreApprove); err != nil {
		t.Fatal(err)
	}
	env.srv.Events = ev

	w := do(env.srv, http.MethodPost, "/api/start?device=test", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body %q", w.Code, w.Body.String())
	}
	w = do(env.srv, http.MethodPost, "/api/stop", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("stop status = %d, body %q", w.Code, w.Body.String())
	}
	waitIdle(t, env.bc)
	// Repeating the lifecycle must replace the previous matching system post,
	// not fill the activity feed with duplicate starts and stops.
	w = do(env.srv, http.MethodPost, "/api/start?device=test", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("second start status = %d, body %q", w.Code, w.Body.String())
	}
	w = do(env.srv, http.MethodPost, "/api/stop", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("second stop status = %d, body %q", w.Code, w.Body.String())
	}
	waitIdle(t, env.bc)

	w = do(env.srv, http.MethodGet, "/api/feed?guest=1", "192.168.1.44:3333")
	if w.Code != http.StatusOK {
		t.Fatalf("feed status = %d, body %q", w.Code, w.Body.String())
	}
	posts, ok := decodeJSON(t, w)["posts"].([]any)
	if !ok {
		t.Fatalf("posts missing/not array: %q", w.Body.String())
	}
	if len(posts) != 2 {
		t.Fatalf("posts len = %d, want 2: %#v", len(posts), posts)
	}
	got := map[string]int{}
	for _, raw := range posts {
		p := raw.(map[string]any)
		if p["author"] != "Ramine" || p["emoji"] != "🎧" || p["dj"] != true || p["state"] != event.StateApproved {
			t.Fatalf("stream post = %#v", p)
		}
		got[p["text"].(string)]++
	}
	if got["Started the stream."] != 1 || got["Stopped the stream."] != 1 {
		t.Fatalf("stream posts = %#v", got)
	}
}

func TestDeliveryEndpoint(t *testing.T) {
	env := newTestEnv(t, nil)

	w := do(env.srv, "POST", "/api/delivery?mode=bogus", djAddr)
	if w.Code != http.StatusBadRequest {
		t.Errorf("bogus mode = %d, want 400", w.Code)
	}

	// MTX is nil → llhls is structurally unavailable.
	w = do(env.srv, "POST", "/api/delivery?mode=llhls", djAddr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("llhls without mediamtx = %d, want 400", w.Code)
	}
	if body := decodeJSON(t, w); !strings.Contains(body["error"].(string), "low-latency unavailable") {
		t.Errorf("error = %v", body["error"])
	}

	w = do(env.srv, "POST", "/api/delivery?mode=hls", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("hls mode = %d, want 200", w.Code)
	}
	if env.bc.Delivery() != "hls" {
		t.Errorf("delivery = %q", env.bc.Delivery())
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
	if w := do(env.srv, "GET", "/wall", ""); !strings.Contains(w.Body.String(), "wall") {
		t.Errorf("GET /wall body = %s", w.Body.String())
	}
	if w := do(env.srv, "GET", "/wall/", ""); w.Code != http.StatusOK {
		t.Errorf("GET /wall/ = %d", w.Code)
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
	w = do(env.srv, "GET", "/covers/hero.jpg", "")
	if w.Code != http.StatusOK {
		t.Errorf("cover = %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=3600" {
		t.Errorf("cover cache-control = %q", cc)
	}
	if w := do(env.srv, "GET", "/no-such-page", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown path (captive off) = %d, want 404", w.Code)
	}
	if w := do(env.srv, "GET", "/api/no-such", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown api = %d, want 404", w.Code)
	}

	captive := newTestEnv(t, func(c *config.Config) { c.Captive = true })
	body := decodeJSON(t, do(captive.srv, "GET", "/api/status", ""))
	if hotspot, _ := body["hotspot"].(map[string]any); hotspot["mode"] != "offline" {
		t.Errorf("captive hotspot.mode = %v, want offline", hotspot["mode"])
	}
	w = do(captive.srv, "GET", "/no-such-page", "")
	if w.Code != http.StatusFound {
		t.Fatalf("unknown path (captive on) = %d, want 302", w.Code)
	}
	if loc := w.Header().Get("Location"); !strings.HasPrefix(loc, "http://") {
		t.Errorf("redirect location = %q", loc)
	}
}

func TestGuestPageUsesGzipWhenSupported(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.Web = fstest.MapFS{
		"listener.html": {Data: bytes.Repeat([]byte("listener __PP_VERSION__ "), 1000)},
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "br, gzip")
	w := httptest.NewRecorder()
	env.srv.ServeHTTP(w, req)
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("content-encoding = %q, want gzip", got)
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	_ = zr.Close()
	if !bytes.Contains(body, []byte("test-1.2.3")) || bytes.Contains(body, []byte("__PP_VERSION__")) {
		t.Fatal("compressed guest page did not contain the stamped version")
	}
}

func TestLiveProxyUsesSameOriginPath(t *testing.T) {
	var gotPath, gotQuery string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		if r.URL.Query().Get("cookieCheck") == "" {
			w.Header().Set("Location", "/party/index.m3u8?cookieCheck=1")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-VERSION:10\n"))
	}))
	defer upstream.Close()
	u, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	env := newTestEnv(t, func(c *config.Config) { c.HLSPort = port })
	w := do(env.srv, http.MethodGet, "/live/party/index.m3u8", "192.168.1.25:5000")
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/live/party/index.m3u8?cookieCheck=1" {
		t.Fatalf("proxied redirect = %d location %q", w.Code, w.Header().Get("Location"))
	}
	w = do(env.srv, http.MethodGet, "/live/party/index.m3u8?cookieCheck=1&_HLS_msn=12&_HLS_part=3", "192.168.1.25:5000")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Body.String(), "#EXTM3U") {
		t.Fatalf("proxied playlist = %d %q", w.Code, w.Body.String())
	}
	if gotPath != "/party/index.m3u8" || gotQuery != "cookieCheck=1&_HLS_msn=12&_HLS_part=3" {
		t.Fatalf("upstream request = %s?%s", gotPath, gotQuery)
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
	w := do(env.srv, "GET", "/api/heartbeat?cid=abc&name=Neon%20Fox&emoji=%F0%9F%AA%A9&lat=250&plat=hls&del=llhls&rate=1&buf=3.5&v=test" /* v required since 0.26: no-v heartbeats are legacy zombie tabs */, "127.0.0.1:5000")
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat = %d", w.Code)
	}

	body := decodeJSON(t, do(env.srv, "GET", "/api/status", djAddr))
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
	if entry["name"] != "Neon Fox" || entry["emoji"] != "🪩" || entry["device"] == "" {
		t.Errorf("roster entry identity/device = %v/%v/%v", entry["name"], entry["emoji"], entry["device"])
	}
	guestBody := decodeJSON(t, do(env.srv, "GET", "/api/status", "192.168.1.99:6000"))
	guestEntry := guestBody["roster"].([]any)[0].(map[string]any)
	if guestEntry["name"] != "Neon Fox" || guestEntry["emoji"] != "🪩" {
		t.Errorf("public roster identity = %#v", guestEntry)
	}
	for _, private := range []string{"device", "ip", "platform", "delivery", "latencyMs"} {
		if _, exposed := guestEntry[private]; exposed {
			t.Errorf("public roster exposed %s: %#v", private, guestEntry)
		}
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
	if body["llhlsUrl"] != "https://party.example.net:8443/live/party/index.m3u8" {
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
	received, receivedOK := body["received"].(float64)
	sent, sentOK := body["sent"].(float64)
	if !receivedOK || !sentOK || received <= 0 || sent < received || ts != sent {
		t.Errorf("NTP timestamps = received:%v sent:%v t:%v", body["received"], body["sent"], body["t"])
	}
}
