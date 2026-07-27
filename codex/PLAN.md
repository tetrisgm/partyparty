# Current queue

1. Run the physical iOS 26.4/27 streaming acceptance in `codex/HANDOFF.md`.
2. After that passes, supervise removal of the inert plain-HLS, delivery-switch,
   recording-tee, and override internals in `internal/broadcast/`.
3. Validate the sandboxed App Store build on a clean Mac.
4. Implement the isolated standalone beta target, Developer ID/notarized
   packaging, Sparkle EdDSA appcast, website download, and one-command ship
   verification without changing the Store product.
5. Package and upload the newest Store build, then finish its App Store Connect
   privacy answers, screenshots, and submission.

Completed: the app is account-free. The Store edition remains App Store-only;
policy now also permits a separately identified standalone beta for testing.
The old shared direct-release daemon and OTA web payloads remain retired.

Do not restore public event pages, online listening, cloud party feeds, replays,
hotspot/captive-portal setup, alternate Apple playback engines, or stream presets.
