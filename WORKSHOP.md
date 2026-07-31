# Workshop: PartyParty.party

Project ID: `partyparty`

Use `workshop quick` for Go tests, stream-contract tests, and the Cloudflare
Worker smoke test. Use `workshop full` for the broader Windows-portable Go
gate.

The Windows worker cannot perform Swift builds, Apple signing, notarization,
App Store packaging, or release publication. Run the required Mac-only checks
and the repository's shipping workflow separately.

Build receipts are written to
`agents/artifacts/builds/<timestamp>-partyparty/`. Durable non-Git project data
belongs under `agents/artifacts/partyparty/`.

Platform source, registry, and recovery instructions live at
`/Users/shokunin/agents/workshop/README.md`.
