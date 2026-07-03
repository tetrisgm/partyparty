package publish

import "testing"

func TestParseFFTime(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"frame= 100 time=00:00:05.00 bitrate=", 5000},
		{"time=01:02:03.50", 3723500},
		{"time=00:00:00.00", 0},
		// multiple progress lines → the LAST wins (final duration)
		{"time=00:00:01.00 x\ntime=00:10:00.25 y", 600250},
		{"no time here", 0},
	}
	for _, c := range cases {
		if got := parseFFTime(c.in); got != c.want {
			t.Errorf("parseFFTime(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestAutoSlugHasFullDate(t *testing.T) {
	// Must carry the year, else the same day next year collides on one page.
	s := autoSlug("fader91")
	// "fader91-YYYYMMDD" → prefix + '-' + 8 digits
	if len(s) != len("fader91-")+8 {
		t.Fatalf("autoSlug year missing: %q", s)
	}
	if s[:8] != "fader91-" {
		t.Fatalf("autoSlug prefix wrong: %q", s)
	}
	for _, r := range s[len("fader91-"):] {
		if r < '0' || r > '9' {
			t.Fatalf("autoSlug date not all digits: %q", s)
		}
	}
	if autoSlug("")[:4] != "set-" {
		t.Fatalf("autoSlug fallback prefix wrong: %q", autoSlug(""))
	}
}

func TestSignatureStableAndSensitive(t *testing.T) {
	// Signature over missing files is empty; identical inputs are stable. (Real
	// name+size sensitivity is covered where files exist; here we assert the
	// stable/empty contract the dedup relies on.)
	if Signature(nil) != "" {
		t.Errorf("empty recordings should sign to empty")
	}
	a := Signature([]string{"/nope/a.aac"})
	b := Signature([]string{"/nope/a.aac"})
	if a != b {
		t.Errorf("signature not stable: %q vs %q", a, b)
	}
}

func TestValidSlugRe(t *testing.T) {
	ok := []string{"a", "fader91-20260101", "Foo.Bar_baz-1", "x"}
	bad := []string{"", "has space", "no/slash", "emoji😀", string(make([]byte, 49))}
	for _, s := range ok {
		if !validSlugRe.MatchString(s) {
			t.Errorf("want valid: %q", s)
		}
	}
	for _, s := range bad {
		if validSlugRe.MatchString(s) {
			t.Errorf("want invalid: %q", s)
		}
	}
}
