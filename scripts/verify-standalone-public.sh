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
    grep -q 'href="/partyparty-beta.zip"' "$TMP/site.html"; then
    ready=1
    break
  fi
  sleep 5
done
if [ "$ready" != "1" ]; then
  echo "Public release metadata did not converge to $VERSION build $BUILD within 60 seconds." >&2
  exit 1
fi

if grep -q '"standaloneBuild"' "$TMP/version.json"; then
  echo "Internal build number leaked through the public version endpoint." >&2
  exit 1
fi

query="release=$VERSION-$BUILD-$(date +%s)"
curl -fsS --retry 5 --retry-all-errors --retry-delay 3 \
  "https://partyparty.party/downloads/partyparty-$VERSION-$BUILD.zip?$query" -o "$TMP/immutable.zip"
curl -fsS --retry 5 --retry-all-errors --retry-delay 3 \
  "https://partyparty.party/partyparty-beta.zip?$query" -o "$TMP/stable.zip"
cmp "$ZIP" "$TMP/immutable.zip"
cmp "$ZIP" "$TMP/stable.zip"
