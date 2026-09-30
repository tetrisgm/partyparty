# Store build 275 — September 30, 2026

- Source: `7a220ab` resolves Apple's [September 23 review feedback](https://appstoreconnect.apple.com/apps/6794880742/distribution/reviewsubmissions/details/4aca8275-18fb-4ae8-be5b-0b54123b2428); this release increments `CURRENT_PROJECT_VERSION` to 275 on `main`.
- Package: `dist/PartyParty-app-store.pkg`, SHA-256 `2168eee99425a6c831a595682c97b4c9e614cd64c7c9114b2521ec5bd0162e32`. Archived app executable SHA-256 `3308653dbdd55bef0c568919d58424800eebd329611d2d3c04e6bdcc57c33816`.
- Built on released macOS 27.0 (26A428) with Xcode 27.0 (27A266a), the existing Apple Distribution and Mac installer certificates, and Store profile `7d2813c2-fefb-4885-bebe-aeb16f33f9aa`. Xcode archive/export, bundle verifier, and exact exported package verifier passed. The local Store launch smoke and standalone compile passed for the same source before the build-number increment.
- App Store Connect build ID: `7344352f-1092-433c-b22d-95ddc5bc8ef0`, version 125.51 (275), processing `VALID`.
- TestFlight: internal and external build states `IN_BETA_TESTING`; `Internal testing` has all-build access, and build 275 is explicitly assigned to `Party testing`. Beta App Review state is `APPROVED`. What to Test notes describe the menu and entitlement changes.
- App Store: build 275 is attached to version 125.51. Review notes describe both corrections. Submission `4aca8275-18fb-4ae8-be5b-0b54123b2428` was resubmitted at `2026-09-30T22:47:49Z` and is `WAITING_FOR_REVIEW`. Release type is `AFTER_APPROVAL`, so Apple will make it available automatically if review succeeds.
- Remaining physical checks: supervised phone/speaker playback, QR scanning, and the native print dialog. See [handoff](../../HANDOFF.md) and [release procedure](../../APPLE-RELEASE.md).
