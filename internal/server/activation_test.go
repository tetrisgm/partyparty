package server

import "testing"

// The DJ app requires a linked account before it can go live. /api/start must
// refuse with not_activated until activated, then defer to the normal flow.
func TestStartRequiresActivation(t *testing.T) {
	env := newTestEnv(t, nil)

	w := do(env.srv, "POST", "/api/start", djAddr)
	if w.Code != 403 {
		t.Fatalf("unactivated /api/start: got %d, want 403\n%s", w.Code, w.Body.String())
	}
	if m := decodeJSON(t, w); m["error"] != "not_activated" {
		t.Fatalf("unactivated /api/start error = %v, want not_activated", m["error"])
	}

	// Once activated the gate passes; the request now fails later for the missing
	// device (400 device required), proving activation is no longer the blocker.
	env.srv.setAccountActivated(true)
	w = do(env.srv, "POST", "/api/start", djAddr)
	if w.Code == 403 {
		t.Fatalf("activated /api/start still blocked: %d %s", w.Code, w.Body.String())
	}
	if m := decodeJSON(t, w); m["error"] != "device required" {
		t.Fatalf("activated /api/start error = %v, want 'device required'", m["error"])
	}
}

func TestStartDevNoLoginBypassesActivationInDevBuild(t *testing.T) {
	t.Setenv("PP_DEV_NO_LOGIN", "1")
	env := newTestEnv(t, nil)
	env.srv.Version = "dev"

	w := do(env.srv, "POST", "/api/start", djAddr)
	if w.Code == 403 {
		t.Fatalf("dev bypass /api/start still blocked: %d %s", w.Code, w.Body.String())
	}
	if m := decodeJSON(t, w); m["error"] != "device required" {
		t.Fatalf("dev bypass /api/start error = %v, want 'device required'", m["error"])
	}
}

func TestStartDevNoLoginIgnoredOutsideDevBuild(t *testing.T) {
	t.Setenv("PP_DEV_NO_LOGIN", "1")
	env := newTestEnv(t, nil) // Version is a non-dev stamped test build.

	w := do(env.srv, "POST", "/api/start", djAddr)
	if w.Code != 403 {
		t.Fatalf("non-dev bypass /api/start: got %d, want 403\n%s", w.Code, w.Body.String())
	}
	if m := decodeJSON(t, w); m["error"] != "not_activated" {
		t.Fatalf("non-dev bypass /api/start error = %v, want not_activated", m["error"])
	}
}

func TestAccountStatusReportsDevNoLoginBypass(t *testing.T) {
	t.Setenv("PP_DEV_NO_LOGIN", "1")
	env := newTestEnv(t, nil)
	env.srv.Version = "dev"

	w := do(env.srv, "GET", "/api/account/status", djAddr)
	if w.Code != 200 {
		t.Fatalf("dev bypass /api/account/status: got %d, want 200\n%s", w.Code, w.Body.String())
	}
	m := decodeJSON(t, w)
	if m["linked"] != true || m["devBypass"] != true {
		t.Fatalf("dev bypass status = %v, want linked/devBypass true", m)
	}
}

// Activation latches TRUE for the process: an unlinked poll never activates, and
// a later sign-out never clears it mid-session (re-gates on next launch only).
func TestAccountActivationLatch(t *testing.T) {
	s := newTestEnv(t, nil).srv
	if s.accountActivated() {
		t.Fatal("fresh srv must not be activated")
	}
	s.setAccountActivated(false)
	if s.accountActivated() {
		t.Fatal("an unlinked poll must not activate")
	}
	s.setAccountActivated(true)
	if !s.accountActivated() {
		t.Fatal("first linked poll must activate")
	}
	s.setAccountActivated(false)
	if !s.accountActivated() {
		t.Fatal("latch broken: activation cleared mid-session")
	}
}

// The activation gate is DJ-only. A guest hitting the listener page must work
// with no account and no activation — the offline party is never gated.
func TestGuestListenerUngatedByActivation(t *testing.T) {
	env := newTestEnv(t, nil) // never activated
	w := do(env.srv, "GET", "/", "192.168.1.50:5555")
	if w.Code != 200 {
		t.Fatalf("guest listener page got %d, want 200 (must stay ungated)", w.Code)
	}
}
