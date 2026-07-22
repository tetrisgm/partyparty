# partyparty — next-steps plan (Codex handoff)

## Current architecture investigation

The LAN HTTPS reliability review is complete. The field brief is in
[`docs/lan-https-reliability.md`](../docs/lan-https-reliability.md), and the
prescriptive implementation contract is in
[`docs/lan-https-reliability-execution-plan.md`](../docs/lan-https-reliability-execution-plan.md).
The implementation must follow that chosen architecture rather than reopening
the guard-wildcard, raw-IP, or plain-HTTP alternatives.

The scheduled-live-playout proposal has been compared with the shipped LL-HLS
design and the packed-party field evidence. The implementation and physical
qualification plan is in
[`docs/scheduled-live-playout-plan.md`](../docs/scheduled-live-playout-plan.md).

Native HLS is permanently the iPhone player: lock-screen and background playback
are non-negotiable. The next experiment is a native-HLS Precise profile using
1s segments, 500ms parts, the existing room pin, and at most one muted natural-
start re-roll. Keep the room target fixed during the A/B and do not modify
`internal/broadcast/` until the geometry-only physical test passes on iOS 26 and
27.

## Historical roadmap context

The remainder of this file was written 2026-07-07 after shipping OAuth sign-in
and the DJ activation gate (v15.47). Its completed task list is retained as
history; it is not the current execution queue.

## Shipped (context)
- **Sign-in**: Google + Apple + email on `partyparty.party` — hand-rolled OAuth in the Worker, keyed by verified email, no schema migration. LIVE.
- **DJ activation gate (v15.47)**: the Mac app requires a linked account before the console / Go Live run. Guests still join offline. LIVE + auto-updating to friends.

## How this autonomous loop works
- Tasks live in `codex/tasks/*.md`, each self-contained (why, do, verify, guardrails).
- `scripts/codex-loop.sh` may use isolated worktrees and branches for parallel implementation, but branch review is not release approval. Once integrated product work is complete and verified, follow the root `AGENTS.md`: run the single owner-facing ship command and verify the public and installed product are current without waiting for another user action.
- Add work by dropping a new `codex/tasks/NN-name.md` and re-running the loop. Finished tasks move to `codex/tasks/done/`; logs land in `codex/logs/`.
- **Read `AGENTS.md` (repo root) first** — sacred guardrails + the exact verify commands.

## Historical task queue
1. **01-mxroute-email** — wire magic-link email through **MXroute SMTP** (implement the `sendViaMXroute` stub over `cloudflare:sockets`). Email transport is MXroute SMTP — NEVER a paid email API (no Resend).
2. **02-account-status-cache** — stop the console's 2s activation poll from hammering the broker.
3. **03-dev-no-login** — a double-guarded env bypass of the activation gate for local dev/testing.
4. **04-claim-alias** — keepsake links: old event slugs still resolve after a rename.
5. **05-oauth-edge-tests** — more OAuth failure-path smoke tests (test-only, safe).

Good next candidates to add later: account-page polish, event-page richness, worker rate-limit hardening, more `dj.html` gate UX (retry/backoff copy).

## Backlog — needs the OWNER or real devices (do NOT attempt autonomously)
- **Real sign-in E2E**: a human signs in with Google / Apple / email end-to-end; set any missing MXroute Worker secrets.
- **Field-test the activation gate** on a real *unlinked* Mac: sign out → relaunch → gate → sign in → console unlocks; and offline-after-activation.
- **HTTPS-only part 2**: physically remove the dead plain-HLS tee/handler — SUPERVISED, paired with one go-live test (touches the audio core).
- **Offline hotspot validation on macOS 26** (bridge100), drift-realign, stalled→rebuild — diagnosed from field session logs, not code changes.
- Multi-channel; richer event pages.

## The guardrail that matters most
**Guests must always be able to join the party offline with no account.** The activation gate is DJ-app-only. If a change would make a guest need an account or the internet to join/hear the party, it is wrong. See `AGENTS.md`.
