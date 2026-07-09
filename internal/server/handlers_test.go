package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
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

func TestUploadLooksLikeBigVideo(t *testing.T) {
	if !uploadLooksLikeBigVideo("clip.MOV", liveGuestVideoDeferBytes, 0) {
		t.Fatal("large video should be deferred while live")
	}
	if uploadLooksLikeBigVideo("clip.mov", liveGuestVideoDeferBytes-1, liveGuestVideoDeferBytes-1) {
		t.Fatal("small video should upload immediately")
	}
	if uploadLooksLikeBigVideo("photo.jpg", liveGuestVideoDeferBytes, liveGuestVideoDeferBytes) {
		t.Fatal("large photo should not use the live video deferral path")
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

func TestEventEndMarksEndedAndBlocksGuestWrites(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	guest := "192.168.1.44:3333"
	postJSON := func(target, remote string, body any) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return doBody(s, http.MethodPost, target, remote, "application/json", bytes.NewBuffer(data))
	}
	w := do(s, http.MethodPost, "/api/event-end", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest event-end status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/event-end", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ event-end status = %d, body %q", w.Code, w.Body.String())
	}
	if ev.Meta().Status != event.StatusEnded || !ev.Ended() {
		t.Fatalf("event not ended: %#v", ev.Meta())
	}
	w = postJSON("/api/post", guest, map[string]any{"cid": "c1", "author": "Guest", "emoji": "🎉", "text": "too late"})
	if w.Code != http.StatusConflict {
		t.Fatalf("guest post after end status = %d, body %q; want 409", w.Code, w.Body.String())
	}
	w = postJSON("/api/requests", guest, map[string]any{"cid": "c1", "text": "track"})
	if w.Code != http.StatusConflict {
		t.Fatalf("guest request after end status = %d, body %q; want 409", w.Code, w.Body.String())
	}
	body, ct := multipartUpload(t, "photo.jpg", "image/jpeg")
	w = doBody(s, http.MethodPost, "/api/upload", guest, ct, body)
	if w.Code != http.StatusConflict {
		t.Fatalf("guest upload after end status = %d, body %q; want 409", w.Code, w.Body.String())
	}
	w = postJSON("/api/post", "127.0.0.1:1234", map[string]any{"cid": "dj", "author": "DJ", "emoji": "🎧", "text": "DJ can still post"})
	if w.Code != http.StatusOK {
		t.Fatalf("DJ post after end status = %d, body %q", w.Code, w.Body.String())
	}
}

func TestEventRetentionCleanupDeleteConfirmAndDJOnly(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})
	guest := "192.168.1.44:3333"

	if got := ev.Meta().RetentionMode; got != event.RetentionKeepApproved {
		t.Fatalf("default retention = %q, want keep_approved", got)
	}
	w := do(s, http.MethodPost, "/api/event-retention?mode=tonight_only", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest event-retention status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/event-retention?mode=tonight_only", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("DJ event-retention status = %d, body %q", w.Code, w.Body.String())
	}
	if got := ev.Meta().RetentionMode; got != event.RetentionTonightOnly {
		t.Fatalf("retention mode = %q, want tonight_only", got)
	}

	media, err := ev.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	post, _, err := ev.AddPost("cid", "Guest", "🎉", "", []event.Media{media}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := ev.SetPostState(post.ID, event.StatePending); err != nil {
		t.Fatal(err)
	}

	w = do(s, http.MethodPost, "/api/event-cleanup?confirm=1", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest event-cleanup status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/event-cleanup", "127.0.0.1:1234")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("event-cleanup without confirm status = %d, body %q; want 400", w.Code, w.Body.String())
	}
	w = do(s, http.MethodPost, "/api/event-cleanup?confirm=1", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("event-cleanup confirmed status = %d, body %q", w.Code, w.Body.String())
	}
	if _, ok := ev.MediaPath(media.ID); ok {
		t.Fatal("cleanup did not remove pending media")
	}

	media, err = ev.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ev.AddPost("cid", "Guest", "🎉", "", []event.Media{media}, false); err != nil {
		t.Fatal(err)
	}
	w = do(s, http.MethodPost, "/api/event-delete?confirm=1", guest)
	if w.Code != http.StatusForbidden {
		t.Fatalf("guest event-delete status = %d, want 403", w.Code)
	}
	w = do(s, http.MethodPost, "/api/event-delete", "127.0.0.1:1234")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("event-delete without confirm status = %d, body %q; want 400", w.Code, w.Body.String())
	}
	w = do(s, http.MethodPost, "/api/event-delete?confirm="+strings.ReplaceAll(event.DeleteEventConfirm, " ", "%20"), "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("event-delete confirmed status = %d, body %q", w.Code, w.Body.String())
	}
	_, ids, mediaCount := ev.Feed(0)
	if len(ids) != 0 || mediaCount != 0 {
		t.Fatalf("feed after event-delete ids=%v media=%d, want empty", ids, mediaCount)
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
	if features["requests"] != true || features["videoUploads"] != false || features["uploads"] != true {
		t.Fatalf("feed features = %#v", features)
	}
}

func TestEventLinksEndpointAndFeatureGatedExposure(t *testing.T) {
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
		t.Fatalf("event-links response did not JSON-escape label: %q", w.Body.String())
	}
	body := decodeJSON(t, w)
	links, ok := body["links"].([]any)
	if !ok || len(links) != 2 {
		t.Fatalf("endpoint links = %#v, want 2", body["links"])
	}
	first := links[0].(map[string]any)
	if first["type"] != "instagram" || first["url"] != "https://instagram.com/dj" || first["label"] != "DJ <main>" {
		t.Fatalf("first endpoint link = %#v", first)
	}
	second := links[1].(map[string]any)
	if second["label"] != "PayPal" {
		t.Fatalf("second endpoint link = %#v, want default PayPal label", second)
	}

	feed := decodeJSON(t, do(s, http.MethodGet, "/api/feed", "192.168.1.44:3333"))
	if got, ok := feed["links"].([]any); !ok || len(got) != 1 {
		t.Fatalf("feed links with tips off = %#v, want normal link only", feed["links"])
	}
	status := decodeJSON(t, do(s, http.MethodGet, "/api/status", "127.0.0.1:1234"))
	eventState := status["event"].(map[string]any)
	if got, ok := eventState["links"].([]any); !ok || len(got) != 1 {
		t.Fatalf("status event links with tips off = %#v, want normal link only", eventState["links"])
	}

	if err := ev.SetFeature("tippingLinks", true); err != nil {
		t.Fatal(err)
	}
	feed = decodeJSON(t, do(s, http.MethodGet, "/api/feed", "192.168.1.44:3333"))
	if got, ok := feed["links"].([]any); !ok || len(got) != 2 {
		t.Fatalf("feed links with tips on = %#v, want 2", feed["links"])
	}
	status = decodeJSON(t, do(s, http.MethodGet, "/api/status", "127.0.0.1:1234"))
	eventState = status["event"].(map[string]any)
	if got, ok := eventState["links"].([]any); !ok || len(got) != 2 {
		t.Fatalf("status event links with tips on = %#v, want 2", eventState["links"])
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

func TestModerationFeedAndRoutes(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ev.SetModerationMode(event.ModerationPreApprove); err != nil {
		t.Fatal(err)
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

	w := postJSON("/api/post", "192.168.1.44:3333", map[string]any{"cid": "c1", "author": "Guest", "emoji": "🎉", "text": "needs review"})
	if w.Code != http.StatusOK {
		t.Fatalf("post status = %d, body %q", w.Code, w.Body.String())
	}
	postID, _ := decodeJSON(t, w)["id"].(string)
	if postID == "" {
		t.Fatal("post id missing")
	}
	if got := len(postsFrom("/api/feed?cid=c2", "192.168.1.45:3333")); got != 0 {
		t.Fatalf("other guest posts = %d, want 0", got)
	}
	own := postsFrom("/api/feed?cid=c1", "192.168.1.44:3333")
	if len(own) != 1 || own[0].(map[string]any)["state"] != event.StatePending {
		t.Fatalf("own pending feed = %#v", own)
	}
	dj := postsFrom("/api/feed", "127.0.0.1:1234")
	if len(dj) != 1 || dj[0].(map[string]any)["state"] != event.StatePending {
		t.Fatalf("DJ pending feed = %#v", dj)
	}
	guestOnLoopback := postsFrom("/api/feed?guest=1", "127.0.0.1:1234")
	if len(guestOnLoopback) != 0 {
		t.Fatalf("guest-forced loopback feed = %#v, want approved-only", guestOnLoopback)
	}

	w = do(s, http.MethodPost, "/api/mod?id="+postID+"&state=approved", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("mod status = %d, body %q", w.Code, w.Body.String())
	}
	other := postsFrom("/api/feed?cid=c2", "192.168.1.45:3333")
	if len(other) != 1 || other[0].(map[string]any)["state"] != event.StateApproved {
		t.Fatalf("approved guest feed = %#v", other)
	}

	w = postJSON("/api/comment", "192.168.1.45:3333", map[string]any{"post": postID, "cid": "c2", "author": "Other", "emoji": "✨", "text": "pending reply"})
	if w.Code != http.StatusOK {
		t.Fatalf("comment status = %d, body %q", w.Code, w.Body.String())
	}
	commentID, _ := decodeJSON(t, w)["id"].(string)
	if commentID == "" {
		t.Fatal("comment id missing")
	}
	other = postsFrom("/api/feed?cid=c2", "192.168.1.45:3333")
	comments, _ := other[0].(map[string]any)["comments"].([]any)
	if len(comments) != 1 || comments[0].(map[string]any)["state"] != event.StatePending {
		t.Fatalf("own pending comment feed = %#v", other)
	}
	own = postsFrom("/api/feed?cid=c1", "192.168.1.44:3333")
	if comments, _ := own[0].(map[string]any)["comments"].([]any); len(comments) != 0 {
		t.Fatalf("other guest saw pending comment: %#v", own)
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
	w := do(env.srv, "GET", "/api/heartbeat?cid=abc&lat=250&plat=hls&del=llhls&rate=1&buf=3.5&v=test" /* v required since 0.26: no-v heartbeats are legacy zombie tabs */, "127.0.0.1:5000")
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
