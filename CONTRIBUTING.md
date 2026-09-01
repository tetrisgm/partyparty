# Contributing to PartyParty

PartyParty is in public beta. Bug reports with a clear reproduction are the
most useful contribution right now.

Before opening an issue, search the existing issues and test the current
TestFlight build or current `main`. Include the PartyParty version, macOS and
iOS versions, Mac model, network shape, expected result, actual result, and the
smallest reliable reproduction. Never attach credentials, private party URLs,
or logs containing guest information to a public issue.

For code changes:

1. Open an issue before a large change so the approach can be discussed.
2. Keep changes focused and preserve the product and playback invariants in
   `AGENTS.md`.
3. Run the verification commands documented in `README.md`.
4. Explain the user-visible effect and testing evidence in the pull request.

Changes to HLS geometry, playback positioning, capture backpressure, signing,
or distribution require the physical-device verification described in
`AGENTS.md`. A green unit test is not a substitute for that evidence.

The repository does not currently declare a source license. Contributions
cannot be accepted until the project owner selects one and contribution terms
are made explicit.
