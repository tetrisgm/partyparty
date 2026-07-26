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
#   scripts/stream-selftest.sh --browser  # ffmpeg guest + real browser listener page
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
REBUILD=0
BROWSER=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --browser) BROWSER=1 ;;
    *)
      echo "usage: $0 [--rebuild] [--browser]"
      exit 2
      ;;
  esac
  shift
done
PIDS=()
cleanup(){
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  for p in "${PIDS[@]:-}"; do wait "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
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
hlsSegmentCount: 48
hlsSegmentDuration: 500ms
hlsPartDuration: 150ms
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
TEE_RTSP="${TEE_RTSP:-rtsp_transport=tcp:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1}"
start_pub(){
  "$FF" -hide_banner -loglevel warning -progress "$WORK/progress.txt" \
    -re -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -vn -ac 2 -ar 48000 -c:a aac -b:a 320k \
    -f tee -map 0:a \
    "[f=rtsp:$TEE_RTSP]rtsp://127.0.0.1:$RTSP_PORT/party|[f=adts:onfail=ignore:use_fifo=1:fifo_options=drop_pkts_on_overflow=1]$WORK/rec.aac" \
    > "$WORK/pub.log" 2>&1 & PIDS+=($!); PUB_PID=$!
}

# GUEST: pull the HTTPS LL-HLS, decode it, and measure the audio LEVEL — so we
# confirm the guest receives the DJ's actual SOUND, not just some bytes or
# silence. Returns "secs|mean_dB|raw".
guest_decode_secs(){
  # raw ffmpeg output -> a file (NOT the return value; it's multi-line and would
  # corrupt the caller's field-split). Return a clean single-line "secs|mean".
  "$FF" -hide_banner -loglevel info -stats -nostdin -tls_verify 0 -rw_timeout 8000000 \
    -i "https://127.0.0.1:$HLS_PORT/party/index.m3u8" -t 6 -map 0:a -af volumedetect -f null - \
    > "$WORK/guest.log" 2>&1 || true
  local t secs mean
  t="$(grep -oE 'time=[0-9:.]+' "$WORK/guest.log" | tail -1 | sed 's/time=//')"
  secs="$(printf '%s' "$t" | awk -F: '{printf "%d", ($1*3600)+($2*60)+$3}')"
  mean="$(grep -oE 'mean_volume: -?[0-9.]+' "$WORK/guest.log" | tail -1 | grep -oE '\-?[0-9.]+' | head -1)"
  printf '%s|%s' "${secs:-0}" "${mean:-none}"
}
# A guest "heard the DJ" only if it decoded >= MIN_SECS AND the audio is not
# silence. mean_volume near -90dB = silence; a real tone/track sits far above.
SILENCE_FLOOR="${SILENCE_FLOOR:--70}"

echo ">> starting mediamtx + publisher (tee rtsp opts: $TEE_RTSP)"
start_mtx; sleep 2; start_pub; sleep 5

not_silent(){ awk -v m="$1" -v f="$SILENCE_FLOOR" 'BEGIN{ if(m=="none"){exit 1}; exit !(m+0 > f+0) }'; }

echo ">> GUEST pull #1 (happy path)"
r1="$(guest_decode_secs)"; s1="${r1%%|*}"; m1="${r1##*|}"
echo "   guest decoded ${s1}s of audio, mean_volume ${m1}dB  (need >= ${MIN_SECS}s and > ${SILENCE_FLOOR}dB)"
not_silent "$m1" && a1=1 || a1=0

s2="$s1"; a2="$a1"
if [ "$REBUILD" = "1" ]; then
  echo ">> injecting capture-rebuild: kill+restart the publisher (like CAPTURE-DEVICECHANGE)"
  kill "$PUB_PID" 2>/dev/null; sleep 1; start_pub; sleep 5
  echo ">> GUEST pull #2 (after rebuild)"
  r2="$(guest_decode_secs)"; s2="${r2%%|*}"; m2="${r2##*|}"
  echo "   guest decoded ${s2}s of audio, mean_volume ${m2}dB after rebuild"
  not_silent "$m2" && a2=1 || a2=0
fi

echo "== mediamtx publish/read events =="
grep -iE "is publishing|is reading|created|error|already" "$WORK/mtx.log" | tail -8

if [ "${s1:-0}" -ge "$MIN_SECS" ] && [ "${s2:-0}" -ge "$MIN_SECS" ] && [ "$a1" = "1" ] && [ "$a2" = "1" ]; then
  echo "RESULT: PASS — a guest received the DJ's actual audio end-to-end (decoded + non-silent)."
else
  echo "RESULT: FAIL — guest did NOT receive the DJ's audio (reproduces 'guests hear nothing')."
  echo "  decoded>=${MIN_SECS}s: #1=$([ "${s1:-0}" -ge "$MIN_SECS" ] && echo ok || echo NO) #2=$([ "${s2:-0}" -ge "$MIN_SECS" ] && echo ok || echo NO) | non-silent: #1=$([ "$a1" = 1 ] && echo ok || echo NO) #2=$([ "$a2" = 1 ] && echo ok || echo NO)"
  echo "---- guest ffmpeg detail ----"; tail -20 "$WORK/guest.log" 2>/dev/null
  exit 1
fi

if [ "$BROWSER" = "1" ]; then
  echo ">> browser guest E2E (actual listener.html + Playwright Chromium + WebAudio RMS)"
  cleanup
  trap - EXIT
  node "$ROOT/scripts/stream-e2e.mjs"
fi

exit 0
