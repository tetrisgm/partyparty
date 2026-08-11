package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"partyparty/internal/cloudsync"
)

// The console shows the person their OWN pages.
//
// The Mac and the web are one experience apart from streaming (owner,
// 2026-08-08). The only way that stays true is for there to be one
// implementation: every Mac bug fixed on the 8th was drift between two of them
// - a rename that changed only the Mac's copy, an install bound to a group
// while the web knew accounts, a sign-in door promising a browser it never
// opened.
//
// So the console keeps loading from THIS server, and this server fetches the
// real pages from the platform and serves them back. Same origin as the
// console's own API, which is what lets the Mac's layer talk to it without
// CORS, mixed content, or a bridge for every call.
//
// Everything here is loopback and DJ-only. Guests are on :8443 with the guest
// page and never reach it.
// SessionClient is the one thing the mirror needs from the platform, as an
// interface so this package can be tested without a network.
type SessionClient interface {
	Session(ctx context.Context) (cloudsync.Session, error)
}

type mirror struct {
	base   string
	client SessionClient

	mu       sync.Mutex
	session  string
	expires  time.Time
	lastFail time.Time
	fails    int
	everOK   bool
}

func newMirror(base string, client SessionClient) *mirror {
	return &mirror{base: strings.TrimRight(base, "/"), client: client}
}

// backoff is how long to wait after a failed session fetch before trying
// again: a second, then two, four, eight, capped at thirty.
//
// It was a flat thirty seconds, and that is what a DJ actually saw. The console
// asks for /home the instant it opens, which can be the instant before the
// platform client is ready; that one miss then locked the answer to "no" for
// half a minute with partyparty.party reachable the whole time. The first
// retry has to be quick, because the first failure is almost always a race
// with our own startup rather than an outage.
func (m *mirror) backoff() time.Duration {
	wait := time.Second << min(m.fails, 5)
	return min(wait, 30*time.Second)
}

// cookie returns a live session for this Mac's owner, fetching one when the
// held one is missing or close to expiry. A Mac that is not signed in has no
// session and never will until somebody signs in, so a failure is remembered
// briefly rather than retried on every page load.
func (m *mirror) cookie(ctx context.Context) string {
	m.mu.Lock()
	if m.session != "" && time.Now().Before(m.expires) {
		defer m.mu.Unlock()
		return m.session
	}
	if m.fails > 0 && time.Since(m.lastFail) < m.backoff() {
		defer m.mu.Unlock()
		return ""
	}
	m.mu.Unlock()

	got, err := m.client.Session(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil || !got.Linked || got.Secret == "" {
		m.lastFail = time.Now()
		m.fails++
		return ""
	}
	m.fails = 0
	m.everOK = true
	m.session = got.Secret
	// Half the advertised life, so a page is never rendered with a cookie that
	// expires between the request and the reply. Bounded at both ends: a silly
	// expiry from the platform must not overflow into the past and make every
	// page load fetch a new session.
	life := time.Duration(got.ExpiresMs-time.Now().UnixMilli()) * time.Millisecond / 2
	m.expires = time.Now().Add(min(max(life, time.Minute), 12*time.Hour))
	return m.session
}

// mirrored is the set of paths the console shows from the platform. Everything
// else on this server stays local: /api/* is the Mac's own, and the guest page
// is nobody's business but a guest's.
func mirrored(path string) bool {
	switch {
	case path == "/home", path == "/people", path == "/settings":
		return true
	case strings.HasPrefix(path, "/people/"), strings.HasPrefix(path, "/parties/"),
		strings.HasPrefix(path, "/@"), strings.HasPrefix(path, "/media/"):
		return true
	}
	return false
}

// serveConsoleFallback answers a console navigation the platform could not,
// with a page saying so. The console shows these pages in a frame inside
// itself, so this must NOT redirect to /dj - that would load the console into
// its own frame. Media is excluded: a missing image is a missing image.
func (s *srv) serveConsoleFallback(w http.ResponseWriter, r *http.Request) bool {
	if !mirrored(r.URL.Path) || strings.HasPrefix(r.URL.Path, "/media/") || !s.isDJ(r) {
		return false
	}
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(offlinePage))
	return true
}

// What the console shows where the person's pages would be. It says the true
// thing - the party is fine, the record is not reachable - because a party in a
// basement with no signal is a supported way to use this, not a fault.
//
// And it comes back on its own. The console loads its frame the moment it
// opens, which is the same moment the platform client may still be starting;
// one unlucky second there used to leave a signed-in DJ looking at "cannot
// reach it right now" for the rest of the session, with the platform reachable
// the whole time and no control anywhere that would try again. So the page that
// reports the outage is the thing that watches for it to end.
// It also does not shout at somebody whose Mac is merely still waking up. For
// the first few seconds this says nothing at all, because the overwhelmingly
// common case is that the console beat the platform client to the punch by half
// a second and the real page is about to arrive. Only when the wait has gone on
// long enough to be a real outage does it say so.
const offlinePage = `<!doctype html><meta charset="utf-8">
<title>Your parties</title>
<style>
html{color-scheme:dark}
body{margin:0;height:100vh;display:grid;place-items:center;
font:14px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
background:#0e0e10;color:#a3a3ac;text-align:center;padding:24px}
b{display:block;font-size:16px;color:#f2f2f4;margin-bottom:8px}
#say{opacity:0;transition:opacity .4s}
#say.show{opacity:1}
</style>
<div id="say"><b>Your parties are on partyparty.party</b>
This Mac cannot reach it right now.<br>The room below still works.</div>
<script>
(function () {
  var said = document.getElementById('say');
  var start = Date.now();
  function look() {
    if (document.hidden) return;
    fetch('/api/mirror', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.ready) { location.reload(); return; }
        if (Date.now() - start > 6000) said.className = 'show';
      })
      .catch(function () {});
  }
  // Briskly at first - this is loopback, and the gap being closed is usually
  // under a second - then settling down so a genuinely offline party is not
  // polling forever.
  var quick = setInterval(look, 700);
  setTimeout(function () { clearInterval(quick); setInterval(look, 5000); }, 15000);
  look();
})();
</script>
`

// mirrorReady reports whether the person's own pages can be served right now.
// It is what the offline page polls, and it asks exactly what serveMirror asks
// - including the failure backoff, so a poll every few seconds does not become
// a session request every few seconds.
func (s *srv) mirrorReady(ctx context.Context) bool {
	if s.mirror == nil {
		return false
	}
	ready, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	return s.mirror.cookie(ready) != ""
}

// serveMirror answers a console request from the platform. Returns false when
// this is not a mirrored path, or when the platform cannot be reached - the
// caller then falls back to the local console, which is what runs a party with
// no internet and is all that ever worked offline anyway.
func (s *srv) serveMirror(w http.ResponseWriter, r *http.Request) bool {
	if s.mirror == nil || !mirrored(r.URL.Path) || !s.isDJ(r) {
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	cookie := s.mirror.cookie(ctx)
	if cookie == "" {
		return false
	}

	target := s.mirror.base + r.URL.RequestURI()
	req, err := http.NewRequestWithContext(ctx, r.Method, target, r.Body)
	if err != nil {
		return false
	}
	// Only what the platform needs: the session, and enough of the request for
	// a form post to arrive intact. Nothing from the LAN is forwarded.
	req.Header.Set("cookie", "pp_s="+cookie)
	if ct := r.Header.Get("content-type"); ct != "" {
		req.Header.Set("content-type", ct)
	}
	req.Header.Set("accept", "text/html,application/json")

	client := &http.Client{
		Timeout: 12 * time.Second,
		// A redirect after a form post has to land back on this server, not send
		// the console off to partyparty.party in its own window.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	for _, h := range []string{"content-type", "cache-control", "location"} {
		if v := resp.Header.Get(h); v != "" {
			// A redirect to the platform is rewritten to this server, so the
			// console stays where it is and keeps its own API alongside.
			if h == "location" {
				v = strings.TrimPrefix(v, s.mirror.base)
			}
			w.Header().Set(h, v)
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return false
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
	return true
}
