//go:build !bundle && !embedhelpers

package main

// Clean dev builds (`go build ./...`, tests, merge-gate verification) must compile
// without the ignored native helper binaries. When those helpers are present
// locally, copy them into the run dir at startup; otherwise return "" and let the
// caller surface the missing-helper state.

import (
	"os"
	"path/filepath"
)

func helperAsset(name string) string {
	candidates := []string{filepath.Join("assets", name)}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "assets", name))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func copyHelper(runDir, name string) string {
	src := helperAsset(name)
	if src == "" {
		return ""
	}
	data, err := os.ReadFile(src)
	if err != nil || len(data) == 0 {
		return ""
	}
	p := filepath.Join(runDir, name)
	if err := os.WriteFile(p, data, 0o755); err != nil {
		return ""
	}
	return p
}

func helperPPCapture(runDir string) string { return copyHelper(runDir, "ppcapture") }
func helperMediaMTX(runDir string) string  { return copyHelper(runDir, "mediamtx") }
func helperFFmpeg(runDir string) string    { return copyHelper(runDir, "ffmpeg") }
