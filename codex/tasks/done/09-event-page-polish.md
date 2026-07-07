# Task: make the published /e/<slug> party page a great shareable artifact

## Why
`/e/<slug>` (rendered in `cloudflare/worker.js`) is the keepsake a DJ shares
after a party — it gathers the set replay (audio + waveform), guest photos/
videos, and comments. The data-gathering works; the PRESENTATION can be much
better so a DJ is proud to post it and guests want to revisit.

## Do (cloudflare/worker.js — the /e/<slug> render only)
First READ the current `/e/<slug>` render + its helpers (search `/e/`,
`getEventBySlug`, the posts/post_media/post_comments gathering ~lines 315-335,
and the page HTML/CSS it emits). Then improve the PRESENTATION, keeping all the
existing data gathering, range-served media, and escaping intact:
- A clean header: event title, host/DJ, date/place, and the cover image if set.
- A prominent **replay player** (the set audio) with the waveform, clearly the
  hero of the page.
- A responsive **photo/video grid** (not a vertical list) for guest media —
  columns on desktop, 2-up on mobile, tasteful gaps, lazy-loaded images.
- A tidy **comment timeline**.
- Mobile-first, fast, no external assets (CSP forbids them — inline CSS, no CDN
  fonts/images). Match the existing light partyparty aesthetic + accent.
- Keep it server-rendered HTML; don't add client frameworks.

## Verify
- `cd cloudflare && node --check worker.js && node test/smoke.mjs` — all pass
  (the /e page + media routes have smoke tests; keep them green, add one if you
  add a meaningful branch). Report the count.

## Guardrails
Read `AGENTS.md`. Do NOT change the publish/broker routes or the data model —
presentation only. Do not deploy. Commit to your branch.
