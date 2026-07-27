# Distribution

partyparty is distributed only through the Mac App Store under bundle ID
`fm.partyparty.app`. There is no Developer ID build, Sparkle updater, installer,
download alias, appcast, or web-payload update channel.

Build a local ad-hoc Store bundle with:

```sh
scripts/build-app.sh
```

Build a signed submission package with:

```sh
APP_STORE_PROVISIONING_PROFILE=/path/profile.provisionprofile \
PP_SIGN_ID="Apple Distribution: ..." \
APP_STORE_INSTALLER_ID="3rd Party Mac Developer Installer: ..." \
scripts/package-app-store.sh
```

The submission script is the only supported package path. It archives the
complete app with Xcode, exports the archive for App Store Connect, expands and
verifies the resulting package, and can run Apple's upload validation. Never
submit a package assembled directly with `productbuild --component`.

The public Worker serves the website and anonymous LAN hostname/certificate
broker only. Product updates are delivered by the Mac App Store.
