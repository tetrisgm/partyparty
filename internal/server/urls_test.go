package server

import "testing"

// The permanent link is the canonical /@handle path on the product apex — only
// advertised when it can actually work: an online party, a handle (dots and
// underscores are fine now that it's a path, not a hostname), and an activated
// machine domain to derive the zone from. Everything else returns "".
func TestPublicPartyURL(t *testing.T) {
	cases := []struct {
		name   string
		domain string
		handle string
		want   string
	}{
		{"simple handle", "ramine-live.partyparty.party", "ramine", "https://partyparty.party/@ramine"},
		{"party. machine namespace", "seth-live.party.partyparty.party", "seth", "https://partyparty.party/@seth"},
		{"party. namespace, legacy word slug", "fader91.party.partyparty.party", "seth", "https://partyparty.party/@seth"},
		{"legacy word slug still maps", "wave77.partyparty.party", "ramine", "https://partyparty.party/@ramine"},
		{"dotted handle works as a /@ path", "x-live.partyparty.party", "seth.finkin", "https://partyparty.party/@seth.finkin"},
		{"underscored handle works as a /@ path", "x-live.partyparty.party", "dj_max", "https://partyparty.party/@dj_max"},
		{"no handle yet", "ramine-live.partyparty.party", "", ""},
		{"no domain", "", "ramine", ""},
		{"single-label domain has no zone", "localhost", "ramine", ""},
	}
	for _, c := range cases {
		if got := publicPartyURL(c.domain, c.handle); got != c.want {
			t.Errorf("%s: publicPartyURL(%q, %q) = %q, want %q", c.name, c.domain, c.handle, got, c.want)
		}
	}
}
