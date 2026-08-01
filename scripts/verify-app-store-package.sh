#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PKG="${1:-$PWD/dist/PartyParty-app-store.pkg}"

fail() {
  echo "App Store package verification failed: $*" >&2
  exit 1
}

[ -f "$PKG" ] || fail "package not found at $PKG"
signature="$(pkgutil --check-signature "$PKG" 2>&1)" || fail "invalid installer signature"
printf '%s\n' "$signature"
grep -Eq '3rd Party Mac Developer Installer:|Mac Installer Distribution:' <<<"$signature" ||
  fail "package is not signed with a Mac App Store installer certificate"

quarantine_pkg_xattr="$(xattr -l "$PKG" 2>/dev/null | grep -E 'com\.apple\.quarantine:' | head -1 || true)"
[ -z "$quarantine_pkg_xattr" ] || fail "package has a quarantine attribute: $quarantine_pkg_xattr"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pkgutil --expand-full "$PKG" "$work/package"

quarantine_payload_xattr="$(xattr -lr "$work/package" 2>/dev/null | grep -E 'com\.apple\.quarantine:' | head -1 || true)"
[ -z "$quarantine_payload_xattr" ] ||
  fail "expanded package has a quarantine attribute: $quarantine_payload_xattr"

apps=()
while IFS= read -r -d '' payload; do
  while IFS= read -r -d '' app; do
    apps+=("$app")
  done < <(find "$payload" -type d -name '*.app' -print0)
done < <(find "$work/package" -type d -name Payload -print0)
[ "${#apps[@]}" -eq 1 ] || fail "expected one app payload, found ${#apps[@]}"
[ "$(basename "${apps[0]}")" = "PartyParty.app" ] ||
  fail "unexpected app payload name: $(basename "${apps[0]}")"

REQUIRE_APP_STORE_DISTRIBUTION=1 ./scripts/verify-app-store.sh "${apps[0]}"
echo "App Store package verified: $PKG"
