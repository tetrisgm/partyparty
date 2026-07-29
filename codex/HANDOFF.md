# Current handoff

The product is venue-Wi-Fi only. The Mac selects one room-wide connection mode.
Direct mode serves HTTPS LL-HLS and the active-room social feed over venue
Wi-Fi. Relay mode reverse-proxies that same live surface when the venue isolates
nearby devices. Public event pages, retained cloud party content, replays,
hotspot setup, playback modes, and old stream settings are retired.

## Network mode contract

- The QR uses the stable public bootstrap while the setup service is reachable.
  The bootstrap probes the Mac's real certificate-backed LAN endpoint before
  loading the room.
- The browser reports only probe success or failure. The Mac is authoritative
  and selects `direct` or `relay` for the entire room.
- A direct verdict is cached for the opaque public-IP plus LAN-subnet network
  key. An isolation verdict is cached the same way. Wi-Fi names are not stored.
- If setup infrastructure is unavailable, a cached certificate still permits a
  direct QR and offline guest playback.
- Relay mode uses one authenticated outbound WebSocket from the Mac. The relay
  exposes only the guest routes, never the DJ console or broadcast controls.
- Relay responses preserve the existing LL-HLS playlists and media bytes.
  Immutable rolling media parts may be cached for up to 60 seconds to avoid
  sending duplicate copies from the Mac. Party history is never retained.
- LL-HLS responses use the priority queue. Guest photos use a capped, throttled
  secondary path. Videos are not uploaded or delivered in relay mode, and the
  guest UI explains that music is being protected. Event cover, DJ avatar,
  track artwork, text posts, and reactions remain available.
- A direct listener that observes a room-wide switch to relay navigates to the
  relay origin. Direct and relayed playback are not mixed in one room.
- The Mac console and menu bar must state `checking`, `direct`, or `relay`.
  Relay copy must explain that the Wi-Fi limits nearby-device connections and
  that using the internet can increase DJ-to-listener delay.

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

Repeat the acceptance on a client-isolated Wi-Fi network:

1. Relaunch the Mac app after joining the isolated network.
2. Confirm the QR is withheld while the Mac refreshes its network identity, then
   appears with `Checking Wi-Fi`.
3. Scan it with the first iPhone. The bootstrap must move the whole room to
   `Internet relay` without first exposing a dead direct page.
4. Join a second iPhone from the same QR. Both phones must use the same relay
   origin, become audible without a refresh, and remain within 1.0 second of one
   another.
5. Lock both phones for at least 20 minutes. Playback and lock-screen controls
   must remain continuous.
6. Post text and a still photo. Both must arrive on the Mac without affecting
   playback. The picker must exclude videos, and a direct video request must be
   rejected before its body enters the relay.
7. Interrupt the Mac's internet connection briefly. The console must say the
   relay is reconnecting, and the room must recover after internet returns.

The analyzer reports bounded outlier reattachments as recovery evidence.
External/OS seeks remain warnings that require checking the following health
windows. Any legacy app-governor event in a current-version session is a failure.

After this gate passes, the supervised cleanup may remove the inert plain-HLS,
delivery-switch, recording-tee, and per-broadcast override code still contained
inside `internal/broadcast/`. Do not change that package before the real go-live
test.

The production edition is sandboxed and App Store-only:

```sh
scripts/build-app-store.sh
scripts/package-app-store.sh
```

Apple Distribution signing and the Store provisioning profile are configured.
The separately identified standalone beta ships through
`scripts/ship-standalone.sh` as a Developer ID signed and notarized app with a
Sparkle EdDSA appcast. It must not alter the Store target or restore the retired
shared release daemon or OTA web payload system. Do not upload another Store or
TestFlight build until the owner explicitly resumes Apple releases.
