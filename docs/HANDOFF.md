# partyparty handoff

## Current position

Guest page: DJ snap-reel plus a layout that works on every screen, and a repo-wide dead-code pass.

UI (web/listener.html): DJ cards are a snap reel where snapping moves focus and the switch fires only once the reel settles (REEL_SETTLE_MS=620) — committing per card crossed would rebuild the HLS session and gap the music each time. Removed the "Party feed" heading; the attach control now reads "Add photos"; dropped the duplicate "Audio stays on with screen locked" line from the player bar; artworkSource() no longer substitutes the party cover for an unrecognised track (the in-page sleeve hides, the lock screen keeps the cover); added an expand chevron; the bottom bar is edge-to-edge and flush; an "X people listening" row with avatars and View all sits under the DJ card; the event name and city moved onto the cover and the QR/Share controls are labelled.

Responsive: the page was a phone shell capped at 720px, so a wide window showed a narrow strip under a full-width bar, and a short window (iPad landscape, Fold open) showed almost nothing but cover art. Added bands at <=370px, >=600px, >=760px and >=1024px sharing one --measure so every full-bleed band lines up; the cover takes an explicit height rather than a capped aspect-ratio (aspect-ratio + max-height shrinks the WIDTH, which had the banner covering two thirds of a wide window) and its stale max-width:900px is overridden; the touch reel drops its centring padding, depth cues and dots from 760px up; the composer stacks on very narrow screens so the comment field keeps its width. Measured at 13 sizes from 280x653 to 1920x1080: cover full-width everywhere at 25-47% of viewport height, bar full-width, Post always fits, no horizontal scroll.

Cleanup: dead CSS removed and same-context rules merged (listener 500->359 live rules, dj 438->311 including the auth-*/authgate cluster orphaned when the account system was removed), plus wall.html and site/index.html; 98 lines of the superseded WebSocket-tunnel relay removed from cloudflare/worker.js by cascading elimination; 4 unreferenced Go functions; PLAN.md and FINDINGS.md folded into AGENTS.md; docs/RELEASING.md and the scripts/build-app-store.sh shim deleted; DISTRIBUTION.md de-duplicated; HANDOFF.md rewritten. Every CSS removal proven inert by computed-style diffing against the pristine files at nine breakpoints: zero differences. scripts/test-stream-contract.mjs now locks in the new UI so it cannot silently regress.

Also carries the prior session's relay, set-report and Apple-lane work. Workshop full lane green on the build worker (exit 0).

Workshop checkpoint: `1785782540403-854bb93d` (product).

## Next concrete step

Finish through Workshop. Nothing is installable on TestFlight (all 22 builds expired by the Aug 3 cleanup), so getting Seth or anyone else a build needs a new upload, which is an explicit owner decision and was not taken here.

## Blockers

- scripts/package-app-store.sh refuses to build on prerelease macOS and this Mac is on macOS 27.0 seed 26A5388g, so Store packages must go through the app-store.yml workflow on the macos-15 runner.
- TestFlight Internal testing has zero testers, so every round waits on Apple's external beta review. Seth Finkin (seth.finkin@gmail.com) is an ACCEPTED tester in the external Party testing group.

## Ruled out

- The 300-500 listener load test: the owner cancelled it, and a real party has since run successfully.
- Speaker mode (foreground Web Audio tight sync) — proposed as a sixth sync mode, never adopted. Web Audio, MSE, and rate-nudging are all proven dead on locked iPhones; do not relitigate without new iOS facts.
- hls.js/ManagedMediaSource as the iPhone default — caused an audible seek storm (~1 skip/sec). Native AVPlayer is the engine; MMS is opt-in only.
- Renaming bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, or the Workshop project id: these are installed-app and live-infrastructure compatibility identifiers, not product-facing old-name copy.
- Commit-on-snap for the DJ reel: selectDJ() rebuilds the HLS session, so a flick past four DJs would mean four rebuilds and four audible gaps. Snap moves focus; the switch fires on settle.
- Capping the cover with aspect-ratio + max-height: the browser shrinks the WIDTH to keep the ratio, which left the banner covering two thirds of a wide window. Use an explicit height with object-fit:cover on the img.
- Splitting a CSS selector list on commas without first excluding comments: a comma inside a comment stranded the closing */ in a fragment that was dropped as dead, turning the rest of the stylesheet into one runaway comment and silently killing ~21 rules.

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
