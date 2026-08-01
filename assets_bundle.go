//go:build bundle

package main

// Signed .app build (`go build -tags bundle`): the native helper binaries are NOT
// embedded. They ship pre-signed (Developer ID + hardened runtime) inside
// PartyParty.app/Contents/Helpers/ and are run in place, so notarization covers
// them and the Screen-Recording/audio TCC grant stays anchored to a stable
// on-disk identity across auto-updates. Resolved relative to the running
// executable (Contents/MacOS/PartyParty -> ../Helpers).

import (
	"os"
	"path/filepath"
)

func helpersDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return filepath.Join(filepath.Dir(exe), "..", "Helpers")
}

// In bundle mode runDir is ignored; helpers live in the (read-only, signed) app
// bundle. Returns "" only if the executable path can't be resolved.
func helper(name string) string {
	d := helpersDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, name)
}

func helperPPCapture(string) string { return helper("ppcapture") }
func helperMediaMTX(string) string  { return helper("mediamtx") }
func helperFFmpeg(string) string    { return helper("ffmpeg") }
