# shellcheck shell=bash
# Ambiente comum dos scripts de build do núcleo (WP-02). `source` por build-*.sh.
#
# Variáveis que o chamador pode definir:
#   CHATYY_CRYPTO_CORE   real (default) | prova  — prova = núcleo temporário ci/prova-core
#   CHATYY_CRYPTO_DIST   saída (default native/chatyy-crypto/dist)
#   CARGO_TARGET_DIR     cache de compilação (default /var/tmp/chatyy-crypto-target[-prova])
#   JOBS                 paralelismo do cargo (default 6)
#   CHATYY_NO_NICE=1     não embrulhar em systemd-run (o CI já seta CI=true)
set -euo pipefail

CC_CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_CRATE_DIR="$(cd "$CC_CI_DIR/.." && pwd)"          # native/chatyy-crypto
CC_REPO_DIR="$(cd "$CC_CRATE_DIR/../.." && pwd)"     # raiz do repo

# ---- versões FIXAS (reprodutível; mudar = PR com vetores) ----
export CHATYY_RUST_TOOLCHAIN="${CHATYY_RUST_TOOLCHAIN:-1.95.0}"
export RUSTUP_TOOLCHAIN="$CHATYY_RUST_TOOLCHAIN"
CC_UNIFFI_VERSION="0.29.5"
CC_WASM_BINDGEN_VERSION="0.2.129"
CC_CARGO_NDK_VERSION="3.5.4"
CC_ANDROID_API="24"                 # minSdk do app = 26; 24 = margem igual ao v4
CC_IOS_MIN="15.1"                   # NSE/Pods; o app principal é 16.0
CC_KOTLIN_VERSION="2.1.21"
CC_JNA_VERSION="5.14.0"
CC_COROUTINES_VERSION="1.8.1"
CC_ANDROID_ABIS=(arm64-v8a armeabi-v7a x86_64)

# ---- orçamento de tamanho (WORK_PACKAGES WP-02) ----
CC_BUDGET_IOS_BYTES=$((8 * 1024 * 1024))        # contribuição linkada (dylib arm64 stripped)
CC_BUDGET_ANDROID_BYTES=$((5 * 1024 * 1024))    # por ABI (.so stripped)
CC_BUDGET_WASM_GZ_BYTES=$((5 * 512 * 1024))     # 2,5 MB gzip -9

# ---- qual núcleo ----
export CHATYY_CRYPTO_CORE="${CHATYY_CRYPTO_CORE:-real}"
case "$CHATYY_CRYPTO_CORE" in
  real)
    CC_SRC_DIR="$CC_CRATE_DIR"
    CC_PKG="chatyy-crypto"
    CC_WASM_DIR="$CC_REPO_DIR/vendor/chatyy-crypto-wasm/rust"   # ponte wasm-bindgen do WP-04
    CC_WASM_PKG="chatyy-crypto-wasm"
    CC_WASM_FEATURES=""
    CC_WASM_LIB="chatyy_crypto_wasm"
    ;;
  prova)
    CC_SRC_DIR="$CC_CI_DIR/prova-core"
    CC_PKG="chatyy-crypto-prova"
    CC_WASM_DIR="$CC_SRC_DIR"
    CC_WASM_PKG="chatyy-crypto-prova"
    CC_WASM_FEATURES="wasm"
    CC_WASM_LIB="chatyy_crypto"
    ;;
  *) echo "CHATYY_CRYPTO_CORE inválido: $CHATYY_CRYPTO_CORE" >&2; exit 2 ;;
esac
CC_LIB="chatyy_crypto"              # nome da lib nativa (staticlib/cdylib) nos dois núcleos

export CHATYY_CRYPTO_DIST="${CHATYY_CRYPTO_DIST:-$CC_CRATE_DIR/dist}"
mkdir -p "$CHATYY_CRYPTO_DIST"
CHATYY_CRYPTO_DIST="$(cd "$CHATYY_CRYPTO_DIST" && pwd)"
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  if [ -n "${RUNNER_TEMP:-}" ]; then CARGO_TARGET_DIR="$RUNNER_TEMP/chatyy-crypto-target"
  else CARGO_TARGET_DIR="/var/tmp/chatyy-crypto-target"; fi
  [ "$CHATYY_CRYPTO_CORE" = prova ] && CARGO_TARGET_DIR="$CARGO_TARGET_DIR-prova"
fi
export CARGO_TARGET_DIR
export CARGO_TERM_COLOR="${CARGO_TERM_COLOR:-never}"
JOBS="${JOBS:-6}"

# ---- reprodutibilidade: caminhos absolutos fora do binário ----
CC_REMAP="--remap-path-prefix=$CC_REPO_DIR=/chatyy --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$HOME/.rustup=/rustup"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$CC_REPO_DIR" log -1 --format=%ct 2>/dev/null || echo 0)}"

# ---- builds pesados: fora do CI, sempre com CPU limitada (regra do US) ----
cc_heavy() {
  if [ -z "${CI:-}" ] && [ -z "${CHATYY_NO_NICE:-}" ] && command -v systemd-run >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    systemd-run --scope -q -p CPUQuota=600% -p CPUWeight=20 nice -n 19 "$@"
  else
    "$@"
  fi
}

cc_log() { echo "[chatyy-crypto/$CHATYY_CRYPTO_CORE] $*"; }
cc_die() { echo "::error::$*" >&2; exit 1; }
# Estouro de orçamento: aviso (fica no size-report e no resumo do CI); CHATYY_SIZE_STRICT=1 falha.
cc_budget() { if [ "${CHATYY_SIZE_STRICT:-0}" = 1 ]; then cc_die "ORÇAMENTO: $*"; else echo "::warning::ORÇAMENTO: $*" >&2; fi; }

cc_sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
cc_size() { wc -c < "$1" | tr -d ' '; }
cc_human() { awk -v b="$1" 'BEGIN{ if (b>=1048576) printf "%.2f MB", b/1048576; else printf "%.1f KB", b/1024 }'; }

cc_toolchain() {
  # Instala a toolchain fixa (+ alvos pedidos) se faltar. Sem rede = usa o que tem.
  if ! rustup run "$CHATYY_RUST_TOOLCHAIN" rustc -V >/dev/null 2>&1; then
    rustup toolchain install "$CHATYY_RUST_TOOLCHAIN" --profile minimal
  fi
  local missing=()
  local installed; installed="$(rustup target list --installed --toolchain "$CHATYY_RUST_TOOLCHAIN")"
  for t in "$@"; do grep -qx "$t" <<<"$installed" || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || rustup target add --toolchain "$CHATYY_RUST_TOOLCHAIN" "${missing[@]}"
}

# Gera bindings Swift/Kotlin. GOTCHA do v4: o release tem strip=symbols e o modo --library do
# UniFFI lê os símbolos UNIFFI_META_* — com a lib stripped ele gera NADA, em silêncio. Por
# isso a fonte é a lib do HOST em perfil dev (mesmo código/features do release).
cc_host_lib_dev() {
  cc_heavy cargo build --manifest-path "$CC_SRC_DIR/Cargo.toml" --lib --features uniffi -j "$JOBS" --locked >&2
  local f
  for f in "$CARGO_TARGET_DIR/debug/lib$CC_LIB.so" "$CARGO_TARGET_DIR/debug/lib$CC_LIB.dylib"; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  cc_die "lib do host não encontrada em $CARGO_TARGET_DIR/debug"
}
cc_bindgen_bin() {
  local bt="$CARGO_TARGET_DIR/bindgen"
  CARGO_TARGET_DIR="$bt" cc_heavy cargo build --manifest-path "$CC_CI_DIR/uniffi-bindgen/Cargo.toml" --release -j "$JOBS" --locked >&2
  echo "$bt/release/uniffi-bindgen"
}
cc_bindgen() { # <swift|kotlin> <out-dir>
  local lang="$1" out="$2" lib bin
  lib="$(cc_host_lib_dev)"; bin="$(cc_bindgen_bin)"
  rm -rf "$out"; mkdir -p "$out"
  ( cd "$CC_SRC_DIR" && "$bin" generate --library "$lib" --language "$lang" --config "$CC_CI_DIR/uniffi.toml" --out-dir "$out" --no-format )
  local n; n="$(find "$out" -type f | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] || cc_die "uniffi-bindgen $lang gerou 0 arquivos (lib stripped? feature uniffi?)"
}

# Manifesto dist/manifest.json: sha256 + tamanho de cada artefato (o app confere antes de usar).
cc_manifest() {
  local m="$CHATYY_CRYPTO_DIST/manifest.json"
  local rev; rev="$(git -C "$CC_REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  ( cd "$CHATYY_CRYPTO_DIST"
    {
      printf '{\n  "core": "%s",\n  "git": "%s",\n  "toolchain": "%s",\n  "uniffi": "%s",\n  "wasm_bindgen": "%s",\n  "files": {\n' \
        "$CHATYY_CRYPTO_CORE" "$rev" "$CHATYY_RUST_TOOLCHAIN" "$CC_UNIFFI_VERSION" "$CC_WASM_BINDGEN_VERSION"
      first=1
      while IFS= read -r f; do
        [ $first = 1 ] || printf ',\n'; first=0
        printf '    "%s": {"sha256": "%s", "bytes": %s}' "${f#./}" "$(cc_sha256 "$f")" "$(cc_size "$f")"
      done < <(find . -type f ! -name 'manifest.json*' ! -path './release/*' | LC_ALL=C sort)
      printf '\n  }\n}\n'
    } > "$m.tmp" && mv "$m.tmp" "$m"
  )
  cc_log "manifesto → $m"
}
