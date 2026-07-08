# Task: worker-side beta robustness + docs (cloudflare/worker.js + README.md)

Read `AGENTS.md` first. Work on your branch only; do NOT `wrangler deploy`. This
task owns `cloudflare/worker.js` and `README.md` (plus a smoke-test run). Do NOT
edit dj.html, site/index.html, or Go/Swift. Do NOT touch the auth/activation
SEMANTICS — the DJ activation gate is SACRED (keep it); these are robustness +
copy + docs changes only.

Fix exactly these (verified beta-readiness findings):

1. **Sign-in no-working-method dead-end (correctness bug).** When no consumer auth
   method is configured (Google/Apple env unset AND email/MXroute SMTP unconfigured),
   `/login` (worker.js ~1632) renders only the email form; on submit `authRequestLink`
   returns `queued=false` and the UI says "use the admin passcode…", but the admin
   passcode field is hidden unless `?admin=1` (~1641) — so a DJ is fully stuck.
   Fix: (a) compute a `providersAvailable` boolean (hasGoogle || hasApple ||
   emailConfigured) and include it in the `/api/account/status` response; (b) in the
   login page renderer, when zero consumer methods are available, render an explicit
   fallback block (surface the existing device-link `install-link/create` path, ~2837)
   plus a clear recovery line, instead of a form that cannot succeed. Do NOT remove
   the activation requirement — just make the zero-providers case reachable/honest.

2. **Make auto-account-create explicit (copy).** A first-timer hits a page titled
   "Sign in" (~1664) but an account is silently created on link (~1741, ~3009). Add a
   line to the `/login` card: "New to partyparty? Your account is created
   automatically the first time you sign in — nothing to fill out." Labeling only.

3. **Quarantine the legacy paste-a-code path (clarity).** Two device-link mechanisms
   coexist: the app-driven browser-token `/link-mac` flow and the legacy
   `install-link/create` "use a code" path surfaced on the /account card (~1735).
   Relabel the account-card code affordance "Older app version only" and add a code
   comment marking it fallback-only, so it isn't mistaken for a parallel supported flow.
   Do not delete it (rec 1 above reuses it as the zero-providers fallback).

4. **Add an honest Uninstalling section.** In `README.md` add an "## Uninstalling"
   section naming exactly what the app registers (the .app in ~/Applications, Sparkle's
   updater/XPC, the login item, the in-bundle FFmpeg/MediaMTX/system-audio helpers) and
   that NOTHING is installed to /Library and no audio driver/kext is left behind (quit,
   drag .app to Trash). Add a condensed version as a FAQ entry in worker.js's FAQ render.

Constraints: no new dependencies; MXroute SMTP only for email (NEVER a paid API).
Keep all guest routes and the activation gate exactly as they are.

Verify: `cd cloudflare && node test/smoke.mjs` (all pass). Paste the output + a summary
of each change in your final report.
