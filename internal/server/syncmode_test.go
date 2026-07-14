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

// The sync payload is a stable contract for deployed player pages: one
// production design, constant values, target from config.
func TestSyncStatusShape(t *testing.T) {
	env := newTestEnv(t, func(c *config.Config) { c.LatencyTarget = 3 })

	for _, addr := range []string{djAddr, guestAddr} {
		m := decodeJSON(t, do(env.srv, http.MethodGet, "/api/status", addr))
		obj := syncObj(t, m)
		if obj["mode"] != "precise" || obj["seek"] != false || obj["pin"] != true || obj["reroll"] != true {
			t.Errorf("%s sync = %v, want precise/no-seek/pin/reroll", addr, obj)
		}
		if tgt, _ := obj["target"].(float64); tgt != 3 {
			t.Errorf("%s sync.target = %v, want 3", addr, obj["target"])
		}
		if _, present := m["syncModes"]; present {
			t.Errorf("%s status still carries the retired syncModes menu", addr)
		}
	}
}

// The retired mode-switch endpoint must be genuinely gone, not half-alive.
func TestSyncModeEndpointRetired(t *testing.T) {
	env := newTestEnv(t, nil)
	if w := do(env.srv, http.MethodPost, "/api/sync-mode?mode=balanced", djAddr); w.Code != http.StatusNotFound {
		t.Fatalf("retired /api/sync-mode = %d, want 404", w.Code)
	}
}

// TestPinInjection drives the /live reverse proxy against a fake LL-HLS
// upstream: the EXT-X-START pin must always be present at the room target.
func TestPinInjection(t *testing.T) {
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

	b := do(env.srv, http.MethodGet, "/live/party/index.m3u8", djAddr).Body.String()
	if !strings.Contains(b, "#EXT-X-START:TIME-OFFSET=-3.000") {
		t.Fatalf("/live multivariant missing the pin:\n%s", b)
	}
	if !strings.Contains(b, "#EXT-X-STREAM-INF") {
		t.Fatalf("/live didn't proxy the playlist:\n%s", b)
	}
	// The experiment-era un-pinned route is retired.
	if w := do(env.srv, http.MethodGet, "/live-plain/party/index.m3u8", djAddr); w.Code != http.StatusNotFound {
		t.Fatalf("retired /live-plain = %d, want 404", w.Code)
	}
}
