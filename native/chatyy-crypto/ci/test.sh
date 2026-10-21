#!/usr/bin/env bash
# cargo test do núcleo escolhido (real: com a feature `testing` = servidor falso do WP-01).
#   bash native/chatyy-crypto/ci/test.sh
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
cc_toolchain
FEAT="uniffi"; [ "$CHATYY_CRYPTO_CORE" = real ] && FEAT="uniffi,testing"
cc_heavy cargo test --manifest-path "$CC_SRC_DIR/Cargo.toml" --features "$FEAT" -j "$JOBS" --locked
