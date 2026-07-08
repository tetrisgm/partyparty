#!/usr/bin/env bash
# End-to-end stream self-test — no field Mac needed.
#
# Runs the real LL-HLS pipeline (bundled mediamtx + ffmpeg, a test-tone source
# through the EXACT tee the app builds) under Seth's real config (hlsEncryption:
# yes / lowLatency), then acts as a GUEST: pulls the HTTPS LL-HLS stream and
# decodes it, confirming real audio actually reaches a listener end-to-end
# (manifest -> media playlist -> segments -> decoded audio) — not just that the
# manifest exists. Optionally injects a capture-rebuild to test resilience.
#
#   scripts/stream-selftest.sh            # happy path
#   scripts/stream-selftest.sh --rebuild  # kill+restart the publisher mid-stream, re-check
#   TEE_RTSP='<custom rtsp leg opts>' scripts/stream-selftest.sh   # test a cure variant
#
# PASS = the guest decoded >= MIN_SECS of audio. Exit 0 on PASS, 1 on FAIL.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FF="${FF:-$ROOT/assets/ffmpeg}"
MTX="${MTX:-$ROOT/assets/mediamtx}"
[ -x "$FF" ] || FF="$HOME/Applications/partyparty.app/Contents/Helpers/ffmpeg"
[ -x "$MTX" ] || MTX="$HOME/Applications/partyparty.app/Contents/Helpers/mediamtx"
WORK="$(mktemp -d)"
RTSP_PORT=18554
HLS_PORT=18888
MIN_SECS="${MIN_SECS:-4}"
REBUILD=0; [ "${1:-}" = "--rebuild" ] && REBUILD=1
PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

echo ">> ffmpeg=$FF"
echo ">> mediamtx=$MTX"
"$FF" -version >/dev/null 2>&1 || { echo "FAIL: ffmpeg not runnable"; exit 1; }
"$MTX" --help  >/dev/null 2>&1 || true

# 1) self-signed cert for the LL-HLS HTTPS listener (matches hlsEncryption:yes)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1

# 2) mediamtx config identical in spirit to internal/mediamtx WriteConfig
cat > "$WORK/mtx.yml" <<EOF
logLevel: info
api: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: 127.0.0.1:$RTSP_PORT
rtspTransports: [tcp]
hls: yes
hlsAddress: :$HLS_PORT
hlsEncryption: yes
hlsServerCert: $WORK/cert.pem
hlsServerKey: $WORK/key.pem
hlsVariant: lowLatency
hlsAlwaysRemux: yes
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
hlsAllowOrigins: ['*']
authInternalUsers:
- user: any
  pass:
  permissions:
  - action: publish
  - action: read
paths:
  party:
EOF

start_mtx(){ "$MTX" "$WORK/mtx.yml" > "$WORK/mtx.log" 2>&1 & PIDS+=($!); MTX_PID=$!; }
# The EXACT tee the app builds (broadcast.go buildArgs): rtsp guest leg (opts
# overridable to test cures) + adts recording leg, both onfail=ignore.
TEE_RTSP="${TEE_RTSP:-rtsp_transport=tcp:onfail=ignore:use_fifo=1}"
start_pub(){
  "$FF" -hide_banner -loglevel warning -progress "$WORK/progress.txt" \
    -re -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -vn -ac 2 -ar 48000 -c:a aac -b:a 320k \
    -f tee -map 0:a \
    "[f=rtsp:$TEE_RTSP]rtsp://127.0.0.1:$RTSP_PORT/party|[f=adts:onfail=ignore]$WORK/rec.aac" \
    > "$WORK/pub.log" 2>&1 & PIDS+=($!); PUB_PID=$!
}

# GUEST: pull the HTTPS LL-HLS and decode it; report decoded audio seconds.
guest_decode_secs(){
  local out
  out="$("$FF" -hide_banner -loglevel error -stats -nostdin -tls_verify 0 -rw_timeout 8000000 \
        -i "https://127.0.0.1:$HLS_PORT/party/index.m3u8" -t 6 -map 0:a -f null - 2>&1 || true)"
  # ffmpeg prints "time=00:00:06.00" on the stats line; grab the last one.
  local t
  t="$(printf '%s\n' "$out" | grep -oE 'time=[0-9:.]+' | tail -1 | sed 's/time=//')"
  if [ -z "$t" ]; then echo "0|$out"; return; fi
  # HH:MM:SS.xx -> seconds (integer)
  local secs
  secs="$(printf '%s\n' "$t" | awk -F: '{printf "%d", ($1*3600)+($2*60)+$3}')"
  echo "${secs:-0}|$t"
}

echo ">> starting mediamtx + publisher (tee rtsp opts: $TEE_RTSP)"
start_mtx; sleep 2; start_pub; sleep 5

echo ">> GUEST pull #1 (happy path)"
r1="$(guest_decode_secs)"; s1="${r1%%|*}"
echo "   guest decoded ${s1}s of audio  (need >= ${MIN_SECS}s)"

s2="$s1"
if [ "$REBUILD" = "1" ]; then
  echo ">> injecting capture-rebuild: kill+restart the publisher (like CAPTURE-DEVICECHANGE)"
  kill "$PUB_PID" 2>/dev/null; sleep 1; start_pub; sleep 5
  echo ">> GUEST pull #2 (after rebuild)"
  r2="$(guest_decode_secs)"; s2="${r2%%|*}"
  echo "   guest decoded ${s2}s of audio after rebuild  (need >= ${MIN_SECS}s)"
fi

echo "== mediamtx publish/read events =="
grep -iE "is publishing|is reading|created|error|already" "$WORK/mtx.log" | tail -8

if [ "${s1:-0}" -ge "$MIN_SECS" ] && [ "${s2:-0}" -ge "$MIN_SECS" ]; then
  echo "RESULT: PASS — a guest received playable audio end-to-end."
  exit 0
else
  echo "RESULT: FAIL — guest did NOT receive enough playable audio (this reproduces 'guests hear nothing')."
  echo "---- guest ffmpeg detail ----"; printf '%s\n' "${r1#*|}" | tail -20
  exit 1
fi
