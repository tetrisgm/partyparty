# PartyParty.party handoff

## Current position

2026-08-03 live-test failures all root-caused and fixed, verified end-to-end on the real relay. (1) ppcapture silence keepalive: silent Mac now goes live in 1.2s (was 34.5s-or-forever); pushSilence never advances totalPushed so stall/hog detection is unchanged; supervised go-live ran and passed. (2) Contribute media plane: media-playlist name cached (was master-fetch per 50ms = MediaMTX session churn flooding the log ring); failed cycle drops cache and re-masters (heals cert-hotswap session invalidation in one cycle); 3 failures reset jar+sent+page+assets; heal_test.go pins both. (3) Relay guests get page assets: dj-avatar, event cover, both Geist fonts pushed pinned (X-PP-Pin sticky pins on origin, survive playlist Pin replacement + eviction, tested); re-push on PageAssetsRev change. (4) Honesty: contribute.Snapshot in /api/status relay map (pushing/pushFailures/pushError); console readiness + live-phase stage line show relay push failure; presence proved able to stay fresh for hours while media push was dead. (5) Origin release 20260804-082602 deployed (waiting page for pre-live/unknown index.html + sticky pins). (6) diagPath in /api/status; session-log 'missing' was a TCC mirage (Claude shell lists container dirs as empty; logs existed all along). (7) Console: DJ profile unfolded per owner (no disclosure/headings). All local verification green: gofmt/vet/build, 11 Go pkgs incl. real-MediaMTX integration, both web suites, console zero JS errors, full relay chain live (page 204KB, status JSON, avatar 194KB, cover, fonts, stream.m3u8 from a silent Mac). App rebuilt/installed; owner had closed the app, state restored to quit. No Apple upload.

Workshop checkpoint: `1785811321983-8d2922c3` (investigation).

## Next concrete step

Owner: re-upload profile photo (current on-disk avatar is the Jul-28 diagnostic fixture). Next real go-live with a phone confirms relay guests see photo/header/fonts and that ShazamKit surfaces a track once real music plays. Then fix the Windows worker's elevated SSH token (key in administrators_authorized_keys) so workshop_verify_task can run, and land the ~16-file uncommitted change-set through guarded integration.

## Blockers

- Windows build worker rejects all jobs: Invoke-PcBuild.ps1 throws 'Workshop builds must not run with Administrator authority' - SSH key sits in administrators_authorized_keys giving an elevated token; owner-side fix required

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
