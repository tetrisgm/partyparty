# Deep review + fix: cloudflare/worker.js (the whole cloud side)

You are reviewing for REAL bugs and broken behavior, then fixing what you find.
Read AGENTS.md first — the SACRED rules and verification commands bind you.
Do NOT ship, deploy, run wrangler against remote, or touch secrets/DNS. Work
and commit on the current branch only; it gets pushed for owner review.

## Context — what changed recently (highest-risk surfaces)
The product just migrated domains (party.ramine.net → partyparty.party, "THE
FLIP" commit) and gained a large live-party web surface in quick succession:
- Handle router: `<handle>.partyparty.party` root serves a probe page
  (renderLiveJoin) that fetches the Mac's LAN host (no-cors, 3.5s) and
  redirects local guests; off-LAN guests go to `/e/<slug>` (the event page).
  The router must own ONLY the root path — every other path falls through
  (this was a P0: the audio playlist request once got HTML back).
- Event page live mode (renderEvent/eventFromRow): cloud-mirror <audio> player,
  join sheet (name/emoji/optional email → POST /api/e/<slug>/join), composer
  (POST /api/e/<slug>/post, source='web'), presence heartbeat
  (POST /api/e/<slug>/presence), wall auto-refresh via page re-fetch + innerHTML
  swap, combined listener count (LAN presence + webListeners()).
- /api/broker/live check-in response now carries {webListeners, webPosts} back
  to the Mac. liveMirrorUpload MINTS the events row for a fresh party (it used
  to 403 all night). /api/broker/offline + cron demote stale 'live' events.
- Old-domain shim: party.ramine.net serves /api/*, /event/*, /content/*
  unchanged, 301s everything else with label mapping. Do not remove it.
- /api/broker/dns-admin (ADMIN_KEY-gated) does zone record maintenance.
- Auth: Google client + Apple Services ID (party.partyparty.web) + MXroute
  magic-link email were all just migrated.

## What to hunt (in priority order)
1. Security: unauthenticated writes, injection into HTML (esc() misses,
   JSON.stringify into <script> without <-escaping), SSRF via dns-admin,
   IDOR across install/event ownership checks, admin-gate bypasses.
2. Correctness: the new join/presence/post/webPosts flows — identity cookie
   handling, upsert races, email keep-when-blank rule, rate limiting, the
   D1 query shapes vs the real schema (migrations/ *.sql are the truth).
3. The domain shim: any code path that builds a URL from the WRONG base
   (stale party.ramine.net in strings, SITE_ORIGIN misuse, redirect loops).
4. Caching bugs: live pages must be no-store; mirror playlists no-store while
   segments are cacheable.
5. Dead code / contradictory comments introduced by the fast migration.

## Rules of engagement
- Fix what you find; every fix needs a smoke test in cloudflare/test/smoke.mjs
  that fails before and passes after (state this in the commit message).
- `cd cloudflare && node test/smoke.mjs` must pass fully. `node --check
  worker.js` clean.
- No behavior changes that aren't bug fixes. No refactors for taste.
- Commit per finding or per tight group; messages explain the failure scenario.
- Finish with a summary commit message or FINDINGS.md listing anything you
  found but deliberately did not fix (with reasons).
