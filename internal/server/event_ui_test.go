package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"partyparty/internal/event"
)

func TestEventUIDataCoverAndPostReactionRoutes(t *testing.T) {
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Events: ev})

	config, _ := json.Marshal(map[string]string{
		"date": "2026-07-09", "time": "20:00", "place": "Rooftop",
		"starts": "Thu, Jul 9 · 8:00 PM · Rooftop", "cover": "/covers/rooftop.webp",
	})
	w := doBody(s, http.MethodPost, "/api/event-config", "127.0.0.1:1234", "application/json", bytes.NewBuffer(config))
	if w.Code != http.StatusOK {
		t.Fatalf("event config = %d: %s", w.Code, w.Body.String())
	}

	media, err := ev.SaveMedia("photo.jpg", strings.NewReader("photo"))
	if err != nil {
		t.Fatal(err)
	}
	post, _, err := ev.AddPost("guest-1", "Guest", "🎉", "hello", []event.Media{media}, false)
	if err != nil {
		t.Fatal(err)
	}
	reaction, _ := json.Marshal(map[string]string{"cid": "guest-2", "post": post.ID, "reaction": "❤️"})
	w = doBody(s, http.MethodPost, "/api/post-reaction", "192.168.1.44:1234", "application/json", bytes.NewBuffer(reaction))
	if w.Code != http.StatusOK {
		t.Fatalf("post reaction = %d: %s", w.Code, w.Body.String())
	}
	feed := decodeJSON(t, do(s, http.MethodGet, "/api/feed?cid=guest-2", "192.168.1.44:1234"))
	if feed["cover"] != "/covers/rooftop.webp" || feed["date"] != "2026-07-09" || feed["photos"] != float64(1) || feed["videos"] != float64(0) {
		t.Fatalf("feed event data = %#v", feed)
	}
	posts := feed["posts"].([]any)
	if posts[0].(map[string]any)["reactions"].(map[string]any)["❤️"] != float64(1) {
		t.Fatalf("feed reactions = %#v", posts[0])
	}

	var upload bytes.Buffer
	mw := multipart.NewWriter(&upload)
	part, err := mw.CreateFormFile("file", "custom.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("jpeg bytes"))
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/event-cover-local", &upload)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w = httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("local cover upload = %d: %s", w.Code, w.Body.String())
	}
	w = do(s, http.MethodGet, "/event-cover", "192.168.1.44:1234")
	if w.Code != http.StatusOK || w.Body.String() != "jpeg bytes" {
		t.Fatalf("event cover = %d %q", w.Code, w.Body.String())
	}
}
