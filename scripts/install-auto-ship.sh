#!/usr/bin/env bash
# Install (or reinstall) the local auto-ship launchd agent for this checkout.
# It fires scripts/auto-ship.sh on every main-ref change plus a 5-min backstop,
# so the latest coherent main is always built + shipped in the background.
#
#   scripts/install-auto-ship.sh            # install + start
#   scripts/install-auto-ship.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="net.ramine.partyparty.autoship"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/build"
cat > "$PLIST" <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/auto-ship.sh</string>
  </array>
  <!-- Fire whenever a commit lands (logs/HEAD moves on every ref change). -->
  <key>WatchPaths</key>
  <array>
    <string>$ROOT/.git/logs/HEAD</string>
  </array>
  <!-- Backstop: also check every 5 min in case a WatchPath event is missed. -->
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$ROOT/build/auto-ship.launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/build/auto-ship.launchd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTXML

# Reload cleanly (bootout is a no-op if not loaded).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "installed + started $LABEL"
echo "  plist:  $PLIST"
echo "  script: $ROOT/scripts/auto-ship.sh"
echo "  log:    $ROOT/build/auto-ship.log"
launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|program =' | head -3 || true
