# Releasing

> **Status (2026-08-03): the standalone Sparkle channel is DORMANT.** The active
> lane is the Mac App Store and TestFlight. Everything for the standalone
> channel is kept intact and working so it can be revived when wanted:
> `scripts/ship-standalone.sh`, the Sparkle appcast, and the R2 download
> plumbing in `cloudflare/worker.js`. Nothing triggers it automatically; it runs
> only when a person runs it.

Verified product work lands on clean `main` and is pushed once. Native releases
may target the Mac App Store, the standalone beta channel, or both. Each channel
has a separate package and verifier; neither may reuse the other's artifact.

Before uploading:

```sh
go build ./... && go vet ./... && go test ./...
(cd app && swift build)
(cd cloudflare && node test/smoke.mjs)
scripts/test-app-store.sh
```

Create the signed Xcode archive/export package with
`scripts/package-app-store.sh`, validate it with
`scripts/verify-app-store-package.sh`, and upload that exact package to App
Store Connect. Never substitute a hand-assembled `productbuild --component`
package. Worker or website changes are deployed independently with Wrangler
after their tests pass.

The standalone beta workflow must build from the same clean `main` commit,
Developer ID sign every executable, notarize and staple the complete artifact,
verify the Sparkle EdDSA signature, publish an immutable versioned download, and
only then update the stable download, appcast, website, and version endpoint.
The Store verifier must continue rejecting Sparkle and standalone-only content.

Do not use the retired shared release daemon or web-payload updater. The
standalone workflow must be one bounded, owner-facing release command with the
same stale-safe locking and immutable-artifact rules as other release tooling.
