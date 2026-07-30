#!/usr/bin/env bash
# Build the bundled ffmpeg from source, LGPL-only, and install it to assets/.
#
# The previous bundled binary was a third-party build configured with
# --enable-gpl --enable-libx264 --enable-libx265. GPL is incompatible with App
# Store distribution terms, and this app is closed source, so shipping that
# binary was a licensing defect in EVERY lane, not just the store one. Nothing
# in the product needs any GPL component: the live path is f32le in, aac_at
# (AudioToolbox) encode, tee/fifo/rtsp out; recordings are mp4/mov/segment;
# thumbnails DECODE video (native + VideoToolbox) and encode png/mjpeg images.
# No video is ever encoded.
#
# So: upstream source, pinned by hash, no external libraries at all, no GPL
# flag. Everything the app uses is in ffmpeg's own LGPL core plus Apple's
# frameworks. The result is also less than half the size of what it replaces.
#
# Run on the Mac that ships (arm64). Requires only Xcode CLT.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

FFMPEG_VERSION="8.1"
FFMPEG_SHA256_EXPECTED="${PP_FFMPEG_SHA256:-}"
WORK="${TMPDIR:-/tmp}/pp-ffmpeg-lgpl-$FFMPEG_VERSION"
JOBS="$(sysctl -n hw.ncpu)"

mkdir -p "$WORK"
cd "$WORK"

TARBALL="ffmpeg-$FFMPEG_VERSION.tar.xz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL "https://ffmpeg.org/releases/$TARBALL" -o "$TARBALL.tmp"
  mv "$TARBALL.tmp" "$TARBALL"
fi
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo "ffmpeg $FFMPEG_VERSION tarball sha256: $SHA"
if [ -n "$FFMPEG_SHA256_EXPECTED" ] && [ "$SHA" != "$FFMPEG_SHA256_EXPECTED" ]; then
  echo "tarball hash mismatch; refusing to build" >&2
  exit 1
fi

# Reuse an existing build tree unless a clean build is demanded: the checks
# below are cheap to re-run, the compile is not.
if [ "${PP_FFMPEG_CLEAN:-0}" = "1" ] || [ ! -f "ffmpeg-$FFMPEG_VERSION/config.h" ]; then
  rm -rf "ffmpeg-$FFMPEG_VERSION"
  tar -xf "$TARBALL"
  NEED_CONFIGURE=1
else
  NEED_CONFIGURE=0
fi
cd "ffmpeg-$FFMPEG_VERSION"

# No --enable-gpl, no --enable-nonfree, no external libraries: the whole build
# is ffmpeg's own LGPL code plus AudioToolbox/VideoToolbox, which is the point.
[ "$NEED_CONFIGURE" = "0" ] || ./configure \
  --cc=/usr/bin/clang \
  --arch=arm64 \
  --disable-shared --enable-static \
  --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-debug \
  --disable-ffplay --disable-ffprobe \
  --disable-sdl2 --disable-xlib --disable-libxcb \
  --enable-audiotoolbox \
  --enable-videotoolbox \
  --enable-neon \
  --enable-runtime-cpudetect \
  --extra-cflags=-fno-stack-check

make -j"$JOBS" ffmpeg

# Prove the licensing posture and the capabilities the product depends on
# BEFORE the binary can reach assets/. A build that lost a needed component
# must fail here, not at a party.
# Capture each listing ONCE, then grep the variable. Piping ffmpeg straight
# into grep -q under pipefail is a trap: grep exits at the first match, ffmpeg
# dies with SIGPIPE writing the rest of the list, and the pipeline reports
# failure for a check that matched. It bit this exact script.
LICENSE="$(./ffmpeg -hide_banner -L 2>&1)"
VERSIONINFO="$(./ffmpeg -hide_banner -version 2>&1)"
ENCODERS="$(./ffmpeg -hide_banner -encoders 2>/dev/null)"
MUXERS="$(./ffmpeg -hide_banner -muxers 2>/dev/null)"
DECODERS="$(./ffmpeg -hide_banner -decoders 2>/dev/null)"
printf '%s\n' "$LICENSE" | head -2
printf '%s' "$LICENSE" | grep -qE "Lesser General Public|LGPL" || { echo "not an LGPL build" >&2; exit 1; }
printf '%s' "$LICENSE" | head -3 | grep -qE "GNU General Public License" && { echo "GPL license text leads the banner; refusing" >&2; exit 1; }
printf '%s' "$VERSIONINFO" | grep -q "enable-gpl" && { echo "GPL flag present; refusing" >&2; exit 1; }
printf '%s' "$ENCODERS" | grep -q " aac_at " || { echo "missing aac_at encoder" >&2; exit 1; }
printf '%s' "$MUXERS" | grep -qE "E +rtsp " || { echo "missing rtsp muxer" >&2; exit 1; }
printf '%s' "$MUXERS" | grep -qE "E +tee " || { echo "missing tee muxer" >&2; exit 1; }
printf '%s' "$MUXERS" | grep -qE "E +fifo " || { echo "missing fifo muxer" >&2; exit 1; }
printf '%s' "$MUXERS" | grep -qE "E +segment" || { echo "missing segment muxer" >&2; exit 1; }
printf '%s' "$DECODERS" | grep -q " h264 " || { echo "missing h264 decoder" >&2; exit 1; }
printf '%s' "$ENCODERS" | grep -qE " png | mjpeg " || { echo "missing image encoders" >&2; exit 1; }
# One real end-to-end encode: PCM in, AudioToolbox AAC out.
./ffmpeg -hide_banner -f lavfi -i "sine=frequency=440:duration=1" -c:a aac_at -f mp4 -y /tmp/pp-lgpl-selftest.mp4 >/dev/null 2>&1 \
  || { echo "aac_at end-to-end encode failed" >&2; exit 1; }

install -m 755 ffmpeg "$ROOT/assets/ffmpeg"
echo "installed LGPL ffmpeg $FFMPEG_VERSION -> assets/ffmpeg ($(du -h "$ROOT/assets/ffmpeg" | cut -f1))"
