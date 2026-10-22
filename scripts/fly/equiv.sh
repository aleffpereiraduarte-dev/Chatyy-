#!/bin/sh
# scripts/fly/equiv.sh — [voar 2026-10-22] teste de equivalência JS↔PHP do motor do Brisa (1000 partidas).
set -e
D=$(dirname "$0"); N=${1:-1000}; S=${2:-20261022}
TMP=$(mktemp /tmp/fly-equiv-XXXXXX.json)
node "$D/gen-equiv.js" "$N" "$S" > "$TMP"
cp "$D/equiv.php" /tmp/fly-equiv.php
docker cp "$TMP" chatyy-php-fpm:/tmp/fly-equiv.json >/dev/null && docker cp /tmp/fly-equiv.php chatyy-php-fpm:/tmp/fly-equiv.php >/dev/null
docker exec chatyy-php-fpm php /tmp/fly-equiv.php /tmp/fly-equiv.json
rm -f "$TMP"
