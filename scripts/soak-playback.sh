#!/usr/bin/env bash
# The pre-upload playback soak the agent contract requires.
#
# Any change to playlist geometry or playback positioning must PASS this before
# a build is uploaded anywhere. Unit and contract tests cannot hear AVPlayer:
# two green-tested geometry builds failed on real phones within minutes on
# 2026-08-05 - one rolled a live listener backward, the other parked a phone
# 27s behind. This attaches a muted, headless, REAL AVPlayer to a live stream
# and watches where it sits.
#
#   scripts/soak-playback.sh [stream-url] [minutes]
#
# Default URL is the local MediaMTX playlist, which is what a guest ultimately
# plays. To soak a CANDIDATE manifest instead of the shipped one, run the bench
# proxy in another shell and point this at it:
#
#   python3 scripts/bench-playlist-proxy.py 8901
#   scripts/soak-playback.sh http://127.0.0.1:8901/party/index.m3u8
#
# PASS means: ten minutes, zero backward movement, position stable at the
# declared target. Keep the log next to the build as the receipt.
set -euo pipefail

cd "$(dirname "$0")/.."
URL="${1:-https://127.0.0.1:8888/party/index.m3u8}"
MINUTES="${2:-10}"
BIN="build/soak-playback"
LOG="build/soak-$(date +%Y%m%d-%H%M%S).log"

mkdir -p build
if [ ! -x "$BIN" ] || [ scripts/soak-playback.swift -nt "$BIN" ]; then
  echo "building the soak player…" >&2
  swiftc -O -o "$BIN" scripts/soak-playback.swift
fi

echo "soaking $URL for ${MINUTES}m -> $LOG" >&2
if ! PP_SOAK_MINUTES="$MINUTES" "$BIN" "$URL" | tee "$LOG"; then
  echo "SOAK FAILED - see $LOG. Nothing ships on a failed soak." >&2
  exit 1
fi
echo "receipt: $LOG" >&2
