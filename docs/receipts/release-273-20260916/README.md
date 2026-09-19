# 125.51 (273), September 16, 2026

Owner requested TestFlight release and App Store preparation. Binary source:
`764cae0`; website and matching origin source: `4760493`.

## TestFlight

- Apple build ID: `c68c80c5-210d-4740-9022-319e2f62b80f`; processing **VALID**.
- Internal testers: **IN_BETA_TESTING**. Invited external group: assigned,
  **WAITING_FOR_BETA_REVIEW** at this checkpoint. Do not upload or submit again.
- Public-link enrollment is disabled; existing testers remain in the group.
- [What to Test](../../../app-store/testflight-notes.txt) is attached in en-US.
- Exported package: `dist/PartyParty-app-store.pkg`, 39,684,795 bytes.
  SHA-256 `fe06d02a92f8ee86092376da4c0f54c7299f7a2accd657ce755d5ee433428c0b`.
  Apple accepted the upload but supplied no remote checksum; the hash is local.
- Built with Xcode 26.6 (17F113) on macOS 27.0 (26A5425a), using the existing
  `PP_TESTFLIGHT_ONLY=1` allowance. **This is not a Store release package.**
- Previous build 272's archive/export/package are preserved in
  `build/release-272/`. No installed TestFlight app was replaced.

## Verification

Go tests, npm's nine suites, nine Swift tests, 27 Worker smoke tests, the Worker
deploy dry-run, and exact archive/package signature and entitlement checks passed.
See the adjacent logs and [TestFlight validation](testflight-validation.json).

[The required bare-AVPlayer soak](soak-playback.log) passed for ten minutes through
the real Go `/live/` proxy on loopback HTTP: 120/120 ready low-latency samples,
zero backward movement, median attachment 2.74 seconds within its existing
2.00 ± 0.75-second assertion. This broad playlist gate does **not** establish
inter-device synchronization. The actual HTTPS guest-page mixed-engine timing
and recovery evidence is [here](../sync-recovery-20260916/README.md).
Physical speaker, phone autoplay, and lock-screen validation remains open.

## Matching services

- Relay origin activated as `/opt/pporigin/releases/20260916-12551-273` with
  no rooms active. Binary SHA-256:
  `091a1e2cca272a300b10386b4a46c18f8190f5664a80c7e6deff108c1c465a69`.
  Health passed and the new clock endpoint rejected unauthenticated requests
  with 403. Previous release `20260911-052634` is retained for rollback.
  No service configuration, radio priorities, or persistent jobs changed.
- Website Worker version `d8282345-e298-40ac-91e0-10218e617446` restores the
  invitation request form and admin-only, paginated reads; removes public
  TestFlight enrollment links; and corrects the privacy description of relay
  transport and temporary storage. Existing `ADMIN_KEY` was confirmed present.
- Browser verification: local submission succeeded using in-memory test data;
  deployed landing/privacy pages show the new flow, and the live form displays
  the server's validation error for an invalid address. No valid test email was
  inserted into the production waitlist.

## App Store readiness

Draft `48b26f37-c69e-4245-8d0e-3ab787eb8610` now targets **125.51**, with manual
release. Description and two-device reviewer instructions are configured.
The optional privacy-choice URL now points to the privacy/contact page instead
of the retired `/account` route. Subscription validation reports no blockers.
Apple refuses `whatsNew` for this initial release with `STATE_ERROR`; the
checked-in initial-release text is retained. No App Store review was submitted.

Remaining blockers:

1. Build on Apple-released macOS with a new build number, then select that
   processed build in the Store draft. This Mac is still on prerelease macOS.
2. Complete supervised physical playback acceptance: multiple phones, staggered
   joins, recovery, real tap-to-play, locking/backgrounding, and acoustic sync.
The outdated Store screenshots were replaced with two current 2880×1800 captures
from the shipped PartyParty app. The source captures and normalized upload set
are under `build/release-273/store-screenshots/` and
`build/release-273/store-screenshots-normalized/`; Apple reports both assets
`COMPLETE` in desktop screenshot set `6c22a6b9-74c3-4a66-9b09-0b41feec0f05`.
The prior screenshots remain backed up under
`build/release-273/previous-screenshots/`.

App Store Connect sign-in is complete through the account passkey. The web review
history is visible and shows no active rejection; the latest completed submission
contains one removed item, matching the API history. App Privacy is published and
shows both privacy URLs at `https://partyparty.party/privacy`, with the declared
Email Address, User ID, and Device ID data types.

The Store draft is prepared, but it is not submission-ready until the released-
macOS build and supervised physical acceptance are closed. Do not attach the
prerelease-host TestFlight package to imply otherwise.
