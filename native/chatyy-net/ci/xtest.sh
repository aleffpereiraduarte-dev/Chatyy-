#!/usr/bin/env bash
# Teste CRUZADO cliente Rust/JNI ↔ leaf Go real (PROTOCOLO.md chatyy/1). Roda no worker NJ (10.8.0.12).
#   bash native/chatyy-net/ci/xtest.sh <dir-do-leaf-src> [kt-classes-dir]
# Copia o leaf (com vendor) p/ um temp, injeta xrust_test.go + xjni_test.go (usam o newQNEnv do
# quicnoise_test.go do servidor: fake hub, cert próprio, chave Noise de teste) e roda:
#   TestXRustProbe  — examples/probe: OPEN, auth_success, migração (rebind) vista pelo servidor,
#                     4001 go_ws p/ conta fora da allowlist, 0x102 noise_fail (chave/região errada)
#   TestXRustV2     — chatyy/2: frio 'I' (pin, frames na msg1, Accept c/ auth_success), pin errado,
#                     rotação, retomada 0-RTT 'E', queda p/ 'I' sem 0-RTT, medida c/ RTT 100 ms, PIN=0
#   TestXJniHarness — a superfície JNI REAL (ChatyyNetJni.class compilada do Kotlin) com a lib do host:
#                     parâmetros ruins → 0, envio/ack, migração, close, GONE, free duplo.
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
LEAF="${1:?dir do leaf src (ex.: /root/quic-noise-2026-10-23/leaf/src)}"
KT="${2:-}"
: "${CARGO_TARGET_DIR:=/var/tmp/chatyy-net-target}"; export CARGO_TARGET_DIR
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cp -a "$LEAF/." "$W/leaf/" 2>/dev/null || { mkdir -p "$W/leaf"; cp -a "$LEAF/." "$W/leaf/"; }
cp "$D/ci/xrust_test.go.in" "$W/leaf/xrust_test.go"
cp "$D/ci/xrust_v2_test.go.in" "$W/leaf/xrust_v2_test.go"
( cd "$D" && cargo build --release --locked --example probe --lib )
export RUST_PROBE="$CARGO_TARGET_DIR/release/examples/probe"
if [ -n "$KT" ] && command -v javac >/dev/null; then
  KS="$(find "${GRADLE_CACHE:-/home/ghrunner/.gradle/caches/modules-2/files-2.1}/org.jetbrains.kotlin/kotlin-stdlib" -name 'kotlin-stdlib-2*.jar' | grep -v sources | head -1)"
  mkdir -p "$W/j" && javac -cp "$KT" -d "$W/j" "$D/ci/JniMain.java"
  cp "$D/ci/xjni_test.go.in" "$W/leaf/xjni_test.go"
  export JNI_CP="$W/j:$KT:$KS" JNI_SO="$CARGO_TARGET_DIR/release/libchatyy_net.so"
fi
( cd "$W/leaf" && GOFLAGS=-mod=vendor GOTOOLCHAIN=local go test -run 'TestX(RustProbe|RustV2|JniHarness)' -count=1 -v . )
