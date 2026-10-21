# chatyy-crypto — núcleo E2EE v5 (WP-01)

Contrato: [`docs/e2ee/CONTRATO.md`](../../docs/e2ee/CONTRATO.md) (§6 = esta API).
Olm + Megolm da `matrix-sdk-crypto =0.18.0` (vodozemac 0.10), store SQLite cifrado
(`matrix-sdk-sqlite`, nativo) ou IndexedDB (`js`, web). Sem servidor Matrix: o servidor é o
`e2ee5.php`, falado pelo `HttpTransport` do host.

```
src/core.rs      CryptoCore: open, sync, encrypt/decrypt, to-device chatyy.*, membros, revogar, export/import
src/identity.rs  chave de conta (MSK/SSK/USK), assinar aparelho, número de segurança, verificar
src/link.rs      vínculo por QR (ECIES vodozemac CHATYY_LINK_V1): LinkWeb / LinkPhone
src/backup.rs    backup de chaves + secret storage (chave de recuperação 48 chars / Argon2id)
src/media.rs     anexos AES-256-CTR + SHA-256 (arquivo e bytes)
src/envelope.rs  {"e2e":5,"c":…} e invariantes do payload v1
src/requests.rs  pedidos da OlmMachine ↔ ações e2ee5_*
src/transport.rs HttpTransport (callback do host) e códigos de erro do servidor
tests/common/fake_server.rs  servidor falso = especificação executável do §4 (conformidade WP-05)
tests/integration.rs         cenários de ponta a ponta
examples/nse_mem.rs          memória/tempo do cenário NSE
fuzz/                        alvos cargo-fuzz (decrypt / decrypt_bytes)
```

## Testar (fora do horário de pico, baixa prioridade)
```bash
cd native/chatyy-crypto
systemd-run --scope -q -p CPUQuota=600% -p CPUWeight=20 nice -n 19 \
  env CARGO_TARGET_DIR=/var/tmp/chatyy-crypto-target cargo test --features testing -- --test-threads=4
# com bindings UniFFI (o WP-02 gera Swift/Kotlin a partir desta lib):
env CARGO_TARGET_DIR=/var/tmp/chatyy-crypto-target cargo build --features uniffi
# Android / wasm (checagem de compilação):
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build --release --features uniffi
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo build --target wasm32-unknown-unknown --no-default-features --features js
```

## Regras
- Versão FIXA `matrix-sdk-crypto =0.18.0` (store/pickle/fio). Atualizar só com vetores.
- `panic = "unwind"` no release (UniFFI vira exceção, não derruba o app/NSE).
- Nada de log com conteúdo, chave, pickle ou segredo. Erros não carregam conteúdo.
- Feature `testing` só para testes (atalho que pula o QR) — nunca em build de app.
