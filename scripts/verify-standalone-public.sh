#!/usr/bin/env bash
set -euo pipefail

ZIP="${1:?zip required}"
VERSION="${2:?version required}"
BUILD="${3:?build required}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsS "https://partyparty.party/appcast.xml" -o "$TMP/appcast.xml"
curl -fsS "https://partyparty.party/downloads/partyparty-$VERSION-$BUILD.zip" -o "$TMP/immutable.zip"
curl -fsS "https://partyparty.party/partyparty-beta.zip" -o "$TMP/stable.zip"
curl -fsS "https://partyparty.party/api/version" -o "$TMP/version.json"
curl -fsS "https://partyparty.party/" -o "$TMP/site.html"

cmp "$ZIP" "$TMP/immutable.zip"
cmp "$ZIP" "$TMP/stable.zip"
grep -q "sparkle:edSignature=" "$TMP/appcast.xml"
grep -q "<sparkle:version>$BUILD</sparkle:version>" "$TMP/appcast.xml"
grep -q "\"version\":\"$VERSION\"" "$TMP/version.json"
if grep -q '"standaloneBuild"' "$TMP/version.json"; then
  echo "Internal build number leaked through the public version endpoint." >&2
  exit 1
fi
grep -q 'href="/partyparty-beta.zip"' "$TMP/site.html"
