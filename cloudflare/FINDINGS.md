# Cloudflare worker review findings

## Registration abuse boundary

- Anonymous registration is protected first by the Worker's
  `REGISTRATION_RATE_LIMITER` binding (30 attempts per source address per
  minute), then by a short Cache API throttle. The network limiter is
  eventually consistent by design, so it is an abuse control rather than an
  authoritative billing quota. Registration writes remain small and bounded,
  and Workers observability records rate-limited responses.

The other two findings recorded here concerned the account worker in
`cloudflare/app` (D1 token cleanup outside `waitUntil`, and event-slug renames).
That worker was deleted from this repo on 2026-08-14 when the product went
account-free, so neither applies to anything this repo now serves.
