package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"partyparty/internal/broadcast"
	"partyparty/internal/cloudsync"
	"partyparty/internal/config"
	"partyparty/internal/event"
	"partyparty/internal/stats"
)

type fakeSessions struct {
	calls  int
	linked bool
	err    error
}

func (f *fakeSessions) Session(context.Context) (cloudsync.Session, error) {
	f.calls++
	if f.err != nil {
		return cloudsync.Session{}, f.err
	}
	if !f.linked {
		return cloudsync.Session{Linked: false}, nil
	}
	return cloudsync.Session{
		Linked: true, Secret: strings.Repeat("a", 48),
		ExpiresMs: time.Now().UnixMilli() + 3_600_000, Handle: "shokunin", Name: "Ramine",
	}, nil
}

// A stand-in platform, so the console's half of the contract can be checked
// without a network: does it ask as the person, and does it hand back what it
// was given.
func platformStub(t *testing.T, seen *[]*http.Request) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.Clone(context.Background()))
		if r.URL.Path == "/nowhere" {
			http.Error(w, "no", http.StatusNotFound)
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><body><h1>Your parties</h1></body>"))
	}))
}

func mirrorSrv(t *testing.T, base string, sessions SessionClient) *Srv {
	t.Helper()
	ev, err := event.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// A real room behind it, because the point of the offline case is that the
	// room still answers when the platform does not.
	dir := t.TempDir()
	cfg := config.Config{}
	return New(Deps{
		Config: cfg, Events: ev, Sessions: sessions, PlatformURL: base,
		Broadcaster: broadcast.New(cfg, dir, "", ""),
		Listeners:   stats.New(15 * time.Second),
		Web: fstest.MapFS{
			"listener.html": {Data: []byte("<html>listener</html>")},
			"dj.html":       {Data: []byte("<html>dj</html>")},
		},
	})
}

func TestTheConsoleShowsThePersonTheirOwnPages(t *testing.T) {
	var seen []*http.Request
	platform := platformStub(t, &seen)
	defer platform.Close()
	sessions := &fakeSessions{linked: true}
	s := mirrorSrv(t, platform.URL, sessions)

	w := do(s, http.MethodGet, "/home", "127.0.0.1:1234")
	if w.Code != http.StatusOK {
		t.Fatalf("/home = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "Your parties") {
		t.Fatalf("the platform's own page was not served: %q", body)
	}
	// Served through untouched. The Mac's own controls are the console shell
	// around this frame, never markup pushed into the page.
	if strings.Contains(body, "macbar") {
		t.Fatal("the console is injecting its own controls into the web's page")
	}
	if len(seen) != 1 || seen[0].Header.Get("cookie") != "pp_s="+strings.Repeat("a", 48) {
		t.Fatalf("it did not ask as the person: %+v", seen)
	}

	// The session is held, not re-fetched for every page on the site.
	do(s, http.MethodGet, "/people", "127.0.0.1:1234")
	if sessions.calls != 1 {
		t.Fatalf("asked for %d sessions, want 1", sessions.calls)
	}
}

// The pillar: a party runs with no internet. Nothing above may weaken it, and
// listing parties never worked offline anyway - so an unreachable platform has
// to fall through to the local console rather than break the room.
func TestWithNoPlatformTheConsoleStillAnswers(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sessions SessionClient
	}{
		{"the platform is unreachable", &fakeSessions{err: errors.New("dial: no route to host")}},
		{"this Mac is not signed in", &fakeSessions{linked: false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := mirrorSrv(t, "http://127.0.0.1:1", tc.sessions)
			// The console shows /home in a frame INSIDE itself, so this must
			// say so in place - never redirect to /dj, which would load the
			// console into its own frame, and never hang or 502.
			w := do(s, http.MethodGet, "/home", "127.0.0.1:1234")
			if w.Code != http.StatusOK ||
				!strings.Contains(w.Body.String(), "cannot reach it right now") {
				t.Fatalf("/home = %d %.80q, want the offline page", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "/dj") {
				t.Fatal("the offline page points the frame at the console itself")
			}
			// And the room's own API is untouched, which is what actually runs
			// a party in a basement with no signal.
			api := do(s, http.MethodGet, "/api/status", "127.0.0.1:1234")
			if api.Code != http.StatusOK {
				t.Fatalf("/api/status = %d with no platform", api.Code)
			}
		})
	}
}

// A guest on the venue Wi-Fi must never be handed the DJ's account pages. The
// mirror is loopback and DJ-only; everything else about a guest's night is
// unchanged.
func TestAGuestNeverSeesTheOwnersPages(t *testing.T) {
	var seen []*http.Request
	platform := platformStub(t, &seen)
	defer platform.Close()
	s := mirrorSrv(t, platform.URL, &fakeSessions{linked: true})

	w := do(s, http.MethodGet, "/home", "192.168.1.44:5555")
	if w.Code == http.StatusOK && strings.Contains(w.Body.String(), "Your parties") {
		t.Fatal("a guest was served the owner's home")
	}
	// And not handed the console's offline page either.
	if strings.Contains(w.Body.String(), "cannot reach it right now") {
		t.Fatal("a guest was served the console's own page")
	}
	if len(seen) != 0 {
		t.Fatalf("a guest's request reached the platform: %+v", seen)
	}
}

func TestOnlyThePersonsPagesAreMirrored(t *testing.T) {
	for path, want := range map[string]bool{
		"/home": true, "/people": true, "/people/abc": true, "/parties/new": true,
		"/@shokunin": true, "/@shokunin/mutant-zoo": true, "/media/covers/x.webp": true,
		"/api/status": false, "/dj": false, "/": false, "/live/index.m3u8": false,
	} {
		if got := mirrored(path); got != want {
			t.Errorf("mirrored(%q) = %v, want %v", path, got, want)
		}
	}
}
