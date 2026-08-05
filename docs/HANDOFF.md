# PartyParty.party handoff

## Current position (2026-08-05): TestFlight 125.34 build 252 is live

Built locally (PP_TESTFLIGHT_ONLY=1, prerelease host allowed for
TestFlight-only), uploaded, VALID in App Store Connect, and the ONLY live
build (248-251 expired; 251 refused to launch, cause below). External "Party
testing" group attached and submitted for beta review; internal group sees
every build automatically; What to Test notes set. In it: the proper-name fix
(251's launch refusal: ppcapture.app briefly shared the app's bundle id, which
minted the "PartyParty 2" LaunchServices ghost — the capture helper is
fm.partyparty.capture forever, verify-app-store.sh asserts it), the two-clock
capture fix, launch-banner honesty (netTried settles only after two failures),
title-edit save, the mobile guest-page round, and dev builds stamped
MARKETING_VERSION-dev.<gitshort> so a desk install can never wear a TestFlight
number again.

Owner-side proofs still pending: install 252 from TestFlight and see it
launch; play a mainstream track (first provisioned build where ShazamKit CAN
work); a Shack15 re-test watching for zero "stream gaps:" diag lines.

Seth is DONE on our side: his address is leadman.seth.finkin@gmail.com (NOT
seth.finkin@gmail.com — a stale NOT_INVITED tester record under that wrong
address still exists in ASC; owner's call whether to delete it). He accepted
the team invite (Marketing role) and sits in the internal group
(44b3bbe2-07c2-491e-a22d-3747cfe1dfd3) in INVITED state: internal testing
needs NO beta review, so 252 is his the moment he taps the TestFlight invite
email.

## Workflow + build lane facts (2026-08-05)

- This repo now lands ONLY via worktree + branch + merge-gate
  (~/dev/stack/runbooks/workflow.md); a pre-commit hook blocks canonical-main
  commits. Standing worktree: ~/dev/partyparty--work (merge-gate --keep).
- GitHub Actions is dead fleet-wide (workflow file + all eight repo secrets
  deleted). Local login keychain holds both distribution identities; the old
  partyparty-app-store keychain is an unrecoverable CI leftover — leave it.
- Local TestFlight packaging: scripts/package-app-store.sh with
  APP_STORE_PROVISIONING_PROFILE (build/partyparty-mas.provisionprofile, or
  re-download: asc profiles view --id W6PS27X4YK), PP_SIGN_ID "Apple
  Distribution: Ramine Darabiha (52WM463HR2)", APP_STORE_INSTALLER_ID "3rd
  Party Mac Developer Installer: ...", PP_TESTFLIGHT_ONLY=1. Upload:
  asc builds upload --app 6794880742 --pkg dist/PartyParty-app-store.pkg
  --version <v> --build-number <n> --wait.
- First merge-gate runs on this repo surfaced two runner facts: (1) the WSL
  runner's network stack can ACCEPT on a "closed" loopback port, so readiness
  timeout tests must dial a TEST-NET-1 blackhole, never a freed local port
  (internal/mediamtx tests fixed); (2) Playwright browsers are provisioned
  once on the runner as root (npx playwright install --with-deps chromium;
  cache /root/.cache/ms-playwright survives across runner builds).

## The Shack15 cutoff fix (reference)

THE SHACK15 CUTOFF CAUSE IS FIXED AND PROVEN. The 2026-08-04 silence keepalive
in swift/ppcapture.swift fired 120ms after the last real frame - inside normal
HAL callback jitter - so on a loaded venue Mac it repeatedly spliced zeros into
PLAYING audio and every listener heard the same hole at the same instant. The
replacement is a two-clock design: real audio rides the device clock
exclusively (per-cycle mSampleTime accounting; a real-frames meter separates
real from synthesized so a wedged/hogged tap still looks wedged to the health
monitor), and dead air is wall-clock-filled only after 1.5s of no real frames -
strictly beyond what the 0.5s ring + 0.9s hold-back absorb, so the filler is
structurally incapable of touching playing audio - with a 5ms fade-in when
music returns. Empirical facts baked into an every-launch "clock report" diag
line: on a silent Mac the aggregate's IO cycle stops COMPLETELY (cycles=0 over
10s, measured 2026-08-05), so device-clocked silence is impossible on this API
and the wall-clock filler is not optional. Verified live on this Mac: silent
go-live in 4s (was 34.5s/forever), silence->music transition with zero
gapHistory growth. Installed and running (125.33-dev stamp).

## Shazam verdict (2026-08-05 02:30)

Track recognition died 2026-07-31 for TWO stacked reasons, both now resolved
as far as code can: (1) the rename flattened ppcapture to a bare inherit-
signed binary, losing the shazamd mach exception AND the bundle identity TCC
needs - restored on the branch (ppcapture.app, app's bundle id, capture
entitlements, verify-app-store.sh asserts all of it). (2) With that fixed, a
clean-room probe proved the remainder: ShazamKit 202 = "Missing entitlements"
wrapping HTTP 401 from api.shazam.apple.com - catalog matching requires
signing/provisioning that carries the App ID's ShazamKit service. Desk builds
embed no profile and are refused by Apple's server, always. Recognition is
therefore PROVEN only in provisioned builds: the next TestFlight build (with
this branch merged) is the verification vehicle. Desk-build recognition would
need a Mac Development profile embedded (app + capture bundle) - optional
follow-up, not a gate.

## Blockers

None recorded.

## Ruled out

- The 300-500 listener load test: the owner cancelled it, and a real party has since run successfully.
- Speaker mode (foreground Web Audio tight sync) — proposed as a sixth sync mode, never adopted. Web Audio, MSE, and rate-nudging are all proven dead on locked iPhones; do not relitigate without new iOS facts.
- hls.js/ManagedMediaSource as the iPhone default — caused an audible seek storm (~1 skip/sec). Native AVPlayer is the engine; MMS is opt-in only.
- Renaming bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, or the Workshop project id: these are installed-app and live-infrastructure compatibility identifiers, not product-facing old-name copy.
- Commit-on-snap for the DJ reel: selectDJ() rebuilds the HLS session, so a flick past four DJs would mean four rebuilds and four audible gaps. Snap moves focus; the switch fires on settle.
- Capping the cover with aspect-ratio + max-height: the browser shrinks the WIDTH to keep the ratio, which left the banner covering two thirds of a wide window. Use an explicit height with object-fit:cover on the img.
- Splitting a CSS selector list on commas without first excluding comments: a comma inside a comment stranded the closing */ in a fragment that was dropped as dead, turning the rest of the stylesheet into one runaway comment and silently killing ~21 rules.
- React + Tailwind for the console: the app is a single vanilla HTML file embedded in the Go binary and rendered in a WKWebView, with no bundler and no internet at runtime. Emitting React/Tailwind would be a framework migration plus an offline-vendored build step, and would discard ~1,400 lines of working JS driving the QR, status polling, capture permissions and the feed.
- A human-readable join address like party.local/sunset: guest playback is HTTPS and the certificate must validate for the hostname, and an mDNS .local name can never hold a public cert. The readable address already exists as the direct hostname; only relay mode shows the opaque r-<token> URL.
- A start/end chime: capture is Mac system output, so any UI sound plays through that output and lands in the guests' stream. 'Subtle sound' and 'never enters program audio' are mutually exclusive under system-output capture.
- "The container is empty" as evidence: a shell without Full Disk Access LISTS ~/Library/Containers/<id>/Data directories as empty and reads files as "Operation not permitted" (TCC). The 2026-08-03 session logs were "missing" all night while sitting exactly where diag.Open put them. Prove absence with a file read, never with ls; /api/status.diagPath now names the live path.
- Probing the r-<token>.partyparty.party URL with curl to judge room health: the Worker serves its relayBootstrap (a probe-then-redirect page) for EVERY path on r- hosts, so curl sees 4.4KB of HTML regardless of room state. The room lives at <token>.relay.partyparty.party; judge health there.
- Treating relay presence as proof the relay works: presence (RunPlane) and media push (Run) are separate planes with separate failure modes. Fresh presence proves only that snapshots flow.
- Counting HTML tags to prove structure: balanced totals do not prove nesting. </details></div> where </div></details> was meant balances perfectly and silently force-closes an ancestor, landing whole panes inside unrelated elements with no syntax error. The contract test now walks the stack in document order instead.
- Presence freshness as relay health: RunPlane and the media cycle are separate planes; presence stayed fresh for hours while the media push was dead
- Judging room health via the r-<token> URL with curl: the Worker serves its relayBootstrap for every path on r- hosts; judge at <token>.relay… or /__pp/health on the box
- Concluding files are missing from ls of ~/Library/Containers/...: TCC shows those dirs as empty to a no-FDA shell; prove absence by file read

## Owed

- Correction to Apple DTS: an earlier support message said the host was
  "macOS 26.0". It is macOS 27.0 build `26A5388g`.
- Field tests no simulator can stand in for: a real-iPhone wildcard-cert join,
  and a relayed party with more phones than one simulator on venue Wi-Fi
  (`docs/relay-architecture.md`).
- Nothing on the web pages. The stacked layout eras are collapsed: dead rules
  removed and every selector declared more than once in the same context merged
  into one canonical rule (listener 500 -> 359 live rules, dj 438 -> 311), with
  computed-style equivalence proven against the pristine files at nine
  breakpoints. What remains of `.hero` and `.hero .artwork` across `@media`
  blocks is genuine responsive variation, not leftovers.
