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
	// put the base segment last, scrambling playback.
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
