#!/usr/bin/env bash
# WP-02 — Web: chatyy_crypto_bg.wasm + glue JS (wasm-bindgen) para o Web Worker do WP-04.
#
#   bash native/chatyy-crypto/build-wasm.sh [--install <dir>]
#   CHATYY_CRYPTO_CORE=prova bash native/chatyy-crypto/build-wasm.sh
#
# Núcleo real: compila a ponte wasm-bindgen do WP-04 (vendor/chatyy-crypto-wasm/rust, que
# depende de native/chatyy-crypto com a feature `js`). Prova: ci/prova-core --features wasm.
# Saída (local FIXO):
#   dist/wasm/web/chatyy_crypto.js + chatyy_crypto_bg.wasm (+ .d.ts)   --target web (worker)
#   dist/wasm/node/chatyy_crypto.js + chatyy_crypto_bg.wasm             --target nodejs (smoke/CI)
#   dist/wasm/no-modules/chatyy_crypto.js + chatyy_crypto_bg.wasm       --target no-modules (worker WP-04)
#   dist/wasm/size-report.txt
# --install <dir>: copia o no-modules com os nomes do WP-04 (chatyy_crypto_bg.wasm + chatyy_crypto_wasm.js).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/ci/env.sh"

INSTALL=""
while [ $# -gt 0 ]; do case "$1" in --install) INSTALL="$2"; shift 2 ;; *) cc_die "arg desconhecido: $1" ;; esac; done

[ -f "$CC_WASM_DIR/Cargo.toml" ] || cc_die "ponte wasm ausente: $CC_WASM_DIR (WP-04)"
cc_toolchain wasm32-unknown-unknown
WB="$(command -v wasm-bindgen || true)"
if [ -z "$WB" ] || ! "$WB" --version | grep -q " $CC_WASM_BINDGEN_VERSION\$"; then
  cc_log "instalando wasm-bindgen-cli $CC_WASM_BINDGEN_VERSION"
  cc_heavy cargo install wasm-bindgen-cli --version "$CC_WASM_BINDGEN_VERSION" --locked
  WB="${CARGO_HOME:-$HOME/.cargo}/bin/wasm-bindgen"
fi
# a versão do crate wasm-bindgen no lock TEM que bater com a CLI (senão o glue quebra)
LOCKV="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/"/,"",$3); print $3}' "$CC_WASM_DIR/Cargo.lock" 2>/dev/null | head -1)"
[ -z "$LOCKV" ] || [ "$LOCKV" = "$CC_WASM_BINDGEN_VERSION" ] || cc_die "wasm-bindgen do lock ($LOCKV) ≠ CLI ($CC_WASM_BINDGEN_VERSION)"

# getrandom 0.3 no navegador exige o cfg além da feature wasm_js.
export RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" $CC_REMAP"
FEAT=(); [ -n "$CC_WASM_FEATURES" ] && FEAT=(--features "$CC_WASM_FEATURES")
cc_heavy cargo build --manifest-path "$CC_WASM_DIR/Cargo.toml" --release --lib --target wasm32-unknown-unknown \
  "${FEAT[@]}" -j "$JOBS" --locked
unset RUSTFLAGS
RAW="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/$CC_WASM_LIB.wasm"
[ -s "$RAW" ] || cc_die "wasm não gerado: $RAW"

OUT="$CHATYY_CRYPTO_DIST/wasm"; rm -rf "$OUT"; mkdir -p "$OUT/web" "$OUT/node" "$OUT/no-modules"
"$WB" "$RAW" --out-dir "$OUT/web"  --out-name chatyy_crypto --target web    --typescript
"$WB" "$RAW" --out-dir "$OUT/node" --out-name chatyy_crypto --target nodejs --no-typescript
# no-modules = o que o worker do WP-04 carrega hoje (importScripts + wasm_bindgen(init))
"$WB" "$RAW" --out-dir "$OUT/no-modules" --out-name chatyy_crypto --target no-modules --no-typescript
if command -v wasm-opt >/dev/null 2>&1; then
  for d in web node no-modules; do
    wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
      "$OUT/$d/chatyy_crypto_bg.wasm" -o "$OUT/$d/chatyy_crypto_bg.opt.wasm"
    mv "$OUT/$d/chatyy_crypto_bg.opt.wasm" "$OUT/$d/chatyy_crypto_bg.wasm"
  done
  OPT="wasm-opt -Oz"
else
  OPT="sem wasm-opt"
fi
W="$OUT/web/chatyy_crypto_bg.wasm"
SZ="$(cc_size "$W")"; GZ="$(gzip -9 -n -c "$W" | wc -c | tr -d ' ')"
BR=""; command -v brotli >/dev/null && BR=" brotli=$(cc_human "$(brotli -q 11 -c "$W" | wc -c | tr -d ' ')")"
{
  echo "core=$CHATYY_CRYPTO_CORE git=$(git -C "$CC_REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo ?) ($OPT)"
  echo "wasm: $(cc_human "$SZ") ($SZ B) gzip-9: $(cc_human "$GZ") ($GZ B)$BR"
  echo "glue js: $(cc_size "$OUT/web/chatyy_crypto.js") B"
  echo "orçamento wasm gzip: $(cc_human "$CC_BUDGET_WASM_GZ_BYTES")"
} | tee "$OUT/size-report.txt"
[ "$GZ" -le "$CC_BUDGET_WASM_GZ_BYTES" ] || cc_budget "wasm gzip $(cc_human "$GZ") > orçamento"

if [ -n "$INSTALL" ]; then
  # nomes que o WP-04 usa em vendor/chatyy-crypto-wasm: chatyy_crypto_bg.wasm + chatyy_crypto_wasm.js
  mkdir -p "$INSTALL"
  cp "$OUT/no-modules/chatyy_crypto_bg.wasm" "$INSTALL/chatyy_crypto_bg.wasm"
  cp "$OUT/no-modules/chatyy_crypto.js" "$INSTALL/chatyy_crypto_wasm.js"
  cc_log "instalado em $INSTALL (rode vendor/chatyy-crypto-wasm/scripts/gen-worker-bundle.js do WP-04 depois)"
fi
cc_manifest
cc_log "OK wasm → $OUT"
