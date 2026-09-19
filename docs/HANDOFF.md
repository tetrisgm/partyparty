# partyparty handoff

2026-09-16 release: **125.51 (273)** is processed and available to internal
TestFlight testers; the invited external group is awaiting Apple beta review.
The matching relay clock update and invitation-only website are deployed.
[Release receipt and remaining Store blockers](receipts/release-273-20260916/README.md)
record artifact hashes, verification, Apple IDs, and deployment versions. The
Store draft is prepared but still needs a released-macOS build and supervised
physical acceptance. Current desktop screenshots are uploaded and complete in
Apple's screenshot set; App Store Connect sign-in is complete, review history is
visible with no active rejection, and App Privacy is published.

2026-09-16: Synchronization work is in [synchronization.md](synchronization.md).
Source/relay clock calibration and shared startup/recovery now target two seconds
on native HLS and hls.js. Recovery uses the existing attachment with a two-second
limit; the old 11-second recovery and inconsistent 1.5-second candidate were
rejected. Publisher timestamps are preserved, hls.js is pinned to 1.7.3, and
[receipts](receipts/sync-recovery-20260916/README.md) retain rejected candidates
and mixed-engine checks. Release status is above. Supervised physical
phone, speaker, autoplay, and lock-screen validation remain open.

2026-09-13: Instruction-only cleanup; application behavior unchanged. Earlier notes are preserved verbatim in [HANDOFF-history-2026-09-13.md](HANDOFF-history-2026-09-13.md). Read the relevant section when resuming its topic; historical release/status claims need revalidation.

## Recent recorded checkpoints

- [Owner release direction (2026-09-12)](HANDOFF-history-2026-09-13.md#owner-release-direction-2026-09-12)
- [Where this leaves the app (2026-09-11, end of session)](HANDOFF-history-2026-09-13.md#where-this-leaves-the-app-2026-09-11-end-of-session)
- [Guest-surface audit (2026-09-11)](HANDOFF-history-2026-09-13.md#guest-surface-audit-2026-09-11)

## Follow-up records to revalidate

- [Still true, and still owed](HANDOFF-history-2026-09-13.md#still-true-and-still-owed)
- [Owed to physical reality](HANDOFF-history-2026-09-13.md#owed-to-physical-reality)
- [What is still open](HANDOFF-history-2026-09-13.md#what-is-still-open)

For other topics, search `HANDOFF-history-2026-09-13.md` by term, then read that section. Implementation and checks are in their source files and git history; this entry point does not duplicate them.
