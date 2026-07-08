# Task: Automated browser-guest E2E stream test + fix loop (no human, no MCP)

## Why
"Guests hear nothing" has bitten repeatedly and is invisible to the existing
`scripts/stream-selftest.sh` (an ffmpeg guest tests the MEDIA path but NOT the
LISTENER PAGE, where the real bug lived: dead `STREAM` guards in
`web/listener.html` that made the player never load). We need a fully-scriptable
test where **one process plays audio and a real headless browser loads the ACTUAL
`web/listener.html` and proves it plays that audio** — then use it to catch any
remaining listener/web-layer streaming bug. Install whatever you need (Playwright
is expected). You may loop: build → run → fix → rerun until it robustly passes.

## Build: `scripts/stream-e2e.mjs` (Node + Playwright), wired into stream-selftest
1. **Serve a live stream.** Reuse the bundled binaries + exact tee like
   `scripts/stream-selftest.sh` (assets/mediamtx + assets/ffmpeg, test-tone
   `sine=frequency=440`, hlsEncryption on with a self-signed cert on throwaway
   ports). PREFER, if you can make it work with dev bypasses, running the REAL
   `partyparty-server` (dev build so `PP_DEV_NO_LOGIN=1` is honored; `device=test`
   skips the realCert gate at /api/start) so the REAL listener page + real
   `/api/status`/`llhlsUrl` are exercised. Fall back to a mock HTTP server that
   serves `web/` verbatim + a mocked `/api/status` (`broadcast.state:"live"`,
   `llhlsUrl:<stream>`, `delivery:"llhls"`, `llhlsRealCert:true`) + `/api/time`.
2. **Browser guest = Playwright headless Chromium**, launched with
   `--autoplay-policy=no-user-gesture-required` and `ignoreHTTPSErrors:true`.
   Load `web/listener.html`, then ASSERT (fail the process nonzero on any):
   - the LL-HLS manifest was actually fetched (watch network for the stream host/port);
   - `#player` reaches `readyState>=3` and `buffered.end(0) > 3`s within ~15s;
   - playback advances: `currentTime` is monotonic and climbs over a multi-second
     window (autoplay allowed, so no tap needed);
   - **REAL AUDIO flows** — inject a WebAudio tap in-page:
     `const ac=new AudioContext(); const src=ac.createMediaElementSource(player);
      const an=ac.createAnalyser(); src.connect(an); an.connect(ac.destination);`
     then sample `getByteTimeDomainData` / `getFloatTimeDomainData` over ~2s and
     assert RMS is clearly non-zero (real tone, not silence). This is the
     definitive "a browser guest actually hears the DJ" check.
   Print a clear `PASS`/`FAIL` line and exit code.
3. **Scenarios:** happy path, and a resilience run that kills+restarts the ffmpeg
   publisher mid-stream (capture-rebuild) and re-asserts the guest recovers.
4. Wire it: `bash scripts/stream-selftest.sh --browser` runs the ffmpeg-guest
   test AND `node scripts/stream-e2e.mjs`. Keep the existing ffmpeg-guest PASS.
5. Add a short README note + a `package.json`/`devDependencies` (playwright) or a
   self-contained `npx playwright` invocation; `npx playwright install chromium`
   in the script if needed.

## Then: use it to FIND + FIX remaining web-layer bugs
Run the browser test. If it fails or is flaky, diagnose and FIX in
`web/listener.html` (and only the web/test layer) until it robustly passes across
several runs. The class of bug to hunt: anything that stops the guest player from
fetching/attaching/playing (stale vars, guards, event wiring, autoplay/prebuffer
logic).

## Guardrails (also see AGENTS.md)
- ONLY: `web/listener.html`, `scripts/*`, a new `scripts/stream-e2e.mjs`,
  `package.json`/lockfile for Playwright. You MAY install software.
- Do NOT touch `internal/broadcast/*` (audio core), the ffmpeg tee/buildArgs,
  `internal/mediamtx/*` config semantics, sign-in, or `main.go`'s pipeline.
- Branch only; do NOT deploy or push main. `go build ./...` must still pass.
- KNOWN LIMIT to document (do not try to defeat): headless Chromium tests the
  hls.js path, NOT iOS Safari NATIVE HLS (Chromium has no native HLS). Note this
  in the README; the native path shares the same fixed guards.

## Done when
`bash scripts/stream-selftest.sh --browser` reliably prints PASS (ffmpeg guest
non-silent AND browser guest fetches+buffers+plays+has non-zero WebAudio RMS)
across repeated runs, committed on the branch with a summary of anything fixed.
