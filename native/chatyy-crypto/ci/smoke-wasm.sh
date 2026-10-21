#!/usr/bin/env bash
# Smoke wasm em Node: glue --target nodejs gerado pelo build-wasm.sh.
#   bash native/chatyy-crypto/ci/smoke-wasm.sh
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
D="$CHATYY_CRYPTO_DIST/wasm/node"
[ -s "$D/chatyy_crypto_bg.wasm" ] || cc_die "rode build-wasm.sh antes ($D)"
node "$CC_CI_DIR/smoke/$CHATYY_CRYPTO_CORE/smoke.mjs" "$D"
