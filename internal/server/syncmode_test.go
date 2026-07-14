package server

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"partyparty/internal/config"
)

const guestAddr = "10.0.0.42:5555"

func syncObj(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	obj, ok := m["sync"].(map[string]any)
	if !ok {
		t.Fatalf("/api/status has no sync object: %v", m["sync"])
	}
	return obj
}

func TestSyncModeDefaultAndStatusShape(t *testing.T) {
	env := newTestEnv(t, nil)

	if got := env.srv.currentSyncMode(); got != "balanced" {
		t.Fatalf("default sync mode = %q, want balanced", got)
	}

	// DJ status: compact sync object for the room + the DJ-only radio menu.
	m := decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr))
	obj := syncObj(t, m)
	if obj["mode"] != "balanced" {
		t.Errorf("sync.mode = %v, want balanced", obj["mode"])
	}
	if obj["seek"] != false {
		t.Errorf("sync.seek = %v, want false (balanced is no-seek)", obj["seek"])
	}
	if obj["pin"] != true {
		t.Errorf("sync.pin = %v, want true (balanced is pinned)", obj["pin"])
	}
	if tgt, _ := obj["target"].(float64); tgt <= 0 {
		t.Errorf("sync.target = %v, want > 0", obj["target"])
	}
	menu, ok := m["syncModes"].([]any)
	if !ok || len(menu) != len(syncModeOrder) {
		t.Fatalf("DJ syncModes menu = %v, want %d entries", m["syncModes"], len(syncModeOrder))
	}

	// Guest status: sync object still present (guests must apply it), but the
	// static radio menu is DJ-only so it never bloats the guest join-path poll.
	mg := decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", guestAddr))
	if _, ok := syncObj(t, mg)["seek"]; !ok {
		t.Error("guest status missing sync.seek")
	}
	if mg["syncModes"] != nil {
		t.Errorf("guest status leaked syncModes menu: %v", mg["syncModes"])
	}
}

func TestSyncModeSetChangesApproach(t *testing.T) {
	env := newTestEnv(t, nil)

	// deep buffer: pinned, target 6.
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=deep", djAddr); w.Code != http.StatusOK {
		t.Fatalf("set deep = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	obj := syncObj(t, decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr)))
	if obj["mode"] != "deep" || obj["pin"] != true {
		t.Errorf("after deep: mode=%v pin=%v, want deep/true", obj["mode"], obj["pin"])
	}
	if tgt, _ := obj["target"].(float64); tgt != 6 {
		t.Errorf("deep target = %v, want 6", obj["target"])
	}
	if env.srv.syncTarget() != 6 || !env.srv.syncPinEnabled() {
		t.Errorf("deep accessors: target=%v pin=%v", env.srv.syncTarget(), env.srv.syncPinEnabled())
	}

	// no-pin: the /live proxy must stop injecting EXT-X-START.
	do(env.srv, http.MethodPost, "/api/sync-mode?mode=nopin", djAddr)
	if env.srv.syncPinEnabled() {
		t.Error("nopin approach still reports pin enabled")
	}
	if pin := syncObj(t, decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr)))["pin"]; pin != false {
		t.Errorf("nopin status pin = %v, want false", pin)
	}

	// seek: native does the muted startup seek again.
	do(env.srv, http.MethodPost, "/api/sync-mode?mode=seek", djAddr)
	if seek := syncObj(t, decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr)))["seek"]; seek != true {
		t.Errorf("seek status seek = %v, want true", seek)
	}
}

// TestSyncModeDynamicPinInjection drives the /live reverse proxy against a fake
// LL-HLS upstream and proves the EXT-X-START pin follows the CURRENT approach at
// request time (the whole point of making injection dynamic): balanced pins,
// nopin doesn't, and /live-plain is never pinned regardless of mode.
func TestSyncModeDynamicPinInjection(t *testing.T) {
	const multivariant = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000\nstream.m3u8\n"
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/index.m3u8") {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			io.WriteString(w, multivariant)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer up.Close()
	port := up.Listener.Addr().(*net.TCPAddr).Port

	env := newTestEnv(t, func(c *config.Config) { c.HLSPort = port; c.LatencyTarget = 3 })

	fetchLive := func(path string) string {
		return do(env.srv, http.MethodGet, path, djAddr).Body.String()
	}

	// Default (balanced) → /live carries the pin at the room target.
	if b := fetchLive("/live/party/index.m3u8"); !strings.Contains(b, "#EXT-X-START:TIME-OFFSET=-3.000") {
		t.Fatalf("balanced /live missing pin:\n%s", b)
	}
	// /live-plain is the un-pinned escape hatch even when the room is pinned.
	if b := fetchLive("/live-plain/party/index.m3u8"); strings.Contains(b, "#EXT-X-START") {
		t.Errorf("/live-plain carried a pin:\n%s", b)
	}

	// Flip to nopin → /live must stop injecting, live, without a rebuild.
	do(env.srv, http.MethodPost, "/api/sync-mode?mode=nopin", djAddr)
	b := fetchLive("/live/party/index.m3u8")
	if strings.Contains(b, "#EXT-X-START") {
		t.Errorf("nopin /live still injected the pin:\n%s", b)
	}
	if !strings.Contains(b, "#EXT-X-STREAM-INF") {
		t.Errorf("nopin /live didn't proxy the playlist:\n%s", b)
	}

	// Flip back → the pin returns.
	do(env.srv, http.MethodPost, "/api/sync-mode?mode=balanced", djAddr)
	if b := fetchLive("/live/party/index.m3u8"); !strings.Contains(b, "#EXT-X-START:TIME-OFFSET=-3.000") {
		t.Errorf("pin did not return after flipping back to balanced:\n%s", b)
	}
}

// TestSyncModePreciseReshapesWithRollback covers the geometry-changing switch:
// Precise triggers the injected ReshapeStream with its 1s/500ms/32 shape; a
// failing reshape rolls the geometry back and KEEPS the old mode; switching to
// a same-geometry preset never calls reshape.
func TestSyncModePreciseReshapesWithRollback(t *testing.T) {
	env := newTestEnv(t, nil)
	var calls [][3]any
	fail := false
	env.srv.ReshapeStream = func(part, seg string, count int) error {
		calls = append(calls, [3]any{part, seg, count})
		if fail && len(calls) == 1 {
			return fmt.Errorf("engine refused")
		}
		return nil
	}

	// Successful switch to precise: exactly one reshape with the precise shape.
	w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr)
	if w.Code != http.StatusOK {
		t.Fatalf("switch to precise = %d (%s)", w.Code, w.Body.String())
	}
	if len(calls) != 1 || calls[0] != [3]any{"500ms", "1s", 32} {
		t.Fatalf("reshape calls = %v, want one (500ms,1s,32)", calls)
	}
	if env.srv.currentSyncMode() != "precise" {
		t.Fatalf("mode = %q, want precise", env.srv.currentSyncMode())
	}
	obj := syncObj(t, decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr)))
	if obj["reroll"] != true {
		t.Errorf("precise sync.reroll = %v, want true", obj["reroll"])
	}
	if obj["switching"] != false {
		t.Errorf("sync.switching = %v, want false at rest", obj["switching"])
	}

	// Same-geometry flips (precise -> precise) never reshape.
	calls = nil
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr); w.Code != http.StatusOK {
		t.Fatalf("re-set precise = %d", w.Code)
	}
	if len(calls) != 0 {
		t.Fatalf("same-geometry switch called reshape: %v", calls)
	}

	// Back to balanced (geometry differs again): one reshape with the defaults.
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=balanced", djAddr); w.Code != http.StatusOK {
		t.Fatalf("back to balanced = %d", w.Code)
	}
	if len(calls) != 1 || calls[0] != [3]any{env.srv.Config.PartDur, env.srv.Config.SegDur, env.srv.Config.SegCount} {
		t.Fatalf("balanced reshape calls = %v, want config defaults", calls)
	}

	// Failing reshape: rollback restores the OLD geometry and the mode stays.
	calls = nil
	fail = true
	w = do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("failing switch = %d, want 500", w.Code)
	}
	if len(calls) != 2 {
		t.Fatalf("want reshape attempt + rollback, got %v", calls)
	}
	if calls[1] != [3]any{env.srv.Config.PartDur, env.srv.Config.SegDur, env.srv.Config.SegCount} {
		t.Fatalf("rollback geometry = %v, want config defaults", calls[1])
	}
	if env.srv.currentSyncMode() != "balanced" {
		t.Fatalf("mode after failed switch = %q, want balanced (unchanged)", env.srv.currentSyncMode())
	}
	if env.srv.isSyncSwitching() {
		t.Fatal("switching flag stuck after a failed transition")
	}
}

func TestSyncModePreciseRequiresReshapeHook(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.ReshapeStream = nil // no engine (MTX unavailable)
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr); w.Code != http.StatusBadRequest {
		t.Fatalf("precise without reshape hook = %d, want 400", w.Code)
	}
	if env.srv.currentSyncMode() != "balanced" {
		t.Fatalf("mode changed despite rejection: %q", env.srv.currentSyncMode())
	}
	// Non-geometry presets still switch instantly without the hook.
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=deep", djAddr); w.Code != http.StatusOK {
		t.Fatalf("deep without reshape hook = %d, want 200", w.Code)
	}
}

func TestSyncModeSwitchSerialization(t *testing.T) {
	env := newTestEnv(t, nil)
	env.srv.ReshapeStream = func(string, string, int) error { return nil }
	// Simulate an in-flight transition: a concurrent geometry switch must 409.
	if !env.srv.beginSyncSwitch() {
		t.Fatal("could not begin switch")
	}
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr); w.Code != http.StatusConflict {
		t.Fatalf("concurrent switch = %d, want 409", w.Code)
	}
	// Status reports the transition to the console.
	if obj := syncObj(t, decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", djAddr))); obj["switching"] != true {
		t.Errorf("sync.switching = %v, want true mid-transition", obj["switching"])
	}
	env.srv.endSyncSwitch()
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=precise", djAddr); w.Code != http.StatusOK {
		t.Fatalf("switch after release = %d, want 200", w.Code)
	}
}

func TestSyncModeRejectsBadAndGuests(t *testing.T) {
	env := newTestEnv(t, nil)

	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=bogus", djAddr); w.Code != http.StatusBadRequest {
		t.Errorf("unknown mode = %d, want 400", w.Code)
	}
	// A guest (non-loopback) must not be able to retune the room.
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=deep", guestAddr); w.Code != http.StatusForbidden {
		t.Errorf("guest set = %d, want 403", w.Code)
	}
	if env.srv.currentSyncMode() != "balanced" {
		t.Errorf("room retuned despite rejected requests: %q", env.srv.currentSyncMode())
	}
	// Wrong method.
	if w := do(env.srv, http.MethodGet, "/api/sync-mode?mode=deep", djAddr); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET sync-mode = %d, want 405", w.Code)
	}
}
