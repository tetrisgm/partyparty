# partyparty: working notes

## Shared machinery lives in ~/dev/stack

The installer/updater/signing recipe this project pioneered now has a
maintained home: the stack repo at `~/dev/stack` (also installed as the
`stack` Claude Code plugin, skills `/stack:add-signin`, `/stack:add-mac-app`,
`/stack:new-project`).

- mac-kit (`~/dev/stack/mac-kit`): Sparkle updater, device-link sign-in
  client, credential store, move-to-Applications, login item, plus the
  parameterized build/notarize/release scripts and the installer stub that
  was modeled on this project's installer-app.
- auth-kit (`~/dev/stack/auth-kit`): NextAuth v5 sign-in surface (Apple,
  Google, email magic links, dev login) as an installable package.
- Console/DNS work is documented in `~/dev/stack/runbooks/`.

Rules:
- Improvements to installer/updater/signing machinery land in the KIT, not
  in per-project copies. Read the kit README before rolling anything new.
- partyparty ships already: do NOT rewire its existing code to consume the
  kits opportunistically. Porting is a deliberate step the owner schedules.
- New features that need sign-in or app-link machinery consume the kits.
