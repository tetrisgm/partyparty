package event

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateRecapApprovedOnlyCopiesAssetsAndPreservesJournal(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetMeta("Recap Night", "DJ Test", "Friday late"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{{Type: "website", URL: "https://example.com/dj", Label: "DJ site"}}); err != nil {
		t.Fatal(err)
	}
	approvedMedia, err := st.SaveMedia("approved.jpg", strings.NewReader("approved image"))
	if err != nil {
		t.Fatal(err)
	}
	hiddenMedia, err := st.SaveMedia("hidden.jpg", strings.NewReader("hidden image"))
	if err != nil {
		t.Fatal(err)
	}
	thumbPath := filepath.Join(st.Dir(), "media", "thumbs", approvedMedia.ID+".jpg")
	if err := os.WriteFile(thumbPath, []byte("approved thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	approved, _, err := st.AddPost("cid-1", "Guest One", "*", "approved shoutout", []Media{approvedMedia}, false)
	if err != nil {
		t.Fatal(err)
	}
	approvedComment, err := st.AddComment(approved.ID, "cid-2", "Guest Two", "+", "approved comment", false)
	if err != nil {
		t.Fatal(err)
	}
	if approvedComment.ID == "" {
		t.Fatal("missing approved comment id")
	}
	hiddenComment, err := st.AddComment(approved.ID, "cid-3", "Guest Three", "-", "hidden comment", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetCommentState(approved.ID, hiddenComment.ID, StateHidden); err != nil {
		t.Fatal(err)
	}
	pending, _, err := st.AddPost("cid-4", "Pending Guest", "?", "pending post", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPostState(pending.ID, StatePending); err != nil {
		t.Fatal(err)
	}
	hidden, _, err := st.AddPost("cid-5", "Hidden Guest", "!", "hidden post", []Media{hiddenMedia}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPostState(hidden.ID, StateHidden); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRequest("cid-6", "private song", "private note", "harder"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddReaction("fire"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetCurrentTrack("First Track", "Artist A", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetCurrentTrack("Second Track", "Artist B", ""); err != nil {
		t.Fatal(err)
	}

	journalPath := filepath.Join(st.Dir(), "posts.jsonl")
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	data, err := st.GenerateRecap(RecapOptions{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("GenerateRecap altered posts.jsonl")
	}
	if data.Event.Title != "Recap Night" || data.Event.Host != "DJ Test" {
		t.Fatalf("event = %#v, want Recap Night/DJ Test", data.Event)
	}
	if data.Stats.Posts != 1 || data.Stats.Comments != 1 || data.Stats.Media != 1 || data.Stats.Requests != 1 || data.Stats.Tracks != 2 {
		t.Fatalf("stats = %#v, want approved-only counts", data.Stats)
	}
	if len(data.Requests.Details) != 0 || data.Requests.DetailsEnabled {
		t.Fatalf("request details = %#v, want summarized only", data.Requests)
	}
	if data.Reactions["fire"] != 1 {
		t.Fatalf("fire reactions = %d, want 1", data.Reactions["fire"])
	}

	recapDir := filepath.Join(st.Dir(), "recap")
	indexPath := filepath.Join(recapDir, "index.html")
	manifestPath := filepath.Join(recapDir, "manifest.json")
	for _, p := range []string{
		indexPath,
		manifestPath,
		filepath.Join(recapDir, "assets", approvedMedia.ID),
		filepath.Join(recapDir, "assets", "thumb-"+approvedMedia.ID+".jpg"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("missing recap file %s: %v", p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(recapDir, "assets", hiddenMedia.ID)); !os.IsNotExist(err) {
		t.Fatalf("hidden media stat err = %v, want not exist", err)
	}
	html, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(html), "Recap Night") || !strings.Contains(string(html), "approved shoutout") {
		t.Fatalf("index.html missing approved recap content:\n%s", string(html))
	}
	for _, hiddenText := range []string{"pending post", "hidden post", "hidden comment", "private note"} {
		if strings.Contains(string(html), hiddenText) {
			t.Fatalf("index.html contains excluded text %q", hiddenText)
		}
	}
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest RecapData
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Stats != data.Stats {
		t.Fatalf("manifest stats = %#v, returned %#v", manifest.Stats, data.Stats)
	}

	if err := os.WriteFile(filepath.Join(recapDir, "assets", "stale.txt"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GenerateRecap(RecapOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(recapDir, "assets", "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("stale recap asset stat err = %v, want not exist after rerun", err)
	}
}
