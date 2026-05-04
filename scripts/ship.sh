#!/usr/bin/env bash
# ship.sh — single command that NEVER lets uncommitted work get left behind
#
# Why this exists: on 2026-05-04 we triggered an iOS build right after a fix
# but didn't commit the rest of the session's WIP. The build went out missing
# 138 files of polish/login/status/peek work. We had to scramble to commit
# and re-trigger. Don't repeat that.
#
# What it guarantees:
#   1. EVERYTHING in the working tree is committed before any deploy step
#   2. The commit message documents what's being deployed
#   3. Push only happens AFTER commit (atomic — same git state)
#   4. Build trigger file is touched in the SAME commit as the work
#   5. No silent skips: if anything looks fishy, abort with a clear error
#
# Usage:
#   scripts/ship.sh ios "fix: cold-start CallKit answer flow"
#   scripts/ship.sh ota "round 51 polish — 12 fixes"
#   scripts/ship.sh both "v2.5.0 — login redesign + call fix"
#
# Modes:
#   ios   — commit + push + touch ios-build trigger (TestFlight build, ~17min)
#   ota   — commit + push + run eas-cli update (over-the-air, ~3min)
#   both  — both at once
#
# Exit codes:
#   0  ok
#   1  not in git repo
#   2  missing args
#   3  uncommitted leftovers detected after auto-stage (sanity check failed)
#   4  push failed
#   5  build/OTA dispatch failed

set -euo pipefail

MODE="${1:-}"
MSG="${2:-}"

if [[ -z "$MODE" || -z "$MSG" ]]; then
  echo "usage: scripts/ship.sh <ios|ota|both> \"<commit message>\"" >&2
  exit 2
fi
case "$MODE" in
  ios|ota|both) ;;
  *) echo "mode must be one of: ios | ota | both" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository" >&2; exit 1
fi

echo "==> ship.sh mode=$MODE"
echo "==> Inspecting working tree"

# 1. Stage everything (modified, deleted, new). -A is intentional: we WANT
#    to bundle the entire WIP so the build matches what's running locally.
git add -A

# 2. Sanity check: nothing should be unstaged after `add -A`. If something
#    is, it's likely a permission issue or a submodule weirdness — abort
#    rather than push a half-state.
if ! git diff --quiet; then
  echo "ERROR: working tree still has unstaged changes after 'git add -A'" >&2
  echo "       This shouldn't happen. Inspect with 'git status' before retrying." >&2
  exit 3
fi

# 3. If the staging area is empty AND we're not just bumping triggers,
#    nothing to ship — bail with a friendly note.
if git diff --cached --quiet; then
  if [[ "$MODE" == "ota" ]]; then
    echo "no changes to commit; running OTA against current HEAD"
  else
    # For ios/both we still need to touch the trigger to fire a build
    echo "no source changes; bumping build trigger only"
  fi
fi

# 4. For ios/both, touch the trigger so the build workflow fires
if [[ "$MODE" == "ios" || "$MODE" == "both" ]]; then
  mkdir -p .github/triggers
  date -u +"%Y-%m-%dT%H:%M:%SZ" > .github/triggers/ios-build.txt
  git add .github/triggers/ios-build.txt
fi

# 5. Commit (skip empty commits — git will refuse anyway)
if ! git diff --cached --quiet; then
  git commit -m "$MSG"
  echo "==> Committed: $(git log -1 --format='%h %s')"
else
  echo "==> Nothing new to commit"
fi

# 6. Push. Rebase first to handle the OTA-publish workflow auto-bumping the
#    OTA trigger file (we've seen this race before — pull --rebase keeps the
#    push fast-forward).
echo "==> Pushing"
if ! git pull --rebase origin main 2>&1 | tail -5; then
  echo "ERROR: rebase failed" >&2; exit 4
fi
if ! git push origin main 2>&1 | tail -5; then
  echo "ERROR: push failed" >&2; exit 4
fi

# 7. Dispatch
if [[ "$MODE" == "ota" || "$MODE" == "both" ]]; then
  echo "==> Publishing OTA"
  if ! npx eas-cli update --branch production --environment production \
       --message "$MSG" --non-interactive 2>&1 | tail -8; then
    echo "ERROR: OTA publish failed" >&2; exit 5
  fi
fi

if [[ "$MODE" == "ios" || "$MODE" == "both" ]]; then
  echo "==> iOS build triggered via .github/triggers/ios-build.txt"
  echo "    Watch: https://github.com/aleffpereiraduarte-dev/Chatyy-/actions/workflows/ios-build-local.yml"
fi

echo "==> ship.sh DONE — everything committed and dispatched"
