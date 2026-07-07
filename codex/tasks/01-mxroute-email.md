# Task: wire magic-link email through MXroute SMTP (implement sendViaMXroute)

## Email transport is MXroute SMTP. NEVER a paid email API (no Resend, no
## SendGrid, no Postmark). The owner has a lifetime MXroute account and pays
## for nothing else. See ~/dev/stack/runbooks/email-smtp-dns.md.

## Why
`cloudflare/worker.js` `sendAuthEmail()` tries the Cloudflare `EMAIL` binding,
which can only deliver to VERIFIED destinations — so email sign-in fails for
real users. The intended real sender is `sendViaMXroute()`, but it's a stub
that throws ("mxroute sender not wired (U13)"). Implement it.

## Do
- Implement `sendViaMXroute(env, toEmail, link)` in `cloudflare/worker.js` as an
  SMTP client over **`cloudflare:sockets`** (`import { connect } from "cloudflare:sockets"`).
  MXroute is SMTP-only; a Cloudflare Worker has no Node/Nodemailer, so speak SMTP
  directly:
  1. `connect({ hostname, port })` to the MXroute submission host. Support both
     implicit TLS on 465 (`secureTransport: "on"`) and STARTTLS on 587
     (`secureTransport: "starttls"` then `socket.startTls()` after the STARTTLS
     reply). Prefer 465 implicit TLS.
  2. SMTP sequence: read greeting → `EHLO <host>` → (STARTTLS if 587) →
     `AUTH LOGIN` (base64 user, base64 pass) → `MAIL FROM:<from>` →
     `RCPT TO:<toEmail>` → `DATA` → headers (From/To/Subject/MIME
     multipart/alternative text+html from `authEmailBody(link)` + `authEmailFrom(env)`)
     → `.` → `QUIT`. Check each reply code (2xx/3xx expected); return `false`
     and close on any error, `true` on success.
  3. Config: read `env.AUTH_EMAIL_SERVER` first (the kit's convention, a URL like
     `smtps://user:pass@mail.example.com:465` or `smtp://user:pass@host:587`);
     fall back to `env.MXROUTE_SMTP_HOST` / `_PORT` / `_USER` / `_PASS`. Parse the
     URL for host/port/user/pass and TLS mode (`smtps://` = 465 implicit).
- In `sendAuthEmail`, make MXroute the PRIMARY path: try `sendViaMXroute` when
  its config is present, BEFORE the `env.EMAIL` binding (keep `env.EMAIL` only as
  a last-resort fallback). Never hardcode credentials — they're Worker secrets.

## Verify
- Add smoke tests in `cloudflare/test/smoke.mjs`: stub `cloudflare:sockets`
  `connect` with a fake socket whose readable side yields canned SMTP replies
  (220/250/235/250/250/354/250/221) and whose writable side records the bytes
  written; assert `sendViaMXroute` walks the SMTP sequence and returns true, and
  that `/api/auth/request-link` does NOT return `queued:false` when
  `AUTH_EMAIL_SERVER` is set. (If mocking the `cloudflare:sockets` import in the
  Node test harness is impractical, factor the SMTP conversation into a pure
  function that takes read/write streams and unit-test THAT.)
- `cd cloudflare && node test/smoke.mjs` — all pass (report the count).

## Guardrails
Read `AGENTS.md`. MXroute SMTP only — never a paid email API. Do not deploy, do
not commit secrets. Commit to your branch.
