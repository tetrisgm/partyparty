# Cloudflare worker review findings

## Deferred infrastructure work

- The registration throttle uses Cache API state, so it is intentionally
  per-edge and fail-open. It blocks immediate unauthenticated R2-write floods but
  is not an authoritative global quota. A stronger bound needs a deployed Rate
  Limiting binding or Durable Object and therefore configuration/provisioning
  outside this code-only, no-deploy review.

The other two findings recorded here concerned the account worker in
`cloudflare/app` (D1 token cleanup outside `waitUntil`, and event-slug renames).
That worker was deleted from this repo on 2026-08-14 when the product went
account-free, so neither applies to anything this repo now serves.
