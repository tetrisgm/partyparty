# PartyParty.party handoff

## Current position

Product-facing references have been renamed to PartyParty and PartyParty.party across the macOS app target/source paths, app display names, web UI, static site, App Store metadata, packaging scripts, release scripts, docs, runtime app-support/log paths, npm package names, and generated artifact names. The repository and project slug remain lowercase: the GitHub repository is `tetrisgm/partyparty`, the canonical checkout is `/Users/shokunin/dev/partyparty`, the origin remote points at `https://github.com/tetrisgm/partyparty.git`, and project infrastructure such as autoship LaunchAgents and Workshop/cache/artifact paths use lowercase `partyparty` names. The clean Workshop build lane was repaired so it no longer depends on ignored helper binaries and can run root npm tests from a clean archive. Compatibility identifiers intentionally remain lowercase where they are installed-app or live-infrastructure identities: bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, and Workshop project id.

Workshop checkpoint: `1785543026717-f2432669` (product).

## Next concrete step

No rename work is in flight. Before starting new product work, re-open Workshop; the next product priorities from the prior handoff remain the TestFlight install-data follow-up with Apple, settling the guarded HTTP fallback invariant, and the 300-500 listener load test.

## Blockers

None recorded.

## Ruled out

- Renaming bundle IDs/DNS/service identifiers in this pass: those are installed-app and live infrastructure compatibility identifiers, not just product-facing old-name copy.
- Renaming bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, or the Workshop project id in this pass: those are compatibility/infrastructure identifiers, not product-facing old-name copy.
