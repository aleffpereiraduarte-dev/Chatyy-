#!/usr/bin/env bash
# [e2ee5 WP-04] Gera o artefato web do núcleo chatyy-crypto:
#   vendor/chatyy-crypto-wasm/chatyy_crypto_bg.wasm      (asset do Metro, conferido por SHA-256 no worker)
#   vendor/chatyy-crypto-wasm/chatyy_crypto_wasm.js      (glue wasm-bindgen --target no-modules, referência)
#   vendor/chatyy-crypto-wasm/manifest.json              (sha256, tamanhos, versões)
#   services/crypto/worker/workerBundle.generated.js     (glue + worker.src.js como string)
# O app NÃO compila Rust no export/OTA: este script roda só quando o núcleo muda (WP-02 pode
# absorvê-lo no build-wasm.sh/CI). Builds pesados: CPU limitada + nice.
# Uso: vendor/chatyy-crypto-wasm/build.sh [--skip-cargo]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-/var/tmp/wp04/target}"
BINDGEN="${WASM_BINDGEN:-$(command -v wasm-bindgen || echo /var/tmp/wp04/tools/bin/wasm-bindgen)}"
WANT_BG="0.2.129"
"$BINDGEN" --version | grep -q "$WANT_BG" || { echo "wasm-bindgen-cli $WANT_BG necessário (cargo install wasm-bindgen-cli --version $WANT_BG --locked)"; exit 2; }

if [ "${1:-}" != "--skip-cargo" ]; then
  ( cd "$HERE/rust" && CARGO_TARGET_DIR="$TARGET_DIR" RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
      systemd-run --scope -p CPUQuota=400% -p CPUWeight=20 --quiet nice -n 19 \
      cargo build --release --locked --target wasm32-unknown-unknown )
fi
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
"$BINDGEN" --target no-modules --no-typescript --out-dir "$OUT" "$TARGET_DIR/wasm32-unknown-unknown/release/chatyy_crypto_wasm.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int -o "$OUT/opt.wasm" "$OUT/chatyy_crypto_wasm_bg.wasm" && mv "$OUT/opt.wasm" "$OUT/chatyy_crypto_wasm_bg.wasm"
fi
cp "$OUT/chatyy_crypto_wasm_bg.wasm" "$HERE/chatyy_crypto_bg.wasm"
cp "$OUT/chatyy_crypto_wasm.js" "$HERE/chatyy_crypto_wasm.js"
node "$HERE/scripts/gen-worker-bundle.js" "$HERE" "$APP"
