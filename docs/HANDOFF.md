# PartyParty.party handoff

## Current position

Title bar removed per owner ("is anything besides Settings in the action bar?" -> "do it"). A fixed invisible drag strip (top-left, min(40%,420px) x 30px, -webkit-app-region:drag) keeps the window movable and stays clear of the poster's always-visible Shuffle/Upload cluster; the Settings gear floats top-right as a translucent circular button (same id, JS untouched); the poster tucks under the traffic lights with a small page top pad. All titlebar CSS removed (#actionbar both eras, .abinner, .tbdrag, .titlebar variants); reduced-transparency/contrast/supports rules retargeted; .startstage kept (lives in the go card). Contract test pins the barless chrome (no id="actionbar", dragstrip drag region, floating gear). Bonus fix: a successful avatar load clears the stale "profile photo failed to load" note that pinned itself under a visibly loaded photo. Verified: JS syntax, both web suites, rebuilt+installed+running, desktop screenshot (poster to the top edge, gear floating), Shuffle clicked through the strip zone, zero console errors.

Workshop checkpoint: `1785867306027-22134a7b` (product).

## Next concrete step

Verify then finish through Workshop (scripts/test-stream-contract.mjs + web/dj.html). Remaining from before: owner-triggered beta-review submission for build 248 if Seth is external; owner re-uploads profile photo; next real phone go-live confirms relay assets + ShazamKit.

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

## Current position (2026-08-04, after the console-layout round)

Everything above LANDED as `46c8bfed` on main through Workshop guarded integration (the
Windows worker is fixed and verified the set: full Go suite + web suites + 8 worker smokes).
On top of the incident fixes, the owner's console-layout round shipped in the same commit:

- Console: titlebar is drag + gear only. Capture block ("What to capture" + picker + ? +
  a big pink Start broadcast / Stop broadcast) sits under the poster where the join card
  was; Guests join here follows (no separator above, compact link field); About You lost
  its Name/About labels (placeholders carry it), chips are a real 3-col grid; the party
  feed head holds Open event folder; guests list lives in the right rail (DJ group header
  only when >1 DJ); readiness strip + isolation note live in Settings as "Status"; the ?
  modal copy is current and carries the HTTP failsafe at its bottom. Cover restored on
  the poster with always-visible Shuffle/Upload (full pipeline verified incl. persistence).
- Pretty join URLs: the Worker mints a party-word join name per install
  (broker/join/<name> -> relayToken; r-<token> hosts stay valid), relay/register returns
  it as joinUrl, QR/link show e.g. happy-dance.partyparty.party (verified live).
  wrangler.jsonc name aligned to the deployed worker (partyparty-site).
- TestFlight: workflow run 30896604591 dispatched for 125.32 build 248 (owner-requested).

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
