# Contrato E2EE v5 — histórico

## e2ee5-contrato/1.7 — 22/10/2026 (keyreq + achados B1/B2 da matriz)
- §3 `chatyy.key_request` / `chatyy.room_key` (reservado ao núcleo); `chatyy.key_resend` obsoleto.
- §3 encaminhamento automático entre MEUS aparelhos: núcleo com `automatic-room-key-forwarding`
  (o texto antigo dizia que a biblioteca já pedia, mas a feature estava desligada — B2).
- §4.2.20 nomes aceitos no `e2ee5_metrics` (+`key_req_*`, `native_timeout`, `native_err`, `core_slow`,
  `key_request_sent/served/ok`); §4.2.21 `e2ee5_key_request`; §4.2.22 `e2ee5_key_request_check`;
  §4.2.23 `e2ee5_devices_former`; §4.3 `e2ee5_key_request_refused`; §4.5 limites.
- §6.4 `request_room_key` / `share_room_key`; §6.12 regras (servidor atesta membro na hora da
  mensagem + registro local de compartilhamento + índice mínimo).
- §6.5 `Trust::DeviceRemoved` ("enviada de um aparelho que não está mais conectado") e UTD
  `unverified_sender` NÃO retentável (B1: histórico de backup/vínculo de aparelho revogado).
- §6.9 `MetricsSnapshot.key_req_*`; §9 flag `__chatyy_e2ee5_keyreq`.

## e2ee5-contrato/1.6 — 21/10/2026 (WP-00, pedidos WP-07/WP-06b/WP-13)
- §2.5 `sender_uid` em toda linha/frame cifrado (PHP, hub, leaf, Rust); o cliente o usa no decrypt.
- §2.7 códigos `{"sys":…}` estruturados (member_*, admin_set, owner_transfer, group_updated, pin,
  disappearing, slow_mode, flags on/off, screenshot, meetup_update, call_scheduled…); campos de
  pessoa `*_uid`; o banco recusa system sem `{"sys":"` em conversa cifrada (DDL 008, P0E51).
- §4.2.19 `members[].email` (canônico).
- §5.4bis leaf `LEAF_E2EE5_LOCAL`, `REGIONAL_ACCEPT_E2EE(_MEDIA)` e `chat_send_rejected.data.code`.
- §3 `chatyy.call_sdp.gen` (geração da negociação / ICE restart).

## e2ee5-contrato/1.5 — 21/10/2026 (WP-00, a pedido do WP-16)
- §0.3bis: conversa `e2ee_mode=1` é privada INTEIRA para leitores do servidor (inclusive o texto
  antigo antes de `e2ee_since_pts`); resposta `e2ee5_server_read_refused` / frase da Bia.
- §4.6: `e2ee5x_translate` / `e2ee5x_transcribe` / `e2ee5x_summarize` / `e2ee5x_ask` (membro da
  conversa, `no_store: true` obrigatório, sem cache/log de conteúdo, kill `.e2ee5x-off`, erros `e2ee5x_*`).
- §4.6: denúncia por `mod_report` com `message_ids` + `evidence_texts`, marcada
  `source:"reporter_supplied_unverified"`; o envelope nunca entra na evidência.

## e2ee5-contrato/1.4 — 21/10/2026 (WP-09/WP-11)
- §2.8 novo: campos aditivos (`batch`, `M.lqip`, `M.poster` como objeto de mídia, `M.title`, `contacts[].avatar`,
  `t:"location_request"`).
- §2.8.2 reação cifrada: a coluna `emoji` guarda o PRÓPRIO envelope (`{"e2e":5…}` reação / `v{"e2e":5…}` estado) e
  `enc` também (no lugar de `emoji="e2e"`), para os agregadores atuais levarem a reação sem mudança; push genérico.
- §2.8.3 estados por pessoa como reação `rx_kind:"state"`: `poll_vote` (substitui a linha com `sys_hidden`),
  `meetup_rsvp` (substitui a tabela de RSVP do WP-07 F2), `live_loc` (posição ao vivo).
- §2.8.4/5 upload opaco (`context=e2e`, octet-stream, nome aleatório; reserva `chat_upload opaque=1`), recusa de
  mídia em claro em conversa E2EE, cache local do ciphertext + cópia de exibição descartável.
- §2.8.6 fora desta versão: visualização única de mídia, reação com figurinha, editar encontro, sessão de voz.

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
