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

# A restart empties the origin's rooms. The Mac heals everything within a couple
# of seconds (the room epoch triggers a full re-send), but native players that
# 404 mid-stream treat it as fatal, so guests mid-party still get kicked to a
# reload. Deploying under a live party once did exactly that during
# verification. So: a live room defers the deploy unless the operator insists.
if [[ "${PPORIGIN_FORCE:-}" != "1" ]]; then
  LIVE="$(ssh_run "curl -fsS --max-time 5 -k https://127.0.0.1/__pp/health" 2>/dev/null || true)"
  if [[ -n "$LIVE" && "$LIVE" != *'"rooms":0'* ]]; then
    echo "!! a party is live on the origin right now: $LIVE" >&2
    echo "!! deploy refused; re-run with PPORIGIN_FORCE=1 to kick the guests anyway" >&2
    exit 75
  fi
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BUILD_DIR="build/origin"
mkdir -p "$BUILD_DIR"

echo "==> building linux/arm64 (the box is aarch64)"
# Static, so the binary does not care what libc the box ships.
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags "-s -w" -o "$BUILD_DIR/pporigin" ./cmd/pporigin
echo "    $(ls -lh "$BUILD_DIR/pporigin" | awk '{print $5}')"

# The service file is a template: it references ${VAR} names that systemd
# resolves from /etc/pporigin.env at start. An unset name expands to an EMPTY
# STRING, not to an error, and every one of those flags changes what the origin
# does:
#
#   -broker ""       disables broker lookup, so with no -rooms the origin
#                    authenticates NOBODY and 403s every Mac's publish
#   -base-domain ""  stops routing by Host label
#   -cert "" -key "" drops TLS
#
# None of that fails a health check. The process comes up, answers
# /__pp/health with 200, and is completely unable to serve a party. Checked here
# because it was nearly shipped: on 2026-09-11 the service file had moved from
# -rooms to -broker ${PPORIGIN_BROKER} while the box's env file, untouched since
# July, had no PPORIGIN_BROKER in it at all.
echo "==> checking the box's environment against the service file"
required_vars="$(grep -oE '\$\{[A-Z_]+\}' deploy/origin/pporigin.service | tr -d '${}' | sort -u)"
# Read the box's key list once and compare here, rather than building a remote
# loop out of local variables and getting the quoting wrong.
present="$(ssh_run "sudo grep -oE '^[A-Z_]+=.+' /etc/pporigin.env 2>/dev/null | cut -d= -f1 | sort -u" || true)"
missing=""
for v in $required_vars; do
  printf '%s\n' "$present" | grep -qx "$v" || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "!! /etc/pporigin.env is missing values the service file needs:$missing" >&2
  echo "!! systemd expands an unset name to an empty string, so deploying now would" >&2
  echo "!! start the origin with those flags EMPTY and it would still pass its health" >&2
  echo "!! check. Add them to /etc/pporigin.env (see deploy/origin/pporigin.env.example)" >&2
  echo "!! and re-run." >&2
  exit 78
fi
echo "    present: $(echo $required_vars | tr '\n' ' ')"

echo "==> uploading release $STAMP"
# /opt is root-owned; take ownership once so every later deploy is unprivileged.
ssh_run "sudo install -d -o \$(id -un) -g \$(id -gn) $REMOTE_ROOT $REMOTE_ROOT/releases
         mkdir -p $REMOTE_ROOT/releases/$STAMP"
scp -q -o BatchMode=yes "$BUILD_DIR/pporigin" "$HOST:$REMOTE_ROOT/releases/$STAMP/pporigin"
scp -q -o BatchMode=yes deploy/origin/pporigin.service "$HOST:/tmp/pporigin.service"
scp -q -o BatchMode=yes deploy/origin/chiptunes-deprioritize.conf "$HOST:/tmp/chiptunes-deprioritize.conf"

echo "==> activating"
ssh_run "set -e
  chmod +x $REMOTE_ROOT/releases/$STAMP/pporigin

  # Keep only the last five releases so /opt does not grow forever.
  cd $REMOTE_ROOT/releases && ls -1t | tail -n +6 | xargs -r rm -rf

  sudo install -m 0644 /tmp/pporigin.service /etc/systemd/system/pporigin.service

  # PartyParty outranks the radio and the video encode under contention.
  # set-property applies the cgroup weights to the RUNNING units immediately and
  # persists them, so a live 24/7 radio is never restarted to pick this up.
  # Restarting it here would interrupt the very service we are trying to be a
  # good neighbour to.
  for unit in rrr-stream rrr-youtube; do
    if systemctl list-unit-files | grep -q \"^\$unit.service\"; then
      sudo systemctl set-property \$unit.service CPUWeight=20 IOWeight=50 2>/dev/null || true
    fi
  done

  ln -sfn $REMOTE_ROOT/releases/$STAMP $REMOTE_ROOT/current
  sudo systemctl daemon-reload
  sudo systemctl enable --now pporigin
  sudo systemctl restart pporigin"

echo "==> health check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ssh_run "curl -fsS --max-time 5 -k https://127.0.0.1/__pp/health" 2>/dev/null; then
    echo
    # Health only proves the process is up. It says nothing about whether the
    # origin can authenticate a publish, which is the one thing a party needs
    # and the first thing a bad environment breaks. An unauthenticated PUT must
    # come back 403: a 200 would mean anyone can publish into any room, and a
    # connection error would mean TLS never came up.
    echo "==> publish auth check"
    auth_code="$(ssh_run "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -k -X PUT --data-binary x https://127.0.0.1/r/deploy-probe/probe.txt" 2>/dev/null || true)"
    if [ "$auth_code" != "403" ]; then
      echo "!! an unauthenticated publish answered $auth_code, expected 403" >&2
      echo "!! the origin is up but is not authenticating publishes correctly; rolling back" >&2
      "$0" --rollback
      exit 1
    fi
    echo "    unauthenticated publish correctly refused (403)"
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
