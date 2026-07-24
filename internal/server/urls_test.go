package server

import "testing"

// The permanent link is the canonical /@handle path on the product apex — only
// advertised when it can actually work: an online party, a handle (dots and
// underscores are fine now that it's a path, not a hostname), and an activated
// machine domain to derive the zone from. Everything else returns "".
func TestPublicPartyURL(t *testing.T) {
	cases := []struct {
		name    string
		domain  string
		handle  string
		captive bool
		want    string
	}{
		{"simple handle", "ramine-live.partyparty.party", "ramine", false, "https://partyparty.party/@ramine"},
		{"party. machine namespace", "seth-live.party.partyparty.party", "seth", false, "https://partyparty.party/@seth"},
		{"party. namespace, legacy word slug", "fader91.party.partyparty.party", "seth", false, "https://partyparty.party/@seth"},
		{"legacy word slug still maps", "wave77.partyparty.party", "ramine", false, "https://partyparty.party/@ramine"},
		{"dotted handle works as a /@ path", "x-live.partyparty.party", "seth.finkin", false, "https://partyparty.party/@seth.finkin"},
		{"underscored handle works as a /@ path", "x-live.partyparty.party", "dj_max", false, "https://partyparty.party/@dj_max"},
		{"captive/offline party never advertises the cloud", "ramine-live.partyparty.party", "ramine", true, ""},
		{"no handle yet", "ramine-live.partyparty.party", "", false, ""},
		{"no domain", "", "ramine", false, ""},
		{"single-label domain has no zone", "localhost", "ramine", false, ""},
	}
	for _, c := range cases {
		if got := publicPartyURL(c.domain, c.handle, c.captive); got != c.want {
			t.Errorf("%s: publicPartyURL(%q, %q, %v) = %q, want %q", c.name, c.domain, c.handle, c.captive, got, c.want)
		}
	}
}
