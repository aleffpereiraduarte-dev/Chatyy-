#!/usr/bin/env bash
# chatyy-net (QUIC+Noise, protótipo ESCURO) — Android: libchatyy_net.so
# (arm64-v8a, armeabi-v7a, x86_64; segmentos LOAD de 16 KB; JNI cru, sem JNA/UniFFI).
#
#   bash native/chatyy-net/build-android.sh [--install modules/expo-chat-transport] [--test]
#
# Saída: native/chatyy-net/dist/android/jniLibs/<abi>/libchatyy_net.so + size-report.txt
# --install <dir>: copia para <dir>/android/src/main/jniLibs/ (gitignored no módulo; o
#   android-build-local.yml com chatyy_net=true libera só no runner, igual ao chatyy-crypto).
# --test: roda antes os testes do host (servidor de referência no loopback).
# Requer: rustup, ANDROID_NDK_HOME (NDK r27), cargo-ndk 3.5.x. NUNCA no US: worker NJ (10.8.0.12)
#   → `. /opt/chatyy-build/net-env.sh` ou o runner do GitHub.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
TOOLCHAIN="${CHATYY_RUST_TOOLCHAIN:-1.95.0}"   # mesma do chatyy-crypto (ci/env.sh)
CARGO_NDK_VERSION="3.5.4"
API=24
ABIS="arm64-v8a armeabi-v7a x86_64"
TARGETS="aarch64-linux-android armv7-linux-androideabi x86_64-linux-android"
BUDGET=$((3 * 1024 * 1024))                    # PLANO F-Q2: Android ≤ +3 MB/ABI
JOBS="${JOBS:-4}"
export RUSTUP_TOOLCHAIN="$TOOLCHAIN"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${RUNNER_TEMP:-/var/tmp}/chatyy-net-target}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$D" log -1 --format=%ct 2>/dev/null || echo 0)}"

log() { echo "[chatyy-net] $*"; }
die() { echo "::error::[chatyy-net] $*" >&2; exit 1; }

INSTALL=""; TEST=0
while [ $# -gt 0 ]; do case "$1" in
  --install) INSTALL="$2"; shift 2 ;;
  --test) TEST=1; shift ;;
  *) die "arg desconhecido: $1" ;;
esac; done

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  for d in "${ANDROID_NDK_LATEST_HOME:-}" /opt/android-sdk/ndk/27.1.12297006 "${ANDROID_HOME:-/none}/ndk/27.1.12297006"; do
    [ -n "$d" ] && [ -d "$d" ] && { export ANDROID_NDK_HOME="$d"; break; }
  done
fi
[ -d "${ANDROID_NDK_HOME:-}" ] || die "ANDROID_NDK_HOME não definido (NDK r27)"
rustup run "$TOOLCHAIN" rustc -V >/dev/null 2>&1 || rustup toolchain install "$TOOLCHAIN" --profile minimal
# shellcheck disable=SC2086
rustup target add --toolchain "$TOOLCHAIN" $TARGETS >/dev/null
command -v cargo-ndk >/dev/null || cargo install cargo-ndk --version "$CARGO_NDK_VERSION" --locked

# Builds pesados fora do CI: CPU limitada (regra da frota).
heavy() {
  if [ -z "${CI:-}" ] && command -v systemd-run >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    systemd-run --scope -q -p CPUQuota=400% -p CPUWeight=20 nice -n 19 "$@"
  else "$@"; fi
}

if [ "$TEST" = 1 ]; then
  ( cd "$D" && heavy cargo test --release --locked -j "$JOBS" )
fi

OUT="$D/dist/android"; JNI="$OUT/jniLibs"
rm -rf "$OUT"; mkdir -p "$JNI"
# 16 KB (Android 15+/Play); RUSTFLAGS anula os por-alvo → tudo aqui.
export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 --remap-path-prefix=$D=/chatyy-net --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
T_ARGS=""; for a in $ABIS; do T_ARGS="$T_ARGS -t $a"; done
# shellcheck disable=SC2086
( cd "$D" && heavy cargo ndk --platform "$API" $T_ARGS -o "$JNI" build --release --lib --locked -j "$JOBS" )
unset RUSTFLAGS

RE="$(command -v llvm-readelf || ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-readelf | head -1)"
: > "$OUT/size-report.txt"
for abi in $ABIS; do
  f="$JNI/$abi/libchatyy_net.so"
  [ -s "$f" ] || die "$abi: $f não gerado"
  bad="$("$RE" -lW "$f" | awk '$1=="LOAD"{print $NF}' | grep -v '^0x4000$' || true)"
  [ -z "$bad" ] || die "$abi: segmento LOAD sem alinhamento 16 KB ($bad)"
  needed="$("$RE" -dW "$f" | awk '/NEEDED/{gsub(/[\[\]]/,"",$NF); print $NF}' | tr '\n' ' ')"
  # Só libs do sistema (libandroid p/ android_setsocknetwork, libc/libm/libdl). Nada de libc++_shared.
  echo "$needed" | grep -q 'c++_shared' && die "$abi: depende de libc++_shared.so"
  jni="$("$RE" -sW --dyn-syms "$f" | grep -c 'Java_expo_modules_chatyytransport_ChatyyNetJni_' || true)"
  [ "$jni" -ge 10 ] || die "$abi: só $jni símbolos JNI exportados (esperado 10)"
  sz="$(wc -c < "$f" | tr -d ' ')"; gz="$(gzip -9 -n -c "$f" | wc -c | tr -d ' ')"
  line="$abi: $sz B ($((sz / 1024)) KB) gzip-9 $gz B ($((gz / 1024)) KB) NEEDED: $needed JNI: $jni"
  log "$line"; echo "$line" >> "$OUT/size-report.txt"
  [ "$sz" -le "$BUDGET" ] || echo "::warning::[chatyy-net] $abi: $sz B > orçamento $BUDGET B"
done
( cd "$JNI" && find . -name '*.so' | LC_ALL=C sort | xargs shasum -a 256 2>/dev/null || find . -name '*.so' | LC_ALL=C sort | xargs sha256sum ) > "$OUT/SHA256SUMS"

if [ -n "$INSTALL" ]; then
  [ -d "$INSTALL/android" ] || die "--install: $INSTALL/android não existe"
  mkdir -p "$INSTALL/android/src/main/jniLibs"
  for abi in $ABIS; do
    mkdir -p "$INSTALL/android/src/main/jniLibs/$abi"
    cp "$JNI/$abi/libchatyy_net.so" "$INSTALL/android/src/main/jniLibs/$abi/"
  done
  log "instalado em $INSTALL/android/src/main/jniLibs"
fi
log "OK → $OUT"
