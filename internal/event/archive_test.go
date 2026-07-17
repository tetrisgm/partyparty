package event

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportArchiveWritesFlatMarkdownMediaAndRecording(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetMeta("Rooftop Ritual", "Ramine", "Sat, Jul 12 · 9:00 PM · The Mission rooftop"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetSlug("rooftop-ritual"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{{Type: "instagram", URL: "https://instagram.com/ramine", Label: "Instagram"}}); err != nil {
		t.Fatal(err)
	}
	media, err := st.SaveMedia("Dance Floor.JPG", strings.NewReader("photo bytes"))
	if err != nil {
		t.Fatal(err)
	}
	post, _, err := st.AddPost("cid-1", "Maya", "M", "this rooftop is unreal", []Media{media}, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddComment(post.ID, "cid-2", "Ramine", "R", "see you downstairs", true); err != nil {
		t.Fatal(err)
	}
	recDir := filepath.Join(st.Dir(), "recordings")
	if err := os.WriteFile(filepath.Join(recDir, "set-20260709-120000.aac"), []byte("recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetCurrentTrack("Intimidated", "Kaytranada", ""); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(st.Dir(), "posts.jsonl")
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := st.ExportArchive(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("ExportArchive altered posts.jsonl")
	}
	md, err := os.ReadFile(filepath.Join(st.Dir(), "event.md"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(md)
	for _, want := range []string{
		"# Rooftop Ritual",
		"Host: Ramine",
		"Date / place: Sat, Jul 12",
		"https://partyparty.party/e/rooftop-ritual",
		"this rooftop is unreal",
		"Ramine [DJ]",
		"Intimidated - Kaytranada",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("event.md missing %q:\n%s", want, text)
		}
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "photo-01-Dance-Floor.jpg")); err != nil {
		t.Fatalf("missing flat photo export: %v", err)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "recording.aac")); err != nil {
		t.Fatalf("missing recording export: %v", err)
	}

	if err := os.WriteFile(filepath.Join(st.Dir(), "photo-99-stale.jpg"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.Dir(), exportManifestName), []byte(`{"files":["photo-99-stale.jpg"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.ExportArchive(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "photo-99-stale.jpg")); !os.IsNotExist(err) {
		t.Fatalf("stale exported photo stat err = %v, want not exist", err)
	}
}
