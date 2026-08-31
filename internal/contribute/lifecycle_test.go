package contribute

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"partyparty/internal/schedule"
)

func TestTargetChangeRepushesCompleteLiveSetBeforePlaylist(t *testing.T) {
	local := localStub()
	defer local.Close()
	first := newOriginStub()
	firstServer := httptest.NewServer(first.handler())
	defer firstServer.Close()
	second := newOriginStub()
	secondServer := httptest.NewServer(second.handler())
	defer secondServer.Close()

	m := New(Config{
		SourceURL: local.URL + "/party/index.m3u8",
		Page:      func() []byte { return []byte("<html>party</html>") },
		Assets: func() []Asset {
			return []Asset{{Name: "dj-avatar", Body: []byte("jpeg"), ContentType: "image/jpeg"}}
		},
		AssetsRev: func() string { return "avatar-1" },
	})
	m.SetTarget(firstServer.URL+"/room/", "token")

	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("first target cycle failed: %v", err)
	}
	m.SetTarget(secondServer.URL+"/room/", "token")
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("replacement target cycle failed: %v", err)
	}

	order, _, _ := second.snapshot()
	playlistAt := -1
	for i, name := range order {
		if name == PublishedPlaylist {
			playlistAt = i
		}
	}
	if playlistAt < 0 {
		t.Fatalf("replacement target never received the playlist: %v", order)
	}
	wants := append(mediaNames(schedule.RewritePlaylist([]byte(samplePlaylist))), PublishedPage, "dj-avatar")
	for _, want := range wants {
		found := false
		for _, name := range order[:playlistAt] {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("replacement target did not receive %s before its playlist: %v", want, order)
		}
	}
}

func TestTokenOnlyTargetChangeRepushesCompleteLiveSet(t *testing.T) {
	local := localStub()
	defer local.Close()
	origin := newOriginStub()
	originServer := httptest.NewServer(origin.handler())
	defer originServer.Close()

	m := New(Config{
		SourceURL: local.URL + "/party/index.m3u8",
		Page:      func() []byte { return []byte("<html>party</html>") },
		Assets: func() []Asset {
			return []Asset{{Name: "dj-avatar", Body: []byte("jpeg"), ContentType: "image/jpeg"}}
		},
		AssetsRev: func() string { return "avatar-1" },
	})
	m.SetTarget(originServer.URL+"/room/", "old-token")
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("old-token cycle failed: %v", err)
	}
	before, _, beforeAuth := origin.snapshot()
	if got := beforeAuth[PublishedPlaylist]; got != "Bearer old-token" {
		t.Fatalf("old-token authorization = %q", got)
	}

	m.SetTarget(originServer.URL+"/room/", "new-token")
	if err := runOneCycle(t, m); err != nil {
		t.Fatalf("new-token cycle failed: %v", err)
	}
	after, _, afterAuth := origin.snapshot()
	rotated := after[len(before):]
	playlistAt := -1
	for i, name := range rotated {
		if name == PublishedPlaylist {
			playlistAt = i
			break
		}
	}
	if playlistAt < 0 {
		t.Fatalf("token rotation never republished the playlist: %v", rotated)
	}
	wants := append(mediaNames(schedule.RewritePlaylist([]byte(samplePlaylist))), PublishedPage, "dj-avatar")
	for _, want := range wants {
		found := false
		for _, name := range rotated[:playlistAt] {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("token rotation did not republish %s before its playlist: %v", want, rotated)
		}
		if got := afterAuth[want]; got != "Bearer new-token" {
			t.Fatalf("%s authorization after rotation = %q", want, got)
		}
	}
	if got := afterAuth[PublishedPlaylist]; got != "Bearer new-token" {
		t.Fatalf("playlist authorization after rotation = %q", got)
	}
}

func TestPlaneCycleUsesOneTargetSnapshot(t *testing.T) {
	type recorder struct {
		mu       sync.Mutex
		requests []string
	}
	newPlaneServer := func(label string, rec *recorder) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec.mu.Lock()
			rec.requests = append(rec.requests, r.Method+" "+r.URL.Path)
			rec.mu.Unlock()
			if r.Method == http.MethodPost {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"writes":[{"path":"post","body":{"from":"` + label + `"}}]}`))
				return
			}
			w.WriteHeader(http.StatusNoContent)
		}))
	}

	firstRec, secondRec := &recorder{}, &recorder{}
	first := newPlaneServer("first", firstRec)
	defer first.Close()
	second := newPlaneServer("second", secondRec)
	defer second.Close()

	var resolutions atomic.Int32
	m := New(Config{Target: func() (string, string) {
		if resolutions.Add(1) == 1 {
			return first.URL + "/room/", ""
		}
		return second.URL + "/room/", ""
	}})
	var applied []string
	m.planeCycle(context.Background(), PlaneHooks{
		Snapshots: func() map[string]json.RawMessage {
			return map[string]json.RawMessage{"status": json.RawMessage(`{"live":true}`)}
		},
		ApplyWrite: func(_ string, body json.RawMessage) { applied = append(applied, string(body)) },
	})

	firstRec.mu.Lock()
	firstRequests := append([]string(nil), firstRec.requests...)
	firstRec.mu.Unlock()
	secondRec.mu.Lock()
	secondRequests := append([]string(nil), secondRec.requests...)
	secondRec.mu.Unlock()
	if len(firstRequests) != 2 || len(secondRequests) != 0 {
		t.Fatalf("one plane cycle split across targets: first=%v second=%v", firstRequests, secondRequests)
	}
	if len(applied) != 1 || applied[0] != `{"from":"first"}` {
		t.Fatalf("plane applied activity from the wrong target: %v", applied)
	}
}

func TestDisableCancelsInFlightUpload(t *testing.T) {
	local := localStub()
	defer local.Close()
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	origin := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() { close(started) })
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer origin.Close()
	defer close(release)

	m := New(Config{
		SourceURL: local.URL + "/party/index.m3u8",
		Target:    func() (string, string) { return origin.URL + "/room/", "token" },
		Logf:      func(string, ...any) {},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.SetEnabled(true)
	go m.Run(ctx)

	waitLifecycleSignal(t, started, "upload to start")
	m.SetEnabled(false)
	waitLifecycleCondition(t, "disabled upload to return", func() bool {
		m.mu.RLock()
		defer m.mu.RUnlock()
		return len(m.active) == 0
	})
	if got := m.Snapshot(); got.Running || got.Failures != 0 || got.LastError != "" {
		t.Fatalf("stale upload result changed disabled status: %+v", got)
	}
}

func TestRapidDisableReenableRejectsPreviousHTTPRequest(t *testing.T) {
	local := localStub()
	defer local.Close()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	newStarted := make(chan struct{})
	var calls atomic.Int32
	var newOnce sync.Once

	m := New(Config{SourceURL: local.URL + "/party/index.m3u8", Logf: func(string, ...any) {}})
	m.SetTarget("https://origin.invalid/room/", "token")
	m.originClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(firstStarted)
			// Deliberately ignore cancellation and return success after the old
			// generation is disabled. The generation guard, not transport luck,
			// must reject this response.
			<-releaseFirst
			return lifecycleResponse(req, http.StatusNoContent, ""), nil
		}
		newOnce.Do(func() { close(newStarted) })
		<-req.Context().Done()
		return nil, req.Context().Err()
	})

	ctx, cancel := context.WithCancel(context.Background())
	m.SetEnabled(true)
	go m.Run(ctx)
	waitLifecycleSignal(t, firstStarted, "old-generation request to start")

	m.SetEnabled(false)
	m.SetEnabled(true)
	close(releaseFirst)
	waitLifecycleSignal(t, newStarted, "new-generation request to start")

	if got := m.Snapshot(); got.Running || got.Failures != 0 || got.Pushed != 0 {
		t.Fatalf("old-generation response changed current status: %+v", got)
	}
	m.mu.RLock()
	sent := len(m.sent)
	m.mu.RUnlock()
	if sent != 0 {
		t.Fatalf("old-generation response repopulated %d media entries", sent)
	}

	cancel()
	waitLifecycleCondition(t, "new-generation request to retire", func() bool {
		m.mu.RLock()
		defer m.mu.RUnlock()
		return len(m.active) == 0
	})
}

func TestTargetRotationImmediatelyCancelsBothLoops(t *testing.T) {
	local := localStub()
	defer local.Close()

	oldMediaStarted := make(chan struct{})
	oldPlaneStarted := make(chan struct{})
	oldMediaCanceled := make(chan struct{})
	oldPlaneCanceled := make(chan struct{})
	var oldMediaStartOnce, oldPlaneStartOnce sync.Once
	var oldMediaCancelOnce, oldPlaneCancelOnce sync.Once
	newMediaStarted := make(chan struct{})
	newPlaneStarted := make(chan struct{})
	var newMediaOnce, newPlaneOnce sync.Once

	m := New(Config{SourceURL: local.URL + "/party/index.m3u8", Logf: func(string, ...any) {}})
	m.originClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		plane := strings.Contains(req.URL.Path, "/__pp/")
		if req.URL.Host == "old.invalid" {
			if plane {
				oldPlaneStartOnce.Do(func() { close(oldPlaneStarted) })
			} else {
				oldMediaStartOnce.Do(func() { close(oldMediaStarted) })
			}
			<-req.Context().Done()
			if plane {
				oldPlaneCancelOnce.Do(func() { close(oldPlaneCanceled) })
			} else {
				oldMediaCancelOnce.Do(func() { close(oldMediaCanceled) })
			}
			return nil, req.Context().Err()
		}
		if got := req.Header.Get("Authorization"); got != "Bearer new-token" {
			t.Errorf("replacement authorization = %q", got)
		}
		if plane {
			newPlaneOnce.Do(func() { close(newPlaneStarted) })
		} else {
			newMediaOnce.Do(func() { close(newMediaStarted) })
		}
		return lifecycleResponse(req, http.StatusServiceUnavailable, "stop"), nil
	})
	m.SetTarget("https://old.invalid/room/", "old-token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.SetEnabled(true)
	go m.Run(ctx)
	go m.RunPlane(ctx, PlaneHooks{Snapshots: func() map[string]json.RawMessage {
		return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
	}})

	waitLifecycleSignal(t, oldMediaStarted, "old media request to start")
	waitLifecycleSignal(t, oldPlaneStarted, "old plane request to start")
	m.SetTarget("https://new.invalid/room/", "new-token")
	waitLifecycleSignal(t, oldMediaCanceled, "old media request cancellation")
	waitLifecycleSignal(t, oldPlaneCanceled, "old plane request cancellation")
	waitLifecycleSignal(t, newMediaStarted, "replacement media request")
	waitLifecycleSignal(t, newPlaneStarted, "replacement plane request")
}

func TestTargetChangeWakesBothRetryLoops(t *testing.T) {
	local := localStub()
	defer local.Close()

	oldMedia := make(chan struct{})
	oldPlane := make(chan struct{})
	var oldMediaOnce, oldPlaneOnce sync.Once
	oldOrigin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/__pp/") {
			oldPlaneOnce.Do(func() { close(oldPlane) })
		} else {
			oldMediaOnce.Do(func() { close(oldMedia) })
		}
		http.Error(w, "retry", http.StatusServiceUnavailable)
	}))
	defer oldOrigin.Close()

	newMedia := make(chan struct{})
	newPlane := make(chan struct{})
	var newMediaOnce, newPlaneOnce sync.Once
	newOrigin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/__pp/") {
			newPlaneOnce.Do(func() { close(newPlane) })
		} else {
			newMediaOnce.Do(func() { close(newMedia) })
		}
		http.Error(w, "retry", http.StatusServiceUnavailable)
	}))
	defer newOrigin.Close()

	m := New(Config{SourceURL: local.URL + "/party/index.m3u8", Logf: func(string, ...any) {}})
	m.SetTarget(oldOrigin.URL+"/room/", "old-token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.SetEnabled(true)
	go m.Run(ctx)
	go m.RunPlane(ctx, PlaneHooks{Snapshots: func() map[string]json.RawMessage {
		return map[string]json.RawMessage{"status": json.RawMessage(`{}`)}
	}})

	waitLifecycleSignal(t, oldMedia, "old media failure")
	waitLifecycleSignal(t, oldPlane, "old plane failure")
	waitLifecycleCondition(t, "both loops to enter retry waits", func() bool {
		m.mu.RLock()
		defer m.mu.RUnlock()
		return len(m.active) == 0
	})
	m.SetTarget(newOrigin.URL+"/room/", "new-token")
	waitLifecycleSignalWithin(t, newMedia, "sleeping media loop to wake", 750*time.Millisecond)
	waitLifecycleSignalWithin(t, newPlane, "sleeping plane loop to wake", 750*time.Millisecond)
}

func TestLifecycleInvalidationJoinsPlaneCallbacks(t *testing.T) {
	for _, callback := range []string{"presence", "write"} {
		t.Run(callback, func(t *testing.T) {
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"listeners":1,"writes":[{"path":"post","body":{"n":1}}]}`))
			}))
			defer origin.Close()

			m := New(Config{})
			m.SetTarget(origin.URL+"/room/", "token")
			m.SetEnabled(true)
			entered := make(chan struct{})
			allowRead := make(chan struct{})
			readDone := make(chan struct{})
			release := make(chan struct{})
			var enterOnce sync.Once
			block := func() {
				enterOnce.Do(func() { close(entered) })
				<-allowRead
				_ = m.Snapshot() // must not deadlock with invalidation's join
				close(readDone)
				<-release
			}
			hooks := PlaneHooks{Snapshots: func() map[string]json.RawMessage { return nil }}
			if callback == "presence" {
				hooks.Presence = func(Presence) { block() }
			} else {
				hooks.ApplyWrite = func(string, json.RawMessage) { block() }
			}

			planeDone := make(chan struct{})
			go func() {
				m.planeCycle(context.Background(), hooks)
				close(planeDone)
			}()
			waitLifecycleSignal(t, entered, callback+" callback to start")

			disableDone := make(chan struct{})
			go func() {
				m.SetEnabled(false)
				close(disableDone)
			}()
			waitLifecycleCondition(t, "invalidation to advance state", func() bool { return !m.isEnabled() })
			close(allowRead)
			waitLifecycleSignal(t, readDone, callback+" callback state read")
			select {
			case <-disableDone:
				t.Fatal("invalidation returned before the committed callback finished")
			default:
			}
			close(release)
			waitLifecycleSignal(t, planeDone, callback+" callback to finish")
			waitLifecycleSignal(t, disableDone, "invalidation to join callback")
		})
	}
}

func TestLifecycleInvalidationSuppressesCallbacksWaitingAtCommitBoundary(t *testing.T) {
	for _, callback := range []string{"presence", "write"} {
		t.Run(callback, func(t *testing.T) {
			drained := make(chan struct{})
			var drainOnce sync.Once
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"listeners":1,"writes":[{"path":"post","body":{"n":1}}]}`))
				drainOnce.Do(func() { close(drained) })
			}))
			defer origin.Close()

			m := New(Config{})
			m.SetTarget(origin.URL+"/room/", "token")
			m.SetEnabled(true)
			var called atomic.Int32
			hooks := PlaneHooks{Snapshots: func() map[string]json.RawMessage { return nil }}
			if callback == "presence" {
				hooks.Presence = func(Presence) { called.Add(1) }
			} else {
				hooks.ApplyWrite = func(string, json.RawMessage) { called.Add(1) }
			}

			// Hold the commit gate while the drain finishes, putting the callback
			// precisely between its HTTP result and final generation check.
			m.commit.Lock()
			planeDone := make(chan struct{})
			go func() {
				m.planeCycle(context.Background(), hooks)
				close(planeDone)
			}()
			waitLifecycleSignal(t, drained, "plane drain to finish")
			disableDone := make(chan struct{})
			go func() {
				m.SetEnabled(false)
				close(disableDone)
			}()
			waitLifecycleCondition(t, "invalidation to advance state", func() bool { return !m.isEnabled() })
			m.commit.Unlock()

			waitLifecycleSignal(t, disableDone, "invalidation to cross callback boundary")
			waitLifecycleSignal(t, planeDone, "stale plane cycle to retire")
			if got := called.Load(); got != 0 {
				t.Fatalf("stale %s callback ran %d times", callback, got)
			}
		})
	}
}

func waitLifecycleSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	waitLifecycleSignalWithin(t, ch, what, time.Second)
}

func waitLifecycleSignalWithin(t *testing.T, ch <-chan struct{}, what string, timeout time.Duration) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func waitLifecycleCondition(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func lifecycleResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}
