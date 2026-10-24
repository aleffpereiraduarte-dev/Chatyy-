#!/bin/bash
# [cbin 2026-10-24] Testa services/cbin.js contra os vetores do Go (chatyy-ws/cbin): decode/encode cruzados, lixo, fuzz.
# Uso: bash tests/cbin/run.sh   (node ≥ 18; não precisa de build)
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
sed "s#from './cbinDict'#from './cbinDict.mjs'#" "$R/services/cbin.js" > "$T/cbin.mjs"
cp "$R/services/cbinDict.js" "$T/cbinDict.mjs"; cp "$R/tests/cbin/run.mjs" "$T/run.mjs"
node "$T/run.mjs" "$R/tests/cbin/vectors-v1.json"
