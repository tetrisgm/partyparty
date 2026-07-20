package server

import "testing"

// The permanent link is only advertised when it can actually work: online party,
// a plain single-label handle, and an activated machine domain to derive the
// zone from. Everything else falls back to the direct machine link.
func TestPublicPartyURL(t *testing.T) {
	cases := []struct {
		name    string
		domain  string
		handle  string
		captive bool
		want    string
	}{
		{"simple handle", "ramine-live.partyparty.party", "ramine", false, "https://ramine.partyparty.party/"},
		{"party. machine namespace (the QR bug)", "seth-live.party.partyparty.party", "seth", false, "https://seth.partyparty.party/"},
		{"party. namespace, legacy word slug", "fader91.party.partyparty.party", "seth", false, "https://seth.partyparty.party/"},
		{"legacy word slug still maps", "wave77.partyparty.party", "ramine", false, "https://ramine.partyparty.party/"},
		{"captive/offline party never advertises the cloud", "ramine-live.partyparty.party", "ramine", true, ""},
		{"no handle yet", "ramine-live.partyparty.party", "", false, ""},
		{"dotted handle cannot be a hostname", "x-live.partyparty.party", "seth.finkin", false, ""},
		{"underscored handle cannot be a hostname", "x-live.partyparty.party", "dj_max", false, ""},
		{"no domain", "", "ramine", false, ""},
		{"single-label domain has no zone", "localhost", "ramine", false, ""},
	}
	for _, c := range cases {
		if got := publicPartyURL(c.domain, c.handle, c.captive); got != c.want {
			t.Errorf("%s: publicPartyURL(%q, %q, %v) = %q, want %q", c.name, c.domain, c.handle, c.captive, got, c.want)
		}
	}
}
