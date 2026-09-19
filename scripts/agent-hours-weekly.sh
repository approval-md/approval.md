#!/bin/zsh
#
# Weekly refresh of metrics/agent-hours.json (APRV-373).
#
# The README badges read the metrics file on main, so the file has to be
# refreshed by something that does not depend on anyone remembering. This
# script is what launchd runs on Mondays: regenerate from origin/main and open
# a pull request that merges itself. It mirrors the records-log PR pattern,
# including the self-arming merge, so a stale badge is never one forgotten
# click away.
#
# It never checks anything out in the primary checkout. The primary's working
# tree is where the daemon writes the live log, and switching branches there
# would move `.approval/log/events.jsonl` underneath it. So all git work
# happens in a throwaway `git worktree` under a temp directory, detached at
# origin/main, and the primary's files are only ever read (the transcripts
# hang off its path, which is why `--repo` is passed explicitly).
#
# It refuses to run from a worktree of its own, because the primary path is
# what selects the transcripts and a worktree path would select nothing.
#
# --dry-run prints every git and gh command it would run without running the
# mutating ones. It still fetches and still regenerates the JSON (inside the
# temp worktree), so the diff summary it prints is the real one.
#
# Usage: zsh scripts/agent-hours-weekly.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print -- "usage: agent-hours-weekly.sh [--dry-run]"
      exit 0
      ;;
    *)
      print -u2 "agent-hours-weekly: unknown option: $arg"
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")/.."
ROOT="$PWD"

case "$ROOT" in
  (*/.claude/worktrees/*)
    print -u2 "agent-hours-weekly: refusing to run from a worktree ($ROOT)."
    print -u2 "agent-hours-weekly: run it from the primary checkout."
    exit 2
    ;;
esac

# Mutating steps go through this: echoed always, executed unless --dry-run.
run() {
  print -- "+ $*"
  if (( DRY_RUN )); then
    return 0
  fi
  "$@"
}

print -- "+ git fetch origin"
git fetch origin

DATE="$(date -u +%F)"
BRANCH="metrics-agent-hours-$DATE"
WT="$(mktemp -d -t agent-hours-wt)"

cleanup() {
  cd "$ROOT"
  if [[ -d "$WT" ]]; then
    git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  fi
  git worktree prune >/dev/null 2>&1 || :
}
trap cleanup EXIT

# The temp worktree is where every write lands. Detached, so no local branch
# exists until there is something worth committing.
print -- "+ git worktree add --detach $WT origin/main"
git worktree add --detach "$WT" origin/main >/dev/null

cd "$WT"
print -- "+ node scripts/agent-hours.mjs --repo $ROOT --json metrics/agent-hours.json"
node scripts/agent-hours.mjs --repo "$ROOT" --json metrics/agent-hours.json >/dev/null

# `generated_at` moves on every run, so it cannot be what decides whether
# anything actually changed. Everything else in the document can.
if diff -q \
  <(git show "origin/main:metrics/agent-hours.json" 2>/dev/null | grep -v '"generated_at"') \
  <(grep -v '"generated_at"' metrics/agent-hours.json) >/dev/null 2>&1; then
  print -- "unchanged: only the timestamp moved, so there is nothing to open a PR for."
  exit 0
fi

print -- "--- what changed ---"
git --no-pager diff --stat -- metrics/agent-hours.json || :

run git switch -c "$BRANCH"
run git add metrics/agent-hours.json
run git commit -m "metrics: weekly agent-hours refresh $DATE"
run git push -u origin "$BRANCH"
run gh pr create \
  --title "metrics: weekly agent-hours refresh $DATE" \
  --body "Automated refresh of metrics/agent-hours.json by scripts/agent-hours-weekly.sh. Only the metrics file changes."
run gh pr merge "$BRANCH" --auto --merge
