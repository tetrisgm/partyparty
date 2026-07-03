package event

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRecordingKey(t *testing.T) {
	// The timestamp itself contains a hyphen (date-time), so the segment number
	// must be parsed structurally, not as "the last -N".
	cases := []struct {
		name    string
		wantTS  string
		wantSeg int
	}{
		{"set-20260101-120000.aac", "20260101120000", 1},
		{"set-20260101-120000-2.aac", "20260101120000", 2},
		{"set-20260101-120000-13.aac", "20260101120000", 13},
		{"set-20260102-093000.aac", "20260102093000", 1},
	}
	for _, c := range cases {
		ts, seg := recordingKey(c.name)
		if ts != c.wantTS || seg != c.wantSeg {
			t.Errorf("recordingKey(%q) = (%q,%d), want (%q,%d)", c.name, ts, seg, c.wantTS, c.wantSeg)
		}
	}
}

// writeRecordings creates a store on a temp dir and drops the named (empty)
// recording files into its recordings/ folder.
func storeWithRecordings(t *testing.T, names ...string) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rec := filepath.Join(s.Dir(), "recordings")
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(rec, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func base(paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = filepath.Base(p)
	}
	return out
}

func TestRecordingFilesOrder_DeviceYankSegmentsInPlayOrder(t *testing.T) {
	// The device-yank case that the plain lexical sort got WRONG: '-' < '.' would
	// put the base segment last, scrambling the published replay.
	s := storeWithRecordings(t,
		"set-20260101-120000-3.aac",
		"set-20260101-120000.aac",
		"set-20260101-120000-2.aac",
	)
	got := base(s.RecordingFiles())
	want := []string{"set-20260101-120000.aac", "set-20260101-120000-2.aac", "set-20260101-120000-3.aac"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RecordingFiles order = %v, want %v", got, want)
	}
}

func TestLatestSetRecordings_OnlyNewestSet(t *testing.T) {
	// Two sets in one event folder + a device-yank in the newer one. A publish
	// must upload ONLY the newest set, not every recording concatenated.
	s := storeWithRecordings(t,
		"set-20260101-200000.aac",   // 8pm set
		"set-20260101-220000.aac",   // 10pm set, segment 1
		"set-20260101-220000-2.aac", // 10pm set, device-yank segment 2
	)
	got := base(s.LatestSetRecordings())
	want := []string{"set-20260101-220000.aac", "set-20260101-220000-2.aac"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LatestSetRecordings = %v, want %v", got, want)
	}
	// And all of them are still visible via RecordingFiles, oldest first.
	if all := base(s.RecordingFiles()); len(all) != 3 || all[0] != "set-20260101-200000.aac" {
		t.Fatalf("RecordingFiles = %v, want 8pm first, 3 total", all)
	}
}

func TestLatestSetRecordings_Empty(t *testing.T) {
	s := storeWithRecordings(t)
	if got := s.LatestSetRecordings(); got != nil {
		t.Fatalf("want nil for no recordings, got %v", got)
	}
}

func TestNormalizeSlug(t *testing.T) {
	cases := map[string]string{
		"Rooftop Sessions":  "rooftop-sessions",
		"  --Foo.Bar__  ":   "foo.bar",
		"wedding@after!!":   "wedding-after",
		"already-good.slug": "already-good.slug",
		"UPPER":             "upper",
		"a b  c":            "a-b-c",
		"":                  "",
		"!!!":               "",
	}
	for in, want := range cases {
		if got := NormalizeSlug(in); got != want {
			t.Errorf("NormalizeSlug(%q) = %q, want %q", in, got, want)
		}
	}
	// Clip to 48 and never end on a separator.
	long := NormalizeSlug(string(make([]byte, 0)) + "aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd.eeeeeeeeee")
	if len(long) > 48 {
		t.Errorf("slug not clipped: %d chars (%q)", len(long), long)
	}
}
