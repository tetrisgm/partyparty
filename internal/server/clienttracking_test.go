package server

import (
	"bytes"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func TestCappedLoadOrStoreBoundsConcurrentKeyMaps(t *testing.T) {
	var entries int32
	var values sync.Map

	if value, loaded, ok := cappedLoadOrStore(&values, &entries, 1, "first", "one"); !ok || loaded || value != "one" {
		t.Fatalf("first insert = %#v, loaded=%v accepted=%v", value, loaded, ok)
	}
	if value, loaded, ok := cappedLoadOrStore(&values, &entries, 1, "first", "other"); !ok || !loaded || value != "one" {
		t.Fatalf("existing insert = %#v, loaded=%v accepted=%v", value, loaded, ok)
	}
	if _, _, ok := cappedLoadOrStore(&values, &entries, 1, "overflow", "two"); ok {
		t.Fatal("new key was accepted after the cap")
	}
	if got := atomic.LoadInt32(&entries); got != 1 {
		t.Fatalf("entry count = %d, want 1", got)
	}
}

func TestClientIdentityMapsClipAndRefuseNewKeysAtCapacity(t *testing.T) {
	env := newTestEnv(t, nil)
	longCID := strings.Repeat("x", 1000)
	body := `{"cid":"` + longCID + `","kind":"join","msg":"failed"}`
	w := doBody(env.srv, http.MethodPost, "/api/client-log", "127.0.0.1:5000",
		"application/json", bytes.NewBufferString(body))
	if w.Code != http.StatusOK {
		t.Fatalf("client log = %d %q", w.Code, w.Body.String())
	}
	key := "log:" + strings.Repeat("x", 64)
	if _, ok := env.srv.clientLogN.Load(key); !ok || atomic.LoadInt32(&env.srv.clientCIDs) != 1 {
		t.Fatal("client log key was not clipped and counted")
	}

	atomic.StoreInt32(&env.srv.clientCIDs, maxClientDiagnosticIDs)
	body = `{"cid":"new-client","kind":"join","msg":"failed"}`
	w = doBody(env.srv, http.MethodPost, "/api/client-log", "127.0.0.1:5000",
		"application/json", bytes.NewBufferString(body))
	if w.Code != http.StatusOK {
		t.Fatalf("client log at capacity = %d %q", w.Code, w.Body.String())
	}
	if _, ok := env.srv.clientLogN.Load("log:new-client"); ok {
		t.Fatal("client log map accepted a new identity past its cap")
	}
}

func TestHeartbeatClipsIdentityBeforeTracking(t *testing.T) {
	env := newTestEnv(t, nil)
	longCID := strings.Repeat("guest", 100)
	w := do(env.srv, http.MethodGet, "/api/heartbeat?cid="+longCID+"&v=test", "127.0.0.1:5000")
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat = %d %q", w.Code, w.Body.String())
	}
	roster := env.srv.Listeners.Roster()
	if len(roster) != 1 || len(roster[0].ID) != 64 {
		t.Fatalf("heartbeat identity was not clipped: %#v", roster)
	}
}

func TestClipStrPreservesUTF8Boundary(t *testing.T) {
	prefix := strings.Repeat("x", 63)
	got := clipStr(prefix+"🪩", 64)
	if got != prefix || !utf8.ValidString(got) {
		t.Fatalf("clipped string = %q, valid=%v", got, utf8.ValidString(got))
	}
}
