package contribute

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// rotatingStub is a localStub whose session can be invalidated, exactly like
// MediaMTX closing its HLS muxer on a config reload (a certificate hot-swap
// does this mid-set): the cookie a client holds stops being accepted, and
// every media playlist fetch after it is a 401 until the client re-fetches
// the master and gets a fresh session.
type rotatingStub struct {
	mu         sync.Mutex
	generation int
	masterHits int
}

func (s *rotatingStub) rotate() {
	s.mu.Lock()
	s.generation++
	s.mu.Unlock()
}

func (s *rotatingStub) masters() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.masterHits
}

func (s *rotatingStub) server() *httptest.Server {
	const cookie = "mediamtx-session"
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		session := "s" + string(rune('0'+s.generation))
		s.mu.Unlock()
		name := r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
		switch {
		case name == "index.m3u8":
			s.mu.Lock()
			s.masterHits++
			s.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: cookie, Value: session, Path: "/"})
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(sampleMaster))
		case name == "audio1_stream.m3u8":
			if c, err := r.Cookie(cookie); err != nil || c.Value != session {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(samplePlaylist))
		default:
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("media:" + name))
		}
	}))
}

// TestInvalidatedSessionHealsViaMasterRefetch replays MediaMTX closing its
// HLS muxer under a running contribution (a certificate hot-swap config
// reload does this mid-set): the held session cookie stops being accepted and
// the media playlist 401s. One cycle is allowed to fail; the failure clears
// the cached variant, the next cycle re-fetches the master, the jar takes the
// fresh cookie, and contribution is healthy again - no outside help, no
// restart.
func TestInvalidatedSessionHealsViaMasterRefetch(t *testing.T) {
	local := &rotatingStub{}
	src := local.server()
	defer src.Close()
	origin := newOriginStub()
	dst := httptest.NewServer(origin.handler())
	defer dst.Close()

	m := New(Config{
		SourceURL: src.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return dst.URL + "/room", "tok" },
	})
	m.SetEnabled(true)

	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("first cycle should succeed: %v", err)
	}
	m.noteCycle(nil)

	// MediaMTX reloads; the session this manager holds is now invalid.
	local.rotate()

	err := runOneCycle(t, m)
	if err == nil {
		t.Fatal("cycle with an invalidated session must fail")
	}
	m.noteCycle(err)

	// The failure dropped the cached variant; this cycle re-fetches the master,
	// which hands the jar a fresh session, and everything works again.
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("cycle after re-master should heal, got: %v", err)
	}
	m.noteCycle(nil)
	if got := local.masters(); got != 2 {
		t.Fatalf("expected exactly 2 master fetches (initial + heal), got %d", got)
	}
	if got := m.Snapshot(); !got.Running || got.Failures != 0 {
		t.Fatalf("expected healthy after heal, got %+v", got)
	}
}

// TestFailStreakResetsSessionAndRepushesFixedNames drives the deeper
// self-heal: when cycles keep failing (an origin outage), failResetAfter
// consecutive failures discard the whole session - cookie jar, sent-state,
// page, assets - so recovery re-pushes the fixed-name files instead of
// assuming a store that may have restarted meanwhile still holds them.
func TestFailStreakResetsSessionAndRepushesFixedNames(t *testing.T) {
	local := &rotatingStub{}
	src := local.server()
	defer src.Close()
	origin := newOriginStub()
	dst := httptest.NewServer(origin.handler())
	defer dst.Close()

	m := New(Config{
		SourceURL: src.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return dst.URL + "/room", "tok" },
		Page:      func() []byte { return []byte("<html>party</html>") },
		Assets: func() []Asset {
			return []Asset{{Name: "dj-avatar", Body: []byte("jpeg"), ContentType: "image/jpeg"}}
		},
		AssetsRev: func() string { return "r1" },
	})
	m.SetEnabled(true)

	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("first cycle should succeed: %v", err)
	}
	m.noteCycle(nil)

	pageBefore := 0
	order, _, _ := origin.snapshot()
	for _, n := range order {
		if n == "index.html" {
			pageBefore++
		}
	}
	if pageBefore != 1 {
		t.Fatalf("page should have pushed once, got %d", pageBefore)
	}

	// The origin goes away; every cycle fails at upload.
	origin.mu.Lock()
	origin.fail = true
	origin.mu.Unlock()
	for range failResetAfter {
		err := runOneCycle(t, m)
		if err == nil {
			t.Fatal("cycle against a failing origin must fail")
		}
		m.noteCycle(err)
	}

	// Recovery: the reset cleared pageSent and assetsRev, so the fixed names
	// go up again even though this side pushed them before the outage.
	origin.mu.Lock()
	origin.fail = false
	origin.mu.Unlock()
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("cycle after recovery should succeed: %v", err)
	}
	m.noteCycle(nil)

	pageAfter, avatarAfter := 0, 0
	order, _, _ = origin.snapshot()
	for _, n := range order {
		if n == "index.html" {
			pageAfter++
		}
		if n == "dj-avatar" {
			avatarAfter++
		}
	}
	if pageAfter < 2 {
		t.Fatalf("page must re-push after a session reset, got %d pushes", pageAfter)
	}
	if avatarAfter < 2 {
		t.Fatalf("assets must re-push after a session reset, got %d pushes", avatarAfter)
	}
}

// TestMasterPlaylistFetchedOncePerSession pins the churn fix: fetching the
// master creates a MediaMTX session, and doing that on every 50ms cycle
// created hundreds of sessions a minute - flooding the log ring so real
// failures scrolled away in seconds. Steady-state cycles must reuse the
// cached media playlist name.
func TestMasterPlaylistFetchedOncePerSession(t *testing.T) {
	local := &rotatingStub{}
	src := local.server()
	defer src.Close()
	origin := newOriginStub()
	dst := httptest.NewServer(origin.handler())
	defer dst.Close()

	m := New(Config{
		SourceURL: src.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return dst.URL + "/room", "tok" },
	})
	m.SetEnabled(true)

	for range 5 {
		if err := runOneCycle(t, m); err != nil {
			t.Fatalf("cycle failed: %v", err)
		}
		m.noteCycle(nil)
	}
	if got := local.masters(); got != 1 {
		t.Fatalf("master playlist fetched %d times over 5 healthy cycles, want exactly 1", got)
	}
}

// TestPageAssetsPushPinnedOncePerRevision: the published page references its
// avatar, cover, and fonts by absolute path, which relayed guests resolve
// against the origin - so the assets must travel with the page, marked sticky
// so live-window eviction never takes them, re-sent only when the revision
// changes (avatar swapped mid-set), and again after an origin epoch change.
func TestPageAssetsPushPinnedOncePerRevision(t *testing.T) {
	local := &rotatingStub{}
	src := local.server()
	defer src.Close()

	var mu sync.Mutex
	pinned := map[string]string{}
	puts := map[string]int{}
	dst := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		name := strings.TrimPrefix(r.URL.Path, "/room/")
		puts[name]++
		pinned[name] = r.Header.Get("X-PP-Pin")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer dst.Close()

	rev := "r1"
	m := New(Config{
		SourceURL: src.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return dst.URL + "/room", "tok" },
		Page:      func() []byte { return []byte("<html>party</html>") },
		Assets: func() []Asset {
			return []Asset{
				{Name: "dj-avatar", Body: []byte("jpeg"), ContentType: "image/jpeg"},
				{Name: "fonts/Geist-Variable.woff2", Body: []byte("woff2"), ContentType: "font/woff2"},
			}
		},
		AssetsRev: func() string { return rev },
	})
	m.SetEnabled(true)

	for range 3 {
		if err := runOneCycle(t, m); err != nil {
			t.Fatalf("cycle failed: %v", err)
		}
		m.noteCycle(nil)
	}
	mu.Lock()
	if puts["dj-avatar"] != 1 || puts["fonts/Geist-Variable.woff2"] != 1 {
		mu.Unlock()
		t.Fatalf("assets should push exactly once per revision, got %v", puts)
	}
	if pinned["dj-avatar"] != "1" || pinned["fonts/Geist-Variable.woff2"] != "1" {
		mu.Unlock()
		t.Fatalf("assets must be pushed pinned, got %v", pinned)
	}
	if pinned["index.html"] == "1" {
		mu.Unlock()
		t.Fatal("the page must not use the sticky pin - the playlist pin owns it")
	}
	mu.Unlock()

	// The avatar changes mid-set; the new revision must push within a cycle.
	rev = "r2"
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("cycle failed: %v", err)
	}
	mu.Lock()
	if puts["dj-avatar"] != 2 {
		mu.Unlock()
		t.Fatalf("avatar should re-push on revision change, got %d pushes", puts["dj-avatar"])
	}
	mu.Unlock()
}
