#!/usr/bin/env bash

NOTARY_PROFILE="${PP_NOTARY_PROFILE:-pp-notary}"

notary_submit_with_retry() {
  local artifact="$1"
  local label="$2"
  local receipt="$3"
  local output
  output="$(mktemp)"
  if ! xcrun notarytool submit "$artifact" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait --output-format json > "$output" 2>&1; then
    cat "$output"
    rm -f "$output"
    return 1
  fi
  cat "$output"
  sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$output" > "$receipt"
  grep -q '"status"[[:space:]]*:[[:space:]]*"Accepted"' "$output"
  rm -f "$output"
}
