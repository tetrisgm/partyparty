# Task: broaden Go test coverage for activation + cache + dev-no-login

## Why
The activation gate, the account-status cache, and the dev-no-login bypass are
core to the app's new behavior but thinly tested. Add focused tests. Test files
ONLY — do not change production behavior.

## Do (internal/server + internal/activate test files ONLY)
- `internal/server/`:
  - Test the `accountStatusCache` helper directly: within TTL a second lookup
    does NOT call the source; `fresh=true` forces a call; `clear()` resets.
    (See `accountStatusCache`/`lookup`/`clear` in server.go.)
  - Test that once `setAccountActivated(true)` has latched, `accountActivated()`
    stays true even after `setAccountActivated(false)` (latch), and that a fresh
    srv is not activated. (Some of this exists — extend, don't duplicate.)
  - Test dev-no-login logging/guarding: `devNoLogin()` returns true only when
    `PP_DEV_NO_LOGIN=1` AND `Version=="dev"`; false otherwise. Use `t.Setenv`.
- `internal/activate/`:
  - If feasible without network, test that `cachedAccountOrError` returns the
    cached state with `Offline=true` only when a previously-linked cache exists,
    and `Linked=false` when there is no cache. (Use a temp dir + write an
    `account.json` fixture via the package's own save path if exported; if the
    cache path isn't testable in-package, skip with a comment saying why.)

## Verify
- `go build ./... && go vet ./... && gofmt -l . && go test ./internal/...`
  — all green. Report which tests you added.

## Guardrails
Read `AGENTS.md`. TEST FILES ONLY — no production code changes (if a test can't
be written without a seam, note it, don't refactor prod blindly). Commit to your
branch.
