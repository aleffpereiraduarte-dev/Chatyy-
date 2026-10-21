#!/usr/bin/env bash
# WP-02 — iOS: ChatyyCryptoCore.xcframework (ios-arm64 + ios-arm64_x86_64-simulator, staticlib)
# + bindings Swift (UniFFI, módulo ChatyyCryptoCore / FFI ChatyyCryptoCoreFFI).
# Só roda em macOS com Xcode.
#
#   bash native/chatyy-crypto/build-ios.sh [--install <modulo-expo>] [--no-x86]
#   CHATYY_CRYPTO_CORE=prova bash native/chatyy-crypto/build-ios.sh
#
# Saída (local FIXO que WP-03/WP-08 importam):
#   dist/ios/ChatyyCryptoCore.xcframework          (Headers: ChatyyCryptoCoreFFI.h + module.modulemap)
#   dist/ios/ChatyyCryptoCore.xcframework.zip      (para o release; sha256 no manifesto)
#   dist/bindings/swift/ChatyyCryptoCore.swift     (+ .h/.modulemap gerados)
#   dist/ios/size-report.txt                       (contribuição linkada no app e na NSE)
# O MESMO xcframework é linkado pelo app e pela NSE (staticlib → cada binário leva sua cópia;
# o passo "NSE" abaixo linka com -application-extension para pegar API proibida cedo).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/ci/env.sh"
[ "$(uname -s)" = Darwin ] || cc_die "build-ios.sh precisa de macOS + Xcode"

INSTALL=""; X86=1
while [ $# -gt 0 ]; do case "$1" in
  --install) INSTALL="$2"; shift 2 ;;
  --no-x86) X86=0; shift ;;
  *) cc_die "arg desconhecido: $1" ;; esac; done

TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim)
[ "$X86" = 1 ] && TARGETS+=(x86_64-apple-ios)
cc_toolchain "${TARGETS[@]}"
export IPHONEOS_DEPLOYMENT_TARGET="$CC_IOS_MIN"
cc_log "xcode: $(xcodebuild -version | head -1) target=$CARGO_TARGET_DIR"

export RUSTFLAGS="$CC_REMAP"
for t in "${TARGETS[@]}"; do
  cargo build --manifest-path "$CC_SRC_DIR/Cargo.toml" --release --lib --features uniffi --target "$t" -j "$JOBS" --locked
done
unset RUSTFLAGS

SOUT="$CHATYY_CRYPTO_DIST/bindings/swift"
cc_bindgen swift "$SOUT"
[ -s "$SOUT/ChatyyCryptoCore.swift" ] || cc_die "uniffi-bindgen não gerou ChatyyCryptoCore.swift"

HDR="$CARGO_TARGET_DIR/xcf-headers"; rm -rf "$HDR"; mkdir -p "$HDR"
cp "$SOUT/ChatyyCryptoCoreFFI.h" "$HDR/"
cp "$SOUT/ChatyyCryptoCoreFFI.modulemap" "$HDR/module.modulemap"

SIMLIB="$CARGO_TARGET_DIR/ios-sim-universal/lib$CC_LIB.a"; mkdir -p "$(dirname "$SIMLIB")"
SIMS=("$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/lib$CC_LIB.a")
[ "$X86" = 1 ] && SIMS+=("$CARGO_TARGET_DIR/x86_64-apple-ios/release/lib$CC_LIB.a")
lipo -create "${SIMS[@]}" -output "$SIMLIB"

OUT="$CHATYY_CRYPTO_DIST/ios"; rm -rf "$OUT"; mkdir -p "$OUT"
XCF="$OUT/ChatyyCryptoCore.xcframework"
xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/lib$CC_LIB.a" -headers "$HDR" \
  -library "$SIMLIB" -headers "$HDR" \
  -output "$XCF" >/dev/null
[ -f "$XCF/Info.plist" ] || cc_die "xcframework não criado"

# ---- tamanho real: quanto o núcleo acrescenta a um binário iOS arm64 (app e NSE) ----
SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
DEV="$XCF/ios-arm64"
W="$CARGO_TARGET_DIR/ios-size"; rm -rf "$W"; mkdir -p "$W"
SMOKE_SWIFT="$CC_CI_DIR/smoke/$CHATYY_CRYPTO_CORE/main.swift"   # main.swift = código de topo
printf 'print("vazio")\n' > "$W/base.swift"
# -dead_strip = DEAD_CODE_STRIPPING=YES (padrão do Xcode em Release); sem ele conta código morto.
LINK=(xcrun swiftc -O -sdk "$SDK" -target "arm64-apple-ios$CC_IOS_MIN" -module-name LinkProbe -Xlinker -dead_strip)
"${LINK[@]}" "$W/base.swift" -o "$W/base"
"${LINK[@]}" -I "$DEV/Headers" -Xcc -fmodule-map-file="$DEV/Headers/module.modulemap" \
  "$SOUT/ChatyyCryptoCore.swift" "$SMOKE_SWIFT" -L "$DEV" -l"$CC_LIB" -framework Security -o "$W/app"
# NSE: mesmo xcframework, com a regra de extensão (API proibida em extensão = erro de link).
"${LINK[@]}" -application-extension -I "$DEV/Headers" -Xcc -fmodule-map-file="$DEV/Headers/module.modulemap" \
  "$SOUT/ChatyyCryptoCore.swift" "$SMOKE_SWIFT" -L "$DEV" -l"$CC_LIB" -framework Security -o "$W/nse"
for b in base app nse; do xcrun strip -x "$W/$b" 2>/dev/null || true; done
B="$(cc_size "$W/base")"; A="$(cc_size "$W/app")"; N="$(cc_size "$W/nse")"
DELTA=$((A - B)); DELTA_NSE=$((N - B))
A_DEV="$(cc_size "$DEV/lib$CC_LIB.a")"
{
  echo "core=$CHATYY_CRYPTO_CORE git=$(git -C "$CC_REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo ?)"
  echo "staticlib ios-arm64 (.a, com bitcode/LTO objs): $(cc_human "$A_DEV") ($A_DEV B)"
  echo "contribuição linkada no app (arm64, strip -x): $(cc_human "$DELTA") ($DELTA B)"
  echo "contribuição linkada na NSE (-application-extension): $(cc_human "$DELTA_NSE") ($DELTA_NSE B)"
  echo "orçamento iOS: $(cc_human "$CC_BUDGET_IOS_BYTES")"
} | tee "$OUT/size-report.txt"
[ "$DELTA" -le "$CC_BUDGET_IOS_BYTES" ] || cc_budget "iOS: $(cc_human "$DELTA") > orçamento $(cc_human "$CC_BUDGET_IOS_BYTES")"

# zip determinístico para o release (o app baixa e confere o sha256 do manifesto)
find "$XCF" -exec touch -h -t "$(date -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || echo 202601010000)" {} + 2>/dev/null || true
( cd "$OUT" && find ChatyyCryptoCore.xcframework -type f | LC_ALL=C sort | zip -q -X -D ChatyyCryptoCore.xcframework.zip -@ )
cc_log "xcframework.zip: $(cc_human "$(cc_size "$OUT/ChatyyCryptoCore.xcframework.zip")")"

if [ -n "$INSTALL" ]; then
  [ -d "$INSTALL" ] || cc_die "--install: $INSTALL não existe"
  mkdir -p "$INSTALL/ios/Generated"
  rm -rf "$INSTALL/ios/ChatyyCryptoCore.xcframework"
  cp -R "$XCF" "$INSTALL/ios/"
  cp "$SOUT/ChatyyCryptoCore.swift" "$INSTALL/ios/Generated/"
  cc_log "instalado em $INSTALL"
fi
cc_manifest
cc_log "OK ios → $OUT"
