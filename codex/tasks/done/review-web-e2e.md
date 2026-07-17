# Review + fix: guest/DJ web surfaces + cross-cutting consistency

Review for REAL bugs, then fix. Read AGENTS.md first. Do NOT ship or deploy.
Commit on the current branch only; it gets pushed for owner review.

## Scope
- web/listener.html (the LAN guest page), web/dj.html (DJ console),
  web/wall.html, site/index.html (public landing with the live-party
  auto-discovery banner + probe).
- Cross-cutting: consistency between what the Go server serves, what the
  Worker renders, and what these pages fetch. docs/ accuracy is bonus.

## Context — recent changes to these files
- listener.html: fixed top action bar (identity chip, QR, share), join sheet
  captures name/emoji/optional email, Now Playing text lives in the listen
  button hint (outer-scope npHintText), bottom controls enlarged.
  ⚠️ KNOWN LANDMINE: there are TWO base hero layout blocks (the LATER "wide"
  one wins on phones) and an OUTER/INNER JS scope split — an outer function
  referencing an inner-scope variable is a runtime ReferenceError that
  `node --check`-style syntax checks will NOT catch. It caused a P0 (tap to
  listen did nothing). Be extremely careful; prefer reading over rewriting.
- dj.html: QR + shown link prefer urls.public (the permanent
  https://<handle>.partyparty.party/ link) over urls.primary; guest-setup
  strip prefers info.publicUrl.
- site/index.html: fires /api/discover on load, probes each party's joinUrl
  (no-cors, 12s), shows the LIVE NOW banner only for a reachable party.
- Domain flip: everything must reference partyparty.party (party.ramine.net
  only allowed inside the Worker's compat shim).

## What to hunt
1. Runtime JS errors the P0-class syntax checks miss: outer/inner scope
   violations, references to removed element ids, event handlers wired to
   elements that don't exist on some layout branch.
2. Broken flows: join sheet edge cases (localStorage disabled/Safari private
   mode must not throw), QR rendering when urls.public is absent, the
   discovery banner when /api/discover returns parties without joinUrl.
3. Stale domain or path references in ALL web/site files and docs.
4. Accessibility/copy nits ONLY when they are outright bugs (mislabeled
   buttons, unreadable states) — no design opinions.

## Verify
- For each HTML file touched: extract and syntax-check every <script> block
  (write a small node script if needed), AND grep your changed identifiers to
  confirm scope (outer functions must not reference inner-scope vars in
  listener.html).
- `go build ./...` still passes (web/ is embedded), and
  `cd cloudflare && node test/smoke.mjs` passes if you touched anything the
  Worker serves.
- Commit per finding with failure-scenario messages; FINDINGS.md for anything
  found-but-not-fixed.
