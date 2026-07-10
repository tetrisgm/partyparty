# Current handoff — synchronization fix ready to ship

Updated 2026-07-10 from branch `codex/event-page-edit-flow`.

## Do this next

Ship the verified synchronization work as a **full native release**, update the
installed Mac app to that exact release, and launch it. Do not use a payload-only
release: the change adds Go server behavior and a new `/api/status.streamSync`
contract.

The single owner-facing command is:

```sh
scripts/ship.sh
```

With the current version files, it should select **48.59** and increment the
Sparkle build from **104** to **105**. Follow the current root `AGENTS.md`: no
extra release approval or branch ceremony is required.

After a successful ship:

1. Verify the public appcast advertises short version `48.59`, Sparkle build
   `105`, an EdDSA signature, and a reachable versioned ZIP.
2. Verify `https://party.ramine.net`, the stable download, and `/api/version`
   report the same release.
3. Update `~/Applications/partyparty.app` through Sparkle. If Sparkle does not
   apply it, install the newly notarized `dist/partyparty-48.59.pkg` locally.
4. Verify the installed `Info.plist` reports version `48.59`, build `105`, then
   launch that installed app.
5. Commit the generated version metadata, fast-forward canonical `main`, and
   push it. Never leave public binaries ahead of GitHub.

## Source state

- Remote: `https://github.com/tetrisgm/partyparty.git`
- Handoff branch: `codex/event-page-edit-flow`
- Base/public release: `6e8c859` (`47.59`)
- Claude design review: `851861a`
- Implemented fix: `5649e61`
- Deeper design and evaluation: `docs/sync-redesign.md`
- The implementation was committed with a clean worktree before this handoff.
- A Developer-ID-signed local bundle was built successfully, but deliberately
  not installed because it still carried the old `47.59` version label.

## User intent and working cadence

- Verified product work should be versioned, shipped, installed, and launched
  without asking for separate per-release approval.
- The website, public downloads, update feed, GitHub source, and installed Mac
  app should all end on the same version.
- The party remains LAN-first and works without internet. Guests never sign in.
- Live audio stays on the Mac; there is no cloud relay.
- Native HLS remains necessary on Apple devices for lock-screen/background audio.
- Protect continuous audible playback: never seek or change playback rate after
  the startup audio gate opens.

## Problem and evidence

Field sessions showed stable rate-1.0 playback after startup, but random startup
cohorts several seconds apart. Buffer starvation was not the root problem: the
bad iPads were 16.4 seconds behind while holding 14.7–15.6 seconds of forward
buffer.

The concrete startup faults were:

- MediaMTX v1.19.2 prefixes a new LL-HLS timeline with seven two-second GAP
  segments. Real runs measured about **14.037 seconds** of synthetic GAP history.
- A client could attach when broadcast state said live but before enough real
  media backed the seven-second room target.
- WebKit reports an assigned `currentTime` while a seek is still pending; reading
  it back is not proof that AVPlayer committed the seek.
- `getStartDate()` can disappear while AVPlayer rebuilds its timeline and has
  approximately whole-second absolute granularity. Its error is common-mode,
  so pairwise listener timing is much tighter than absolute deadline error.
- The old fixed hold and 0.8-second launch lead created nondeterministic cohorts.

## Implemented behavior

Server:

- `internal/mediamtx` follows the multivariant playlist and parses the media
  playlist into contiguous real history, GAP history, part holdback, part target,
  and playlist generation.
- `/api/status.streamSync` exposes generation and readiness.
- Readiness is probed asynchronously at most once per second and latches only
  when contiguous non-GAP history backs the room target.
- Generation changes invalidate readiness and force a fresh client attachment.

Listener:

- Never attaches while idle or while the current generation is GAP-only.
- Native Safari does not attach until the user's gesture, preventing a paused
  AVPlayer timeline from aging before playback.
- Uses six sequential Mac-clock samples and a median of the fastest LAN samples.
- Latches a stable native program-time origin instead of trusting one instant.
- Performs moving-target muted seeks, awaits `seeked`, proves raw playback is
  advancing, and verifies three timing samples before opening audio.
- Startup verification allows 550ms absolute error because of WebKit's common-
  mode origin quantization; the product contract remains typically <=500ms and
  at most one second pairwise.
- Allows at most four muted startup seeks in a 12-second budget.
- A progressing but unmeasurable player opens as explicitly timing-unverified;
  a known gross offset shows a visible Retry Sync state.
- Once audible, no app-directed seek or rate correction occurs.
- Publisher restart reuses the same user-blessed audio element, waits for the
  new generation, then re-enters the muted startup gate.

Room buffering remains a fixed shared contract: all listeners target seven
seconds behind the Mac, while MediaMTX retains about 32 seconds. Do not make the
buffer target per-device. `server.latencyTargetSec` accepts 0–15 through OTA
config, but a changed target applies on server/app startup, not in the middle of
a live session. Keep seven seconds until packed-party evidence shows starvation.

## Verification already completed

Repository checks:

```text
go build ./...                         PASS
go vet ./...                           PASS
gofmt -l .                             clean
go test ./...                          PASS
go test -race ./internal/mediamtx ./internal/server  PASS
cd cloudflare && node test/smoke.mjs   PASS (all cases)
cd app && swift build                  PASS
make app                               PASS; Developer ID signature verified
```

Real LL-HLS browser runs using bundled FFmpeg and MediaMTX:

```text
Server readiness: real=8.021s gaps=14.037s target=7.000s
Chromium startup pair: 141ms spread
WebKit native startup pair: 37ms spread, about 6.2s tap-to-audio
WebKit after injected 650ms peer move: 167ms spread
Chromium after injected 650ms peer move: 503ms spread
Healthy peer continuity: no waits, no seeks, rate 1.0
Missing native program clock: audible bounded fallback; healthy peer unchanged
Publisher restart: PASS on Chromium and native WebKit
Idle/GAP-only attachment gate: PASS on Chromium and native WebKit
```

The browser tests are strong implementation evidence, not a substitute for
physical acoustic measurement on the actual iOS versions.

## Physical validation after release

Use at least one iPhone on iOS 26.4 and Apple devices on iOS 27 beta. Test:

- page opened before Go Live, at Go Live, and mid-set;
- two or more simultaneous joins;
- lock/unlock, backgrounding, camera/photo use, and returning to Safari;
- a publisher rebuild or audio-output-device change;
- built-in speakers separately from Bluetooth output paths.

Acceptance:

- typical pairwise media timing <=500ms; <=1s is acceptable;
- no repeated audible pauses, app seeks, or playback-rate changes;
- one slow or broken device never changes healthy listeners;
- no listener remains silently muted beyond the 15-second watchdog;
- inspect the resulting session log before changing the seven-second room target.

## Guardrails for the next agent

- Do not modify `internal/broadcast/` during release follow-through.
- Do not install the old locally built `47.59` bundle.
- Do not substitute `scripts/release.sh`, manual version edits, or direct Worker
  deployment for `scripts/ship.sh`.
- Do not call this complete until public feed, public download, installed app,
  running app, and GitHub all agree on version/build.
