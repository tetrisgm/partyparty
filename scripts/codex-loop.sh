#!/usr/bin/env bash
# Autonomous Codex worker loop.
#
# Runs each task in codex/tasks/*.md in its OWN git worktree + branch
# (codex/<task>), up to MAX_PARALLEL at once. Codex builds/tests + commits per
# codex/AGENTS.md; this loop then pushes the branch for OWNER REVIEW. It never
# touches main and never deploys. Finished tasks move to codex/tasks/done/.
#
#   scripts/codex-loop.sh            # run all queued tasks
#   MAX_PARALLEL=2 scripts/codex-loop.sh
#   CODEX_SANDBOX=workspace-write scripts/codex-loop.sh   # more conservative
#
# Requires: codex on PATH, a clean-ish main, push access to origin.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DIR="$ROOT/codex/tasks"
DONE_DIR="$TASKS_DIR/done"
LOGS_DIR="$ROOT/codex/logs"
MAX_PARALLEL="${MAX_PARALLEL:-3}"
SANDBOX="${CODEX_SANDBOX:-danger-full-access}"
BASE="${CODEX_BASE:-main}"

run_one() {
  local tf="$1"
  local name wt branch
  name="$(basename "$tf" .md)"
  wt="$ROOT/../pp-codex-$name"
  branch="codex/$name"

  echo "[$name] $(date +%H:%M:%S) start"
  git -C "$ROOT" worktree remove --force "$wt" 2>/dev/null || true
  git -C "$ROOT" branch -D "$branch" 2>/dev/null || true
  if ! git -C "$ROOT" worktree add -B "$branch" "$wt" "$BASE" >/dev/null 2>&1; then
    echo "[$name] FAILED to create worktree"; return 1
  fi

  codex exec -s "$SANDBOX" -C "$wt" "$(cat "$tf")" >"$LOGS_DIR/$name.log" 2>&1 \
    || echo "[$name] codex exited non-zero (see codex/logs/$name.log)"

  if [ -n "$(git -C "$wt" log "$BASE"..HEAD --oneline 2>/dev/null)" ]; then
    if git -C "$wt" push -u origin "$branch" >/dev/null 2>&1; then
      echo "[$name] pushed branch $branch — review it"
      mkdir -p "$DONE_DIR" && mv "$tf" "$DONE_DIR/"
    else
      echo "[$name] committed but push failed — branch $branch kept locally"
    fi
  else
    echo "[$name] no commits produced — task left in queue (see log)"
  fi
  git -C "$ROOT" worktree remove --force "$wt" 2>/dev/null || true
}

# Re-entrant single-task mode (used by xargs to get real parallelism on bash 3.2).
if [ "${1:-}" = "--run-one" ]; then
  run_one "$2"
  exit $?
fi

command -v codex >/dev/null 2>&1 || { echo "codex not on PATH"; exit 1; }
mkdir -p "$DONE_DIR" "$LOGS_DIR"

shopt -s nullglob
tasks=("$TASKS_DIR"/*.md)
if [ "${#tasks[@]}" -eq 0 ]; then
  echo "No tasks in $TASKS_DIR (all done?). Drop a new codex/tasks/NN-name.md and re-run."
  exit 0
fi

echo "codex-loop: ${#tasks[@]} task(s), up to $MAX_PARALLEL in parallel, sandbox=$SANDBOX, base=$BASE"
printf '%s\0' "${tasks[@]}" | xargs -0 -P "$MAX_PARALLEL" -I{} bash "$0" --run-one "{}"
echo "codex-loop: done. Review with:  git branch -r | grep codex/"
