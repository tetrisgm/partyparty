# Auth, Device Link, and Activation

partyparty has two separate auth concepts:

- Web account sign-in on `party.ramine.net`, implemented in the Cloudflare Worker.
- Local DJ app activation, implemented by the Mac server and unlocked by linking this install to a signed-in web account.

Guests are not part of either auth system. Guest join, listening, wall, heartbeat, and local posting remain LAN-only and unauthenticated.

## Web Sign-In Methods

The sign-in UI is rendered by `loginResponse` in [cloudflare/worker.js](../cloudflare/worker.js). It offers whichever providers are configured and always keeps email magic-link sign-in available.

Google:

- Start route: `GET /auth/google`
- Callback route: `GET /auth/google/callback`
- Worker handlers: `googleAuthStart` and `googleAuthCallback` in [cloudflare/worker.js](../cloudflare/worker.js)
- The callback validates the returned ID token claims, requires a verified email, and then creates the same Worker session used by email sign-in.

Apple:

- Start route: `GET /auth/apple`
- Callback route: `POST /auth/apple/callback`
- Worker handlers: `appleAuthStart` and `appleAuthCallback` in [cloudflare/worker.js](../cloudflare/worker.js)
- Apple uses `response_mode=form_post`, so the state cookie is set with `SameSite=None` for that provider callback. The callback validates the ID token claims, requires a verified email, and then creates the same Worker session used by email sign-in.

Email magic-link:

- Request route: `POST /api/auth/request-link`
- Verify route: `GET|POST /auth/verify`
- Worker handlers: `authRequestLink`, `authVerify`, `sendAuthEmail`, and `sendViaMXroute` in [cloudflare/worker.js](../cloudflare/worker.js)
- The request route stores a hashed one-time token in `auth_magic_tokens`, emails the raw link, and rate-limits by email/IP hash. The verify route marks the token used and creates a Worker session.

All three methods converge through `createAuthSession` in [cloudflare/worker.js](../cloudflare/worker.js): accounts are keyed by normalized verified email in `users`, and sessions are stored in `auth_sessions`. The relevant D1 tables are declared in [cloudflare/migrations/0002_platform.sql](../cloudflare/migrations/0002_platform.sql).

## Email Transport

Production magic-link email is MXroute SMTP. Do not replace it with Resend, SendGrid, Postmark, Mailgun, or another paid email API. This is also called out as a sacred rule in [AGENTS.md](../AGENTS.md).

Preferred secret format:

```text
AUTH_EMAIL_SERVER=smtps://<smtp-user>:<smtp-password>@<mxroute-host>:465
```

The Worker parser also accepts `smtp://...:587` for STARTTLS. If the single URL secret is not present, the current code falls back to split MXroute settings: `MXROUTE_SMTP_HOST`, `MXROUTE_SMTP_PORT`, `MXROUTE_SMTP_USER`, and `MXROUTE_SMTP_PASS`. The optional sender override is `AUTH_EMAIL_FROM` or `MXROUTE_SMTP_FROM`.

The implementation lives in `mxrouteSmtpConfig`, `smtpAuthLogin`, `mxrouteConnectFn`, and `sendViaMXroute` in [cloudflare/worker.js](../cloudflare/worker.js). The config comment in [cloudflare/wrangler.jsonc](../cloudflare/wrangler.jsonc) documents the same secret shape.

Important current-code note: `sendAuthEmail` has a generic `env.EMAIL.send` fallback after MXroute. The repo policy is still MXroute SMTP for production and never a paid email API; do not wire that fallback to a paid provider.

## Device-Link Flow

The primary app link flow starts inside the local DJ console:

1. `web/dj.html` calls the local Mac route `POST /api/link-install/start`.
2. `internal/server/server.go` handles that route and calls `activate.StartInstallLink`.
3. `internal/activate/activate.go` authenticates the install to the broker with its local install id/secret and posts to the Worker route `POST /api/broker/link-start`.
4. The Worker creates an `install_browser_tokens` row and returns a short-lived URL: `/link-mac?token=...`.
5. The Mac opens that URL in the browser. If the user is not signed in, `/link-mac` redirects to `/login?redirect=/link-mac?...`.
6. `GET /link-mac` renders a confirmation page only. It does not bind the install.
7. The confirmation form submits `POST /link-mac`.
8. The Worker marks the browser token used and upserts `device_installs`, binding the install id/slug to the signed-in user and DJ profile.

Relevant files:

- Local console start: [web/dj.html](../web/dj.html)
- Local server routes: [internal/server/server.go](../internal/server/server.go)
- Local broker client: [internal/activate/activate.go](../internal/activate/activate.go)
- Worker broker/link handlers: [cloudflare/worker.js](../cloudflare/worker.js)
- Browser token table: [cloudflare/migrations/0004_install_browser_tokens.sql](../cloudflare/migrations/0004_install_browser_tokens.sql)
- Device install table: [cloudflare/migrations/0002_platform.sql](../cloudflare/migrations/0002_platform.sql)

The `/link-mac` confirm is intentionally a same-site POST for CSRF safety. A cross-site top-level GET can carry a `SameSite=Lax` session cookie, so `GET /link-mac` must be read-only. The actual bind happens only after the user presses the confirm button and submits a same-site POST. `linkMacResponse` also checks the POST `Origin` defensively, allowing same-site, missing, or WebKit's `null` origin from the no-referrer confirm page while rejecting genuinely foreign origins.

There is also an older/manual code flow: signed-in web account route `POST /api/install-link/create` creates a one-time code, and the local Mac route `POST /api/link-install` sends that code to broker route `POST /api/broker/link-install`. It binds the same `device_installs` table, but the app's first-run path uses the browser handoff above.

## DJ Activation Gate

The DJ app must be linked before the console can run Go Live:

- `web/dj.html` polls local `GET /api/account/status` and blocks the console until the returned state is linked.
- `internal/server/server.go` handles `/api/account/status`, calls `activate.AccountStatus`, and latches `accActivated` when `status.Linked` is true.
- `POST /api/start` checks `accountActivated()` before starting broadcast. If the process has not latched activation, it returns `403` with `{ "error": "not_activated" }`.
- The latch is process-local and only flips true. A later sign-out or revoke does not stop a live party mid-set; it re-gates on the next launch.
- `POST /api/account/sign-out` calls `activate.SignOutAccount`, revokes the broker link with `POST /api/broker/account-unlink`, and clears the local account cache.

Offline activation is intentional:

- `activate.AccountStatus` saves a linked broker response to `account.json` under the app state directory.
- If the broker is unreachable later, `cachedAccountOrError` returns the saved linked account with `offline: true`.
- The local `/api/account/status` handler treats linked online and linked cached-offline as the same activation signal and latches `accActivated`.
- Separately, `main.go` can load a still-valid cached cert/key with `activate.CachedCertReady` so an already activated Mac can start at an offline venue without waiting for online cert renewal.

This activation gate is DJ-only. It must not be applied to guest routes, guest pages, HLS/LL-HLS segment routes, local status/heartbeat routes, or guest media/reaction/comment/request posting.
