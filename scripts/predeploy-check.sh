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

echo "==> 3. missing icon imports (catches <IconFoo /> without import from Icons)"
# Catches the bug class from round 9: agent added <IconBookmark /> but forgot
# to add it to the multi-line `import { ... } from './Icons'` list. node --check
# doesn't catch this — it's runtime "Property X doesn't exist" on Hermes.
miss_fail=0
# Walk every .js under app/ and components/ — the IconBookmark bug could happen anywhere.
ICON_FILES=$(find app components -type f -name '*.js' 2>/dev/null | grep -v node_modules || true)
for f in $ICON_FILES; do
  [ -f "$f" ] || continue
  # Extract Icons import block: from start of `import` line that ends with from .../Icons
  # Use python3 for proper multi-line grouping.
  imports=$(python3 -c "
import re, sys
src = open('$f').read()
# match import { ... } from '.../Icons' OR \".../Icons\" (single + double quoted).
# Also accept Icons.js, ./components/Icons, ../components/Icons, etc.
m = re.findall(r'import\s*\{([^}]+)\}\s*from\s*[\"\\']([^\"\\']*Icons(?:\.js)?)[\"\\']', src)
names = set()
for blk, _src in m:
  for n in re.findall(r'\b(Icon[A-Z][A-Za-z0-9_]*)\b', blk):
    names.add(n)
print('\n'.join(sorted(names)))" 2>/dev/null)
  used=$(grep -oE '<Icon[A-Z][A-Za-z0-9_]+' "$f" | sed 's/^<//' | sort -u)
  # Locally available IconFoo names (function/const/let decls + destructured props
  # like `({ ..., IconCmp, ... })` where IconCmp is the prop name, not an import).
  local_decls=$(python3 -c "
import re
src = open('$f').read()
names = set()
# function IconFoo / const IconFoo / let IconFoo / var IconFoo
for m in re.finditer(r'\b(?:function|const|let|var)\s+(Icon[A-Z][A-Za-z0-9_]*)', src):
  names.add(m.group(1))
# any destructured params: ({ ... }) — covers arrows AND function decls
# (function Foo({ icon: IconCmp }) too — the colon-renamed form binds the rhs name)
for blk in re.findall(r'\(\s*\{([^{}]+)\}\s*\)', src):
  for n in re.findall(r'\b(Icon[A-Z][A-Za-z0-9_]*)\b', blk):
    names.add(n)
print('\n'.join(sorted(names)))" 2>/dev/null)
  for ico in $used; do
    if echo "$local_decls" | grep -qx "$ico"; then continue; fi
    if ! echo "$imports" | grep -qx "$ico"; then
      red "  ✖ $f uses <$ico /> but it's not in the Icons import"
      miss_fail=1
    fi
  done
done
[ "$miss_fail" = 0 ] && green "  ✓ all icon usages have imports" || fail=1

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
