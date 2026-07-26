#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PARTYPARTY_APP_STORE=1
exec "$PWD/scripts/build-app.sh"
