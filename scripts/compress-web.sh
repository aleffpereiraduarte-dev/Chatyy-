#!/usr/bin/env bash
# Compress static web assets with Brotli (quality 11) so nginx can serve
# pre-compressed .br files with zero CPU in the hot path. Run on the
# production host after `rsync dist/ → /var/www/mail/`.
#
# Saves ~80% on the main JS bundle vs gzip's ~65%. The quality-11 compression
# is slow (~minutes), but only runs once per deploy.
set -eu

ROOT=${1:-/var/www/mail}
if ! command -v brotli >/dev/null; then
  echo "brotli not installed, skipping" >&2
  exit 0
fi

count=0
while IFS= read -r -d '' f; do
  [ -f "${f}.br" ] && [ "${f}.br" -nt "$f" ] && continue
  brotli -q 11 -k -f "$f" 2>/dev/null && count=$((count + 1))
done < <(find "$ROOT" \
  -path "$ROOT/api" -prune -o \
  -path "$ROOT/data" -prune -o \
  -path "$ROOT/meet" -prune -o \
  -path "$ROOT/docs" -prune -o \
  -path "$ROOT/suporte" -prune -o \
  \( -name "*.js" -o -name "*.css" -o -name "*.html" -o -name "*.json" -o -name "*.svg" -o -name "*.wasm" \) \
  -type f -size +1k -print0)

echo "compressed $count files"
chown -R www-data:www-data "$ROOT/_expo" "$ROOT/assets" 2>/dev/null || true
