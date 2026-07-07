# Task: document the auth + activation + offline architecture

## Why
The auth story is now rich (OAuth Google/Apple + magic-link email over MXroute
SMTP, device-link, the DJ activation gate, offline-cached activation) but
undocumented. Write it down so future work doesn't re-derive it. DOCS ONLY — no
code changes.

## Do (create docs/ files only)
- Create `docs/auth.md` covering:
  - The three web sign-in methods (Google, Apple, email magic-link) and where
    each lives in `cloudflare/worker.js` (route names only, no secrets).
  - **Email is MXroute SMTP, never a paid API** (see repo `AGENTS.md`); the
    `AUTH_EMAIL_SERVER` secret format.
  - The device-link flow (`/api/link-install/start` → broker → `/link-mac`
    confirm → bind), and why the confirm is a same-site POST (CSRF).
  - The DJ activation gate: `/api/start` → 403 `not_activated` until linked;
    the server latch; offline-cached activation; guests are never gated.
- Create `docs/offline.md` (or a section) summarizing the offline-first GUEST
  model vs the activation-gated APP (cite `AGENTS.md` sacred rules).
- Keep it accurate to the CURRENT code — read the files, don't guess. Link to
  file paths.

## Verify
- Docs are markdown; no code touched. `git status` shows only new files under
  `docs/`. Re-read your docs against the code for accuracy; report any mismatch
  you found (that itself is valuable).

## Guardrails
Read `AGENTS.md`. Docs only. Never include secret values. Commit to your branch.
