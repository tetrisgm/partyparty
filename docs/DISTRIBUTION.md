# Distribution

> **Status (2026-08-03): the standalone Sparkle channel is DORMANT.** The active
> lane is the Mac App Store and TestFlight. Everything for the standalone
> channel is kept intact and working so it can be revived when wanted:
> `scripts/ship-standalone.sh`, the Sparkle appcast, and the R2 download
> plumbing in `cloudflare/worker.js`. Nothing triggers it automatically; it runs
> only when a person runs it.

PartyParty has two isolated macOS distribution channels built from the same
clean `main` commit. Neither may reuse the other's artifact.

Before any upload:

```sh
go build ./... && go vet ./... && go test ./...
(cd app && swift build)
(cd cloudflare && node test/smoke.mjs)
scripts/test-app-store.sh
```

## Mac App Store

Bundle ID `fm.partyparty.app`. Sandboxed, contains no Sparkle code or framework,
updated only through the Mac App Store. `scripts/build-app.sh` builds a local
ad-hoc bundle; `scripts/package-app-store.sh` is the only supported submission
package path. Never submit a package assembled with `productbuild --component`.

Full recipe, verification, and the `asc` commands: `docs/app-store-release.md`.

## Standalone beta

A separate bundle identifier so it can coexist with the Store edition and never
impersonate an App Store receipt-bearing app. Developer ID signed, notarized,
stapled, distributed from the website. Sparkle may exist only here and must
verify an EdDSA-signed appcast and update archive.

Each release publishes an immutable versioned archive first, verifies its
signature and notarization, then updates the stable download, appcast, website,
and version endpoint. All public metadata must identify the same version/build
and source commit. The updater never performs privileged installation, alters
network configuration, or weakens the permission floor.

## Worker

The public Worker serves the product website, anonymous LAN
hostname/certificate broker, relay registration and bootstrap, standalone beta
download, and signed beta appcast. It never carries media. When venue Wi-Fi
isolates guests, the Mac contributes one LL-HLS copy to `cmd/pporigin`, which
keeps only a bounded active-room window and fans it out. Neither component
creates a cloud party page, replay, recording archive, or remote-listening
product.
