# Current queue

1. Run the physical iOS 26.4/27 streaming acceptance in `codex/HANDOFF.md`.
2. After that passes, supervise removal of the inert plain-HLS, delivery-switch,
   recording-tee, and override internals in `internal/broadcast/`.
3. Keep the DJ app and guest listening local and account-free. The paid App Store
   download is the purchase boundary; anonymous install credentials are only for
   LAN hostname/certificate provisioning.
4. Validate the sandboxed App Store build on a clean Mac.
5. Package and upload the newest Store build, then finish its App Store Connect
   privacy answers, screenshots, and submission.
6. Retire direct distribution only after existing installs have migrated.

Do not restore public event pages, online listening, cloud party feeds, replays,
hotspot/captive-portal setup, alternate Apple playback engines, or stream presets.
