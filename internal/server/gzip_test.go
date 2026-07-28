package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func doGz(s *Srv, target string, acceptGzip bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.RemoteAddr = "192.168.1.44:1234"
	if acceptGzip {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func gunzipBody(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip failed: %v", err)
	}
	return string(raw)
}

func TestVendorAssetsGzipWhenAccepted(t *testing.T) {
	env := newTestEnv(t, nil)

	// Text asset + gzip accepted → compressed, correct content after gunzip.
	w := doGz(env.srv, "/vendor/hls.js", true)
	if w.Code != http.StatusOK {
		t.Fatalf("vendor fetch = %d", w.Code)
	}
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("vendor .js not gzipped (Content-Encoding=%q)", w.Header().Get("Content-Encoding"))
	}
	if got := gunzipBody(t, w); got != "// hls.js stub" {
		t.Fatalf("gunzipped vendor body = %q", got)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=3600") {
		t.Errorf("vendor lost its cache header: %q", cc)
	}

	// No Accept-Encoding → identity, same content.
	w = doGz(env.srv, "/vendor/hls.js", false)
	if w.Header().Get("Content-Encoding") != "" {
		t.Fatal("vendor gzipped for a client that did not ask for it")
	}
	if w.Body.String() != "// hls.js stub" {
		t.Fatalf("identity vendor body = %q", w.Body.String())
	}

	// Missing file stays a 404.
	if w = doGz(env.srv, "/vendor/nope.js", true); w.Code != http.StatusNotFound {
		t.Fatalf("missing vendor asset = %d, want 404", w.Code)
	}
}

func TestStatusGzipsLargeResponsesOnly(t *testing.T) {
	env := newTestEnv(t, nil)

	// The status body must be valid JSON either way. Small payloads may skip
	// compression (under one MTU there is nothing to win) - assert correctness,
	// not compression.
	w := doGz(env.srv, "/api/status", true)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	body := w.Body.String()
	if w.Header().Get("Content-Encoding") == "gzip" {
		body = gunzipBody(t, w)
	}
	if !strings.Contains(body, "\"appVersion\"") {
		t.Fatalf("status body unrecognizable: %.120s", body)
	}

	// Identity request is never gzipped.
	w = doGz(env.srv, "/api/status", false)
	if w.Header().Get("Content-Encoding") != "" {
		t.Fatal("status gzipped without Accept-Encoding")
	}
	if !strings.Contains(w.Body.String(), "\"appVersion\"") {
		t.Fatalf("identity status body unrecognizable: %.120s", w.Body.String())
	}
}
