# Task: keepsake links — old event slugs still resolve after a rename

## Why
When a DJ renames an event, its slug can change and old shared links (QR codes,
texts) break. Add a slug-alias so `party.ramine.net/e/<old-slug>` still resolves
to the current event.

## Do
- First READ how events + slugs work today in `cloudflare/worker.js` (search
  `/e/`, `events`, `slug`, `updateEventApi`, and the D1 schema in
  `cloudflare/migrations/`). Follow the existing patterns exactly.
- Add a D1 migration `cloudflare/migrations/000N_event_aliases.sql`:
  `event_aliases(old_slug TEXT PRIMARY KEY, slug TEXT NOT NULL, created_ms INTEGER)`
  plus an index on `slug`.
- When an event's slug changes (in the update/upsert path), record the previous
  slug → new slug in `event_aliases` (ignore if unchanged; avoid alias loops and
  never alias to a slug that is itself an active event other than the target).
- In the `/e/<slug>` view handler, if no event matches `<slug>`, look it up in
  `event_aliases` and, if found, **301-redirect** to `/e/<currentSlug>`.

## Verify
- Add smoke tests in `cloudflare/test/smoke.mjs` using the existing `FakeD1`
  harness (add an `event_aliases` store + matchers): renaming an event records
  the alias; hitting the old slug 301s to the new one; an unknown slug still
  404s. `cd cloudflare && node test/smoke.mjs` — all pass.

## Guardrails
Read `AGENTS.md`. Do NOT run migrations against prod (owner does that) and do
NOT `wrangler deploy`. Commit to your branch (migration file + code + tests).
