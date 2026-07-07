# Task: cache /api/account/status so the console poll doesn't hammer the broker

## Why
`web/dj.html` polls `/api/account/status` every 2s while the activation gate is
up, and each call makes a live broker round-trip (`activate.AccountStatus` in
`internal/server/server.go`). Cache it briefly server-side.

## Do
- In `internal/server/server.go`, cache the last `activate.AccountStatus` result
  for a short TTL (≈15s). On `/api/account/status`, serve the cached value if
  fresh, else refresh. Guard with a mutex (follow the existing `actMu` pattern).
- **Keep `setAccountActivated(status.Linked)` called on every refresh** so the
  activation latch still works.
- Add a bypass: if the request has `?fresh=1`, skip the cache and force a
  refresh (so the console's "I've signed in" path detects a fresh link
  promptly). Wire `dj.html`'s explicit retry to pass `?fresh=1` if it doesn't
  already.

## Verify
- Add a test in `internal/server/` for the cache helper: within the TTL a
  second lookup does not re-hit the source; `?fresh=1` forces a refresh. If
  `activate.AccountStatus` isn't injectable, extract a tiny cache helper
  (value + timestamp + TTL) and unit-test THAT directly.
- `go build ./... && go vet ./... && go test ./internal/server/`

## Guardrails
Read `AGENTS.md`. Do NOT weaken the gate or change the latch semantics. Guests
are untouched. Commit to your branch.
