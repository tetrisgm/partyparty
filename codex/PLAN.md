# Current queue

1. Run the physical iOS 26.4/27 streaming acceptance in `codex/HANDOFF.md`.
2. After that passes, supervise removal of the inert plain-HLS, delivery-switch,
   recording-tee, and override internals in `internal/broadcast/`.
3. Validate the sandboxed App Store build on a clean Mac.
4. Package and upload the newest Store build, then finish its App Store Connect
   privacy answers, screenshots, and submission.

Completed: the app is account-free and App Store-only; direct distribution,
Sparkle, installer/appcast publishing, and OTA web payloads are retired.

Do not restore public event pages, online listening, cloud party feeds, replays,
hotspot/captive-portal setup, alternate Apple playback engines, or stream presets.
