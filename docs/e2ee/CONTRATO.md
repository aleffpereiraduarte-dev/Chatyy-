# Contrato E2EE v5 do Chatyy

| | |
|---|---|
| **Versão** | `e2ee5-contrato/1.1` (1.1.0) — 21/10/2026 (1.0 → 1.1: §6.11 API JS do host, aditivo) |
| **Dono** | WP-00 (líder/arquiteto). Mudanças só por PR neste arquivo + entrada em `CHANGELOG.md`. |
| **Implementação de referência** | `native/chatyy-crypto` (WP-01) e o servidor falso dos testes `native/chatyy-crypto/tests/common/fake_server.rs` (conformidade do WP-05). |
| **Base** | `/root/e2ee-2026-10-21/PLANO.md` + DECISÕES DO FOUNDER (21/10: todas as recomendações aprovadas, "nível WhatsApp"). |
| **Espelho** | `/root/e2ee-2026-10-21/spec/` aponta para esta pasta. |

Este documento fixa **tudo que dois pacotes precisam combinar**: ids, formatos, ações HTTP,
eventos WS, API do núcleo, push, estados de conversa, flags e i18n. Não há "a definir" nos
itens 2, 4, 5 e 6. O que está explicitamente fora do v1 está marcado **[fora do v1]**.

Documentos irmãos:
- `DDL.sql` — proposta de esquema (cópia em `/root/e2ee-2026-10-21/ddl/000-schema.sql`).
- `CHANGELOG.md` — histórico de versões do contrato.
- `exemplos/` — corpos JSON reais gerados pelos testes do núcleo (referência byte a byte).

---

## 0. Regras gerais e versionamento

1. **Três versões independentes**, todas numéricas e explícitas no fio:
   - envelope: `{"e2e":5,…}` — **5 é fixo** para todo o protocolo Olm/Megolm deste contrato.
     Mudança incompatível de envelope = `e2e:6` (e o app velho mostra "Atualize o Chatyy").
   - payload interno: campo `v` (hoje `1`). Campos novos são **aditivos**; o leitor ignora o
     que não conhece e **preserva** (não reescreve) o payload.
   - contrato: `e2ee5-contrato/MAJOR.MINOR`. MINOR = aditivo (campo, ação, evento novo).
     MAJOR = incompatível (exige versão mínima de app).
2. O núcleo informa `core_version()`; o servidor informa `contract` em `e2ee5_status`. Cliente
   com MAJOR diferente do servidor **não ativa** o E2EE (fica em texto, sem erro para o usuário).
3. **O servidor nunca lê conteúdo** de conversa `e2ee_mode=1`: nem para IA, busca, prévia,
   moderação, hashtags, tradução, transcrição, resumo ou push.
4. **Logs**: só ids (`conv_id`, `mid`, `device_id`, `session_id`), contagens e tamanhos. Nunca
   conteúdo, chave, pickle, segredo do QR, bearer, chave de recuperação, corpo de to-device.
5. **Falhar fechado**: falta de sodium, assinatura inválida, versão desconhecida, chave ausente
   ⇒ recusar (servidor) ou "aguardando"/"atualize" (cliente). Nunca cair para texto puro calado.
6. **Cripto só no núcleo** (`chatyy-crypto`). JS/Swift/Kotlin/PHP não implementam primitiva.
   Exceções permitidas: o PHP **verifica** assinaturas ed25519 (sodium) e o host gera bytes
   aleatórios para a senha do store (SecRandomCopyBytes / SecureRandom / crypto.getRandomValues).

---

## 1. Identidades e ids

### 1.1 `uid` (conta)
- Inteiro estável (`bigint`), emitido pelo servidor na tabela nova `e2ee5_uid`
  (`uid bigserial PK, email_canon text UNIQUE, created_at`). Criado na 1ª chamada `e2ee5_*`
  autenticada da conta.
- **E-mail canônico** (função PHP única `e2ee5CanonEmail()` no `e2ee5.php`):
  `strtolower(trim($e))`, depois `@onemundo.com.br` → `@chatyy.com.br`. Assim
  `apitest@onemundo.com.br ≡ apitest@chatyy.com.br` (mesmo uid). Outros domínios: como estão.
- Troca de e-mail (se um dia existir): o **uid fica**, só `email_canon` é atualizado
  (UPDATE administrativo). A identidade criptográfica não muda.
- O servidor traduz uid ↔ e-mail em todas as fronteiras: o núcleo e o fio E2EE **só** usam uid.
  O app pega os uids dos membros pela ação `e2ee5_conversation_state` (§4.2.19).

### 1.2 Ids internos do núcleo (nunca aparecem na UI)
| Coisa | Formato | Exemplo |
|---|---|---|
| usuário | `@u<uid>:chatyy` | `@u42:chatyy` |
| conversa (sala Megolm) | `!c<conv_id>:chatyy` (`conv_id` = `chat_conversations.id`) | `!c971:chatyy` |
| event_id usado na decifragem | `$m<chat_messages.id>` | `$m88123` |

`uid` e `conv_id` são decimais sem zero à esquerda (validados no núcleo).

### 1.3 `device_id`
- `^[PWTX][A-Z2-7]{12}$` (13 chars). Prefixo: `P` celular (principal ou não), `W` web,
  `T` tablet/desktop, `X` testes. Gerado por `new_device_id(prefix)` do núcleo **uma vez por
  instalação**.
- Persistência: iOS Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, access group
  compartilhado app+NSE+extensões, **sem** sincronizar com iCloud); Android
  `noBackupFilesDir` + EncryptedSharedPreferences; web IndexedDB do worker.
- **Reinstalar = aparelho novo** (device_id e store novos). O servidor aceita no máximo
  **1 celular principal + 4 vinculados** ativos por uid (`e2ee5_device_limit`).
- O servidor só aceita `keys_upload` para um device_id **novo** ou já do mesmo uid; device_id
  de outro uid ⇒ `e2ee5_device_conflict`.

### 1.4 Aparelho principal e chave de conta
- **Principal** = o aparelho que tem as privadas MSK/SSK/USK (criadas em `bootstrap_identity`
  no celular na ativação, ou restauradas do backup).
- Aparelhos vinculados recebem só: assinatura SSK do próprio aparelho + bearer vinculado +
  chaves Megolm de entrada (export). Não recebem MSK/SSK/USK privadas.
- Exceção D4: conta **sem celular** (só web) pode fazer `bootstrap_identity` na web; o app
  então **exige** ligar o backup (chave de recuperação) antes de ativar.

---

## 2. Envelope, payload interno e metadados

### 2.1 Envelope em `chat_messages.content`
```json
{"e2e":5,"c":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"…","session_id":"…","sender_key":"…","device_id":"…"}}
```
- Sempre começa exatamente com `{"e2e":` (sem espaço) — teste barato no PHP/Go/JS.
- `c` = conteúdo `m.room.encrypted` produzido pela OlmMachine, **sem alteração**. Os campos
  `sender_key`/`device_id` podem sumir em versões futuras da biblioteca; o leitor não depende
  deles (usa `session_id`).
- Tamanho: o servidor recusa envelope > **96 KiB** (`e2ee5_too_large`). Texto típico: 0,5–2 KiB.
- `{"e2e":N}` com `N != 5`: cliente mostra **"Mensagem protegida. Atualize o Chatyy para ler."**
  (`e2ee5.msg.update_to_read`). Este placeholder sai por OTA já na F0 (WP-08c), para N≥5
  enquanto o núcleo não estiver no binário.

### 2.2 Evento interno
Tipo Megolm interno **`chatyy.msg`** (cifrado; o servidor não vê). O conteúdo é o payload v1.
A biblioteca amarra o ciphertext à sala (`!c<conv>`): mover a mensagem para outra conversa
falha na decifragem. O núcleo também confere `payload.conv == conv_id` e
`payload.cmid == client_message_id` ⇒ senão `UTD{context_mismatch}`.

### 2.3 Payload v1 — campos comuns (obrigatórios em toda mensagem)
| Campo | Tipo | Regra |
|---|---|---|
| `v` | int | `1` |
| `t` | string | tipo fino (tabela 2.4), ≤ 32 chars |
| `conv` | string | `conv_id` decimal; = conversa de destino |
| `cmid` | string | = `client_message_id` em claro da linha (8–64 chars, UUID v4 recomendado) |
| `ts` | int | ms do relógio do remetente (informativo; ordem = servidor) |

Opcionais comuns (qualquer `t`):
| Campo | Tipo | Uso |
|---|---|---|
| `reply` | `{mid, cmid, sender_uid, quote, qt}` | citação: `mid` = id servidor do pai, `quote` ≤ 300 chars do texto citado, `qt` = `t` do pai |
| `mentions` | `[uid…]` | também em claro (§2.5) — a cópia cifrada é a fonte de verdade p/ renderizar |
| `mention_all` | bool | @todos |
| `fwd` | `{n}` | encaminhada (`n` = nº de encaminhamentos, ≥5 = "encaminhada com frequência") |
| `vo` | bool | visualização única (§2.4 mídia) |
| `ttl` | int s | mensagem temporária (o cliente apaga; o servidor apaga a linha pelo metadado da conversa) |
| `effect` | string | id do efeito de tela (`confetti`, `hearts`…) |
| `link_preview` | `{url, title, desc, site, img}` | `img` = objeto de mídia (§2.4.1) ou ausente |
| `via` | `"bia"` | resposta gerada pela Bia a pedido explícito (D2) |
| `x` | object | extensão livre versionada (`x.<pacote>`), ignorável |

### 2.4 Payload v1 — por tipo (`t`)
| `t` | Campos específicos | `type` em claro (2.5) |
|---|---|---|
| `text` | `body` (≤ 16 KiB UTF-8), `fmt?` (`"md"`) | `text` |
| `edit` | `edit_of` (mid servidor), `edit_of_cmid`, `body`, `media?` | `text` (a linha original não muda; a edição é linha nova com `edit_of` em claro, §2.5) |
| `reaction` | `target_mid`, `target_cmid`, `emoji` (≤ 16 chars) — **F2** | (vai em `chat_message_reactions` com o envelope no lugar do emoji; §2.7) |
| `image` | `media:[M]` (1 = foto, n = álbum), `caption?` | `image` |
| `video` | `media:[M]` com `dur`, `poster` (M), `caption?`, `round?` (vídeo-recado) | `video` |
| `gif` | `media:[M]` **ou** `ref:{pack,id,url}` (GIF público) | `image` |
| `sticker` | `media:[M]` **ou** `ref:{pack,id,url}`; `lottie?` | `image` |
| `voice` | `media:[M]` com `dur`, `waveform` (≤ 100 amostras 0–255, base64) | `audio` |
| `audio` | `media:[M]` com `dur`, `title?`, `artist?` | `audio` |
| `file` | `media:[M]` com `name`, `mime`, `size` | `file` |
| `location` | `lat`, `lng`, `acc?`, `name?`, `address?`, `live?:{until}` | `text` |
| `contact` | `contacts:[{name, phones:[], emails:[], uid?}]` | `text` |
| `poll` | `question`, `options:[{id,text}]` (2–12), `multi` bool, `anon` bool — **F2** | `text` |
| `poll_vote` | `poll_mid`, `poll_cmid`, `option_ids:[…]` (vazio = retirar) — **F2** | `text` (+ `sys_hidden` em claro: não aparece na lista) |
| `meetup` | `title`, `place?`, `desc?`, `start`, `end?`, `lat?`, `lng?` — **F2** | `text` |
| `delete` | — (não existe: "apagar para todos" é metadado, §2.5) | — |

**Objeto de mídia `M`** (2.4.1) — cada variante é um arquivo cifrado **separado**:
```json
{"kind":"image","url":"https://media.chatyy.com.br/e2e/AbC…","file":{MediaEncryptionInfo},
 "mime":"image/jpeg","size":123456,"w":1280,"h":960,"dur":null,"blurhash":"LEHV6n…",
 "thumbs":[{"kind":"t320","url":"…/e2e/…","file":{…},"w":320,"h":240,"size":9000}],
 "name":null}
```
- `file` = `MediaEncryptionInfo` do núcleo (`encrypt_file`/`encrypt_bytes` → `info_json`):
  `{"v":"v2","key":{"kty":"oct","alg":"A256CTR","ext":true,"k":"…","key_ops":["encrypt","decrypt"]},"iv":"…","hashes":{"sha256":"…"}}`.
- `url` sempre sob `e2e/<aleatório 22+ chars base64url>`, `Content-Type: application/octet-stream`.
- Variantes geradas **no cliente**: `t320` (≤320 px), tela (≤1280 px) = o próprio `M`, `poster`
  (vídeo), `blurhash`, `w/h/dur`, `waveform`. Original em resolução total opcional
  (`thumbs[].kind="orig"`). Sem HLS em E2EE.
- Visualização única: `vo:true` no payload; o cliente apaga a `file.key` local após ver e
  chama `chat_view_once_seen` (WP-07 apaga o blob).

### 2.5 Metadados em claro (os ÚNICOS permitidos em conversa E2EE)
| Coluna / campo | Valor | Por quê |
|---|---|---|
| `type` | `text` · `image` · `video` · `audio` · `file` · `system` (mapeamento da tabela 2.4) | aba de mídia, contadores, paginação |
| `client_message_id` | = `payload.cmid` | dedupe, ✓ otimista |
| `reply_to_id` | mid do pai (ou null) | navegação/contagem; a citação vai cifrada |
| `mentions` | lista de uids → o servidor converte para e-mails na coluna atual | push "mencionou você", gate @todos |
| `mention_all` | bool | push @todos |
| `has_link` | bool (cliente calcula) | aba "Links" do perfil |
| `edit_of` | mid editada (linha de edição) | versões/ordem |
| `deleted_for_all`, `pinned`, `starred`, recibos, reações (alvo) | como hoje | estado de metadado |
| tamanho do envelope, hora do servidor, remetente | como hoje | — |

**Nunca** em claro: texto, legenda, citação, nome de arquivo, URL de prévia, blurhash,
miniatura (`thumb_b64`), transcrição, tradução, coordenadas, opções de enquete, emoji de reação
(a partir da F2).

### 2.6 Limites
| Item | Limite |
|---|---|
| payload interno serializado | 64 KiB (`MAX_PAYLOAD_BYTES`) |
| envelope | 96 KiB (`MAX_ENVELOPE_BYTES`) |
| `body` texto | 16 KiB |
| arquivo de mídia (cada) | igual ao limite atual do upload (sem mudança) |
| to-device `chatyy.*` (conteúdo) | 32 KiB |
| membros com E2EE por conversa | 1024 (F2) |

### 2.7 Mensagens de sistema (não cifradas, sem texto livre)
`type='system'` com `content` JSON **fixo** `{"sys":"<código>", …ids}`. Isentas da imposição.
| `sys` | Campos | Quem grava |
|---|---|---|
| `e2ee_on` | `since_pts` | servidor, ao ativar |
| `e2ee_off` | `by_uid`, `reason` (`user`/`admin`/`kill`) | servidor, rebaixamento explícito |
| `e2ee_member_update` | `uid` | servidor ("Fulano precisa atualizar") — opcional |
| `call_card`, `game`, `watch_session`, `gift` | ids e números, sem texto livre (D7) | servidor/WP-16 |

"O código de segurança de X mudou" e "aparelho novo de X" são **locais** (gerados pelo cliente
a partir de `SyncResult.identity_changed_uids`), não vão ao servidor.

Reações F2: `chat_message_reactions.emoji` recebe `"e2e"` e a coluna nova `enc` recebe o
envelope `{"e2e":5,…}` com payload `t:"reaction"`. Prévia de push: "reagiu à sua mensagem".

---

## 3. Eventos to-device `chatyy.*` (cifrados Olm aparelho→aparelho)

Enviados com `CryptoCore.send_to_device(event_type, targets, content_json)`; chegam em
`SyncResult.chatyy_events` **somente** se o aparelho remetente é assinado pelo dono.
Todos têm `v:1`. Evento em claro com tipo `chatyy.*` é **descartado**.

| Tipo | Conteúdo | Uso / fase |
|---|---|---|
| `chatyy.call_key` | `{v, call_id, conv_id, key (b64 32 B), index (u32), ts}` | chave LiveKit E2EE por ligação; rotação = `index+1` (F5) |
| `chatyy.call_sdp` | `{v, call_id, kind: "offer"\|"answer"\|"candidate"\|"bye", sdp?, candidate?, mid?, mline?}` | P2P 1:1 DTLS-SRTP autenticado (F5) |
| `chatyy.draft` | `{v, conv_id, text, ts}` | sync de rascunho entre MEUS aparelhos (opcional) |
| `chatyy.decrypt_report` | `{v, conv_id, mid, session_id, reason, ts}` | "não consegui decifrar" → remetente reenvia chave (`rotate_conversation` + reenvio) |
| `chatyy.key_resend` | `{v, conv_id, session_id}` | pedido de reenvio de chave a outro membro (a biblioteca já pede aos MEUS aparelhos) |
| `chatyy.link.revoked` | `{v, device_id}` | celular avisa meus aparelhos que um vinculado saiu |
| `chatyy.read_sync` | **[fora do v1]** | — |

`targets`: lista `{uid, device_id}`; `device_id` vazio = todos os aparelhos **assinados** do uid.
O aparelho atual nunca recebe o próprio evento.

---

## 4. API HTTP do servidor de chaves (`e2ee5.php`, WP-05)

### 4.1 Convenções
- `POST /api/email.php?action=e2ee5_<nome>`; o `email.php` só faz
  `case 'e2ee5_…': require_once __DIR__.'/e2ee5.php'; handleE2EE5Action($action);`.
- Cabeçalhos: `Authorization: Bearer <token>`, `X-E2EE-Device: <device_id>`,
  `Content-Type: application/json`. Corpo = JSON. Exceções sem bearer: `link_create`,
  `link_post`(lado `w`), `link_poll`(lado `w`).
- Resposta = envelope atual do `email.php`: `{"success":true,"data":{…}}` ou
  `{"success":false,"data":{"code":"e2ee5_…"},"message":"…"}` com HTTP 4xx/5xx.
  **O `data` de sucesso é exatamente o JSON Matrix** descrito em cada ação (o núcleo parseia).
- Ids de usuário no fio: **sempre `@u<uid>:chatyy`**; o PHP converte para e-mail internamente.
- `X-E2EE-Device` é obrigatório nas ações de aparelho (`keys_*`, `sync`, `to_device_send`,
  `signatures_upload`). Após a F4, bearer vinculado ao aparelho (`auth_tokens.e2ee5_device`)
  **tem** de bater com o cabeçalho (`e2ee5_device_mismatch`).
- Escritas sempre no **master US**. Leituras podem ir à réplica com RYW pelo cursor (`sync`) —
  se `td_since`/`dc_since` > réplica, ler do master.
- Todas as ações respondem `e2ee5_disabled` (HTTP 403) se a conta não está na allowlist /
  coorte (`e2ee5_allow` + `E2EE5_PCT`), **exceto** `status`.

### 4.2 Ações

**4.2.1 `e2ee5_status`** — sempre disponível.
Req `{}` → `{"uid":"42","user_id":"@u42:chatyy","contract":"e2ee5-contrato/1.1","enabled":true,
"kill":false,"flags":{"e2ee5_native":true,"e2ee5_media":false,"e2ee5_calls":false,
"e2ee5_link":false,"e2ee5_backup":false,"e2ee5_push_decrypt":false},"device_limit":5,
"devices":[{"device_id":"P…","kind":"P","last_seen":1729500000000,"signed":true}],
"has_identity":true,"has_backup":false}`

**4.2.2 `e2ee5_keys_upload`** (Matrix `POST /keys/upload`)
Req `{"device_keys":{…}|null,"one_time_keys":{"signed_curve25519:AAAAAQ":{"key":"…","signatures":{…}}},"fallback_keys":{…}}`
→ `{"one_time_key_counts":{"signed_curve25519":50}}`.
Validação **obrigatória** (falhar fechado se `sodium` faltar ⇒ `e2ee5_no_sodium` 500):
- `device_keys.user_id` = chamador, `device_keys.device_id` = `X-E2EE-Device`;
- assinatura ed25519 do aparelho sobre o JSON canônico (§4.4) em `device_keys` e em **cada** OTK
  e fallback; `algorithms` ⊇ `["m.olm.v1.curve25519-aes-sha2","m.megolm.v1.aes-sha2"]`;
- device_keys de um device_id existente **não pode trocar** `ed25519`/`curve25519`
  (`e2ee5_device_key_changed`);
- máx. 100 OTKs não usadas por aparelho (excedente ignorado); 1 fallback ativo (substitui).
- Novo aparelho ⇒ evento em `e2ee5_device_changes` para o próprio uid e para todos que
  dividem conversa com ele + WS `e2ee5_devices` (§5).

**4.2.3 `e2ee5_keys_query`** (Matrix `POST /keys/query`)
Req `{"device_keys":{"@u7:chatyy":[],"@u42:chatyy":["PABC…"]}}`
→ `{"device_keys":{"@u7:chatyy":{"PXYZ…":{device_keys com signatures acumuladas}}},
"master_keys":{…},"self_signing_keys":{…},"user_signing_keys":{"@u42:chatyy":{…}},"failures":{}}`
- Autorização: cada uid pedido tem de ser o próprio ou **dividir ao menos uma conversa
  (membro ativo) ou ser contato**. Senão o uid vai em `failures` com `{"code":"forbidden"}`
  (não 403 — o resto da resposta continua).
- `user_signing_keys` **só do próprio** chamador.
- Lista vazia = todos os aparelhos ativos.
- Limite: 1024 uids por chamada (`e2ee5_too_many`).

**4.2.4 `e2ee5_keys_claim`** (Matrix `POST /keys/claim`)
Req `{"one_time_keys":{"@u7:chatyy":{"PXYZ…":"signed_curve25519"}}}`
→ `{"one_time_keys":{"@u7:chatyy":{"PXYZ…":{"signed_curve25519:AAAAAg":{…}}}},"failures":{}}`
- Mesma autorização do `keys_query`.
- **Anti-dreno**: por par (requisitante uid, aparelho alvo) no máx. **5 OTKs/hora**; acima
  disso devolve a **fallback key** (não consome). Por requisitante, no máx. 3.000
  aparelhos-alvo/hora (`e2ee5_rate_limited` 429).
- OTK entregue é apagada (`DELETE … RETURNING` atômico). Sem OTK ⇒ fallback. Sem nenhuma ⇒
  aparelho omitido (o núcleo trata).
- Em massa: 1 SELECT/DELETE por chamada, nunca 1 conexão por alvo. Meta: 2.000 alvos < 2 s.

**4.2.5 `e2ee5_signing_keys_upload`** (Matrix `/keys/device_signing/upload`)
Req `{"master_key":{…},"self_signing_key":{…},"user_signing_key":{…}}` → `{}`.
- 1ª vez: aceita (MSK auto-assinada pelo aparelho chamador; SSK e USK assinadas pela MSK —
  verificar ambos).
- Troca de MSK (reset de identidade, ex. celular novo sem backup): só do aparelho que vai ser o
  novo principal, **apaga as assinaturas antigas**, grava `e2ee5_device_changes` para todos os
  contatos (eles verão "código de segurança mudou").

**4.2.6 `e2ee5_signatures_upload`** (Matrix `/keys/signatures/upload`)
Req `{"@u42:chatyy":{"PABC…":{device_keys com nova assinatura}, "<msk_b64>":{master_key com assinatura}}}`
→ `{"failures":{}}`. Verifica cada assinatura com a SSK (aparelho próprio), USK (MSK de outro
usuário) ou chave do aparelho (MSK própria). Assinatura inválida ⇒ `failures[user][key] =
{"errcode":"M_INVALID_SIGNATURE"}`. Mescla em `signatures` (não substitui as outras).
Dispara `e2ee5_device_changes` do dono.

**4.2.7 `e2ee5_to_device_send`** (Matrix `PUT /sendToDevice`)
Req `{"event_type":"m.room.encrypted","txn_id":"…","messages":{"@u7:chatyy":{"PXYZ…":{…},"*":{…}}}}`
→ `{}`.
- Idempotente por (`remetente device`, `txn_id`) por 24 h.
- `"*"` = todos os aparelhos ativos do uid.
- Autorização: destino = próprio uid ou divide conversa/contato. Destino proibido é **ignorado
  em silêncio** (não revela existência).
- `event_type` aceito: `m.room.encrypted` (cifrado), `m.room_key_request`,
  `m.room_key.withheld`, `m.secret.request`. Qualquer outro em claro ⇒ `e2ee5_bad_event`.
- Grava 1 linha por aparelho destino em `e2ee5_to_device` com `sender` = `@u<uid>:chatyy` do
  chamador (o servidor **carimba**; o cliente não escolhe o remetente) e avisa via WS
  `e2ee5_td` (§5). Em massa: COPY/INSERT multi-linha. Meta: 2.000 destinos < 2 s.
- TTL 30 dias; tamanho máx. por mensagem 64 KiB; corpo total 4 MiB.

**4.2.8 `e2ee5_sync`** (substitui `to_device_pull` + `ack` + `device_changes` numa ida só)
Req `{"td_since":"<cursor|''>","dc_since":"<cursor|''>","limit":100}`
→ ```json
{"to_device":[{"type":"m.room.encrypted","sender":"@u7:chatyy","content":{…}}],
 "td_next":"9123","more":false,
 "device_lists":{"changed":["@u7:chatyy"],"left":[]},"dc_next":"5501",
 "one_time_key_counts":{"signed_curve25519":37},"unused_fallback_key_types":["signed_curve25519"]}
```
- `td_since` é o **ack**: o servidor apaga as linhas `id <= td_since` do aparelho (o núcleo só
  avança o cursor depois de processar e gravar). `limit` máx. 500. `more` = há mais.
- `device_lists.changed` = uids (que dividem conversa comigo, ou eu) com mudança de
  aparelho/assinatura/MSK desde `dc_since`. `left` = uids que deixaram de dividir conversa.
- Cursor vazio = início: `to_device` desde sempre (não lido), `device_lists` vazio e `dc_next`
  = posição atual.
- Aliases aceitos (para o WP-18 depurar): `e2ee5_to_device_pull` (= sync sem `device_lists`) e
  `e2ee5_device_changes` (= só `device_lists`). O núcleo usa só `sync`.

**4.2.9 `e2ee5_device_delete`** Req `{"device_id":"W…"}` → `{}`. Só do próprio uid; o
**principal** revoga qualquer vinculado; um vinculado só revoga a si mesmo (logout). Apaga
chaves/OTKs/fila, invalida o bearer vinculado, grava `device_changes`, WS `e2ee5_devices`.

**4.2.10 `e2ee5_devices_list`** Req `{}` → `{"devices":[{"device_id","kind","created_at",
"last_seen","signed","platform","label"}]}` (tela "Aparelhos vinculados"). `label` = texto
livre do cliente ("Chrome no Mac"), só metadado.

**4.2.11 `e2ee5_backup_version_create`** Req `{"algorithm":"m.megolm_backup.v1.curve25519-aes-sha2","auth_data":{"public_key":"…","signatures":{…}}}` → `{"version":"3"}`.
Uma versão ativa por uid (a anterior é desativada).
**4.2.12 `e2ee5_backup_version_get`** Req `{}` → `{"version","algorithm","auth_data","count","etag"}` ou 404 `e2ee5_no_backup`.
**4.2.13 `e2ee5_backup_version_delete`** Req `{"version"}` → `{}`.
**4.2.14 `e2ee5_backup_keys_put`** Req `{"version":"3","rooms":{"!c971:chatyy":{"sessions":{"<sid>":{"first_message_index":0,"forwarded_count":0,"is_verified":true,"session_data":{"ephemeral","ciphertext","mac"}}}}}}`
→ `{"etag":"…","count":123}`. Versão diferente da ativa ⇒ `e2ee5_wrong_backup_version` 403.
Regra de substituição Matrix: fica a de menor `first_message_index`.
**4.2.15 `e2ee5_backup_keys_get`** Req `{"version"}` → `{"rooms":{…}}` (mesmo formato).
Paginação [fora do v1]: limite 50.000 sessões por resposta.

**4.2.16 `e2ee5_secret_storage_put`** Req `{"key_id","key_info":{SecretStorageKeyEventContent},"argon2":{alg,salt,m,t,p}|null,"secrets":{"m.cross_signing.master":{"iv","ciphertext","mac"},…}}` → `{}`.
**4.2.17 `e2ee5_secret_storage_get`** Req `{}` → mesmo objeto ou 404 `e2ee5_no_backup`.
Rate limit: 10/h por uid (tentativas de restauração).

**4.2.18 Vínculo (rendezvous)** — TTL **2 min** desde `link_create`, prorrogado a cada post até
10 min no total; máx. 64 mensagens, 256 KiB cada.
- `e2ee5_link_create` (sem bearer; rate limit 20/h por IP) Req `{}` → `{"link_id":"<22 chars base64url>","expires_in":120}`.
- `e2ee5_link_post` Req `{"link_id","side":"p"|"w","seq":n,"data":"<opaco>"}` → `{}`. Lado `p`
  exige bearer (o servidor grava o uid do celular no link no 1º post); lado `w` sem bearer.
  `seq` estritamente crescente por lado (`e2ee5_link_seq`).
- `e2ee5_link_poll` Req `{"link_id","side":"p"|"w","after":n}` → `{"msgs":[{"seq","data"}],"state":"open"|"expired"}`.
  `side` = lado que **escreveu** as mensagens lidas. Ler o lado `w` exige o bearer do uid do link.
- `e2ee5_link_finish` (bearer do **principal**, mesmo uid do link) Req `{"link_id","device_id"}`
  → `{"bearer":"…"}`: emite bearer **vinculado ao aparelho** (`auth_tokens.e2ee5_device =
  device_id`, sem `password_enc`), pré-registra o device_id para o uid e conta no limite.

**4.2.19 `e2ee5_conversation_state`** Req `{"conv_id":"971"}` → `{"conv_id":"971",
"e2ee_mode":1,"since_pts":12345,"members":[{"uid":"7","capable":true},{"uid":"42","capable":true}],
"can_enable":true,"blocked_reason":null}`. `blocked_reason` ∈ `member_needs_update`,
`not_allowed`, `kill`, `kids`, `bot`, `public`. Também: `{"conv_id","set":1}` liga (se
`can_enable`) e `{"conv_id","set":0,"confirm":true}` rebaixa com mensagem `e2ee_off`.

**4.2.20 `e2ee5_metrics`** Req `MetricsSnapshot` do núcleo (§6.9) + `{"platform","app_version"}`
→ `{}`. Agrega por dia/plataforma em `e2ee5_metrics`. Nunca ids de mensagem.

### 4.3 Códigos de erro (`data.code`)
| Código | HTTP | Quando |
|---|---|---|
| `e2ee5_disabled` | 403 | fora da allowlist/coorte, ou `E2EE5_KILL` para ativação |
| `unauthorized` | 401 | sem bearer / bearer inválido |
| `e2ee5_device_required` | 400 | falta `X-E2EE-Device` |
| `e2ee5_device_mismatch` | 403 | bearer vinculado a outro aparelho |
| `e2ee5_device_conflict` | 409 | device_id de outro uid |
| `e2ee5_device_limit` | 409 | 1 principal + 4 vinculados atingido |
| `e2ee5_device_key_changed` | 409 | tentou trocar chave de identidade de aparelho existente |
| `e2ee5_bad_signature` | 400 | assinatura ed25519 inválida |
| `e2ee5_no_sodium` | 500 | extensão sodium ausente (falha fechada) |
| `e2ee5_bad_request` | 400 | JSON/campo inválido |
| `e2ee5_bad_event` | 400 | to-device com tipo proibido |
| `e2ee5_too_large` / `e2ee5_too_many` | 413 | limites |
| `e2ee5_rate_limited` | 429 | rate limit (com `data.retry_after` s) |
| `e2ee5_no_backup` | 404 | sem backup/secret storage |
| `e2ee5_wrong_backup_version` | 403 | versão de backup não ativa |
| `e2ee5_link_expired` / `e2ee5_link_seq` / `e2ee5_link_forbidden` | 410/409/403 | rendezvous |
| `e2ee5_plaintext_refused` | 409 | (chat_send/native_send/leaf) texto puro em conversa `e2ee_mode=1` |
| `e2ee5_not_e2ee` | 409 | envelope em conversa `e2ee_mode=0` (cliente desatualizado do estado) |

### 4.4 JSON canônico e verificação (PHP)
Algoritmo Matrix: remover `signatures` e `unsigned`; serializar com chaves ordenadas
(código de ponto), sem espaços, UTF-8 sem escapar não-ASCII, números inteiros.
Em PHP: `ksort` recursivo + `json_encode($x, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)`;
verificar com `sodium_crypto_sign_verify_detached(base64_decode_unpadded(sig), $canon,
base64_decode_unpadded(pub))`. A referência em Rust está em
`tests/common/fake_server.rs::verify_signed` e os vetores em `docs/e2ee/exemplos/`.

### 4.5 Rate limits (resumo)
| Ação | Limite |
|---|---|
| `keys_claim` | 5 OTK/h por (requisitante, aparelho alvo) → depois fallback; 3.000 alvos/h por requisitante |
| `keys_query` | 120/min por aparelho |
| `to_device_send` | 600/min por aparelho; 4 MiB por chamada |
| `sync` | 120/min por aparelho |
| `link_create` | 20/h por IP |
| `secret_storage_get` | 10/h por uid |

---

## 5. WebSocket (hub Go, WP-06a)

### 5.1 Declaração do aparelho
O frame de auth ganha o campo **`e2ee5_device`** (string, `^[PWTX][A-Z2-7]{12}$`), separado do
`device_id` diagnóstico de hoje. Passa por `sanitizeClientTag`.

### 5.2 Eventos (frame atual `{"type":…, "data":{…}, "event_id"?}`)
| `type` | `data` | Canal | Cliente faz |
|---|---|---|---|
| `e2ee5_td` | `{"device_id":"P…","n":3}` | `chat_user_<email>` | se `device_id` = o meu (ou ausente): `core.sync()` (debounce 300 ms) |
| `e2ee5_devices` | `{"uids":["7","42"]}` | `chat_user_<email>` de cada afetado | `core.sync()` (pega `device_lists`) |
| `conv_e2ee` | `{"conv_id":"971","e2ee_mode":1,"since_pts":12345}` | `chat_user_<email>` dos membros | atualiza estado da conversa; se 1, próximos envios cifram |

- Publicação: PHP → `POST http://127.0.0.1:8084/broadcast` com `{channel, event, data}` (como
  hoje, `_wsBroadcastTargets`). Sem Redis novo.
- Roteamento fino por aparelho é **otimização** do hub: se a conexão declarou
  `e2ee5_device` e `data.device_id` existe e difere, o hub pode não entregar. Sem o kit do hub,
  o evento vai a todos os aparelhos do usuário e o cliente filtra. Os 3 eventos **não** entram
  em `ws_event_log` (o `sync` é a fonte; perder um aviso não perde dado).
- Mensagens cifradas usam os eventos de mensagem atuais; o `content` é o envelope.
  O relay **não** monta `reply_to.content` para envelopes (manda só `reply_to.id`).

---

## 6. API do núcleo `chatyy-crypto` (Rust → UniFFI / wasm)

Código: `native/chatyy-crypto/src`. Nomes Rust abaixo; UniFFI gera os mesmos nomes em
camelCase no Swift/Kotlin; o wasm (WP-04) expõe os mesmos nomes em camelCase via worker.

### 6.1 Modelo de execução
- Tudo é **async**. Nativo: runtime tokio (UniFFI `async_runtime = "tokio"`). Web: futures
  no worker (wasm-bindgen-futures).
- Uma instância `CryptoCore` por processo e por conta. Chamadas concorrentes no mesmo processo
  são serializadas internamente (mutex). Entre processos (app × NSE × extensão), trava
  `CrossProcessLock` no próprio SQLite (lease 2 s com renovação); se outro processo escreveu,
  a instância recarrega do disco antes de continuar (sem ação do host).
- O núcleo **não** tem timers nem threads próprias: o host decide quando chamar `sync()`
  (WS `e2ee5_td`, abertura do app, push, a cada 60 s em 1º plano).
- Rede só pelo `HttpTransport` do host.

### 6.2 Transporte (host implementa)
```rust
trait HttpTransport: Send + Sync {
    async fn call(&self, action: String, body_json: String) -> Result<HttpResponse, TransportError>;
}
struct HttpResponse { status: u16, body: String }
enum TransportError { Network { msg: String } }
```
Na web (wasm) o trait não exige `Send + Sync` (o `fetch` vive numa thread só); o resto é igual.
`action` vem **sem** o prefixo (`"keys_upload"`); o host faz
`POST {base}/api/email.php?action=e2ee5_<action>` com os cabeçalhos do §4.1 e devolve status e
corpo crus (inclusive 4xx/5xx). O núcleo interpreta `{success,data,message}`.
Timeout recomendado: 15 s (NSE: 5 s).

### 6.3 Funções livres
| Função | Retorno |
|---|---|
| `core_version()` | `"chatyy-crypto 0.1.0; contrato e2ee5-contrato/1.1; matrix-sdk-crypto 0.18.0; vodozemac 0.10.0"` |
| `new_device_id(prefix: "P"\|"W"\|"T"\|"X")` | `String` |
| `envelope_version(content)` | `Option<u64>` (5, ou outro N → placeholder "Atualize") |
| `encrypt_bytes(plain: bytes) / decrypt_bytes(data: bytes, info_json)` | `EncryptedBytes{data, info_json}` / bytes |
| `encrypt_file(in, out) / decrypt_file(in, out, info_json)` | `EncryptedFile{info_json, size}` / `u64`. Decifra em `<out>.part` e só renomeia se o SHA-256 conferir |
| `safety_number_for(uid_a, msk_a, uid_b, msk_b)` (não exportada pelo UniFFI; a web pode expor) | `SafetyNumber{digits, qr_payload}` |

### 6.4 `CryptoCore`
```text
open(opts: OpenOptions, transport) -> CryptoCore          // sem rede
  OpenOptions { store_dir, store_passphrase (≥16; 32 B aleatórios b64), uid, device_id,
                role: App|Push|Extension|Web, holder_suffix }
uid() / device_id() / this_device() -> DeviceSummary
sync() -> SyncResult                                       // e2ee5_sync + processa + publica OTKs
sync_with(sync_data_json) -> SyncResult                    // host já tem o corpo do sync
track_users(uids)
encrypt(conv_id, member_uids, payload_json) -> EncryptResult{envelope_json, session_id, key_share_requests, key_share_bytes}
decrypt(DecryptInput{conv_id, envelope_json, sender_uid, server_mid, cmid, ts_ms})
      -> Decrypted{payload_json, sender_uid, sender_device_id, trust: Verified|Tofu|Changed, session_id}
send_to_device(event_type "chatyy.*", targets: [DeviceTarget{uid, device_id}], content_json) -> SendToDeviceResult{sent_devices, withheld}
rotate_conversation(conv_id) -> bool
on_members_changed(conv_id, member_uids, removed_uids)    // saiu alguém ⇒ rotação imediata
forget_device(device_id) -> u32                           // revoga MEU vinculado + rotaciona tudo
list_devices(uid) -> [DeviceSummary{uid, device_id, ed25519, curve25519, signed_by_owner, is_this_device}]
bootstrap_identity() -> IdentityStatus                     // só celular principal (ou D4)
sign_device(device_id, expected_ed25519)                   // vínculo; recusa chave divergente
identity_status(uid) -> IdentityStatus{uid, has_identity, master_key, verified, needs_approval, is_primary}
pin_identity(uid)                                          // aceita MSK nova após o aviso
safety_number(uid) -> SafetyNumber
verify_safety_qr(uid, scanned) -> bool                     // confere e marca verificado
mark_verified(uid)
export_room_keys(ExportFilter{conv_ids, since_ms}) -> bytes (JSON ExportedRoomKey[]; SEGREDO)
import_room_keys(bytes) -> ImportResult{imported, total, convs}
export_room_keys_with_passphrase(pass) -> String / import_room_keys_with_passphrase(data, pass)
backup_enable(passphrase|"") -> BackupEnabled{recovery_key, version}
backup_step(max_batches) -> u32 / backup_status() -> BackupStatus / backup_disable()
backup_restore(recovery_key_or_passphrase) -> RestoreResult{imported, total, identity_restored, convs}
metrics_snapshot() -> MetricsSnapshot / flush_metrics()
```
Regras de uso:
- `member_uids` em `encrypt` = membros **atuais** segundo o servidor (`conversation_state`);
  o próprio uid entra sempre (meus outros aparelhos).
- Sessão Megolm: rotação a cada **100 mensagens ou 7 dias**, ou quando a lista de aparelhos
  muda / alguém sai. Compartilhamento só com aparelhos **assinados pelo dono**
  (`IdentityBasedStrategy`); decifragem só de aparelhos assinados (`TrustRequirement::CrossSigned`).
- Recebeu `convs_with_new_keys` ⇒ host re-tenta decifrar as mensagens "aguardando" dessas conversas.
- Recebeu `identity_changed_uids` ⇒ host grava a linha local "o código de segurança de X mudou"
  e chama `pin_identity(uid)` (comportamento WhatsApp: avisa, não bloqueia). Se X era
  **verificado**, o `encrypt` falha com `IdentityViolation` até o usuário confirmar.

### 6.5 Erros (`CoreError`)
`Utd{reason, session_id}` · `InvalidInput{field, msg}` · `Transport{msg}` · `Server{status, code}` ·
`Store{msg}` · `LockBusy` · `Identity{msg}` (`not_primary`, `cross_signing_not_setup`,
`own_device_not_verified`, `own_identity_missing`, `contact_identity_missing`) ·
`IdentityViolation{uids}` · `Media{msg}` · `Link{msg}` · `Backup{msg}` · `Internal{msg}`.

`UtdReason`: `missing_session` · `unknown_index` · `withheld` · `untrusted_device` ·
`sender_mismatch` · `context_mismatch` · `bad_envelope` · `corrupted` · `store`.
Retentáveis após `sync()`: `missing_session`, `unknown_index`, `store`, `untrusted_device`.
UI: retentável = "Aguardando esta mensagem…"; não retentável = "Não foi possível decifrar".
Após 60 s retentável sem sucesso ⇒ `chatyy.decrypt_report` ao remetente + métrica.

### 6.6 Número de segurança
- Por lado: `SHA-512(0x0000 ‖ MSK(32 B) ‖ uid ASCII)`, depois 5.200 × `SHA-512(h ‖ MSK)`;
  primeiros 30 bytes → 6 blocos de 5 bytes → cada `uint40 mod 100000` com 5 dígitos.
- Número = lado do **menor uid numérico** primeiro + outro lado = **60 dígitos**
  (exibir 12 grupos de 5).
- QR: `chatyy-sn:1:<uidA>:<mskA_b64>:<uidB>:<mskB_b64>` (A = menor uid).

### 6.7 Vínculo por QR (objetos `LinkWeb` / `LinkPhone`)
```text
Web:    LinkWeb::begin(transport) -> LinkWeb ; qr_payload() ; link_id()
        poll(core?) -> Waiting | Hello{uid, check_code} | Granted{bearer} | Importing{received_chunks,total_chunks} | Done{imported}
        send_device(core)      // após Hello (host abriu CryptoCore com o uid recebido e device "W…")
        complete_upload(core)  // após Granted (host instalou o bearer no transporte)
Celular: LinkPhone::accept(core, qr, ExportFilter) -> LinkPhone ; check_code()
        poll() -> WaitingDevice | WaitingUpload{device_id} | Sent{device_id, chunks} | Done{device_id}
```
- QR: `chatyy-link:1:<link_id>:<pk_web b64url>:<segredo 32 B b64url>`.
- Canal ECIES (`vodozemac::ecies`, info `CHATYY_LINK_V1`). 1ª mensagem do celular leva o
  segredo do QR; a web recusa se não conferir. Código de 2 dígitos (`check_code`) para
  conferência opcional.
- O celular só assina o aparelho web se a chave ed25519 publicada no servidor for **igual** à
  recebida pelo canal (servidor não troca o aparelho). A web só confia na MSK recebida pelo
  canal e recusa se o servidor mostrar outra.
- Histórico: export das chaves de entrada em blocos de 200 (D5: tudo por padrão;
  `since_ms` = "só últimos 3 meses").

### 6.8 Backup
- Chave de recuperação = `SecretStorageKey` base58 (48 chars + espaços a cada 4). Senha
  opcional: Argon2id (m=64 MiB, t=3, p=1, sal 16 B) → b64 → PBKDF2 padrão Matrix.
- Segredos guardados: `m.cross_signing.{master,self_signing,user_signing}` e
  `m.megolm_backup.v1`. Backup das chaves Megolm: `m.megolm_backup.v1.curve25519-aes-sha2`.
- `backup_restore` restaura a **mesma** MSK (o código de segurança não muda para os contatos),
  assina o aparelho novo e importa o histórico.

### 6.9 Métricas
`MetricsSnapshot{encrypt, decrypt_ok, utd_json, utd_total, to_device_in, to_device_utd,
dropped_untrusted, store_reloads}` — só contagens. `flush_metrics()` envia e zera.

### 6.10 Store
- Nativo: SQLite `matrix-sdk-sqlite` cifrado com `store_passphrase` em `store_dir`
  (iOS App Group `group.com.onemundo.mail/e2ee5/<uid>`; Android
  `noBackupFilesDir/e2ee5/<uid>`). Excluído de iCloud/Auto Backup/D2D.
- Web: IndexedDB `chatyy-e2ee5-<uid>` com `open_with_passphrase` (senha derivada de chave
  WebCrypto não-exportável — WP-04).
- Valores próprios do núcleo no store (custom values): cursores `td_since`/`dc_since`,
  `session_seen` (para o filtro de 3 meses) e `convs` conhecidas.

### 6.11 API JS do host (`services/crypto`, web = WP-04, nativo = WP-03) — NORMATIVA
A tabela completa (nomes, argumentos, retornos e `.code` de erro) está em
[`proposta-host-api.md`](proposta-host-api.md) e **vale como parte deste contrato** desde a 1.1,
com estas decisões do WP-00:
1. Nomes = §6.3/§6.4 em camelCase; structs em camelCase (`envelope_json` → `envelopeJson`);
   JSON aninhado devolvido pelo núcleo continua **string** (`payloadJson`, `contentJson`,
   `infoJson`, `utdJson`); bytes = `Uint8Array`; tudo Promise, exceto `isEnabled()`.
2. `trust` em JS: `'verified' | 'tofu' | 'changed'`. Erro: `Error` com `.code` (`utd`,
   `invalid_input`, `transport`, `server`, `store`, `lock_busy`, `identity`,
   `identity_violation`, `media`, `link`, `backup`, `internal`, + `disabled`, `unsupported`,
   `not_ready`, `not_open`, `wasm_*`, `worker_error`, `terminated`) e `.reason` para `utd`.
3. **Senha do store web** (aprovada): `base64(HMAC-SHA256(K, "chatyy-e2ee5-store-v1|<uid>|<device_id>"))`,
   `K` = CryptoKey HMAC **não-exportável** guardada no IndexedDB `chatyy-e2ee5-meta` com o
   `device_id`. Sem o registro ⇒ aparelho novo (store órfão apagado).
4. **Web não tem `encryptFile`/`decryptFile`** (só bytes). Nativo tem os dois.
5. Vínculo, lado celular (WP-03/WP-12): `linkAccept(qrPayload, {convIds, sinceMs})` →
   `{checkCode}` e `linkPhonePoll()` → `{state: 'waiting_device'|'waiting_upload'|'sent'|'done',
   deviceId?, chunks?}` (espelha `LinkPhoneState` do §6.7). Lado web: `linkBegin`,
   `linkPoll`, `linkSendDevice`, `linkCompleteUpload`, `linkCancel` como na proposta.
6. O host esconde `store_dir`, `store_passphrase`, `role`, `holder_suffix`; o JS passa só `uid`.

---

## 7. Push (WP-07 servidor, WP-10 clientes)

Campos de `data` em conversa `e2ee_mode=1`:
| Campo | Valor |
|---|---|
| `e2e` | `"5"` |
| `e2e_c` | envelope inteiro (string) se `len ≤ 2800` bytes (mesmo orçamento do `_chatBgSyncFields`) |
| `e2e_fetch` | `"1"` quando o envelope não coube (cliente busca a mensagem por `mid`) |
| `e2e_sid` | `session_id` do envelope (NSE decide se precisa `sync` antes) |
| `e2e_conv` | `conv_id` |
| `e2e_mid` / `e2e_cmid` | id servidor / client_message_id |
| `e2e_sender_uid` | uid do remetente |
| `title` | nome do remetente / grupo (metadado, como hoje) |
| `body` | **genérico** `"Nova mensagem"` (i18n do servidor) — a NSE substitui pelo decifrado |

**Nunca** em conversa E2EE: `msg_preview`, `bg_text`, `bg_rquote`, `bg_thumb`, `bg_fname`,
`smart_replies`, `transcript`, `preview_full`, `image`. `bg_full='0'`. O `push_preview` WS leva
`{conv_id, mid, cmid, sender_uid, e2e_c}`.
NSE: `open(role=Push)` → se `decrypt` der `missing_session`, `sync()` uma vez (timeout 5 s) e
tenta de novo; senão mostra "Nova mensagem". Responder pela notificação cifra no nativo ou abre o app.

---

## 8. Estado da conversa, ativação e imposição

### 8.1 Colunas novas (`chat_conversations`, aditivas)
`e2ee_mode smallint NOT NULL DEFAULT 0` · `e2ee_since_pts bigint` · `e2ee_changed_at timestamptz`.
(A coluna antiga `is_e2ee` e a tabela `e2ee_v4_conversations` ficam para o legado, WP-19.)

### 8.2 Elegível
Conversa `direct` ou `group` (≤ 1024 membros), **não** `channel`/`saved`/comunidade/bot/
ponte/live, **sem** conta Kids supervisionada (D6), todos os membros ativos com ≥ 1 aparelho
`e2ee5` **assinado** (principal com MSK) e na coorte (`e2ee5_allow` ou `E2EE5_PCT` por
`conv_id`), e `E2EE5_KILL` desligado.

### 8.3 Ativação automática
No `chat_send` / `conversation_state` / quando um membro ganha aparelho elegível: se elegível
e `e2ee_mode=0` ⇒ `e2ee_mode=1`, `e2ee_since_pts = next_pts`, mensagem `system`
`{"sys":"e2ee_on","since_pts":…}`, WS `conv_e2ee`. Nunca volta sozinha para 0.

### 8.4 Imposição no envio (chat_send, native_send, leaf, aceite regional, agendadas)
Com `e2ee_mode=1`: conteúdo de usuário **sem** prefixo `{"e2e":5` ⇒ `e2ee5_plaintext_refused`.
Isentos: `type='system'` gerado pelo servidor. Com `e2ee_mode=0`: envelope ⇒
`e2ee5_not_e2ee` (cliente re-busca o estado). Em conversa E2EE o servidor **pula**: link
preview, moderação OpenAI, palavra-chave, hashtags, tradução, transcrição, grep de @todos no
texto (usa `mention_all`), `content_tsv`, citação montada do pai.

### 8.5 Rebaixamento
Só por `conversation_state set:0 confirm:true` (qualquer membro em 1:1; admin em grupo) ou
pelo founder/admin. Sempre grava `e2ee_off` visível a todos. O `E2EE5_KILL` **não** rebaixa
conversas já cifradas.

### 8.6 Mensagens antigas
Antes de `e2ee_since_pts`: texto como hoje (legíveis). Divisor no cliente na posição do
`e2ee_on`: "As mensagens e ligações agora são protegidas com criptografia de ponta a ponta.
Toque para saber mais." (`e2ee5.divider.on`).

---

## 9. Flags

| Flag | Onde mora | Quem lê | Efeito |
|---|---|---|---|
| `e2ee5_allow(email_canon, enabled)` | tabela | `e2ee5.php` | allowlist de contas (QA: apitest@onemundo, qa2@chatyy; **nunca duarte@**) |
| `E2EE5_PCT` (0–100) | `/etc/mail-api.env` | `e2ee5.php`, `chat.php` | coorte por `conv_id % 100 < PCT` (além da allowlist) |
| `E2EE5_KILL=1` | env | `e2ee5.php`, `chat.php` | para de **ligar** conversas e de aceitar `bootstrap`; as cifradas continuam |
| `e2ee_mode` | `chat_conversations` | servidor, hub, clientes | estado real + imposição |
| `__chatyy_e2ee5` | JS global (OTA) | `services/flags.js` → WP-08c | liga o caminho novo no JS; desligado = byte a byte igual a hoje |
| `e2ee5_native` | `e2ee5_status.flags` | módulo nativo (WP-03) grava no store nativo ao abrir | o nativo só inicializa o núcleo se `true` |
| `e2ee5_media` / `e2ee5_calls` / `e2ee5_link` / `e2ee5_backup` / `e2ee5_push_decrypt` | `e2ee5_status.flags` (env `E2EE5_FLAGS=media,calls,…` + por conta) | clientes | um interruptor por fase |
| input `chatyy_crypto` | workflows CI | WP-02 | inclui o núcleo no binário (sem comportamento até as flags) |

Os clientes leem `e2ee5_status` no login, ao voltar ao 1º plano (máx. 1×/10 min) e após
`conv_e2ee`. Sem resposta ⇒ usa o último valor salvo; nunca liga sozinho.

---

## 10. i18n (`i18n/e2ee5/{pt-BR,pt-PT,en,es}.js`, dono WP-15)

Chaves planas no namespace `e2ee5.*`. Cada pacote **só acrescenta no seu sub-namespace**:
| Sub-namespace | Pacote | Exemplos |
|---|---|---|
| `e2ee5.msg.*` | WP-08c/09 | `e2ee5.msg.update_to_read`, `e2ee5.msg.waiting`, `e2ee5.msg.cannot_decrypt`, `e2ee5.msg.learn_more` |
| `e2ee5.divider.*` | WP-15 | `e2ee5.divider.on`, `e2ee5.divider.off` |
| `e2ee5.safety.*` | WP-15 | `e2ee5.safety.title`, `e2ee5.safety.changed` ("O código de segurança de {name} mudou"), `e2ee5.safety.new_device`, `e2ee5.safety.verified`, `e2ee5.safety.scan` |
| `e2ee5.banner.*` | WP-15 | `e2ee5.banner.needs_update` ("{name} precisa atualizar o Chatyy para ativar a criptografia") |
| `e2ee5.exit.*` | WP-15/17 | `e2ee5.exit.translate`, `e2ee5.exit.bia`, `e2ee5.exit.transcribe` ("isto sai da criptografia") |
| `e2ee5.badge.*` | WP-15 | `e2ee5.badge.not_encrypted` (jogos, bots, canais, Kids) |
| `e2ee5.link.*` | WP-12 | `e2ee5.link.scan_title`, `e2ee5.link.confirm`, `e2ee5.link.code`, `e2ee5.link.importing`, `e2ee5.link.need_phone` |
| `e2ee5.devices.*` | WP-12 | `e2ee5.devices.title`, `e2ee5.devices.logout`, `e2ee5.devices.inactive_30d` |
| `e2ee5.backup.*` | WP-14 | `e2ee5.backup.enable`, `e2ee5.backup.key_title`, `e2ee5.backup.confirm_chunks`, `e2ee5.backup.wrong_key`, `e2ee5.backup.restore` |
| `e2ee5.call.*` | WP-13 | `e2ee5.call.encrypted`, `e2ee5.call.no_key` |
| `e2ee5.push.*` | WP-10 (servidor/NSE) | `e2ee5.push.new_message` ("Nova mensagem"), `e2ee5.push.reacted` |
| `e2ee5.settings.*` | WP-15 | página "Criptografia" |

Tom: igual ao WhatsApp, sem alarme. Nunca emoji na UI (cadeado = SVG).

---

## 11. Conformidade

- `native/chatyy-crypto/tests/common/fake_server.rs` implementa **este contrato** (§4) em
  memória, inclusive autorização, anti-dreno de OTK, verificação de assinatura e rendezvous.
  É a especificação executável: o WP-05 roda os mesmos cenários contra o `e2ee5.php` real
  trocando o transporte (`CHATYY_E2EE5_BASE` + bearers QA — runner do WP-18).
- Exemplos JSON reais (gerados pelos testes) em `docs/e2ee/exemplos/`.
- Qualquer divergência PHP × servidor falso é bug do PHP **ou** deste contrato — corrigir aqui
  primeiro (MINOR) e depois nos dois lados.
