#!/usr/bin/env bash
set -euo pipefail

ZIP="${1:?zip required}"
VERSION="${2:?version required}"
BUILD="${3:?build required}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ready=0
for attempt in $(seq 1 12); do
  query="release=$VERSION-$BUILD-$(date +%s)-$attempt"
  if curl -fsS -H 'Cache-Control: no-cache' "https://partyparty.party/appcast.xml?$query" -o "$TMP/appcast.xml" &&
    curl -fsS -H 'Cache-Control: no-cache' "https://partyparty.party/api/version?$query" -o "$TMP/version.json" &&
    curl -fsS -H 'Cache-Control: no-cache' "https://partyparty.party/?$query" -o "$TMP/site.html" &&
    grep -q "sparkle:edSignature=" "$TMP/appcast.xml" &&
    grep -q "<sparkle:version>$BUILD</sparkle:version>" "$TMP/appcast.xml" &&
    grep -q "\"version\":\"$VERSION\"" "$TMP/version.json" &&
    grep -q 'href="/partyparty-beta.zip"' "$TMP/site.html" &&
    # The URL Sparkle will actually fetch must resolve. The appcast advertising a
    # build is not the same as the Worker serving it: 125.0 shipped with the zip
    # in R2 and the appcast pointing at it, but the Worker's download map had no
    # entry, so every updating Mac got a 404 and reported "update error". Check
    # the real path, not just the metadata that describes it.
    curl -fsI -H 'Cache-Control: no-cache' \
      "https://partyparty.party/downloads/partyparty-$VERSION-$BUILD.zip?$query" >/dev/null; then
    ready=1
    break
  fi
  sleep 5
done
if [ "$ready" != "1" ]; then
  echo "Public release did not converge to $VERSION build $BUILD within 60 seconds." >&2
  echo "Check: appcast signature and version, /api/version, the site link, and" >&2
  echo "that https://partyparty.party/downloads/partyparty-$VERSION-$BUILD.zip resolves." >&2
  exit 1
fi

if grep -q '"standaloneBuild"' "$TMP/version.json"; then
  echo "Internal build number leaked through the public version endpoint." >&2
  exit 1
fi

query="release=$VERSION-$BUILD-$(date +%s)"
# Same patience as the convergence loop above. These used to give up after about
# fifteen seconds while the loop above them allowed sixty, so a Worker deploy that
# had reached the edge answering the HEAD check but not yet the edge answering
# this GET failed the whole ship on a release that was in fact fine. A byte
# comparison is the right gate; a stricter deadline than the readiness check that
# precedes it is not.
curl -fsS --retry 12 --retry-all-errors --retry-delay 5 \
  "https://partyparty.party/downloads/partyparty-$VERSION-$BUILD.zip?$query" -o "$TMP/immutable.zip"
curl -fsS --retry 12 --retry-all-errors --retry-delay 5 \
  "https://partyparty.party/partyparty-beta.zip?$query" -o "$TMP/stable.zip"
cmp "$ZIP" "$TMP/immutable.zip"
cmp "$ZIP" "$TMP/stable.zip"
