#!/bin/bash
# Pre-deploy syntax + duplicate-symbol check.
#
# Run this BEFORE committing/publishing OTA. Catches the bug class that
# bit us in OTA rounds 3 + 5: an agent re-declared an existing function
# or const, OTA export blew up after the bundle started, wasting Expo
# bandwidth + leaving CI red.
#
# Usage: bash scripts/predeploy-check.sh
# Exit 0 if everything looks healthy.

set -uo pipefail
cd "$(dirname "$0")/.."

red() { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

fail=0

echo "==> 1. node --check on all changed .js"
CHANGED=$(git diff --name-only HEAD --diff-filter=ACMR -- '*.js' | grep -v 'node_modules\|/dist/' || true)
if [ -z "$CHANGED" ]; then
  yellow "  (no .js files in pending diff — checking last commit instead)"
  CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD --diff-filter=ACMR -- '*.js' | grep -v 'node_modules\|/dist/' || true)
fi
for f in $CHANGED; do
  if [ -f "$f" ]; then
    if ! node --check "$f" 2>&1 >/dev/null; then
      red "  ✖ syntax error in $f"
      node --check "$f" 2>&1 | head -3 | sed 's/^/      /'
      fail=1
    fi
  fi
done
[ "$fail" = 0 ] && green "  ✓ all changed .js parse clean"

echo "==> 2. duplicate-symbol scan in services/api.js (catches dup export functions)"
DUPS=$(awk '/^export (async )?function /' services/api.js | sed -E 's/^export (async )?function ([a-zA-Z_$][a-zA-Z0-9_$]*).*/\2/' | sort | uniq -d)
if [ -n "$DUPS" ]; then
  red "  ✖ duplicate exports in services/api.js:"
  echo "$DUPS" | sed 's/^/      /'
  fail=1
else
  green "  ✓ no duplicate exports in services/api.js"
fi

echo "==> 3. (skipped — useState dup check too noisy; node --check catches real shadowing)"

echo "==> 4. PHP syntax check on api/*.php (changed only)"
PHP_CHANGED=$(git -C /var/www/mail diff --name-only HEAD --diff-filter=ACMR -- 'api/*.php' 2>/dev/null || true)
if [ -n "$PHP_CHANGED" ]; then
  while read -r f; do
    [ -z "$f" ] && continue
    full="/var/www/mail/$f"
    if [ -f "$full" ] && ! php -l "$full" >/dev/null 2>&1; then
      red "  ✖ PHP syntax error in $full"
      php -l "$full" 2>&1 | head -3 | sed 's/^/      /'
      fail=1
    fi
  done <<< "$PHP_CHANGED"
fi
green "  ✓ PHP files OK (or none changed)"

if [ "$fail" -ne 0 ]; then
  red "==> FAIL — fix issues above before publishing OTA"
  exit 1
fi

green "==> all checks passed — safe to OTA"
exit 0
