# Current handoff

The product is venue-Wi-Fi only. The Mac selects one room-wide connection mode.
Direct mode serves HTTPS LL-HLS and the active-room social feed over venue
Wi-Fi. Relay mode reverse-proxies that same live surface when the venue isolates
nearby devices. Public event pages, retained cloud party content, replays,
hotspot setup, playback modes, and old stream settings are retired.

## Network mode contract

- The QR uses the stable public bootstrap while the setup service is reachable.
  The bootstrap probes the Mac's real certificate-backed LAN endpoint, then
  redirects itself to the direct URL or to the relay origin. The guest's own
  probe is the decision; nothing waits for the Mac to agree.
- The browser reports only probe success or failure. The Mac is authoritative
  and selects `direct` or `relay` for the entire room.
- A direct verdict is cached for the opaque public-IP plus LAN-subnet network
  key. An isolation verdict is cached the same way. Wi-Fi names are not stored.
- If setup infrastructure is unavailable, a cached certificate still permits a
  direct QR and offline guest playback.
- Relay mode PUSHES: the Mac uploads its own LL-HLS to the relay origin, which
  fans it out. The Mac sends one copy whether five or five hundred people listen,
  and it is never in a guest's request path.
- The Mac forwards its own playlists byte for byte, so PROGRAM-DATE-TIME and the
  room schedule survive the relay. Nothing re-packages or re-stamps.
- The origin holds one party's live window in memory, bounded, and drops it when
  the room goes quiet. Party history is never retained.
- The room API is served from the origin: the Mac publishes state, heartbeats
  aggregate into one digest, and guest writes queue for the Mac. 500 listeners
  cost the Mac what 5 do.
- A direct listener that observes a room-wide switch to relay navigates to the
  relay origin. Direct and relayed playback are not mixed in one room.
- The Mac console and menu bar must state `checking`, `local`, `direct`,
  `relay`, or `no path`.
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
