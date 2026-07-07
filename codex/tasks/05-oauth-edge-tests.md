# Task: more OAuth failure-path smoke tests

## Why
The Google/Apple OAuth in `cloudflare/worker.js` has happy-path smoke tests;
harden coverage of the failure paths so a regression can't silently sign
someone in wrongly.

## Do
- In `cloudflare/test/smoke.mjs`, reuse the existing helpers
  (`withGoogleTokenMock`, `withAppleTokenMock`, `fakeIdToken`, `googleClaims`,
  `appleClaims`, `googleCallbackReq`, `appleCallbackReq`) and add tests for:
  - token endpoint returns a non-2xx (mock fetch → 400/500) → callback redirects
    to `/login?error=...` and creates NO session cookie.
  - `id_token` is malformed / undecodable → no session.
  - `id_token` missing the `email` claim → `/login?error=verify`, no session.
  - `id_token` with an expired `exp` → rejected, no session.
  - Apple callback with a missing `code` in the form body → `/login?error=state`
    (or the appropriate error), no session.
- Assert each lands on the right `/login?error=...` and sets NO session cookie
  (check `set-cookie`).

## Verify
- `cd cloudflare && node test/smoke.mjs` — all pass; report the new total.

## Guardrails
Read `AGENTS.md`. This is test-only. If a test reveals a REAL bug in the OAuth
logic, note it clearly in your final report (and fix it minimally if obvious).
Commit to your branch.
