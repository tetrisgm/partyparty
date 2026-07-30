#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${PP_VERSION:?set PP_VERSION to the next standalone version}"
: "${PP_BUILD:?set PP_BUILD to the next standalone build}"

./scripts/build-standalone.sh
./scripts/install-standalone-local.sh ./build/partyparty-beta.app
