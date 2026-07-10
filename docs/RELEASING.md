# Releasing partyparty (signed, notarized, auto-updating)

`make app` builds a local, ad-hoc-signed `partyparty.app` for testing. A **release**
is the full chain: build → Developer-ID sign → notarize → staple → sign the Sparkle
appcast → publish to **party.ramine.net** (Cloudflare R2 + Worker). Installed apps
then auto-update via Sparkle. See [DISTRIBUTION.md](DISTRIBUTION.md) for the hosting
layout.

Completed, verified product work is shipped by default. A separate owner approval,
branch merge, tag, or manual version edit is not required.

## Normal path — one command

Uses your local Developer ID cert, the `pp-notary` notarytool profile, the Sparkle
key in your login keychain, and your `wrangler login`. This is the reliable path.

```
scripts/ship.sh                 # native/server release; chooses the next version
scripts/ship.sh --payload-only  # compatible web-only OTA payload
scripts/ship.sh --dry-run       # verify and describe the release without publishing
```

The command refuses dirty tracked files, runs the relevant Go/Worker/Swift checks,
records the version, builds and notarizes the app, signs `appcast.xml`, uploads
versioned artifacts and stable download aliases, deploys the Worker/public site,
and flips the update feed/version marker last. Afterward, verify and update the
copy installed on this Mac so the public feed and running app report the same build.
First run prompts once for keychain access to the Sparkle key — click **Always Allow**.

Agents should run this flow automatically after completed product changes unless
the user explicitly requests no release or publishing is genuinely blocked.

## CI fallback — GitHub Actions

```
git tag v0.1.1 && git push origin v0.1.1
```
[.github/workflows/release.yml](../.github/workflows/release.yml) can publish from
a tag on a macOS runner. It is an optional recovery/CI path, not the normal release
ceremony, and requires all the repo secrets below.

### Repo secrets

| Secret | What | Status |
|---|---|---|
| `SPARKLE_ED_PRIVATE_KEY` | Sparkle EdDSA private key — signs the appcast | ✅ set |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token — R2 write + Workers deploy | ⬜ **you add** |
| `MACOS_CERT_P12_BASE64` | Developer ID Application cert+key (.p12, base64) | ⬜ **you add** |
| `MACOS_CERT_PASSWORD` | password for that .p12 | ⬜ **you add** |
| `MACOS_DEVELOPER_ID` | `Developer ID Application: <Name> (<TEAMID>)` | ⬜ **you add** |
| `AC_API_KEY_BASE64` | App Store Connect API key (.p8, base64) — notarization | ⬜ **you add** |
| `AC_API_KEY_ID` | the key's Key ID | ⬜ **you add** |
| `AC_API_ISSUER_ID` | the key's Issuer ID | ⬜ **you add** |

Add them at Settings → Secrets and variables → Actions, or with `gh secret set NAME`.
`CLOUDFLARE_ACCOUNT_ID` is baked into the workflow (not secret). The CI path is
optional — **`scripts/ship.sh` already works today with zero repo secrets.**

#### Creating each secret

- **Sparkle key** — already generated. The public key is committed in
  `app/Info.plist` (`SUPublicEDKey`); the private key is in your login keychain and
  in the `SPARKLE_ED_PRIVATE_KEY` secret. **Back it up** (it can't be re-derived):
  `app/.build/artifacts/sparkle/Sparkle/bin/generate_keys -x sparkle-backup.txt`,
  store `sparkle-backup.txt` somewhere safe (a password manager), then delete it.
- **Cloudflare token** — dash.cloudflare.com → My Profile → API Tokens → Create
  Token → *Custom token* with permissions **Account · Workers Scripts · Edit**,
  **Account · Workers R2 Storage · Edit**, and **Zone · Workers Routes · Edit** (zone
  ramine.net). Then `gh secret set CLOUDFLARE_API_TOKEN`.
- **Developer ID cert** — export **Developer ID Application** (cert + private key)
  from Keychain Access as a `.p12` with a password: `base64 -i DeveloperID.p12 | pbcopy`
  → `MACOS_CERT_PASSWORD` = the export password; `MACOS_DEVELOPER_ID` =
  `Developer ID Application: Ramine Darabiha (52WM463HR2)`.
- **Notarization key** — App Store Connect → Users and Access → Integrations →
  create an API key (Developer role), download the `.p8` once:
  `base64 -i AuthKey_XXXX.p8 | pbcopy` → `AC_API_KEY_BASE64`; Key ID →
  `AC_API_KEY_ID`; Issuer ID → `AC_API_ISSUER_ID`.

## Notes
- Do not bump plist or version files manually. `scripts/ship.sh` and its lower-level
  release scripts keep the product version, `CFBundleShortVersionString`, and
  monotonic `CFBundleVersion` aligned. Sparkle compares the build number when
  deciding whether an update is available.
- The appcast lists only the newest build; that's all Sparkle needs to offer an
  update. Older versioned zips stay on R2 (immutable) so their links keep working.
- If notarization fails, `xcrun notarytool log <id> --keychain-profile pp-notary`
  names the offending nested binary (helpers in `Contents/Helpers/`, Sparkle's XPC).
