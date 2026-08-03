#!/usr/bin/env bash
set -euo pipefail
# ---------------------------------------------------------------------------
# DORMANT LANE (2026-08-03). The active distribution path is the Mac App Store
# and TestFlight. This standalone Sparkle channel is deliberately KEPT so it can
# be picked up again later; it is not deleted and not deprecated.
#
# Nothing invokes this script automatically any more. The launchd daemon that
# used to run it on every commit is gone: it made five notarize-and-publish
# attempts in one day off ordinary development commits. Running this is a
# deliberate act, by a person, on request.
# ---------------------------------------------------------------------------


cd "$(dirname "$0")/.."
ROOT="$PWD"

# The version string, like the build number below, is derived from what is
# already published rather than hand-typed. The old default here was a stale
# constant, which is the same defect that shipped an undeliverable release when
# the build number had one: forget the env var once and the ship stamps whatever
# was current when someone last edited this file. PP_VERSION still overrides for
# deliberate jumps (a new major); otherwise the last published version's final
# component is bumped by one.
derive_version() {
  local published
  published=$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml 2>/dev/null |
    grep -oE '<sparkle:shortVersionString>[0-9.]+</sparkle:shortVersionString>' |
    grep -oE '[0-9.]+' | tail -1)
  local live
  live=$(curl -fsS --max-time 20 https://partyparty.party/api/version 2>/dev/null |
    grep -oE '"version":"[0-9.]+"' | grep -oE '[0-9.]+' | head -1)
  python3 - "$published" "$live" <<'DERIVE'
import sys

def parse(raw):
    try:
        parts = [int(p) for p in raw.strip().split(".") if p != ""]
        return parts if parts else None
    except ValueError:
        return None

candidates = [v for v in (parse(a) for a in sys.argv[1:]) if v]
if not candidates:
    sys.stderr.write("Cannot determine the published version; refusing to guess.\n")
    sys.exit(1)
current = max(candidates)
current[-1] += 1
print(".".join(str(p) for p in current))
DERIVE
}
VERSION="${PP_VERSION:-$(derive_version)}"
[ -n "$VERSION" ] || exit 1

# The build number is what Sparkle compares, so it must only ever go up. It used
# to default to a hardcoded constant, which meant any ship that did not happen to
# pass PP_BUILD published a build number lower than the one already installed.
# Sparkle then correctly refused to offer the update, the ship reported success,
# and auto-update was silently dead. That shipped as 125.2 build 216 against an
# installed 218.
#
# Derived from the record of what has actually been published: the Worker's
# download map accumulates every registered build and is committed, and the live
# appcast is what installs are comparing against right now. Highest of the two,
# plus one.
derive_build() {
  local from_map from_feed
  from_map=$(grep -oE 'PartyParty-[0-9.]+-([0-9]+)\.zip' "$ROOT/cloudflare/worker.js" 2>/dev/null |
    sed -E 's/.*-([0-9]+)\.zip/\1/' | sort -n | tail -1)
  from_feed=$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml 2>/dev/null |
    grep -oE '<sparkle:version>[0-9]+</sparkle:version>' |
    sed -E 's/[^0-9]//g' | sort -n | tail -1)
  local highest=0
  for candidate in "$from_map" "$from_feed"; do
    if [ -n "$candidate" ] && [ "$candidate" -gt "$highest" ] 2>/dev/null; then highest=$candidate; fi
  done
  if [ "$highest" -le 0 ]; then
    echo "Cannot determine the last published build; refusing to guess." >&2
    return 1
  fi
  echo $((highest + 1))
}
BUILD="${PP_BUILD:-$(derive_build)}"
[ -n "$BUILD" ] || exit 1
echo "shipping version $VERSION build $BUILD"

# Every ship writes a machine-readable receipt, success or failure. Reading a
# ship's outcome from its log tail has produced false reports twice (a buffered
# tail read as a stall, a wrapper exit code read as the ship's), and a receipt
# keyed to the commit is what the autoship daemon gates on. The receipt is
# written by a trap so a failure at ANY stage still records where it stopped.
RECEIPTS="$ROOT/dist/receipts"
mkdir -p "$RECEIPTS"
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
STAGE="starting"
write_receipt() {
  local status="$1" error="${2:-}"
  python3 - "$RECEIPTS" "$VERSION" "$BUILD" "$COMMIT" "$STAGE" "$status" "$error" <<'RECEIPT'
import json, os, sys, time
receipts, version, build, commit, stage, status, error = sys.argv[1:8]
receipt = {
    "version": version, "build": int(build), "commit": commit,
    "status": status, "stage": stage, "finishedAt": int(time.time()),
    "downloadUrl": f"https://partyparty.party/downloads/PartyParty-{version}-{build}.zip",
}
if error:
    receipt["error"] = error[-2000:]
path = os.path.join(receipts, f"ship-{version}-{build}.json")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(receipt, f, indent=1)
    f.write("\n")
os.replace(tmp, path)
latest = os.path.join(receipts, "latest.json")
with open(latest + ".tmp", "w") as f:
    json.dump(receipt, f, indent=1)
    f.write("\n")
os.replace(latest + ".tmp", latest)
RECEIPT
}
on_exit() {
  local code=$?
  if [ "$code" -eq 0 ]; then
    write_receipt success
  else
    write_receipt failed "exit $code during $STAGE"
  fi
}
trap on_exit EXIT
APP="$ROOT/build/PartyParty-Beta.app"
RELEASE_DIR="$ROOT/dist/standalone-$VERSION-$BUILD"
ZIP_NAME="PartyParty-$VERSION-$BUILD.zip"
ZIP="$RELEASE_DIR/$ZIP_NAME"
APPCAST="$RELEASE_DIR/appcast.xml"
WRANGLER="$ROOT/cloudflare/node_modules/.bin/wrangler"
GENERATE_APPCAST="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin/generate_appcast"

if curl -fsI "https://partyparty.party/downloads/$ZIP_NAME" >/dev/null 2>&1; then
  echo "Refusing to reuse published standalone version $VERSION build $BUILD." >&2
  exit 1
fi

# Exported, not merely set: build-standalone.sh stamps the bundle from its own
# PP_VERSION and PP_BUILD, so a build number this script derived but kept to
# itself leaves the bundle stamped with the child's fallback instead. That
# mismatch is caught by verify-standalone.sh below, but the right place to agree
# on the number is here, once, before anything is built.
export PP_VERSION="$VERSION" PP_BUILD="$BUILD"
STAGE="build"
"$ROOT/scripts/build-standalone.sh"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE_DIR/notary.zip"
STAGE="notarize"
source "$ROOT/scripts/notary-lib.sh"
notary_submit_with_retry "$RELEASE_DIR/notary.zip" "standalone-app" "$RELEASE_DIR/notary-id.txt"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
REQUIRE_NOTARIZED=1 "$ROOT/scripts/verify-standalone.sh" "$APP" "$VERSION" "$BUILD"
rm "$RELEASE_DIR/notary.zip"

STAGE="package"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
"$GENERATE_APPCAST" \
  --download-url-prefix "https://partyparty.party/downloads/" \
  "$RELEASE_DIR"
[ -f "$APPCAST" ]
grep -q "sparkle:edSignature=" "$APPCAST"
grep -q "<sparkle:version>$BUILD</sparkle:version>" "$APPCAST"

# Refuse to flip the feed to a build that installs would reject. Every other gate
# here checks the release is well formed, and a regressing build number is well
# formed in every way while being undeliverable, so it passed all of them. This
# is the only check that asks the question that matters: will an installed Mac
# actually take this update.
PUBLISHED_BUILD=$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml 2>/dev/null |
  grep -oE '<sparkle:version>[0-9]+</sparkle:version>' | sed -E 's/[^0-9]//g' | sort -n | tail -1)
if [ -n "$PUBLISHED_BUILD" ] && [ "$BUILD" -le "$PUBLISHED_BUILD" ]; then
  echo "Refusing to publish build $BUILD over published build $PUBLISHED_BUILD." >&2
  echo "Sparkle compares build numbers, so this release would never be offered." >&2
  exit 1
fi

STAGE="publish"
(
  cd cloudflare

  # Publish-then-flip: both immutable zips land first, and the appcast, which is
  # what makes installs act, lands LAST. The Worker resolves release downloads
  # from the bucket by name and derives /api/version from this appcast, so a
  # ship needs NO Worker edit and NO Worker deploy. The registration step this
  # replaces was itself the cause of a broken release (map never updated, every
  # updater 404ed) and then of a failed ship (the step crashed mid-publish), and
  # the class is closed by there being nothing to register.
  "$WRANGLER" r2 object put "partyparty-dl/standalone/$ZIP_NAME" --file "$ZIP" --content-type application/zip --remote
  "$WRANGLER" r2 object put "partyparty-dl/standalone/PartyParty-Beta.zip" --file "$ZIP" --content-type application/zip --remote
  "$WRANGLER" r2 object put "partyparty-dl/standalone/appcast.xml" --file "$APPCAST" --content-type application/xml --remote
)

STAGE="verify-public"
"$ROOT/scripts/verify-standalone-public.sh" "$ZIP" "$VERSION" "$BUILD"
STAGE="done"
