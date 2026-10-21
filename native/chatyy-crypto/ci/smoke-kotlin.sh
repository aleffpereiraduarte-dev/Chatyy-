#!/usr/bin/env bash
# Smoke Kotlin/JVM: bindings Kotlin geradas + JNA + kotlinx-coroutines, rodando contra a lib do
# HOST (Linux .so / macOS .dylib) — o mesmo código que vai no .so do Android.
#   bash native/chatyy-crypto/ci/smoke-kotlin.sh
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
TOOLS="${CHATYY_TOOLS_DIR:-${RUNNER_TOOL_CACHE:-/var/tmp}/chatyy-crypto-tools}"; mkdir -p "$TOOLS"
fetch() { [ -s "$TOOLS/$2" ] && return 0; curl -fsSL --retry 3 -o "$TOOLS/$2.tmp" "$1"; mv "$TOOLS/$2.tmp" "$TOOLS/$2"; }
fetch "https://github.com/JetBrains/kotlin/releases/download/v$CC_KOTLIN_VERSION/kotlin-compiler-$CC_KOTLIN_VERSION.zip" "kotlinc-$CC_KOTLIN_VERSION.zip"
fetch "https://repo1.maven.org/maven2/net/java/dev/jna/jna/$CC_JNA_VERSION/jna-$CC_JNA_VERSION.jar" "jna-$CC_JNA_VERSION.jar"
fetch "https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/$CC_COROUTINES_VERSION/kotlinx-coroutines-core-jvm-$CC_COROUTINES_VERSION.jar" "coroutines-$CC_COROUTINES_VERSION.jar"
KC="$TOOLS/kotlinc-$CC_KOTLIN_VERSION/kotlinc/bin/kotlinc"
[ -x "$KC" ] || { mkdir -p "$TOOLS/kotlinc-$CC_KOTLIN_VERSION" && unzip -q -o "$TOOLS/kotlinc-$CC_KOTLIN_VERSION.zip" -d "$TOOLS/kotlinc-$CC_KOTLIN_VERSION"; }
CP="$TOOLS/jna-$CC_JNA_VERSION.jar:$TOOLS/coroutines-$CC_COROUTINES_VERSION.jar"

LIB="$(cc_host_lib_dev)"
GEN="$CARGO_TARGET_DIR/smoke-kotlin/gen"; cc_bindgen kotlin "$GEN"
JAR="$CARGO_TARGET_DIR/smoke-kotlin/smoke.jar"
cc_heavy "$KC" -nowarn -cp "$CP" $(find "$GEN" -name '*.kt') "$CC_CI_DIR/smoke/$CHATYY_CRYPTO_CORE/Smoke.kt" -include-runtime -d "$JAR"
java -Djna.library.path="$(dirname "$LIB")" -cp "$JAR:$CP" SmokeKt
