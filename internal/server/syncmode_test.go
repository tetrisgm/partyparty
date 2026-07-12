package server

import (
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
