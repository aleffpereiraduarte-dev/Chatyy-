# E2EE v5 do Chatyy — documentação

- `CONTRATO.md` — **fonte da verdade** das interfaces (todos os WPs seguem).
- `DDL.sql` — proposta de esquema (não aplicada).
- `CHANGELOG.md` — versões do contrato.
- `exemplos/` — corpos JSON reais de cada ação, gerados pelos testes do núcleo
  (`CHATYY_WRITE_EXAMPLES=docs/e2ee/exemplos cargo test --features testing --test integration grava_exemplos`).
  Contêm só chaves públicas e ciphertext de contas de teste efêmeras.
- Núcleo: `native/chatyy-crypto` (README lá). Plano: `/root/e2ee-2026-10-21/PLANO.md`.
