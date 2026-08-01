#!/usr/bin/env bash
# Install (or reinstall) the autoship launchd agent. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
PLIST_SRC="deploy/autoship/net.ramine.partyparty.autoship.plist"
PLIST_DST="$HOME/Library/LaunchAgents/net.ramine.partyparty.autoship.plist"
LABEL="net.ramine.partyparty.autoship"
plutil -lint "$PLIST_SRC" >/dev/null
cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|program" | head -3
echo "autoship installed; state in ~/Library/Application Support/partyparty-autoship/"
