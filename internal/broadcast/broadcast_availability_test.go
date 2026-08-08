package broadcast

import (
	"os"
	"path/filepath"
	"testing"

	"partyparty/internal/config"
)

// The console asks whether this Mac can capture system audio, and shows the
// option when the answer is yes. The answer used to be "we have a path for it",
// which is not the same thing: a .app that shipped the helper at the wrong
// place - as the standalone lane did, for as long as its verifier looked at the
// same wrong place - answered yes and then failed at spawn when the DJ pressed
// Start. Offering something that cannot work is worse than saying no.
func TestSystemAudioIsOnlyAvailableWhenTheHelperReallyIs(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "ppcapture")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		path string
		want bool
	}{
		{"a helper that is there", real, true},
		{"a path to nothing", filepath.Join(dir, "gone"), false},
		{"no path at all", "", false},
		{"a directory where the binary should be", dir, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := New(config.Config{}, dir, tc.path, "")
			if got := b.SystemAudioAvailable(); got != tc.want {
				t.Fatalf("SystemAudioAvailable() = %v, want %v", got, tc.want)
			}
		})
	}
}
