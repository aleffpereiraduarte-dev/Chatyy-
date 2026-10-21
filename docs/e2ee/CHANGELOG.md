# Contrato E2EE v5 — histórico

## e2ee5-contrato/1.3 — 21/10/2026 (WP-00, a pedido do WP-07/WP-10)
- §4.3 códigos novos do chat.php: `e2ee5_server_read_refused` (409), `e2ee5_forward_client` (409),
  `e2ee5_forbidden` (403, rebaixar grupo sem ser admin).
- §5.2 prévia `reply_to` de pai cifrado: `content:""` + `reply_to.e2e: true`.
- §8.3 nota: ativação automática ainda não implementada (só `set:1` explícito).
- §8.4bis `chat_edit` aceita envelope por compatibilidade; oficial = linha nova com `edit_of`.
- §7 push: `e2e_np` ("1" oculta / "0" pode mostrar; ausente = oculta).
- §9 flags do App Group da NSE: `chatyy.e2ee5.push_decrypt.u.<uid>` e `…push_decrypt.kill`.
- §6.4 fila NSE→app no núcleo: eventos `chatyy.*` e conversas com chave nova consumidos em papel
  Push/Extension são entregues uma vez no próximo `sync()` do App/Web (núcleo 0.1.0 + este commit).

## e2ee5-contrato/1.2 — 21/10/2026 (WP-00, a pedido do WP-06a/WP-15)
- §5.3 caps de auth `e2ee5_ws`/`e2ee5_ns` (envelope pelo WS só com `e2ee5_ns`); frame WS de até
  160 KiB para contas e2ee5.
- §5.4 frame `chat_send_error {code, http, client_message_id, conversation_id, req_id}` com
  `e2ee5_plaintext_refused` / `e2ee5_not_e2ee` / `e2ee5_bad_request`; cliente não reenvia por HTTP.
- §5.5 avisos entregues no canal do e-mail canônico + alias `@onemundo.com.br`.
- §10 i18n: chaves `e2ee5.*` nos arquivos de idioma atuais (bloco `[e2ee5]`), não em
  `i18n/e2ee5/*.js` (incompatível com `build-i18n-json.js`).

## e2ee5-contrato/1.1 — 21/10/2026 (WP-00)
- §6.11: API JS do host (`services/crypto`) normativa — `proposta-host-api.md` do WP-04 aceita,
  com senha do store web (HMAC com CryptoKey não-exportável), web só com bytes (sem
  `encryptFile`), nomes do vínculo no celular (`linkAccept`/`linkPhonePoll`).
- §6.2: na web o `HttpTransport` não exige `Send + Sync`.
- §6.3: funções de mídia recebem bytes/strings por valor (UniFFI).

## e2ee5-contrato/1.0 — 21/10/2026 (WP-00)
- Primeira versão. Fixa: ids (§1), envelope `e2e:5` + payload v1 por tipo (§2), eventos
  `chatyy.*` (§3), 20 ações `e2ee5_*` com autorização, rate limits e códigos (§4), eventos WS
  `e2ee5_td`/`e2ee5_devices`/`conv_e2ee` (§5), API do núcleo (§6), push (§7), estados de
  conversa (§8), flags (§9), i18n (§10), conformidade (§11).
- Decisões do founder (21/10) incorporadas: D1 matrix-sdk-crypto; D2 IA/tradução só explícitas;
  D3 servidor não lê privadas; D4 web só por QR (exceção conta sem celular + backup obrigatório);
  D5 histórico completo (opção 3 meses); D6 Kids fora; D7 jogos/cartões fora; D8 versão mínima
  + revisão externa na F7.
- Diferença em relação ao WORK_PACKAGES: `to_device_pull`/`ack`/`device_changes` viraram uma
  ação só, `e2ee5_sync` (cursor = ack). As duas antigas ficam como aliases de depuração.
  Ações novas: `e2ee5_device_delete`, `e2ee5_devices_list`, `e2ee5_backup_version_delete`.
