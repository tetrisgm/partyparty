# Task: PP_DEV_NO_LOGIN — bypass the activation gate for local testing

## Why
The activation gate (v15.47) blocks the DJ console until this Mac is linked to
an account. Developers need to run the console locally WITHOUT linking a real
account. Add a double-guarded dev bypass, inert in production.

## Do
- In `internal/server/server.go`, add `func (s *srv) devNoLogin() bool` that
  returns true only when `os.Getenv("PP_DEV_NO_LOGIN") == "1"`. (Look for an
  existing "is this a release/prod build" signal in the repo to double-guard
  it; if none exists, gate on the env var alone AND log a loud one-time warning
  via `s.Diag` so it can never pass silently in a shipped build.)
- Make `accountActivated()` return true when `devNoLogin()` is true (bypassing
  the gate), and reflect it so `dj.html` unlocks (e.g. `/api/account/status`
  can report linked/devBypass when the flag is set). Do NOT change the real
  latch behavior for normal users.

## Verify
- Test in `internal/server/`: with the env set (use `t.Setenv`), `/api/start`
  from `djAddr` is NOT blocked by the gate (it fails later with 400 device
  required, like the activated case); without the env, it still returns 403
  `not_activated`. See `internal/server/activation_test.go` for the pattern.
- `go build ./... && go test ./internal/server/`

## Guardrails
Read `AGENTS.md`. This is a DEV aid — OFF by default, must never weaken the gate
for normal users, and must never touch guest routes. Commit to your branch.
