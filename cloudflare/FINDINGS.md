# Cloudflare worker review findings

## Deferred infrastructure work

- Authentication and install-link token cleanup starts best-effort D1 promises
  without attaching them to `ExecutionContext.waitUntil()`. The rows are already
  expiry-gated and capped on reads, so this is housekeeping rather than an auth
  bypass or user-facing correctness failure. A proper follow-up should thread
  the execution context into those handlers and cover Worker-lifetime behavior;
  awaiting the deletes inline would add avoidable latency to sign-in/linking.

- The new registration throttle uses Cache API state, so it is intentionally
  per-edge and fail-open. It blocks immediate unauthenticated R2-write floods but
  is not an authoritative global quota. A stronger bound needs a deployed Rate
  Limiting binding or Durable Object and therefore configuration/provisioning
  outside this code-only, no-deploy review.

Populated event slug changes are now rejected rather than partially migrated.
Supporting those renames later requires a coordinated D1 child-row migration and
R2 object copy; rejecting them preserves all existing content and keeps empty
upcoming-event renames working.
