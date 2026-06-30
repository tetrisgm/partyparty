#!/usr/bin/env bash
# Quick LL-HLS latency test on a REAL device, before committing to the full rebuild.
# Captures the Mac's system audio -> AAC -> MediaMTX -> LL-HLS over HTTPS.
# Open the printed URL on your iPhone and compare the delay to the ~3s plain-HLS build.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v mediamtx >/dev/null || { echo "mediamtx not found: brew install mediamtx"; exit 1; }
[ -x assets/ppcapture ] || { echo "system-audio helper missing: run 'make' first"; exit 1; }

DIR="$(pwd)/run/llhls"
mkdir -p "$DIR"
IP="$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)"

# Self-signed cert including the current LAN IP (so the iPhone URL matches).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -days 365 -subj "/CN=partyparty" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP" 2>/dev/null

cat > "$DIR/mediamtx.yml" <<EOF
logLevel: info
api: no
metrics: no
playback: no
rtmp: no
srt: no
webrtc: no
rtsp: yes
rtspAddress: :8554
hls: yes
hlsAddress: :8888
hlsEncryption: yes
hlsServerCert: $DIR/cert.pem
hlsServerKey: $DIR/key.pem
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

echo "Starting MediaMTX (LL-HLS, HTTPS)…"
mediamtx "$DIR/mediamtx.yml" &
MTX=$!
cleanup() { kill "${FF:-0}" "$MTX" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
sleep 2

echo "Capturing system audio → LL-HLS…"
./assets/ppcapture \
  | ffmpeg -hide_banner -loglevel warning -f f32le -ar 48000 -ac 2 -i pipe:0 \
      -c:a aac_at -b:a 256k -ac 2 -muxdelay 0 -flush_packets 1 \
      -f rtsp -rtsp_transport tcp rtsp://localhost:8554/party &
FF=$!

cat <<MSG

================ LL-HLS TEST ================
1) Put your iPhone on the SAME Wi-Fi as this Mac.
2) Trust the cert once (HTTPS is required for LL-HLS):
     • AirDrop  run/llhls/cert.pem  to the iPhone → Install the profile
       (Settings → Profile Downloaded → Install)
     • Settings → General → About → Certificate Trust Settings → enable "partyparty"
3) On the iPhone, open Safari to:
       https://$IP:8888/party/index.m3u8
4) Play music on the Mac and compare the delay to the ~3s you had.

Ctrl+C to stop.
MSG

wait
