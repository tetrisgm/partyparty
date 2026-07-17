# Task: rework the macOS notarization approach — fast + reliable + self-healing

## The problem (owner's words)
"Notarization seems broken. You're always taking so long with it." Every release
stalls for many minutes on notarization, and it intermittently fails on Apple's
side (transient upload/S3 errors) with no retry, forcing a manual re-run.

## How it works today (read these first)
- `scripts/notarize.sh` — zips `build/partyparty.app`, runs ONE
  `xcrun notarytool submit … --wait` (blocks 1–5+ min), then `stapler staple`
  the .app. Invoked via `make notarize`.
- `scripts/release.sh` — calls `make notarize` (SUBMISSION 1, the .app), then
  later builds the installer `.pkg` from that app and runs a SECOND
  `xcrun notarytool submit dist/partyparty-$VERSION.pkg --wait` + `stapler
  staple` (SUBMISSION 2, the .pkg). See the block around "package … installer
  pkg" through the pkg staple.
- Net: **two sequential blocking `--wait` submissions per release** (~6–15 min
  total), and **no retry** if Apple returns a transient error mid-upload.

## Why both submissions exist (do NOT collapse to one — this is load-bearing)
There are TWO distribution channels for the SAME signed app:
1. `dist/partyparty-$VERSION.zip` — the Sparkle update enclosure. Sparkle
   installs the `.app` directly (NOT inside a pkg), so the `.app` must be
   independently notarized AND stapled.
2. `dist/partyparty-$VERSION.pkg` — the fresh-install download. Gatekeeper
   checks the pkg's OWN notarization ticket when opened, so the pkg must be
   independently notarized AND stapled.
So both artifacts genuinely need notarization. The win is NOT removing one.

## What to build
Rework `scripts/notarize.sh` and `scripts/release.sh` (add a small shared helper
if it reads cleaner, e.g. `scripts/notary-lib.sh`) so that:

1. **Parallelize the two submissions.** Notarization validates code SIGNATURES,
   not staples — so the `.pkg` can be built from the SIGNED (not-yet-stapled)
   app and submitted CONCURRENTLY with the `.app` submission. Wait for both,
   THEN staple each. This turns two sequential ~4-min waits into one. Preserve
   ordering constraints: sign app → build pkg from signed app → submit app & pkg
   in parallel → wait both → staple app, staple pkg → verify both.
2. **Retry with backoff on transient failures.** Wrap each `notarytool submit`
   in a bounded retry loop (e.g. 3 attempts, exponential-ish backoff). Only
   retry transient/network/5xx/upload errors; a real "Invalid" verdict is
   terminal and must fail loudly (do NOT retry a rejected binary forever).
3. **Diagnosable failures.** Capture each submission id; on a non-"Accepted"
   status fetch `xcrun notarytool log <id> --keychain-profile "$PROFILE"` and
   print the reason. Today a failure is opaque.
4. **Keep everything else identical**: same `pp-notary` keychain profile
   (`PP_NOTARY_PROFILE` override), same Developer-ID signing, same stapled
   outputs feeding the .zip (Sparkle) and the productbuild .pkg, same
   `scripts/verify-release-artifacts.py` gate, same `spctl` acceptance checks
   (`-t exec` for the app, `-t install` for the pkg). `set -euo pipefail`
   discipline; background jobs must propagate failure (capture `wait` exit codes
   per-PID — a failed parallel submit must fail the release, not be swallowed).

## Hard constraints
- The `.app` fed into BOTH the Sparkle .zip and the pkg must end up
  notarized + stapled. `stapler validate` must pass on both the .app and the
  .pkg at the end.
- Don't touch the audio/broadcast core, the Sparkle appcast signing, the R2
  upload/deploy steps, or version derivation — ONLY the notarize/staple/package
  mechanics.
- Keep the scripts POSIX-bash + macOS `xcrun`/`ditto`/`pkgbuild`/`productbuild`
  as today; no new toolchain.

## Verification (important — be honest in FINDINGS)
You CANNOT run a real notarization here: it needs the owner's `pp-notary`
keychain credentials, a real Developer-ID-signed `.app`, and network to Apple's
notary service — none available in this sandbox. So:
- Verify with `bash -n` (syntax) and shellcheck if available on every edited
  script, and hand-trace the control/data flow and the parallel-wait exit-code
  handling.
- Do NOT claim an end-to-end notarization was performed. In a FINDINGS note,
  state explicitly that a live `scripts/ship.sh` run by the owner is required to
  validate, and list exactly what to watch (both artifacts staple + `spctl`
  accept, total wall-clock roughly halved, a forced transient error retries).

Follow `codex/AGENTS.md`. Commit your work on this branch with clear messages.
