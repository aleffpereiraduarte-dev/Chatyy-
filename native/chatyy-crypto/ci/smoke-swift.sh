#!/usr/bin/env bash
# Smoke Swift (macOS): bindings Swift geradas + lib do host (dylib dev) — o mesmo código do
# xcframework. Usa async/await de verdade (runtime tokio do UniFFI).
#   bash native/chatyy-crypto/ci/smoke-swift.sh
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
[ "$(uname -s)" = Darwin ] || cc_die "smoke-swift.sh precisa de macOS"
LIB="$(cc_host_lib_dev)"
GEN="$CARGO_TARGET_DIR/smoke-swift/gen"; cc_bindgen swift "$GEN"
BIN="$CARGO_TARGET_DIR/smoke-swift/smoke"
swiftc -O -module-name SmokeCrypto -I "$GEN" -Xcc -fmodule-map-file="$GEN/ChatyyCryptoCoreFFI.modulemap" \
  -L "$(dirname "$LIB")" -l"$CC_LIB" "$GEN/ChatyyCryptoCore.swift" "$CC_CI_DIR/smoke/$CHATYY_CRYPTO_CORE/main.swift" -o "$BIN"
DYLD_LIBRARY_PATH="$(dirname "$LIB")" "$BIN"
