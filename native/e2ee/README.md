# E2EE v4 nativo (vodozemac via Rust/UniFFI)

Desligado por padrão. Nada aqui entra no app até um build com `e2ee_native=true`.

- `rust/` crate `chatyy-e2ee-native`: mesma API e mesmo vodozemac (=0.11.1) do wasm
  (`/root/chatyy-e2ee-wasm`). `build-ios.sh` gera o xcframework e as bindings Swift (macOS).
  `build-android.sh` gera as `.so` (16 KB) e as bindings Kotlin.
- `expo-chatyy-e2ee/` módulo Expo `ChatyyE2EE` (Swift/Kotlin, handles). Fica FORA de
  `modules/` para não ser autolinkado. O CI move o módulo para `modules/` só com o input.
- `services/e2eeV4Native.js` adaptador com a forma do `V` do wasm. `services/e2eeV4Loader.js`
  usa o adaptador se o módulo existir (`services/e2eeV4.js` ainda só liga no web).

Testes (rodam no Linux, sem Mac):
    cd native/e2ee/rust && CARGO_TARGET_DIR=/var/tmp/chatyy-e2ee-target cargo test
    node native/e2ee/vectors/wasm-vectors.mjs check      # nativo → wasm
    node native/e2ee/vectors/wasm-vectors.mjs gen        # regenera wasm → nativo
    node native/e2ee/js-test/core-interop.mjs            # núcleo + adaptador ↔ web
CI: `.github/workflows/e2ee-core.yml` (manual) roda tudo isto, mais Kotlin/JVM e Swift/macOS.
Plano e próximos passos: /root/e2ee-nativo-plano.md
