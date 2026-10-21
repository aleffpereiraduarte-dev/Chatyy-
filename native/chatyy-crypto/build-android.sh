#!/usr/bin/env bash
# WP-02 — Android: libchatyy_crypto.so (arm64-v8a, armeabi-v7a, x86_64; páginas de 16 KB) +
# bindings Kotlin (UniFFI, pacote com.chatyy.crypto.core) + AAR só de jniLibs.
#
#   bash native/chatyy-crypto/build-android.sh [--install <modulo-expo>]
#   CHATYY_CRYPTO_CORE=prova bash native/chatyy-crypto/build-android.sh   # núcleo temporário
#
# Saída (local FIXO que WP-03 importa):
#   dist/android/jniLibs/<abi>/libchatyy_crypto.so
#   dist/android/chatyy-crypto-jni.aar
#   dist/bindings/kotlin/com/chatyy/crypto/core/chatyy_crypto.kt
# --install <dir>: copia jniLibs para <dir>/android/src/main/jniLibs e o .kt para
#   <dir>/android/src/main/java (ex.: modules/expo-chatyy-crypto, dono WP-03).
# Requer: ANDROID_NDK_HOME (NDK r27), cargo-ndk 3.5.x. No US roda com CPU limitada.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/ci/env.sh"

INSTALL=""
while [ $# -gt 0 ]; do case "$1" in --install) INSTALL="$2"; shift 2 ;; *) cc_die "arg desconhecido: $1" ;; esac; done

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  for d in "${ANDROID_NDK_LATEST_HOME:-}" /opt/android-sdk/ndk/27.1.12297006 "${ANDROID_HOME:-/none}/ndk/27.1.12297006"; do
    [ -n "$d" ] && [ -d "$d" ] && { export ANDROID_NDK_HOME="$d"; break; }
  done
fi
[ -d "${ANDROID_NDK_HOME:-}" ] || cc_die "ANDROID_NDK_HOME não definido (NDK r27)"
command -v cargo-ndk >/dev/null || cargo install cargo-ndk --version "$CC_CARGO_NDK_VERSION" --locked
cc_toolchain aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cc_log "NDK=$ANDROID_NDK_HOME target=$CARGO_TARGET_DIR"

OUT="$CHATYY_CRYPTO_DIST/android"
JNI="$OUT/jniLibs"
rm -rf "$OUT"; mkdir -p "$JNI"

# Android 15+/Play exigem segmentos LOAD alinhados a 16 KB; NDK r27 ainda linka 4 KB.
# RUSTFLAGS (e não CARGO_TARGET_*_RUSTFLAGS) porque RUSTFLAGS anula os por-alvo.
export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 $CC_REMAP"
# (cargo-ndk passa o próprio --manifest-path: roda de dentro da crate)
( cd "$CC_SRC_DIR" && cc_heavy cargo ndk --platform "$CC_ANDROID_API" $(printf -- '-t %s ' "${CC_ANDROID_ABIS[@]}") -o "$JNI" \
  build --release --lib --features uniffi -j "$JOBS" --locked )
unset RUSTFLAGS

RE="$(command -v llvm-readelf || ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-readelf | head -1)"
for abi in "${CC_ANDROID_ABIS[@]}"; do
  f="$JNI/$abi/lib$CC_LIB.so"
  [ -s "$f" ] || cc_die "$abi: $f não gerado"
  # cargo-ndk copia também libc++_shared se usado; o núcleo não deve precisar dele.
  bad="$("$RE" -lW "$f" | awk '$1=="LOAD"{print $NF}' | grep -v '^0x4000$' || true)"
  [ -z "$bad" ] || cc_die "$abi: segmento LOAD sem alinhamento 16 KB ($bad)"
  needed="$("$RE" -dW "$f" | awk '/NEEDED/{gsub(/[\[\]]/,"",$NF); print $NF}' | tr '\n' ' ')"
  sz="$(cc_size "$f")"; gz="$(gzip -9 -n -c "$f" | wc -c | tr -d ' ')"
  line="$abi: $(cc_human "$sz") ($sz B) gzip-9 $(cc_human "$gz") ($gz B) NEEDED: $needed"
  cc_log "$line"; echo "$line" >> "$OUT/size-report.txt"
  [ "$sz" -le "$CC_BUDGET_ANDROID_BYTES" ] || cc_budget "$abi: $(cc_human "$sz") > orçamento $(cc_human "$CC_BUDGET_ANDROID_BYTES") (sem compressão)"
done
echo "orçamento Android por ABI: $(cc_human "$CC_BUDGET_ANDROID_BYTES") (sem compressão)" >> "$OUT/size-report.txt"

KOUT="$CHATYY_CRYPTO_DIST/bindings/kotlin"
cc_bindgen kotlin "$KOUT"
KT="$KOUT/com/chatyy/crypto/core/chatyy_crypto.kt"
[ -s "$KT" ] || cc_die "bindings Kotlin ausentes ($KT)"
cc_log "kotlin: $(cc_size "$KT") B → ${KT#$CHATYY_CRYPTO_DIST/}"

# AAR mínimo (só jniLibs + manifesto) para quem preferir dependência binária. As classes
# Kotlin geradas são FONTE (o módulo do WP-03 compila junto, com JNA + coroutines).
AARD="$CARGO_TARGET_DIR/aar"; rm -rf "$AARD"; mkdir -p "$AARD/jni"
cp -R "$JNI/." "$AARD/jni/"
cat > "$AARD/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.chatyy.crypto.jni" />
XML
# classes.jar vazio = só o registro "fim do diretório central" do ZIP (22 bytes).
printf 'PK\005\006\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' > "$AARD/classes.jar"
( cd "$AARD"
  find . -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} + 2>/dev/null || true
  rm -f "$OUT/chatyy-crypto-jni.aar"
  find AndroidManifest.xml classes.jar jni -type f | LC_ALL=C sort | zip -q -X -D "$OUT/chatyy-crypto-jni.aar" -@ )
cc_log "aar: $(cc_human "$(cc_size "$OUT/chatyy-crypto-jni.aar")")"

if [ -n "$INSTALL" ]; then
  [ -d "$INSTALL" ] || cc_die "--install: $INSTALL não existe"
  mkdir -p "$INSTALL/android/src/main/jniLibs" "$INSTALL/android/src/main/java"
  cp -R "$JNI/." "$INSTALL/android/src/main/jniLibs/"
  cp -R "$KOUT/." "$INSTALL/android/src/main/java/"
  cc_log "instalado em $INSTALL"
fi
cc_manifest
cc_log "OK android → $OUT"
