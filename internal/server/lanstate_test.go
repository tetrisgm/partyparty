package server

import "testing"

func TestReduceLanState(t *testing.T) {
	base := lanInputs{
		CertReady: true, Host: "seth-live.party.partyparty.party",
		ExpectedIP: "192.168.4.30", ChecksComplete: true,
	}
	with := func(f func(*lanInputs)) lanInputs { c := base; f(&c); return c }

	cases := []struct {
		name string
		in   lanInputs
		want string
	}{
		{"no cert -> unavailable", with(func(i *lanInputs) { i.CertReady = false }), lanUnavailable},
		{"no host -> unavailable", with(func(i *lanInputs) { i.Host = "" }), lanUnavailable},
		{"cert up, nobody joined -> ready", base, lanReady},
		{"LAN listeners -> confirmed", with(func(i *lanInputs) { i.LanListeners = 2 }), lanConfirmed},
		{"recent guest -> confirmed", with(func(i *lanInputs) { i.GuestConfirmed = true }), lanConfirmed},
		{"only cloud listeners -> cloud_fallback", with(func(i *lanInputs) { i.CloudListeners = 3 }), lanCloudFallback},
		{"LAN presence beats cloud -> confirmed", with(func(i *lanInputs) { i.LanListeners = 1; i.CloudListeners = 5 }), lanConfirmed},
	}
	for _, c := range cases {
		if got := reduceLanState(c.in).State; got != c.want {
			t.Errorf("%s: state = %q, want %q", c.name, got, c.want)
		}
	}

	// The observed counts are carried through for the console to display.
	if s := reduceLanState(with(func(i *lanInputs) { i.LanListeners = 4; i.CloudListeners = 1 })); s.LanListeners != 4 || s.CloudListeners != 1 {
		t.Errorf("counts not carried through: %+v", s)
	}
}

// /api/status exposes the lan object, computed inline from observed reality. With
// no activation in the test env there is no cert, so it reduces to `unavailable`.
func TestStatusIncludesLanObject(t *testing.T) {
	env := newTestEnv(t, nil)
	body := decodeJSON(t, do(env.srv, "GET", "/api/status", ""))
	lan, ok := body["lan"].(map[string]any)
	if !ok {
		t.Fatalf("/api/status has no lan object: %v", body["lan"])
	}
	if lan["state"] != lanUnavailable {
		t.Errorf("lan.state = %v, want %q", lan["state"], lanUnavailable)
	}
}
