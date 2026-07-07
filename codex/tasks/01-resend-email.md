# Task: send magic-link email via Resend

## Why
`cloudflare/worker.js` `sendAuthEmail()` uses the Cloudflare `EMAIL` binding,
which can only deliver to **verified destination addresses** — so magic-link
email sign-in fails for real users ("Email sign-in is temporarily unavailable").
Add Resend (HTTP API) as the primary transactional sender, matching the
auth-kit / Write stack.

## Do
- In `cloudflare/worker.js`, make `sendAuthEmail(env, toEmail, link, devMode)`
  prefer Resend when configured, then fall back to the existing paths:
  1. If `env.AUTH_RESEND_KEY` && `env.AUTH_EMAIL_FROM` → POST
     `https://api.resend.com/emails` with header
     `Authorization: Bearer ${env.AUTH_RESEND_KEY}`, JSON body
     `{ from: env.AUTH_EMAIL_FROM, to: [toEmail], subject, html, text }`
     (reuse `authEmailBody(link)` for subject/html/text). Return `true` on a
     2xx response, `false` otherwise.
  2. else if `env.EMAIL?.send` → existing Cloudflare binding path.
  3. else if MXroute vars → existing `sendViaMXroute`.
  4. else `false`.
- Do NOT hardcode any key — it comes from a Worker secret the owner sets
  (`AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`). Mirror the env-var names above exactly.

## Verify
- Add smoke tests in `cloudflare/test/smoke.mjs` (mirror the existing
  `withGoogleTokenMock` pattern): stub `globalThis.fetch` for
  `https://api.resend.com/emails` and assert that `POST /api/auth/request-link`
  does NOT return `queued:false` when `AUTH_RESEND_KEY` + `AUTH_EMAIL_FROM` are
  set, and that the outbound request carries the right `from`/`to`/auth header.
- `cd cloudflare && node test/smoke.mjs` — all pass (report the count).

## Guardrails
Read `AGENTS.md`. Do not deploy, do not commit secrets. Commit to your branch.
