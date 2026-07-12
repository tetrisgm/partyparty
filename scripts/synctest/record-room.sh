#!/usr/bin/env bash
# Record the room (all test devices on speaker playing the click track) with one
# mic, for measure-sync.py to cross-correlate into a device-to-device spread.
#
#   scripts/synctest/record-room.sh [seconds] [mic-index]
# mic-index defaults to the built-in mic; list them with:
#   assets/ffmpeg -f avfoundation -list_devices true -i ""
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FF="${FF:-$ROOT/assets/ffmpeg}"; [ -x "$FF" ] || FF="ffmpeg"
SECS="${1:-45}"
MIC="${2:-1}"     # [1] MacBook Pro Microphone on the tested Mac
OUT="$ROOT/scripts/synctest/room.wav"

echo ">> Place ONE mic roughly equidistant from all device speakers."
echo ">> Recording ${SECS}s from avfoundation audio device [$MIC] -> $OUT"
"$FF" -hide_banner -loglevel warning -y \
  -f avfoundation -i ":$MIC" -t "$SECS" -ac 1 -ar 48000 "$OUT"
echo ">> done. Now: python3 scripts/synctest/measure-sync.py"
