package livemirror

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParsePlaylist(t *testing.T) {
	pl := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		"#EXT-X-TARGETDURATION:3",
		"#EXT-X-MEDIA-SEQUENCE:5",
		"#EXTINF:3.000000,",
		"live5.ts",
		"#EXTINF:3.000000,",
		"live6.ts",
		"#EXTINF:3.000000,",
		"live7.ts",
		"",
	}, "\n")
	segs, err := parsePlaylist([]byte(pl))
	if err != nil {
		t.Fatalf("parsePlaylist: %v", err)
	}
	want := []string{"live5.ts", "live6.ts", "live7.ts"}
	if len(segs) != len(want) {
		t.Fatalf("segments = %v, want %v", segs, want)
	}
	for i := range want {
		if segs[i] != want[i] {
			t.Fatalf("segment[%d] = %q, want %q (order must match the playlist)", i, segs[i], want[i])
		}
	}
	if ms := mediaSequence([]byte(pl)); ms != 5 {
		t.Fatalf("mediaSequence = %d, want 5", ms)
	}
}

func TestParsePlaylistStripsPathAndRejectsNonHLS(t *testing.T) {
	// A URI with a leading directory must reduce to its basename (the object key).
	segs, err := parsePlaylist([]byte("#EXTM3U\n#EXTINF:3,\nsub/dir/live0.ts\n"))
	if err != nil {
		t.Fatalf("parsePlaylist: %v", err)
	}
	if len(segs) != 1 || segs[0] != "live0.ts" {
		t.Fatalf("segments = %v, want [live0.ts]", segs)
	}
	if _, err := parsePlaylist([]byte("not a playlist\n")); err == nil {
		t.Fatal("parsePlaylist should reject non-HLS data")
	}
}

// recorder captures the order and identity of broker PUTs.
type recorder struct {
	mu    sync.Mutex
	order []string // e.g. "seg:live5.ts", "playlist:live.m3u8"
	seen  map[string][]byte
}

func newRecorder() *recorder { return &recorder{seen: map[string][]byte{}} }

func (r *recorder) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Auth + routing headers must be present on every call.
		if req.Header.Get("x-pp-id") == "" || req.Header.Get("x-pp-secret") == "" ||
			req.Header.Get("x-pp-slug") == "" || req.Header.Get("x-pp-session") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		file := req.Header.Get("x-pp-file")
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		kind := "seg"
		if strings.HasSuffix(req.URL.Path, playlistPath) {
			kind = "playlist"
		}
		r.order = append(r.order, kind+":"+file)
		r.seen[file] = body
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})
}

func (r *recorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

func writeScratch(t *testing.T, dir string, segs []string, mediaSeq int) {
	t.Helper()
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n")
	b.WriteString("#EXT-X-MEDIA-SEQUENCE:" + itoa(mediaSeq) + "\n")
	for _, s := range segs {
		b.WriteString("#EXTINF:3.000000,\n" + s + "\n")
		if err := os.WriteFile(filepath.Join(dir, s), []byte("TS-"+s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, playlistName), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func newTestMirror(t *testing.T, base, scratch string) *Mirror {
	t.Helper()
	return New(Config{
		Base:       base,
		Creds:      Creds{ID: "id-1", Secret: "sec-1"},
		ScratchDir: scratch,
		SlugFn:     func() string { return "myslug" },
		Logf:       func(string, ...any) {},
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	})
}

// TestSyncSegmentsBeforePlaylist is the core safety invariant: every segment a
// playlist names is PUT before that playlist, so a remote guest never fetches a
// playlist pointing at a segment the cloud lacks.
func TestSyncSegmentsBeforePlaylist(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	scratch := t.TempDir()
	writeScratch(t, scratch, []string{"live0.ts", "live1.ts", "live2.ts"}, 0)

	m := newTestMirror(t, srv.URL, scratch)
	m.syncOnce(context.Background(), "sess-1", map[string]bool{})

	got := rec.snapshot()
	want := []string{"seg:live0.ts", "seg:live1.ts", "seg:live2.ts", "playlist:live.m3u8"}
	if len(got) != len(want) {
		t.Fatalf("upload order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("upload[%d] = %q, want %q (segments must precede the playlist, in order)", i, got[i], want[i])
		}
	}
}

// TestSyncIncrementalReuploadsPlaylist verifies a second tick uploads only the
// NEW segment and then re-uploads the playlist (never re-PUTting old segments).
func TestSyncIncrementalReuploadsPlaylist(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	scratch := t.TempDir()
	uploaded := map[string]bool{}
	m := newTestMirror(t, srv.URL, scratch)

	writeScratch(t, scratch, []string{"live0.ts", "live1.ts"}, 0)
	m.syncOnce(context.Background(), "sess-1", uploaded)

	// A new segment appears; the window slides forward by one.
	writeScratch(t, scratch, []string{"live1.ts", "live2.ts"}, 1)
	m.syncOnce(context.Background(), "sess-1", uploaded)

	got := rec.snapshot()
	want := []string{
		"seg:live0.ts", "seg:live1.ts", "playlist:live.m3u8", // first tick
		"seg:live2.ts", "playlist:live.m3u8", // second tick: only the new segment, then the playlist
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("upload order = %v, want %v", got, want)
	}
}

// TestSyncSkipsPlaylistWhenSegmentUnreadable proves invariant (1) holds under a
// prune race: if a referenced segment isn't on disk, the playlist is NOT
// uploaded (the cloud keeps its previous consistent window).
func TestSyncSkipsPlaylistWhenSegmentUnreadable(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	scratch := t.TempDir()

	// Playlist references live0.ts and live1.ts, but live1.ts is missing on disk.
	pl := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\nlive0.ts\n#EXTINF:3,\nlive1.ts\n"
	if err := os.WriteFile(filepath.Join(scratch, playlistName), []byte(pl), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scratch, "live0.ts"), []byte("TS0"), 0o644); err != nil {
		t.Fatal(err)
	}

	m := newTestMirror(t, srv.URL, scratch)
	m.syncOnce(context.Background(), "sess-1", map[string]bool{})

	got := rec.snapshot()
	// live0.ts may upload, but the playlist must NOT (it names the missing live1.ts).
	for _, g := range got {
		if strings.HasPrefix(g, "playlist:") {
			t.Fatalf("playlist uploaded while a referenced segment was missing: %v", got)
		}
	}
}

// TestSyncNoPlaylistIsNoop verifies an empty/absent scratch dir does nothing.
func TestSyncNoPlaylistIsNoop(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	m := newTestMirror(t, srv.URL, t.TempDir())
	m.syncOnce(context.Background(), "sess-1", map[string]bool{})
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("expected no uploads without a playlist, got %v", got)
	}
}

// TestRunCleansScratchOnStop verifies Run wipes the scratch window when the
// session ends, so the next go-live can't re-read a stale playlist.
func TestRunCleansScratchOnStop(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	scratch := t.TempDir()
	writeScratch(t, scratch, []string{"live0.ts"}, 0)

	m := newTestMirror(t, srv.URL, scratch)
	m.cfg.PollInterval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx, "sess-1"); close(done) }()
	time.Sleep(60 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if _, err := os.Stat(filepath.Join(scratch, playlistName)); !os.IsNotExist(err) {
		t.Fatalf("live.m3u8 should be removed on session end, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(scratch, "live0.ts")); !os.IsNotExist(err) {
		t.Fatalf("segment should be removed on session end, stat err = %v", err)
	}
}
