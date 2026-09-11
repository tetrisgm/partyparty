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
#   scripts/soak-playback.sh <stream-url> [minutes]
#
# THE URL IS REQUIRED, and that is deliberate. Until 2026-09-11 this script
# defaulted to https://127.0.0.1:8888/party/index.m3u8, which is MediaMTX's own
# loopback port. The room schedule is authored by the Go proxy mounted at /live
# (internal/server/server.go), so a default run measured a playlist NO GUEST
# EVER RECEIVES - unpinned, on the muxer's raw hold-back - while the contract
# called the result a pre-upload receipt. None of the five receipts committed
# before that date records which URL it measured, so none of them can be
# compared to another. A guessed default is how that happened; there is no
# default now, and the harness writes the URL into the log itself.
#
# Which URL to pass:
#
#   direct guest path   https://<guest-host>:8443/live/<stream-path>/index.m3u8
#                       (the exact llhlsUrl in /api/status)
#   relay guest path    https://<token>.relay.partyparty.party/stream.m3u8
#   throwaway lab       scripts/soak-lab.mjs runs every arm for you against a
#                       disposable stack, and needs no live room at all
#
# Do NOT put scripts/bench-playlist-proxy.py in the media path. It returned
# 3.12s, 3.20s and 3.16s for three different pin placements: the proxy, not the
# manifest, was the thing being measured.
#
# PASS means: the run attached, advanced, never moved backward, and sat at the
# declared target. The target assertion is on ATTACH (distance from the live
# edge), not on end-to-end latency, because attach is the quantity a playlist
# change can move. Keep the log next to the build as the receipt.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

URL="$1"
MINUTES="${2:-10}"
BIN="build/soak-playback"
LABEL="${PP_SOAK_LABEL:-$(printf '%s' "$URL" | sed -e 's#^https\{0,1\}://##' -e 's#[/:]#-#g')}"
LOG="build/soak-$(date +%Y%m%d-%H%M%S)-${LABEL}.log"

mkdir -p build
if [ ! -x "$BIN" ] || [ scripts/soak-playback.swift -nt "$BIN" ]; then
  echo "building the soak player…" >&2
  swiftc -O -o "$BIN" scripts/soak-playback.swift
fi

echo "soaking $URL for ${MINUTES}m -> $LOG" >&2
if ! PP_SOAK_MINUTES="$MINUTES" PP_SOAK_LABEL="$LABEL" "$BIN" "$URL" | tee "$LOG"; then
  echo "SOAK FAILED - see $LOG. Nothing ships on a failed soak." >&2
  exit 1
fi
echo "receipt: $LOG" >&2
echo "keep it: build/ is gitignored and 'make clean' deletes it. A receipt that" >&2
echo "matters belongs in docs/receipts/." >&2
