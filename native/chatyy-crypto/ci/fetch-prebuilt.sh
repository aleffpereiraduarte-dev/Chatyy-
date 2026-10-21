#!/usr/bin/env bash
# Usado pelos builds do APP (input chatyy_crypto=true): baixa o núcleo PRÉ-COMPILADO do release
# fixado em ci/prebuilt.lock, confere o sha256 e instala no módulo Expo (WP-03).
#   bash native/chatyy-crypto/ci/fetch-prebuilt.sh <ios|android|wasm> <dir-destino>
# ios     → <dir>/ios/ChatyyCryptoCore.xcframework + <dir>/ios/Generated/ChatyyCryptoCore.swift
# android → <dir>/android/src/main/jniLibs/<abi>/libchatyy_crypto.so + <dir>/android/src/main/java/com/chatyy/crypto/core/*.kt
# wasm    → <dir>/chatyy_crypto_bg.wasm + chatyy_crypto_wasm.js (no-modules, nomes do WP-04)
# Sem release fixado: falha, a menos que CHATYY_CRYPTO_BUILD_FALLBACK=1 (só build de TESTE),
# que compila da fonte com build-<plat>.sh.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
PLAT="${1:?ios|android|wasm}"; DEST="${2:?destino}"
mkdir -p "$DEST"; DEST="$(cd "$DEST" && pwd)"
LOCK="$CC_CI_DIR/prebuilt.lock"
# shellcheck disable=SC1090
TAG=""; source "$LOCK"
SUM_VAR="SHA256_$(echo "$PLAT" | tr a-z A-Z)"; WANT="${!SUM_VAR:-}"

if [ -z "$TAG" ] || [ -z "$WANT" ]; then
  [ "${CHATYY_CRYPTO_BUILD_FALLBACK:-0}" = 1 ] || cc_die "prebuilt.lock sem TAG/$SUM_VAR — rode o e2ee-core.yml com release=true e fixe o lock (ou CHATYY_CRYPTO_BUILD_FALLBACK=1 em build de teste)"
  cc_log "SEM pré-compilado: compilando da fonte (build de teste)"
  bash "$CC_CRATE_DIR/build-$PLAT.sh"
  SRC="$CHATYY_CRYPTO_DIST"
else
  ASSET="chatyy-crypto-$PLAT-${TAG#chatyy-crypto-v}.tar.gz"
  W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
  REPO="${GITHUB_REPOSITORY:-$(git -C "$CC_REPO_DIR" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')}"
  if command -v gh >/dev/null && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    gh release download "$TAG" -R "$REPO" -p "$ASSET" -D "$W"
  else
    curl -fsSL --retry 3 -o "$W/$ASSET" "https://github.com/$REPO/releases/download/$TAG/$ASSET"
  fi
  GOT="$(cc_sha256 "$W/$ASSET")"
  [ "$GOT" = "$WANT" ] || cc_die "sha256 de $ASSET não confere (lock=$WANT baixado=$GOT)"
  mkdir -p "$W/x"; tar -xzf "$W/$ASSET" -C "$W/x"; SRC="$W/x"
  cc_log "$ASSET ok (sha256 $GOT)"
fi

case "$PLAT" in
  ios)
    mkdir -p "$DEST/ios/Generated"; rm -rf "$DEST/ios/ChatyyCryptoCore.xcframework"
    cp -R "$SRC/ios/ChatyyCryptoCore.xcframework" "$DEST/ios/"
    cp "$SRC/bindings/swift/ChatyyCryptoCore.swift" "$DEST/ios/Generated/" ;;
  android)
    mkdir -p "$DEST/android/src/main/jniLibs" "$DEST/android/src/main/java"
    cp -R "$SRC/android/jniLibs/." "$DEST/android/src/main/jniLibs/"
    cp -R "$SRC/bindings/kotlin/." "$DEST/android/src/main/java/" ;;
  wasm)
    cp "$SRC/wasm/no-modules/chatyy_crypto_bg.wasm" "$DEST/chatyy_crypto_bg.wasm"
    cp "$SRC/wasm/no-modules/chatyy_crypto.js" "$DEST/chatyy_crypto_wasm.js" ;;
  *) cc_die "plataforma inválida: $PLAT" ;;
esac
cc_log "instalado ($PLAT) em $DEST"
