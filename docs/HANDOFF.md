# PartyParty.party handoff

## Current position

Menu-bar rebuilt as the owner asked: left-clicking 🕺 opens a little NSPopover window that IS the guest QR (CIQRCodeGenerator at 2x, nearest-neighbor crisp, white rounded panel), "N listening" under it, one Go live / Stop broadcast toggle with the console button's exact semantics — stop posts /api/stop immediately; a nameless party opens the console title editor through the new window.ppOpenTitleEditor bridge in dj.html (explicit window property so script scoping can never strand it); start posts /api/start (device=mac default — an interface DJ starts from the console where the picker lives) and surfaces server errors in an alert — plus Open PartyParty and a quiet Quit. The prose menu is deleted (Not broadcasting/version/connection/audio-capture lines, Show QR). Right-click keeps a safety menu (Open, Check for Updates on standalone, Quit) via the set-menu/performClick/unset pattern. The icon now shows a brand-pink ● (attributed title) beside the dancer while live. The "Checking Wi-Fi is broken" report is CLOSED AS BY-DESIGN: connection.mode=checking reason=awaiting_probe is the probe-gated room-mode verdict — the Mac cannot observe its own guest-side reachability (client isolation is only visible from a client), one phone scan resolves it; internetOk was true and both join paths ready. The menu was surfacing an internal pending state; that surface is gone. Transport bar now reads as the deck: raised surface (+5% white), brighter top rule, 0 -12px 32px shadow — measured live. StatusPopover.swift registered in project.pbxproj (classic hand-rolled sequential UUID file list — new files DO NOT auto-include; build failed with "cannot find in scope" until registered). Store bundle builds and launches; web suites pass; ppOpenTitleEditor verified as a function in the running console. NOT verified: the popover pixels themselves — screen-control permission was denied, so the owner should click the 🕺 icon to eyeball it.

Workshop checkpoint: `1785875163163-cfa564bb` (investigation).

## Next concrete step

Verify then finish through Workshop (app/Sources + pbxproj + web/dj.html). Then the owner's Instagram-feed round: composer + post cards + section treatment in dj.html. Standing: owner eyeballs the new menu popover; TestFlight 248 beta-review if Seth is external; next phone go-live confirms relay assets + ShazamKit.

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
