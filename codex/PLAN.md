# partyparty — next-steps plan (Codex handoff)

Written 2026-07-07, after shipping OAuth sign-in + the DJ activation gate (v15.47).

## Shipped (context)
- **Sign-in**: Google + Apple + email on `party.ramine.net` — hand-rolled OAuth in the Worker, keyed by verified email, no schema migration. LIVE.
- **DJ activation gate (v15.47)**: the Mac app requires a linked account before the console / Go Live run. Guests still join offline. LIVE + auto-updating to friends.

## How this autonomous loop works
- Tasks live in `codex/tasks/*.md`, each self-contained (why, do, verify, guardrails).
- `scripts/codex-loop.sh` runs each task in its **own git worktree + branch** (`codex/<task>`), up to 3 in parallel. Each task is expected to build/test itself and commit to its branch; the loop then **pushes the branch for the owner to review**. It never touches `main` and never deploys.
- Add work by dropping a new `codex/tasks/NN-name.md` and re-running the loop. Finished tasks move to `codex/tasks/done/`; logs land in `codex/logs/`.
- **Read `AGENTS.md` (repo root) first** — sacred guardrails + the exact verify commands.

## Current task queue (`codex/tasks/`)
1. **01-resend-email** — send magic-link email via Resend (Cloudflare's `EMAIL` binding can't reach arbitrary recipients, so email sign-in currently fails).
2. **02-account-status-cache** — stop the console's 2s activation poll from hammering the broker.
3. **03-dev-no-login** — a double-guarded env bypass of the activation gate for local dev/testing.
4. **04-claim-alias** — keepsake links: old event slugs still resolve after a rename.
5. **05-oauth-edge-tests** — more OAuth failure-path smoke tests (test-only, safe).

Good next candidates to add later: account-page polish, event-page richness, worker rate-limit hardening, more `dj.html` gate UX (retry/backoff copy).

## Backlog — needs the OWNER or real devices (do NOT attempt autonomously)
- **Real sign-in E2E**: a human signs in with Google / Apple / email end-to-end; set the Resend + any missing Worker secrets.
- **Field-test the activation gate** on a real *unlinked* Mac: sign out → relaunch → gate → sign in → console unlocks; and offline-after-activation.
- **HTTPS-only part 2**: physically remove the dead plain-HLS tee/handler — SUPERVISED, paired with one go-live test (touches the audio core).
- **Offline hotspot validation on macOS 26** (bridge100), drift-realign, stalled→rebuild — diagnosed from field session logs, not code changes.
- Multi-channel; richer event pages.

## The guardrail that matters most
**Guests must always be able to join the party offline with no account.** The activation gate is DJ-app-only. If a change would make a guest need an account or the internet to join/hear the party, it is wrong. See `AGENTS.md`.
