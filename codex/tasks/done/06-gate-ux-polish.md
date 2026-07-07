# Task: polish the activation-gate UX in the console

## Why
The DJ activation gate (v15.47+) in `web/dj.html` blocks the console until this
Mac is linked. The copy + behavior can be friendlier without weakening the gate.

## Do (web/dj.html ONLY — do not touch server code or worker.js)
- In `renderAccountState` and the gate markup:
  - Add a subtle one-line explanation under the title of WHY sign-in is needed:
    "Sign in to publish your parties online and link this Mac. You do this once."
  - Improve the OFFLINE-never-activated message so it's clearly actionable
    ("You're offline — connect to the internet once to activate, then partyparty
    works offline at your venue.").
  - Add a gentle retry: while the blocking gate is up and NOT signing in, poll
    `/api/account/status` on a backoff (e.g. 3s → 6s → 12s, cap ~30s) instead of
    a fixed fast interval, so an offline Mac isn't hammering. When the user
    clicks "Sign in / Sign up", switch to the existing 2s active poll.
  - Keep it a BLOCKING gate (no dismiss) and don't change the server contract.

## Verify
- The file stays valid: no unbalanced braces/tags. Load-test the logic mentally
  for the three states (checking / offline-error / not-linked) and confirm the
  console only starts once `linked` (or session-latched). Describe the states in
  your final report.
- If a headless HTML lint is available use it; otherwise `node -e "require('fs').readFileSync('web/dj.html','utf8')"` sanity + a careful read.

## Guardrails
Read `AGENTS.md`. Guests untouched. Commit to your branch. No worker.js changes.
