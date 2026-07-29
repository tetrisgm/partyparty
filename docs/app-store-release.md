# Mac App Store release

## Product boundary

The Store edition is the venue-Wi-Fi product:

- The paid App Store download is the purchase boundary. The app has no login,
  product account, profile, username, or separate license check.
- The Mac serves the DJ console, guest page, party feed, uploads, and HTTPS
  LL-HLS.
- Guests need no account. Direct mode remains usable without internet after the
  secure room identity has been provisioned.
- iPhones use native HLS/AVPlayer so audio continues while Safari is backgrounded
  or the phone is locked.
- The app never creates or selects Wi-Fi networks.
- The app never installs privileged helpers or asks for an administrator
  password.
- Store builds contain no Sparkle, LaunchDaemon, network-repair, or downloaded
  web-payload behavior.
- Store builds keep diagnostics on the Mac. They do not upload session status or
  logs.

Do not add public event pages, replays, previous-event browsing, hotspots,
Internet Sharing, captive portals, plain-HTTP guest links, alternate iPhone
playback engines, or playback presets. The only cloud live path is the
Mac-controlled ephemeral relay for client-isolated venue Wi-Fi.

## Apple prerequisites

Create these in the Apple Developer and App Store Connect accounts before
packaging:

1. A macOS App Store record with bundle ID `fm.partyparty.app`.
2. An Apple Distribution certificate available in the login keychain.
3. A Mac Installer Distribution certificate available in the login keychain.
4. A Mac App Store distribution provisioning profile for `fm.partyparty.app`.
5. An App Store Connect API key when command-line upload validation is desired.

The profile, app record, signing identities, and app bundle must all use team
`52WM463HR2`.

## Build and package

Local ad-hoc Store build:

```sh
scripts/build-app-store.sh
scripts/verify-app-store.sh
```

Distribution package:

```sh
APP_STORE_PROVISIONING_PROFILE=/absolute/path/profile.provisionprofile \
PP_SIGN_ID='Apple Distribution: ... (52WM463HR2)' \
APP_STORE_INSTALLER_ID='Mac Installer Distribution: ... (52WM463HR2)' \
scripts/package-app-store.sh
```

Add `APP_STORE_VALIDATE=1`, `APP_STORE_CONNECT_KEY_ID`, and
`APP_STORE_CONNECT_ISSUER_ID` to run Apple's upload validation after packaging.

The packaging script creates a signed Xcode archive and exports it with
`xcodebuild -exportArchive`. Do not replace this with a hand-assembled
`productbuild --component` package. TestFlight and the App Store require the
archive/export metadata and signing transformations that Xcode applies during
distribution.

The verifier expands the exact exported package and rejects an incorrect bundle
ID, missing asset catalog or privacy manifest, quarantine attributes, Sparkle,
LaunchDaemons, privileged helpers, extra helper binaries, missing sandbox/network
or audio entitlements, extra child entitlements, an incorrect provisioning
profile, a non-distribution app signature, or a non-App-Store installer
signature.

## Privacy

The privacy manifest declares no user-account data and no tracking. The random
installation credential used to provision a secure LAN name is infrastructure
authentication, is not associated with a user identity, and is used only for app
functionality.

Guest names, posts, uploads, listening status, and audio remain on the Mac in
direct mode. In relay mode, audio, listening status, text posts, and reactions
transit Cloudflare to reach that Mac. Guest photos use a capped, throttled
secondary path. Videos are unavailable in relay mode and never enter the
tunnel. Rolling HLS media parts and relayed still photos may be cached for up
to 60 seconds. Session diagnostics remain on the Mac in the Store edition. App
Store Connect privacy answers must match the bundled manifest and must not claim
analytics or diagnostics collection for the Store build.

## Automated verification

Verify an App Store bundle with:

```sh
scripts/test-app-store.sh
```

Verify the exact package submitted to Apple with:

```sh
scripts/verify-app-store-package.sh dist/partyparty-app-store.pkg
```

For an Apple Distribution candidate, this verifies the complete submission
bundle but does not attempt to launch it. macOS blocks distribution-signed
bundles before App Store installation and Apple re-signing. For a locally
launchable Apple Development build, the script also waits for the sandboxed
local server, checks `/api/status`, confirms that no plain-HTTP guest URL is
exposed, quits the app, and confirms its child server exits.

## Physical acceptance

Run this once on a clean macOS user account before uploading a candidate:

1. Install the candidate package and launch it from `/Applications`.
2. Confirm there is no administrator prompt.
3. Confirm no Screen Recording prompt appears.
4. Let the anonymous secure hostname finish provisioning, then disconnect
   internet access. Relaunch and confirm the DJ console still opens and the
   cached certificate remains valid.
5. Reconnect to venue-style Wi-Fi. Confirm the app requests Local Network access
   only when the LAN service is used.
6. Select Mac audio. Start Go Live and confirm the System Audio Recording prompt
   appears at that point, not at launch.
7. Stop, select a microphone or audio interface, and confirm the Microphone
   prompt appears only when that source is used.
8. Scan the displayed QR with at least two default-configured iPhones on the same
   Wi-Fi. Confirm the URL is HTTPS and both phones become audible.
9. Repeat on client-isolated Wi-Fi. Confirm the Mac reports Internet relay mode
   before exposing a failed local room and both phones use the relayed room.
10. Lock both phones for five minutes. Confirm playback continues and lock-screen
   media controls remain available.
11. Unlock both phones. Confirm playback remains smooth and neither phone is
    grossly behind the room.
12. Post text and a still photo from a guest and confirm both appear in the
    active room without interrupting playback. Confirm the picker excludes video
    and a video request is rejected before its body enters the tunnel.
13. Enable the optional login item, restart the user session, and confirm the app
    launches without requesting new privileges.
14. Inspect Activity Monitor's Sandbox column for the app and bundled helpers.
15. Quit the app and confirm all helpers terminate.

Capture the app window and a live guest/QR state for App Store screenshots. In
App Review notes, state that the reviewer needs two devices on the same Wi-Fi,
that guest playback uses the HTTPS QR link, and that locked-phone playback is an
intentional core feature.

## Distribution

This target is the Mac App Store production channel and receives updates only
from Apple. A separately identified Developer ID signed standalone beta may be
distributed for testing, but its Sparkle framework, updater code, appcast,
entitlements, and release metadata must never enter this Store target or package.
Downloaded web payloads and privileged installers remain retired.
