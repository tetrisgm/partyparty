# Releasing partyparty (signed, notarized, auto-updating)

`make app` builds a local, ad-hoc-signed `partyparty.app` for testing. **Releases**
are cut by CI ([.github/workflows/release.yml](../.github/workflows/release.yml)) on a
version tag: build → Developer-ID sign → notarize → staple → Sparkle appcast →
GitHub Release. Installed apps then auto-update via Sparkle.

## One-time setup

### 1. Sparkle update-signing key
On your Mac (Sparkle tools are in the Sparkle release `bin/`):
```
./bin/generate_keys
```
- Copy the **public** key it prints into `app/Info.plist` (uncomment `SUPublicEDKey`
  and paste). The public key is not secret — commit it.
- Export the **private** key and store it as the `SPARKLE_ED_PRIVATE_KEY` repo secret:
  `./bin/generate_keys -x private.pem` (then paste the file contents into the secret).

### 2. Developer ID certificate
Export your **Developer ID Application** cert + private key from Keychain as a `.p12`
(set a password), then:
```
base64 -i DeveloperID.p12 | pbcopy
```
Add as `MACOS_CERT_P12_BASE64`; add the export password as `MACOS_CERT_PASSWORD`.
Add the identity string (e.g. `Developer ID Application: Ramine X (TEAMID)`) as
`MACOS_DEVELOPER_ID`.

### 3. Notarization (App Store Connect API key)
App Store Connect → Users and Access → Integrations → create an API key (Developer
role). Download the `.p8` once.
```
base64 -i AuthKey_XXXX.p8 | pbcopy
```
Add as `AC_API_KEY_BASE64`, the Key ID as `AC_API_KEY_ID`, the Issuer ID as
`AC_API_ISSUER_ID`.

### Repo secrets summary
| Secret | What |
|---|---|
| `MACOS_CERT_P12_BASE64` | Developer ID Application cert+key (.p12, base64) |
| `MACOS_CERT_PASSWORD` | password for that .p12 |
| `MACOS_DEVELOPER_ID` | `Developer ID Application: <Name> (<TEAMID>)` |
| `AC_API_KEY_BASE64` | App Store Connect API key (.p8, base64) — notarization |
| `AC_API_KEY_ID` | the key's Key ID |
| `AC_API_ISSUER_ID` | the key's Issuer ID |
| `SPARKLE_ED_PRIVATE_KEY` | Sparkle EdDSA private key — signs the appcast |

Add them at: Settings → Secrets and variables → Actions → New repository secret.

## Cut a release
```
git tag v0.1.0
git push origin v0.1.0
```
CI builds, signs, notarizes, publishes the Release (the `.app` zip + `appcast.xml`),
and installed apps pick up the update on their next check.

## Notes
- Bump `CFBundleShortVersionString` + `CFBundleVersion` in `app/Info.plist` before
  tagging (Sparkle compares `CFBundleVersion`).
- The first notarization is the moment to confirm the embedded helpers
  (ffmpeg/mediamtx/ppcapture, signed in `Contents/Helpers/`) and Sparkle's nested
  code pass — `xcrun notarytool log <id> ...` names any offender.
