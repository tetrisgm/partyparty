# Distribution

partyparty has two build lanes from the same source.

## Mac App Store

```sh
scripts/build-app-store.sh
```

This produces `build/partyparty-app-store.app` with App Sandbox, network client
and server, and audio-input entitlements. It excludes Sparkle, downloaded OTA
content, privileged-helper migration code, and network-repair code.

For submission packaging, provide the App Store provisioning profile and signing
identities:

```sh
APP_STORE_PROVISIONING_PROFILE=/path/profile.provisionprofile \
PP_SIGN_ID="Apple Distribution: ..." \
APP_STORE_INSTALLER_ID="3rd Party Mac Developer Installer: ..." \
scripts/package-app-store.sh
```

## Direct distribution

The existing Developer ID build remains available during App Store transition:

```sh
scripts/build-app.sh
```

It includes Sparkle and legacy cleanup code solely to migrate already-installed
direct builds. New product behavior must not depend on privileged helpers or
administrator access.

The public Worker serves the landing page, stable installer, Sparkle appcast,
immutable direct-build artifacts, and `/api/version`. It does not serve public
event pages, replays, remote listeners, or party media.
