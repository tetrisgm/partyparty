#!/usr/bin/env bash
# Build the relay origin for the box and deploy it, idempotently.
#
# The origin holds no state on disk, so a deploy is a binary swap and a restart.
# Rollback is repointing one symlink, which is why this keeps the previous
# release rather than overwriting in place.
#
#   scripts/deploy-origin.sh              # build, upload, activate, health-check
#   scripts/deploy-origin.sh --rollback   # go back to the previous release
#
# Owner-gated prerequisites (once, see deploy/origin/README.md):
#   - Oracle VCN ingress rule allowing TCP 443
#   - iptables ACCEPT for 443, persisted
#   - wildcard certificate for the relay domain
#   - grey-clouded wildcard DNS record pointing at the box
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${PPORIGIN_HOST:-ubuntu@146.235.201.5}"
REMOTE_ROOT=/opt/pporigin
HEALTH_HOST="${PPORIGIN_HEALTH_HOST:-}"

ssh_run() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

if [[ "${1:-}" == "--rollback" ]]; then
  echo "==> rolling back to the previous release"
  ssh_run "set -e
    cd $REMOTE_ROOT/releases
    prev=\$(ls -1t | sed -n 2p)
    [ -n \"\$prev\" ] || { echo 'no previous release to roll back to'; exit 1; }
    ln -sfn $REMOTE_ROOT/releases/\$prev $REMOTE_ROOT/current
    sudo systemctl restart pporigin
    echo \"rolled back to \$prev\""
  exit 0
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BUILD_DIR="build/origin"
mkdir -p "$BUILD_DIR"

echo "==> building linux/arm64 (the box is aarch64)"
# Static, so the binary does not care what libc the box ships.
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags "-s -w" -o "$BUILD_DIR/pporigin" ./cmd/pporigin
echo "    $(ls -lh "$BUILD_DIR/pporigin" | awk '{print $5}')"

echo "==> uploading release $STAMP"
ssh_run "mkdir -p $REMOTE_ROOT/releases/$STAMP"
scp -q -o BatchMode=yes "$BUILD_DIR/pporigin" "$HOST:$REMOTE_ROOT/releases/$STAMP/pporigin"
scp -q -o BatchMode=yes deploy/origin/pporigin.service "$HOST:/tmp/pporigin.service"
scp -q -o BatchMode=yes deploy/origin/chiptunes-deprioritize.conf "$HOST:/tmp/chiptunes-deprioritize.conf"

echo "==> activating"
ssh_run "set -e
  chmod +x $REMOTE_ROOT/releases/$STAMP/pporigin

  # Keep only the last five releases so /opt does not grow forever.
  cd $REMOTE_ROOT/releases && ls -1t | tail -n +6 | xargs -r rm -rf

  sudo install -m 0644 /tmp/pporigin.service /etc/systemd/system/pporigin.service

  # partyparty outranks the radio and the video encode under contention.
  for unit in rrr-stream rrr-youtube; do
    if systemctl list-unit-files | grep -q \"^\$unit.service\"; then
      sudo mkdir -p /etc/systemd/system/\$unit.service.d
      sudo install -m 0644 /tmp/chiptunes-deprioritize.conf \
        /etc/systemd/system/\$unit.service.d/10-partyparty-priority.conf
    fi
  done

  ln -sfn $REMOTE_ROOT/releases/$STAMP $REMOTE_ROOT/current
  sudo systemctl daemon-reload
  sudo systemctl reload-or-restart rrr-stream rrr-youtube 2>/dev/null || true
  sudo systemctl enable --now pporigin
  sudo systemctl restart pporigin"

echo "==> health check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ssh_run "curl -fsS --max-time 5 -k https://127.0.0.1/__pp/health" 2>/dev/null; then
    echo
    echo "==> deployed $STAMP"
    if [[ -n "$HEALTH_HOST" ]]; then
      echo "==> public check via $HEALTH_HOST"
      curl -fsS --max-time 10 "https://$HEALTH_HOST/__pp/health" && echo
    fi
    exit 0
  fi
  sleep 2
done

echo "!! health check failed; rolling back" >&2
"$0" --rollback
exit 1
