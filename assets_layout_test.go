package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Where ppcapture lives inside a built .app is decided in two places that
// cannot see each other: the Go code that spawns it (assets_bundle.go, built
// with -tags bundle) and the shell that assembles and checks the bundle. When
// the helper became a real .app - TCC needs a bundle - the Go side moved and
// two scripts did not.
//
// The App Store lane died loudly: `make app` stopped at codesign with "No such
// file or directory". The standalone lane died SILENTLY: it wrote a bare
// binary, its verifier looked at that same bare path and passed, and the app
// it produced could not find its own capture helper. Two wrongs agreeing is
// not a check.
//
// This reads the files against each other, so a future move has to move all of
// them. It is a text test on purpose: the bundle path only exists under a build
// tag, and a test that needs -tags bundle is a test that never runs.
func TestEveryLaneAgreesWhereTheCaptureHelperLives(t *testing.T) {
	read := func(path string) string {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		return string(body)
	}

	// The Go side is the source of truth: it is what actually runs the helper.
	source := read("assets_bundle.go")
	if !strings.Contains(source, `helper("ppcapture.app"), "Contents", "MacOS", "ppcapture"`) {
		t.Fatal("assets_bundle.go no longer resolves ppcapture.app/Contents/MacOS/ppcapture; " +
			"if the layout moved, move the scripts named in this test with it")
	}

	// Every script that writes, signs or checks a bundle has to name the same
	// thing. Each of these mentions ppcapture; none may mean the bare binary.
	lanes := []string{
		"scripts/build-app.sh",           // App Store bundle, ad-hoc signed
		"scripts/build-standalone.sh",    // Developer ID + Sparkle
		"scripts/xcode-embed-helpers.sh", // the Xcode phase both share
		"scripts/verify-app-store.sh",    // and the two verifiers
		"scripts/verify-standalone.sh",
	}
	// Helpers/ppcapture NOT followed by ".app" - the layout that silently ships
	// a helper nothing will ever launch. Deliberately allows the deletion and
	// the refusal in verify-standalone.sh, which name the bare path in order to
	// forbid it, by requiring the match to be inside a copy or codesign.
	bare := regexp.MustCompile(`(?m)^[^#\n]*(?:cp|codesign|install)[^\n]*Helpers/ppcapture(?:"|/Contents|\s|$)`)

	for _, lane := range lanes {
		body := read(lane)
		if !strings.Contains(body, "ppcapture.app") {
			t.Errorf("%s: does not mention ppcapture.app - which layout is it building?", lane)
		}
		if m := bare.FindString(body); m != "" {
			t.Errorf("%s: writes or signs the bare Helpers/ppcapture, which the server "+
				"never looks at:\n    %s", lane, strings.TrimSpace(m))
		}
	}
}
