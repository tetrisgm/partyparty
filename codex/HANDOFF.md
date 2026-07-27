# Current handoff

The product is venue-Wi-Fi only. The Mac serves HTTPS LL-HLS and the active-room
social feed directly to guests. Public event pages, remote listening, cloud
party content, replays, hotspot setup, playback modes, and old stream settings
are retired.

## Streaming contract

- AAC-LC, 320 kbps stereo, 48 kHz.
- 500 ms segments, 150 ms parts, 48 retained segments.
- One 1.0-second client playout target.
- The Go `/live` proxy passes MediaMTX's LL-HLS playlists through unchanged.
  It does not add `EXT-X-START` or inflate `PART-HOLD-BACK`.
- Apple browsers always use native `<audio>`/AVPlayer. This is non-negotiable:
  background and lock-screen playback must continue.
- There are no app-authored native seeks or playback-rate corrections. Native
  AVPlayer owns healthy LL-HLS playout.
- Program Date Time and the Mac/phone clock-offset estimate are measurement and
  recovery inputs only. Missing timing telemetry never interrupts audio.
- A visible native player at least 750 ms beyond the one-second target for three
  consecutive measurements gets a fresh HLS attachment. Recovery has a
  30-second cooldown and a two-attempt ceiling per stream generation. It never
  runs hidden or locked.
- Non-Apple browsers use one hls.js profile with the same target.

The old delivery endpoint, public delivery state, request bitrate/mono knobs,
automatic set recording activation, dynamic server payload settings, sync
presets, and alternate Apple engines are no longer production paths.

## Physical acceptance

Use physical iOS 26.4 and iOS 27 devices on ordinary venue Wi-Fi. This is the
required supervised gate before touching the protected encoder/capture cleanup:

1. Start a real DJ capture and join at least four phones within 30 seconds.
2. Confirm every phone becomes audible with no refresh and no startup seek.
3. Compare simultaneous telemetry windows. Phone-to-phone media-time spread
   must stay below 1.0 second; 0.5 second or less is the preferred result.
4. Confirm measured latency clusters around the one-second target. Investigate
   any open above 1.5 seconds and fail any open at or above two seconds.
5. Lock every phone for at least 20 minutes. Audio must remain smooth and
   continuous; no web recovery action may occur while hidden.
6. Unlock two phones, background/foreground Safari, and interrupt one network
   path. A visible late phone must converge without moving healthy peers.
7. Restart the DJ stream once. Listening phones must recover automatically.
8. Run `node scripts/analyze-session-log.mjs --strict <session.log>`. There must
   be no failed stream contract, startup-spread, or steady-room
   spread finding.

The analyzer reports bounded outlier reattachments as recovery evidence.
External/OS seeks remain warnings that require checking the following health
windows. Any legacy app-governor event in a current-version session is a failure.

After this gate passes, the supervised cleanup may remove the inert plain-HLS,
delivery-switch, recording-tee, and per-broadcast override code still contained
inside `internal/broadcast/`. Do not change that package before the real go-live
test.

The app is sandboxed and App Store-only:

```sh
scripts/build-app-store.sh
scripts/package-app-store.sh
```

Apple Distribution signing and the Store provisioning profile are configured.
Direct builds, Sparkle, appcasts, installer aliases, and OTA web payloads are
retired. After the physical streaming gate, package and upload the newest source
version, then finish the App Store Connect screenshots, privacy answers, and
submission.
