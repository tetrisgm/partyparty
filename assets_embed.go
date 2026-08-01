//go:build !bundle && embedhelpers

package main

// `make build` build: the native helper binaries are embedded in the Go binary
// and extracted to the run dir at startup. This keeps a single self-contained
// binary for local development and testing after make has regenerated helpers.
//
// The signed .app build uses `-tags bundle` instead (see assets_bundle.go), where
// the helpers ship pre-signed in Contents/Helpers/ so notarization covers them.

import (
	_ "embed"
	"os"
	"path/filepath"
)

//go:embed assets/ppcapture
var capBin []byte

//go:embed assets/mediamtx
var mediamtxBin []byte

//go:embed assets/ffmpeg
var ffmpegBin []byte

// extractHelper writes an embedded binary to runDir and returns its path, or ""
// if the binary isn't embedded (stub build) or extraction fails.
func extractHelper(runDir, name string, data []byte) string {
	if len(data) == 0 {
		return ""
	}
	p := filepath.Join(runDir, name)
	if err := os.WriteFile(p, data, 0o755); err != nil {
		return ""
	}
	return p
}

func helperPPCapture(runDir string) string { return extractHelper(runDir, "ppcapture", capBin) }
func helperMediaMTX(runDir string) string  { return extractHelper(runDir, "mediamtx", mediamtxBin) }
func helperFFmpeg(runDir string) string    { return extractHelper(runDir, "ffmpeg", ffmpegBin) }
