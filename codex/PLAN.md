# Current queue

1. When the owner resumes Apple releases, package and upload the newest Store
   build, then finish its App Store Connect privacy answers, screenshots, and
   submission.

Completed: the app is account-free. The Store edition remains App Store-only;
the separately identified standalone beta is shipped through its signed Sparkle
channel. The old shared direct-release daemon and OTA web payloads remain
retired. The sandboxed Store edition builds, installs, launches, serves its
local console, and shuts down cleanly on the owner's macOS 27 test machine
through `scripts/build-install-app-store-local.sh`.

Do not restore public event pages, retained online listening, cloud party
feeds, replays, hotspot/captive-portal setup, alternate Apple playback engines,
or stream presets. The only cloud live path is the Mac-controlled ephemeral
relay for isolated venue Wi-Fi.
