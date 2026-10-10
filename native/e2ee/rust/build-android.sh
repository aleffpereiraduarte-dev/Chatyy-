#!/usr/bin/env bash
# E2EE v4 nativo — Android: .so (arm64-v8a, armeabi-v7a, x86_64) + bindings Kotlin.
#   bash native/e2ee/rust/build-android.sh [MODULE_DIR]
# MODULE_DIR = módulo Expo que recebe os artefatos (default: native/e2ee/expo-chatyy-e2ee).
# Requer: rustup targets aarch64-linux-android armv7-linux-androideabi x86_64-linux-android,
#         cargo-ndk 3.5.x, ANDROID_NDK_HOME (NDK 27.x).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="${1:-$HERE/../expo-chatyy-e2ee}"
MOD="$(cd "$MOD" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${RUNNER_TEMP:-/var/tmp}/chatyy-e2ee-target}"
cd "$HERE"
NICE=()
if command -v systemd-run >/dev/null 2>&1 && [ -z "${CI:-}" ]; then
  NICE=(systemd-run --scope -q -p CPUQuota=400% -p CPUWeight=20 -E CARGO_TARGET_DIR="$CARGO_TARGET_DIR" -E ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-}" nice -n 19)
fi
# Android 15+ / Play: páginas de 16 KB. NDK r27 ainda linka com 4 KB por padrão.
PAGE='-C link-arg=-Wl,-z,max-page-size=16384'
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$PAGE"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_RUSTFLAGS="$PAGE"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="$PAGE"
JNI="$MOD/android/src/main/jniLibs"
mkdir -p "$JNI"
"${NICE[@]}" cargo ndk --platform 24 -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$JNI" \
  build --release --lib -p chatyy-e2ee-native -j "${JOBS:-4}"
# bindings: gerados a partir da lib do HOST em perfil DEV — o release tem
# strip=symbols e o modo --library do UniFFI lê os símbolos UNIFFI_META_*
# (sem eles gera NADA, em silêncio).
"${NICE[@]}" cargo build --lib -p chatyy-e2ee-native -j "${JOBS:-4}"
"${NICE[@]}" cargo build -p uniffi-bindgen -j "${JOBS:-4}"
HOSTLIB="$CARGO_TARGET_DIR/debug/libchatyy_e2ee.so"
[ -f "$HOSTLIB" ] || HOSTLIB="$CARGO_TARGET_DIR/debug/libchatyy_e2ee.dylib"
OUT="$MOD/android/src/main/java"
"$CARGO_TARGET_DIR/debug/uniffi-bindgen" generate --library "$HOSTLIB" --language kotlin \
  --config "$HERE/uniffi.toml" --out-dir "$OUT" --no-format
test -f "$OUT/expo/modules/chatyye2ee/core/chatyy_e2ee.kt"
for abi in arm64-v8a armeabi-v7a x86_64; do
  f="$JNI/$abi/libchatyy_e2ee.so"; test -s "$f"
  if command -v llvm-readelf >/dev/null 2>&1 || [ -n "${ANDROID_NDK_HOME:-}" ]; then
    RE="$(command -v llvm-readelf || ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-readelf | head -1)"
    "$RE" -lW "$f" | awk '/LOAD/{print $NF}' | grep -qv '0x4000' && { echo "::error::$abi sem alinhamento 16 KB"; exit 1; }
  fi
  echo "$abi $(wc -c < "$f") bytes"
done
echo "OK android → $MOD"
