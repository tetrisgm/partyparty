# Current queue

1. Run the direct and isolated-Wi-Fi physical acceptance in
   `codex/HANDOFF.md`, including two phones in each room mode.
2. After direct streaming acceptance passes, supervise removal of the inert plain-HLS, delivery-switch,
   recording-tee, and override internals in `internal/broadcast/`.
3. Validate the sandboxed App Store build on a clean Mac.
4. When the owner resumes Apple releases, package and upload the newest Store
   build, then finish its App Store Connect privacy answers, screenshots, and
   submission.

Completed: the app is account-free. The Store edition remains App Store-only;
the separately identified standalone beta is shipped through its signed Sparkle
channel. The old shared direct-release daemon and OTA web payloads remain
retired.

Do not restore public event pages, retained online listening, cloud party
feeds, replays, hotspot/captive-portal setup, alternate Apple playback engines,
or stream presets. The only cloud live path is the Mac-controlled ephemeral
relay for isolated venue Wi-Fi.
