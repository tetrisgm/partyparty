# Current handoff

The product is venue-Wi-Fi only. The Mac serves HTTPS LL-HLS and the active-room
social feed directly to guests. Apple devices use native AVPlayer so audio stays
smooth and continues while locked. Public event pages, remote listening, cloud
party content, replays, hotspot setup, playback modes, and old stream settings
are retired.

The direct build remains for migration and Sparkle updates. The App Store lane is
sandboxed and Sparkle-free:

```sh
scripts/build-app-store.sh
scripts/package-app-store.sh
```

The remaining owner-dependent step is App Store Connect submission material and
a distribution provisioning profile. Do not change `internal/broadcast/` without
a supervised go-live test.
