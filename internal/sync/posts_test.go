package postsync

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"partyparty/internal/publish"
)

func TestSyncPostsSkipsAckedAndPushesFresh(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "media"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "media", "old.jpg"), []byte("old-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "media", "fresh.jpg"), []byte("fresh-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	postsJSONL := `{"op":"post","cid":"old-cid","post":{"id":"old-post","ts":1000,"act":1000,"author":"Old","emoji":"x","text":"Already synced","media":[{"id":"old.jpg","type":"image","name":"old.jpg","size":9}]}}` + "\n" +
		`{"op":"post","cid":"fresh-cid","post":{"id":"fresh-post","ts":2000,"act":2000,"author":"Fresh","emoji":"y","text":"New","media":[{"id":"fresh.jpg","type":"image","name":"fresh.jpg","size":11}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "posts.jsonl"), []byte(postsJSONL), 0o644); err != nil {
		t.Fatal(err)
	}

	posts, err := readPosts(dir)
	if err != nil {
		t.Fatal(err)
	}
	var oldHash string
	for _, p := range posts {
		if p.cloud.LocalID == "old-post" {
			oldHash = p.hash
		}
	}
	if oldHash == "" {
		t.Fatal("old post not found")
	}
	oldMediaCloudID := cloudMediaID("old-post", "old.jpg")
	state := &stateFile{
		Version:   1,
		Slug:      "party-slug",
		InstallID: "abc123abc123",
		Posts: map[string]postAck{
			"old-post": {Hash: oldHash, AckedMS: 1},
		},
		Media: map[string]mediaAck{
			mediaStateKey("old-post", "old.jpg"): {CloudID: oldMediaCloudID, AckedMS: 1},
		},
	}
	if err := saveState(dir, state); err != nil {
		t.Fatal(err)
	}

	var postCalls, mediaCalls int
	var imported []string
	var mediaIDs []string
	oldClient := httpClient
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/broker/publish-posts":
			postCalls++
			var body struct {
				ID     string `json:"id"`
				Secret string `json:"secret"`
				Slug   string `json:"slug"`
				Posts  []struct {
					LocalID string `json:"localId"`
				} `json:"posts"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode publish-posts: %v", err)
			}
			if body.ID != "abc123abc123" || body.Secret != "secret" || body.Slug != "party-slug" {
				t.Errorf("bad publish-posts auth/body: %+v", body)
			}
			for _, p := range body.Posts {
				imported = append(imported, p.LocalID)
			}
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media":
			mediaCalls++
			if got := r.Header.Get("x-pp-id"); got != "abc123abc123" {
				t.Errorf("x-pp-id = %q", got)
			}
			if got := r.Header.Get("x-pp-slug"); got != "party-slug" {
				t.Errorf("x-pp-slug = %q", got)
			}
			if got := r.Header.Get("x-pp-post"); got != cloudPostID("party-slug", "abc123abc123", "fresh-post") {
				t.Errorf("x-pp-post = %q", got)
			}
			mediaIDs = append(mediaIDs, r.Header.Get("x-pp-media"))
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		default:
			return jsonResponse(http.StatusNotFound, map[string]any{"error": "not found"}), nil
		}
	})}
	t.Cleanup(func() { httpClient = oldClient })

	res, err := SyncPosts(t.Context(), dir, publish.Creds{ID: "abc123abc123", Secret: "secret"}, "party-slug", "https://broker.test")
	if err != nil {
		t.Fatal(err)
	}
	if res.PostsPushed != 1 || res.PostsSkipped != 1 || res.MediaPushed != 1 || res.MediaSkipped != 1 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if postCalls != 1 || mediaCalls != 1 {
		t.Fatalf("calls = posts:%d media:%d", postCalls, mediaCalls)
	}
	if len(imported) != 1 || imported[0] != "fresh-post" {
		t.Fatalf("imported = %v", imported)
	}
	if want := cloudMediaID("fresh-post", "fresh.jpg"); len(mediaIDs) != 1 || mediaIDs[0] != want {
		t.Fatalf("mediaIDs = %v, want %q", mediaIDs, want)
	}
}

func TestSyncPostsRoutesSmallSinglePutAndLargeMultipart(t *testing.T) {
	dir := writeSyncFixture(t, map[string]string{
		"small.jpg": "small",
		"large.mp4": "abcdefghijklmnopqrst",
	}, `{"op":"post","cid":"cid","post":{"id":"post-one","ts":1000,"act":1000,"author":"Guest","emoji":"x","text":"Media","media":[{"id":"small.jpg","type":"image","name":"small.jpg","size":5},{"id":"large.mp4","type":"video","name":"large.mp4","size":20}]}}`+"\n")
	restoreSyncTuning(t, 10, 5, 1)

	var singlePUTs, inits, completes int
	var parts []int
	installMediaTransport(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/broker/publish-posts":
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media":
			singlePUTs++
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media-multipart-init":
			inits++
			return jsonResponse(http.StatusOK, map[string]any{"ok": true, "uploadId": "upload-one", "mediaId": r.Header.Get("x-pp-media")}), nil
		case "/api/broker/publish-post-media-multipart-part":
			part, _ := strconv.Atoi(r.Header.Get("x-pp-part-number"))
			parts = append(parts, part)
			return jsonResponse(http.StatusOK, map[string]any{"ok": true, "partNumber": part, "etag": "etag-" + strconv.Itoa(part)}), nil
		case "/api/broker/publish-post-media-multipart-complete":
			completes++
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		default:
			return jsonResponse(http.StatusNotFound, map[string]any{"error": "not found"}), nil
		}
	})

	res, err := SyncPosts(t.Context(), dir, publish.Creds{ID: "abc123abc123", Secret: "secret"}, "party-slug", "https://broker.test")
	if err != nil {
		t.Fatal(err)
	}
	if res.MediaPushed != 2 || singlePUTs != 1 || inits != 1 || completes != 1 {
		t.Fatalf("res=%+v single=%d init=%d complete=%d", res, singlePUTs, inits, completes)
	}
	if !reflect.DeepEqual(parts, []int{1, 2, 3, 4}) {
		t.Fatalf("parts = %v, want 1..4", parts)
	}
}

func TestSyncPostsMultipartResumesUploadedParts(t *testing.T) {
	dir := writeSyncFixture(t, map[string]string{
		"clip.mp4": "abcdefghijklmnopqrst",
	}, `{"op":"post","cid":"cid","post":{"id":"post-one","ts":1000,"act":1000,"author":"Guest","emoji":"x","text":"Video","media":[{"id":"clip.mp4","type":"video","name":"clip.mp4","size":20}]}}`+"\n")
	restoreSyncTuning(t, 10, 4, 1)

	run := 1
	var uploaded []int
	var completed bool
	installMediaTransport(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/broker/publish-posts":
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media-multipart-init":
			return jsonResponse(http.StatusOK, map[string]any{"ok": true, "uploadId": "upload-one", "mediaId": r.Header.Get("x-pp-media")}), nil
		case "/api/broker/publish-post-media-multipart-part":
			part, _ := strconv.Atoi(r.Header.Get("x-pp-part-number"))
			if run == 1 && part == 3 {
				return jsonResponse(http.StatusServiceUnavailable, map[string]any{"error": "flaky"}), nil
			}
			uploaded = append(uploaded, part)
			return jsonResponse(http.StatusOK, map[string]any{"ok": true, "partNumber": part, "etag": "etag-" + strconv.Itoa(part)}), nil
		case "/api/broker/publish-post-media-multipart-complete":
			completed = true
			var body struct {
				Parts []multipartPartAck `json:"parts"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode complete: %v", err)
			}
			got := make([]int, 0, len(body.Parts))
			for _, p := range body.Parts {
				got = append(got, p.PartNumber)
			}
			if !reflect.DeepEqual(got, []int{1, 2, 3, 4, 5}) {
				t.Errorf("complete parts = %v", got)
			}
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		default:
			return jsonResponse(http.StatusNotFound, map[string]any{"error": "not found"}), nil
		}
	})

	res, err := SyncPosts(t.Context(), dir, publish.Creds{ID: "abc123abc123", Secret: "secret"}, "party-slug", "https://broker.test")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Offline {
		t.Fatalf("first run should stop offline after part 3 failures: %+v", res)
	}
	st := readStateForTest(t, dir)
	key := mediaStateKey("post-one", "clip.mp4")
	if got := doneParts(st.Uploads[key]); !reflect.DeepEqual(got, []int{1, 2}) {
		t.Fatalf("persisted parts = %v, want [1 2]", got)
	}

	run = 2
	uploaded = nil
	res, err = SyncPosts(t.Context(), dir, publish.Creds{ID: "abc123abc123", Secret: "secret"}, "party-slug", "https://broker.test")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offline || res.MediaPushed != 1 || !completed {
		t.Fatalf("second run did not complete: %+v completed=%v", res, completed)
	}
	if !reflect.DeepEqual(uploaded, []int{3, 4, 5}) {
		t.Fatalf("second run uploaded parts = %v, want [3 4 5]", uploaded)
	}
	st = readStateForTest(t, dir)
	if _, ok := st.Uploads[key]; ok {
		t.Fatalf("upload progress left after complete: %+v", st.Uploads[key])
	}
}

func TestSyncPostsDefersLargeMediaWhenLiveGateEnabled(t *testing.T) {
	dir := writeSyncFixture(t, map[string]string{
		"photo.jpg": "ok",
		"video.mp4": "abcdefghijklmnopqrst",
	}, `{"op":"post","cid":"cid","post":{"id":"post-one","ts":1000,"act":1000,"author":"Guest","emoji":"x","text":"Live","media":[{"id":"photo.jpg","type":"image","name":"photo.jpg","size":2},{"id":"video.mp4","type":"video","name":"video.mp4","size":20}]}}`+"\n")
	restoreSyncTuning(t, 10, 5, 1)

	var singlePUTs, multipartCalls int
	installMediaTransport(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/broker/publish-posts":
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media":
			singlePUTs++
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		case "/api/broker/publish-post-media-multipart-init", "/api/broker/publish-post-media-multipart-part", "/api/broker/publish-post-media-multipart-complete":
			multipartCalls++
			return jsonResponse(http.StatusOK, map[string]any{"ok": true}), nil
		default:
			return jsonResponse(http.StatusNotFound, map[string]any{"error": "not found"}), nil
		}
	})

	res, err := SyncPostsWithOptions(t.Context(), dir, publish.Creds{ID: "abc123abc123", Secret: "secret"}, "party-slug", "https://broker.test", Options{DeferLargeMedia: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.MediaPushed != 1 || res.MediaDeferred != 1 || singlePUTs != 1 || multipartCalls != 0 {
		t.Fatalf("unexpected live-gated result: %+v single=%d multipart=%d", res, singlePUTs, multipartCalls)
	}
	st := readStateForTest(t, dir)
	if _, ok := st.Media[mediaStateKey("post-one", "video.mp4")]; ok {
		t.Fatal("deferred video was marked acked")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func jsonResponse(status int, body any) *http.Response {
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(body)
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     make(http.Header),
		Body:       io.NopCloser(&buf),
	}
}

func restoreSyncTuning(t *testing.T, threshold, partSize int64, concurrency int) {
	t.Helper()
	oldThreshold, oldPartSize, oldConcurrency := MultipartThreshold, MultipartPartSize, MultipartConcurrency
	MultipartThreshold, MultipartPartSize, MultipartConcurrency = threshold, partSize, concurrency
	t.Cleanup(func() {
		MultipartThreshold, MultipartPartSize, MultipartConcurrency = oldThreshold, oldPartSize, oldConcurrency
	})
}

func installMediaTransport(t *testing.T, fn roundTripFunc) {
	t.Helper()
	oldClient := httpClient
	httpClient = &http.Client{Transport: fn}
	t.Cleanup(func() { httpClient = oldClient })
}

func writeSyncFixture(t *testing.T, media map[string]string, postsJSONL string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "media"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range media {
		if strings.Contains(name, "/") {
			t.Fatalf("bad media fixture name %q", name)
		}
		if err := os.WriteFile(filepath.Join(dir, "media", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "posts.jsonl"), []byte(postsJSONL), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func readStateForTest(t *testing.T, dir string) stateFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, stateName))
	if err != nil {
		t.Fatal(err)
	}
	var st stateFile
	if err := json.Unmarshal(data, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func doneParts(progress mediaUploadProgress) []int {
	var out []int
	for k, v := range progress.Done {
		if v.ETag == "" {
			continue
		}
		n, _ := strconv.Atoi(k)
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}
