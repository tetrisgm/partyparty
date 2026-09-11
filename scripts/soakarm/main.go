// soakarm serves one experimental arm of the playback soak lab.
//
// WHY THIS EXISTS AT ALL, given that a proxy in the media path is a documented
// dead end. scripts/bench-playlist-proxy.py returned 3.12s, 3.16s and 3.20s for
// three different pin placements: a synchronous Python proxy could not keep up
// with part fetching, so the player fell behind the proxy and the manifest
// under test made no measurable difference. That failure was the proxy's
// implementation, not the idea. The production direct path is ITSELF a Go
// httputil.ReverseProxy (internal/server/server.go, newLiveProxy), so a Go
// reverse proxy configured the same way is the technology already proven to
// keep up with 150ms parts.
//
// The lab still does not take that on trust. It runs this binary twice: once in
// -pin=keep, which must reproduce the unproxied direct arm, and once in
// -pin=strip. If the keep arm does not match the direct arm, this instrument is
// distorting the measurement and the run reports that instead of drawing a
// conclusion from it. That control is the thing the bench proxy never had.
//
// Stripping EXT-X-START is the only difference between the two arms, which
// makes their difference the entire effect of the room's attachment pin.
//
// This is test scaffolding. It is not part of the app, is never shipped, and
// must never be put in front of a real guest.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

// maxPlaylistBytes mirrors the bound the production proxy puts on a rewrite, so
// a broken upstream cannot make this buffer an arbitrary response.
const maxPlaylistBytes = 1 << 20

var seenProto sync.Once

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	upstream := flag.String("upstream", "", "upstream base URL, e.g. http://127.0.0.1:8000")
	pin := flag.String("pin", "keep", "keep: pass playlists through untouched; strip: remove EXT-X-START")
	holdBack := flag.Float64("holdback", 0, "if >0, declare HOLD-BACK=<n> in EXT-X-SERVER-CONTROL (0 leaves the playlist alone)")
	flag.Parse()

	if *upstream == "" {
		log.Fatal("soakarm: -upstream is required")
	}
	target, err := url.Parse(*upstream)
	if err != nil {
		log.Fatalf("soakarm: bad -upstream: %v", err)
	}
	if *pin != "keep" && *pin != "strip" {
		log.Fatalf("soakarm: -pin must be keep or strip, got %q", *pin)
	}
	strip := *pin == "strip"
	setHoldBack := *holdBack > 0

	proxy := &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			// Record what the player actually negotiated. AVPlayer behaves
			// differently at segment and at part granularity, and the protocol
			// is one of the few things that can decide which, so a receipt that
			// does not name it is not comparable to one taken elsewhere.
			if strings.HasSuffix(r.URL.Path, ".m3u8") {
				seenProto.Do(func() { log.Printf("soakarm: client protocol is %s", r.Proto) })
			}
			r.URL.Scheme = target.Scheme
			r.URL.Host = target.Host
			r.Host = target.Host
		},
		Transport: &http.Transport{
			MaxIdleConns:        64,
			MaxIdleConnsPerHost: 64,
			DisableCompression:  true,
		},
		// Match the production proxy: flush every write immediately, or a
		// blocking playlist reload stops being low latency.
		FlushInterval: -1,
		ModifyResponse: func(resp *http.Response) error {
			if (!strip && !setHoldBack) || resp.Request == nil || resp.StatusCode != http.StatusOK {
				return nil
			}
			if !strings.HasSuffix(resp.Request.URL.Path, ".m3u8") {
				return nil
			}
			body, err := io.ReadAll(io.LimitReader(resp.Body, maxPlaylistBytes+1))
			_ = resp.Body.Close()
			if err != nil {
				return err
			}
			if len(body) > maxPlaylistBytes {
				return fmt.Errorf("upstream playlist exceeds %d bytes", maxPlaylistBytes)
			}
			if strip {
				body = stripStart(body)
			}
			if setHoldBack {
				body = setSegmentHoldBack(body, *holdBack)
			}
			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		},
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("soakarm: listen: %v", err)
	}
	log.Printf("soakarm: pin=%s holdback=%.3f upstream=%s listening on http://%s", *pin, *holdBack, target, ln.Addr())
	srv := &http.Server{Handler: proxy}
	if err := srv.Serve(ln); err != nil {
		log.Fatalf("soakarm: serve: %v", err)
	}
}

// stripStart removes the room's attachment pin and nothing else. Media bytes,
// timestamps, segment and part URIs and PROGRAM-DATE-TIME are untouched, so the
// only difference between the two arms is the tag under test.
func stripStart(body []byte) []byte {
	text := string(body)
	if !strings.Contains(text, "#EXT-X-START:") {
		return body
	}
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-START:") {
			continue
		}
		kept = append(kept, line)
	}
	return []byte(strings.Join(kept, "\n"))
}

// setSegmentHoldBack declares an explicit segment-tier HOLD-BACK.
//
// This is the arm that turns "EXT-X-START does nothing" into a usable finding.
// The shipping media playlist declares PART-HOLD-BACK but NOT HOLD-BACK, so a
// client that is holding back at segment granularity falls to the HLS default
// of three target durations. gohlslib rounds TARGETDURATION to an integer
// second, so 500ms segments make that default 3.0s - which is the room's
// declared delay by coincidence, not by design, and would move on its own if
// the segment duration ever changed.
//
// Moving this value in both directions and watching where the player sits is
// what distinguishes a real lever from another inert tag.
func setSegmentHoldBack(body []byte, seconds float64) []byte {
	text := string(body)
	if !strings.Contains(text, "#EXT-X-SERVER-CONTROL:") {
		return body
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if !strings.HasPrefix(line, "#EXT-X-SERVER-CONTROL:") {
			continue
		}
		attrs := strings.Split(strings.TrimPrefix(line, "#EXT-X-SERVER-CONTROL:"), ",")
		kept := attrs[:0]
		for _, a := range attrs {
			if strings.HasPrefix(strings.TrimSpace(a), "HOLD-BACK=") {
				continue
			}
			kept = append(kept, a)
		}
		kept = append(kept, fmt.Sprintf("HOLD-BACK=%.5f", seconds))
		lines[i] = "#EXT-X-SERVER-CONTROL:" + strings.Join(kept, ",")
	}
	return []byte(strings.Join(lines, "\n"))
}
