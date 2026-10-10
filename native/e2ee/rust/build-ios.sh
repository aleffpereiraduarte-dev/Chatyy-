#!/usr/bin/env bash
# E2EE v4 nativo — iOS: ChatyyE2EECore.xcframework (device arm64 + simulador
# arm64/x86_64) + bindings Swift. Só roda em macOS com Xcode.
#   bash native/e2ee/rust/build-ios.sh [MODULE_DIR]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="${1:-$HERE/../expo-chatyy-e2ee}"
MOD="$(cd "$MOD" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${RUNNER_TEMP:-/tmp}/chatyy-e2ee-target}"
export IPHONEOS_DEPLOYMENT_TARGET=15.1   # mínimo do app/pods (o app principal é 16.0)
cd "$HERE"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios >/dev/null
for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --release --lib -p chatyy-e2ee-native --target "$t" -j "${JOBS:-6}"
done
# host dylib em perfil DEV → bindgen (o release tem strip=symbols e o modo
# --library do UniFFI precisa dos símbolos UNIFFI_META_*).
cargo build --lib -p chatyy-e2ee-native -j "${JOBS:-6}"
cargo build -p uniffi-bindgen -j "${JOBS:-6}"
GEN="$CARGO_TARGET_DIR/uniffi-swift"
rm -rf "$GEN" && mkdir -p "$GEN"
"$CARGO_TARGET_DIR/debug/uniffi-bindgen" generate --library "$CARGO_TARGET_DIR/debug/libchatyy_e2ee.dylib" \
  --language swift --config "$HERE/uniffi.toml" --out-dir "$GEN"
HDR="$CARGO_TARGET_DIR/xcf-headers"
rm -rf "$HDR" && mkdir -p "$HDR"
test -s "$GEN/ChatyyE2EECore.swift" || { echo "::error::uniffi-bindgen não gerou Swift"; exit 1; }
cp "$GEN/ChatyyE2EECoreFFI.h" "$HDR/"
cp "$GEN/ChatyyE2EECoreFFI.modulemap" "$HDR/module.modulemap"
SIM="$CARGO_TARGET_DIR/ios-sim-universal"
mkdir -p "$SIM"
lipo -create \
  "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libchatyy_e2ee.a" \
  "$CARGO_TARGET_DIR/x86_64-apple-ios/release/libchatyy_e2ee.a" \
  -output "$SIM/libchatyy_e2ee.a"
XCF="$MOD/ios/ChatyyE2EECore.xcframework"
rm -rf "$XCF"
xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libchatyy_e2ee.a" -headers "$HDR" \
  -library "$SIM/libchatyy_e2ee.a" -headers "$HDR" \
  -output "$XCF"
mkdir -p "$MOD/ios/Generated"
cp "$GEN/ChatyyE2EECore.swift" "$MOD/ios/Generated/ChatyyE2EECore.swift"
du -sh "$XCF"
echo "OK ios → $MOD"
