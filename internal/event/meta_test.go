package event

import (
	"os"
	"strings"
	"testing"
)

func TestStructuredScheduleAndLocalCover(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSchedule("2026-07-09", "20:15", "The Great Northern", "Thu, Jul 9 · 8:15 PM · The Great Northern"); err != nil {
		t.Fatal(err)
	}
	meta := st.Meta()
	if meta.Date != "2026-07-09" || meta.Time != "20:15" || meta.Place != "The Great Northern" {
		t.Fatalf("schedule = %#v", meta)
	}
	if err := st.SetSchedule("July 9", "20:15", "", ""); err == nil {
		t.Fatal("invalid date was accepted")
	}
	if err := st.SetCover("/covers/rooftop.webp"); err != nil {
		t.Fatal(err)
	}
	if got := st.Meta().Cover; got != "/covers/rooftop.webp" {
		t.Fatalf("curated cover = %q", got)
	}
	if err := st.SetCover("/covers/../secret.jpg"); err == nil {
		t.Fatal("unsafe cover was accepted")
	}
	path, err := st.SaveCover("custom.jpg", strings.NewReader("jpeg bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Meta().Cover != "/event-cover" {
		t.Fatalf("local cover ref = %q", st.Meta().Cover)
	}
	got, ok := st.CoverPath()
	if !ok || got != path {
		t.Fatalf("CoverPath = %q, %v; want %q, true", got, ok, path)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "jpeg bytes" {
		t.Fatalf("cover bytes = %q, %v", data, err)
	}
}
