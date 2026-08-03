# Distribution

> **Status (2026-08-03): the standalone Sparkle channel is DORMANT.** The active
> lane is the Mac App Store and TestFlight. Everything for the standalone
> channel is kept intact and working so it can be revived when wanted:
> `scripts/ship-standalone.sh`, the Sparkle appcast, and the R2 download
> plumbing in `cloudflare/worker.js`. Nothing triggers it automatically; it runs
> only when a person runs it.

PartyParty has two isolated macOS distribution channels built from the same
clean `main` commit.

## Mac App Store

The production edition uses bundle ID `fm.partyparty.app`. It is sandboxed,
contains no Sparkle code or framework, and receives updates only through the
Mac App Store.

Build a local ad-hoc Store bundle with:

```sh
scripts/build-app.sh
```

Build a signed submission package with:

```sh
APP_STORE_PROVISIONING_PROFILE=/path/profile.provisionprofile \
PP_SIGN_ID="Apple Distribution: ..." \
APP_STORE_INSTALLER_ID="3rd Party Mac Developer Installer: ..." \
scripts/package-app-store.sh
```

The submission script is the only supported Store package path. It archives the
complete app with Xcode, exports the archive for App Store Connect, expands and
verifies the resulting package, and can run Apple's upload validation. Never
submit a package assembled directly with `productbuild --component`.

## Standalone beta

The testing edition must use a separate bundle identifier so it can coexist
with the Store edition and never impersonate an App Store receipt-bearing app.
It is Developer ID signed, notarized, stapled, and distributed from the
PartyParty website. Sparkle may exist only in this edition and must verify an
EdDSA-signed appcast and update archive.

The standalone artifact is a complete app release, not a downloaded web payload.
Every release must publish an immutable versioned archive first, verify its
signature and notarization, then update the stable download, appcast, website,
and version endpoint. All public metadata must identify the same version/build
and source commit.

The standalone updater must never execute privileged installation, alter network
configuration, or weaken the permission floor. The retired shared release daemon
and web-payload updater remain prohibited.

The public Worker may serve the product website, anonymous LAN
hostname/certificate broker, standalone beta download, signed beta appcast, and
an ephemeral live relay when venue Wi-Fi isolates guests from the Mac. The relay
does not retain party pages, audio, or posts and must never provide replays or a
remote-listening product.
