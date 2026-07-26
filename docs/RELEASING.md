# Releasing

Verified product work lands once on clean `main` and is pushed once. The
`net.ramine.partyparty.autoship` launchd job runs the full direct-distribution
release in the background. Do not run `scripts/ship.sh` interactively.

The daemon verifies, signs, notarizes, uploads immutable artifacts, deploys the
Worker and landing page, flips public aliases and version markers last, records
release metadata, pushes `main`, and updates the installed direct build.

Native, Go, Swift, entitlement, or packaging changes require a full release.
Compatible web-only changes may use payload OTA for direct builds. App Store
builds never load downloaded executable or web payload content; they advance
through App Store releases.

Before submission, verify the Store app's signature, sandbox entitlements,
embedded provisioning profile, bundle version/build, and absence of Sparkle.
