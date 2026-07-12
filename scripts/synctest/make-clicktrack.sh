#!/usr/bin/env bash
# Generate a click track for the physical device-to-device sync test.
#
# The ONLY ground truth for room sync is a microphone: browser telemetry cannot
# see the speaker/DAC output path (Bluetooth alone adds 150-300ms invisibly).
# This track plays a sharp 1kHz impulse every 2s, with a distinctive triple-burst
# every 10s as an unambiguous alignment marker. Play it on the DJ Mac so partyparty
# captures it and streams it to every device; record the room (record-room.sh) and
# analyse (measure-sync.py).
#
#   scripts/synctest/make-clicktrack.sh [seconds]   # default 60
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FF="${FF:-$ROOT/assets/ffmpeg}"; [ -x "$FF" ] || FF="ffmpeg"
SECS="${1:-60}"
OUT="$ROOT/scripts/synctest/clicktrack.wav"

# A 1kHz tone gated to a 12ms burst every 2s. Uniform (no markers) so every click
# event is a single burst whose temporal WIDTH = the device-to-device spread.
"$FF" -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=sin(2*PI*1000*t)*lt(mod(t\,2)\,0.012):s=48000:d=$SECS" \
  -af "alimiter=limit=0.9" -ac 2 -ar 48000 "$OUT"
echo ">> wrote $OUT (${SECS}s: 12ms 1kHz click every 2s)"
echo ">> Play it on the DJ Mac (any player through the output partyparty captures),"
echo "   Go Live, join all test devices on SPEAKER at matched volume, then run record-room.sh."
