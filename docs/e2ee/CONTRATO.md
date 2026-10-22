# Contrato E2EE v5 do Chatyy

| | |
|---|---|
| **Versão** | `e2ee5-contrato/1.7` (1.7.0) — 22/10/2026 (1.7: pedido de chave de sala `chatyy.key_request`/`chatyy.room_key` + `e2ee5_key_request(_check)` (§3, §4.2.21–22, §6.12), encaminhamento automático entre MEUS aparelhos (`automatic-room-key-forwarding`), aparelhos já desconectados `e2ee5_devices_former` (§4.2.23) com `trust: device_removed` e UTD `unverified_sender`; 1.1: §6.11 API JS do host; 1.2: §5.3–5.5 WS do WP-06a, §10 i18n; 1.3: códigos/campos do WP-07, `e2e_np` e flag NSE do WP-10, fila NSE→app do núcleo; 1.4: §2.8 tipos ricos e mídia cifrada do WP-09/WP-11; 1.5: §0.3bis privada inteira, §4.6 `e2ee5x_*` e denúncia do WP-16; 1.6: `sender_uid`, `members[].email`, códigos `{"sys"}`, leaf/`chat_send_rejected`, `gen` do `call_sdp`) |
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
3bis. **Conversa `e2ee_mode=1` é privada INTEIRA para leitores do servidor**: nenhuma rota que lê
   conteúdo (Bia/One, busca, unified-search, tradução, transcrição, resumo, export, moderação
   automática, jogos…) lê qualquer linha dela — nem as mensagens antigas em texto anteriores a
   `e2ee_since_pts`. Rota JSON responde `e2ee5_server_read_refused`; a Bia responde "Não consigo
   ler esta conversa: ela é protegida com criptografia de ponta a ponta. Quer me mandar o
   trecho?". A única entrada de conteúdo é o que o **cliente** manda por pedido explícito (§4.6)
   ou por denúncia (§4.6).
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
| `sender_uid` (string) | uid do remetente (`e2ee5_uid`) em **toda linha cifrada**: `chat_messages`, `chat_load_around`, `chat_sync`, `chat_list.last_message`, frames WS `chat_message`/`chat_summary`, eco/`chat_send_ack` (PHP, hub e leaf) e Rust `/messages`/`/sync`. Conversa normal: ausente | o cliente passa este valor como `DecryptInput.sender_uid` (não deriva do e-mail) |

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
| `member_added`, `member_removed`, `member_left` | `by_uid`, `member_uid` | chat.php |
| `member_joined` | `member_uid`, `via`: `approval`\|`link`\|`invite` | chat.php |
| `admin_set` / `owner_transfer` | `by_uid`, `member_uid`, `on` | chat.php |
| `group_updated` | `by_uid`, `field`: `name`\|`description`\|`avatar` (o valor novo NÃO vai; o cliente lê do perfil do grupo) | chat.php |
| `pin` | `by_uid`, `mid`, `on` | chat.php |
| `disappearing` / `slow_mode` | `by_uid`, `seconds` | chat.php |
| `admin_only`, `screenshot_alerts`, `adv_privacy`, `vanish`, `forwarding_admins`, `members_edit_info`, `hide_members`, `join_approval` | `by_uid`, `on` | chat.php |
| `screenshot` | `by_uid`, `blocked`, `view_once` | chat.php |
| `meetup_update` | `by_uid`, `mid`, `cancel` | chat.php |
| `call_scheduled` / `call_schedule_cancelled` | `by_uid`, ids (o `meta` ainda leva o título em claro: pendência WP-13/16) | chat.php |

Regra (WP-07, DDL 008): em conversa cifrada o banco **recusa** `type='system'` cujo `content` não
comece com `{"sys":"` (erro P0E51). Campos de pessoa são sempre `*_uid`, nunca `*_email`.
Criação de grupo/canal fica fora (a conversa nasce em modo 0); canal e bot nunca cifram.
Cliente: `{"sys":<código desconhecido>}` mostra texto genérico, nunca JSON cru.

"O código de segurança de X mudou" e "aparelho novo de X" são **locais** (gerados pelo cliente
a partir de `SyncResult.identity_changed_uids`), não vão ao servidor.

Reações F2: `chat_message_reactions.emoji` recebe `"e2e"` e a coluna nova `enc` recebe o
envelope `{"e2e":5,…}` com payload `t:"reaction"`. Prévia de push: "reagiu à sua mensagem".

---

### 2.8 Adendos 1.4 (WP-09/WP-11 — tipos ricos e mídia cifrada no cliente; todos aditivos)
Implementação: `services/e2ee/payload.js` (montar/ler), `services/e2ee/e2ee5Media.js` (variantes, cifra,
upload opaco, download+decifra), `api/e2ee5_media.php` (servidor). Notas: `/root/e2ee-2026-10-21/wp11/NOTAS.md`.

1. **Campos aditivos do payload**: `batch` (string ≤ 64; álbum = N mensagens `image`/`video` de 1 envio,
   o cliente agrupa depois de decifrar — o servidor não vê `batch_id`); `M.lqip` (JPEG ~40 px em base64,
   < 6 KB, o LQIP que a bolha pinta antes do download; o `blurhash` continua); `M.poster` = objeto de mídia
   `{kind:"poster", url, file, w, h, size, mime}`; `M.title` (áudio); `contacts[].avatar`/`.chatyy`;
   `t:"location_request"` (`body` ≤ 200, `type` grosso `text`). `media[]` com mais de 1 item: o leitor
   v1 do app mostra só o 1º (o app envia álbum como mensagens separadas com `batch`).
2. **Reação cifrada (substitui o texto do §2.7)**: `chat_react {message_id, emoji:"e2e", enc:<envelope>,
   rx_kind:"reaction"|"state", remove?:1, silent?:1}`. A coluna `emoji` recebe o **próprio envelope**
   (`{"e2e":5…}` = reação; `v{"e2e":5…}` = **estado por pessoa**) e `enc` recebe o envelope também — assim
   todos os agregadores atuais (lista, WS `reaction`, sync, Rust) transportam a reação cifrada sem mudança e
   o cliente decifra e reagrupa. 1 reação + 1 estado por pessoa por mensagem (troca = apaga o meu do
   mesmo tipo + insere; `remove:1` retira). Só em mensagem cifrada; emoji em claro em mensagem cifrada =
   `e2ee5_plaintext_refused`; em mensagem em claro (de antes da ativação) segue como hoje. O payload da
   reação/estado traz `target_mid` (ou `poll_mid`) e o cliente **descarta** o que não bate com a mensagem
   onde está (o servidor não consegue mover reação de lugar). Push: reação = "reagiu à sua mensagem"
   (sem emoji); estado = sem push.
3. **Estados por pessoa** (reação `rx_kind:"state"`): `t:"poll_vote"` (`poll_mid`, `option_ids` — vazio =
   retirar; apuração no cliente; **substitui** a linha `poll_vote` com `sys_hidden` do §2.4),
   `t:"meetup_rsvp"` (`target_mid`, `status` = `going`|`maybe`|`not_going`; substitui o RSVP em tabela
   própria do WP-07 F2), `t:"live_loc"` (`target_mid`, `lat`, `lng`, `acc?`, `stopped?` — posição ao vivo
   da mensagem `location` com `live`; só vale o estado do REMETENTE da mensagem). Enquete cifrada no app:
   `poll.id = "e5:<mid>"`.
4. **Upload opaco (§2.4.1)**: o cliente cifra cada arquivo (nativo `encrypt_file`; web `encrypt_bytes`) e
   sobe pelo Rust/edge `POST /api/rust/upload[/init|chunk|complete]` com `context=e2e`,
   `Content-Type: application/octet-stream` e nome aleatório de 22 caracteres (sem extensão) → URL
   `https://media.chatyy.com.br/e2e/<id>_<aleatório>`; reserva: `chat_upload` com `opaque=1` no US →
   `e2e/<24 base64url>`, `{success, data:{opaque:1, url, size}}`, sem linha em `chat_messages`. Em conversa
   `e2ee_mode=1` o `chat_upload` sem `opaque=1` (e o `chat_upload_finalize` do edge) = `e2ee5_plaintext_refused`;
   `opaque=1` em conversa normal = `e2ee5_not_e2ee`. O edge nunca processa upload de conversa E2EE.
   Nenhum processo de mídia (Imagick, ffmpeg, HLS, waveform, thumb, LQIP, blurhash) toca `e2e/`.
5. **Download**: o cliente guarda o ciphertext (nativo `documentDirectory/e2ee5-media/enc`; web Cache
   Storage `chatyy-e2ee5-media-v1`) e decifra para uma cópia de exibição descartável (nativo
   `cacheDirectory/e2ee5-media/plain`; web `blob:` da aba). Vídeo/áudio: baixa e decifra inteiro antes de
   tocar (o SHA-256 confere só no fim). Byte trocado ⇒ `media` ⇒ "não foi possível abrir".
6. **Fora desta versão (o app recusa localmente, nada sai em claro)**: visualização única de mídia,
   reação com figurinha, editar encontro, sessão de voz que sobe o áudio enquanto grava, prévia de link
   gerada no cliente, agendada/enviar-quando-online de mídia.

## 3. Eventos to-device `chatyy.*` (cifrados Olm aparelho→aparelho)

Enviados com `CryptoCore.send_to_device(event_type, targets, content_json)`; chegam em
`SyncResult.chatyy_events` **somente** se o aparelho remetente é assinado pelo dono.
Todos têm `v:1`. Evento em claro com tipo `chatyy.*` é **descartado**.

| Tipo | Conteúdo | Uso / fase |
|---|---|---|
| `chatyy.call_key` | `{v, call_id, conv_id, key (b64 32 B), index (u32), ts}` | chave LiveKit E2EE por ligação; rotação = `index+1` (F5) |
| `chatyy.call_sdp` | `{v, call_id, kind: "offer"\|"answer"\|"candidate"\|"bye", gen, sdp?, candidate?, mid?, mline?}` — `gen` (int, 0 = 1ª negociação) = geração da negociação (ICE restart), igual ao `call_p2p_*` do hub; o receptor casa por `(call_id, kind, gen)` | P2P 1:1 DTLS-SRTP autenticado (F5) |
| `chatyy.draft` | `{v, conv_id, text, ts}` | sync de rascunho entre MEUS aparelhos (opcional) |
| `chatyy.decrypt_report` | `{v, conv_id, mid, session_id, reason, ts}` | "não consegui decifrar" (60 s) → remetente rotaciona (`rotate_conversation`): resolve as PRÓXIMAS; as já enviadas vêm pelo `chatyy.key_request` (1.7) |
| `chatyy.key_resend` | `{v, conv_id, session_id}` | **obsoleto (1.7)** — substituído por `chatyy.key_request`; o app só rotaciona ao recebê-lo |
| `chatyy.key_request` (1.7) | `{v, req_id, conv_id, session_id, mid}` | destinatário sem a chave de uma sessão EXISTENTE pede ao remetente (§6.12). Vai a todos os aparelhos assinados do remetente; só o que CRIOU a sessão atende (`share_room_key`). Sai do `request_room_key` do núcleo, nunca do host |
| `chatyy.room_key` (1.7) | `{v, req_id, conv_id, session_id, key: ExportedRoomKey}` | resposta: chave da sessão exportada a partir do índice permitido. **Reservado ao núcleo**: `send_to_device` recusa este tipo; o receptor importa DENTRO do núcleo (não aparece em `chatyy_events`) e só se (a) ele pediu há ≤ 48 h, (b) `sender_key`/`sender_claimed_keys.ed25519` = chaves do aparelho Olm remetente, assinado pelo dono, (c) sem cadeia de encaminhamento |
| `chatyy.link.revoked` | `{v, device_id}` | celular avisa meus aparelhos que um vinculado saiu |
| `chatyy.read_sync` | **[fora do v1]** | — |

`targets`: lista `{uid, device_id}`; `device_id` vazio = todos os aparelhos **assinados** do uid.
O aparelho atual nunca recebe o próprio evento.

**Entre MEUS aparelhos (1.7):** o núcleo é compilado com `automatic-room-key-forwarding` da
matrix-sdk-crypto: um decrypt sem chave (`missing_session`/`unknown_index`) enfileira um
`m.room_key_request` (em claro, só ids) para os MEUS aparelhos, que respondem com
`m.forwarded_room_key` (Olm); só se aceita forward de aparelho PRÓPRIO verificado. Para chave de
OUTRO usuário a biblioteca recusa forward — por isso o `chatyy.key_request`/`chatyy.room_key` acima.
(Antes da 1.7 este parágrafo dizia que a biblioteca já pedia aos meus aparelhos, mas a feature
estava desligada: nenhum pedido saía.)

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
Req `{}` → `{"uid":"42","user_id":"@u42:chatyy","contract":"e2ee5-contrato/1.6","enabled":true,
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
"e2ee_mode":1,"since_pts":12345,"members":[{"uid":"7","capable":true,"email":"a@chatyy.com.br"},{"uid":"42","capable":true,"email":"b@chatyy.com.br"}],
"can_enable":true,"blocked_reason":null}`. `blocked_reason` ∈ `member_needs_update`,
`not_allowed`, `kill`, `kids`, `bot`, `public`. Também: `{"conv_id","set":1}` liga (se
`can_enable`) e `{"conv_id","set":0,"confirm":true}` rebaixa com mensagem `e2ee_off`.
`members[].email` é o e-mail **canônico** (§1.1); as linhas de mensagem podem trazer
`sender_email` com `@onemundo.com.br` — canonicalizar antes de comparar, ou usar `sender_uid`.

**4.2.20 `e2ee5_metrics`** Req `MetricsSnapshot` do núcleo (§6.9) + `{"platform","app_version"}`
→ `{}`. Agrega por dia/plataforma em `e2ee5_metrics`. Nunca ids de mensagem. Campos aceitos (1.7):
`encrypt, decrypt_ok, utd_total, to_device_in, to_device_utd, dropped_untrusted, store_reloads,
key_req_sent, key_req_served, key_req_ok, key_req_refused`, `utd_json` (→ `utd.<motivo>`) e
`counters{}` só com `utd_60s, utd_resolved, enc_le50, enc_le150, enc_le500, enc_gt500,
missing_sessions, plaintext_refused, nse_fallback, native_timeout, native_err, core_slow,
key_request_sent, key_request_served, key_request_ok`. O servidor grava também, com
`platform="srv"`, `keyreq.srv_request|srv_dedup|srv_refused|srv_attested|srv_check_empty`.

**4.2.21 `e2ee5_key_request`** (1.7, destinatário) Req `{"conv_id":"2585","mid":"104080944762881",
"session_id":"<sid>","sender_uid":"7"}` → `{"req_id":"12","min_index":5,"dedup":false}`.
O servidor confere, e recusa com 403 `e2ee5_key_request_refused` + `data.reason` se não:
a mensagem `mid` existe nessa conversa, é envelope v5 dessa `session_id` e desse remetente
(`no_message`/`not_e2ee`/`session_mismatch`/`sender_mismatch`/`bad_envelope`); o chamador era
**membro da conversa na hora da mensagem** (`joined_at ≤ created_at + 5 s` e não tinha saído;
`not_member_at_message`); o aparelho chamador já existia (`created_at ≤ created_at da msg + 5 s`;
`device_after_message` — aparelho novo/reinstalação recupera pelo backup, não por pedido).
`min_index` = índice Megolm da mensagem (lido do `ciphertext`); repetições guardam o menor.
Dedupe: o mesmo (aparelho, sessão) pendente há < 20 s ⇒ `dedup:true` (o núcleo não manda o
`chatyy.key_request` de novo). Limites: 120/min por aparelho, 3.000/h por uid, 60 repetições do
mesmo pedido (429). Tabela `e2ee5_key_requests` (DDL 021, só ids/índice/horários; 7 dias).

**4.2.22 `e2ee5_key_request_check`** (1.7, remetente) Req `{"conv_id","session_id","target_uid",
"target_devices":["W…"]}` (≤ 20; vazio = todos que pediram) → `{"allowed":[{"device_id","min_index",
"req_id"}]}`: pedidos ≤ 48 h, ainda não atendidos, de aparelhos ativos do alvo, para sessões em
que o CHAMADOR é o remetente. Marca atendido. 300/min por aparelho.

**4.2.23 `e2ee5_devices_former`** (1.7) Req `{"user_ids":["@u42:chatyy"]}` (≤ 50) →
`{"device_keys":{"@u42:chatyy":{"<device_id>":{…device_keys como estavam, com a assinatura da SSK…}}}}`:
aparelhos **revogados** (≤ 400 dias, que eram assinados) de quem divide conversa comigo, ou meus.
Nunca entram no `keys_query` (aparelho revogado não recebe chave nova). O núcleo confere a
assinatura com a SSK ATUAL do dono antes de usar (§6.5). 60/min por aparelho.

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
| `e2ee5_server_read_refused` | 409 | (chat.php) ação que leria conteúdo de conversa cifrada: IA/Bia, tradução, transcrição, resumo, export, jogos (D2/D7) |
| `e2ee5_forward_client` | 409 | (chat.php) `chat_forward`/`chat_forward_multi`/`chat_clone_to_saved`/broadcast de mensagem cifrada — o cliente recifra e envia por conta própria |
| `e2ee5_key_request_refused` | 403 | (1.7) `e2ee5_key_request` recusado; `data.reason` ∈ `no_message`, `not_e2ee`, `session_mismatch`, `sender_mismatch`, `bad_envelope`, `not_member_at_message`, `device_after_message`, `device_mismatch` |
| `e2ee5_forbidden` | 403 | (`conversation_state set:0`) em grupo só admin rebaixa a criptografia |

### 4.6 Pedido explícito do usuário (`e2ee5x_*`, WP-16) e denúncia
Fonte: `/root/e2ee-2026-10-21/wp16/API.md`. O cliente manda **o trecho já decifrado** que o
usuário escolheu, depois do aviso "isto sai da criptografia" (D2). O servidor **não guarda
nada**: sem cache, sem log de conteúdo (só ids/tamanhos/códigos), sem moderação.
- `POST email.php?action=<ação>`, bearer normal. Obrigatórios em todas: `conversation_id`
  (o usuário tem de ser **membro** da conversa) e `no_store: true` (sem ele ⇒ 400 `e2ee5x_bad_request`).
- Kill: arquivo `api/.e2ee5x-off` ⇒ 503 `e2ee5x_disabled`.

| Ação | Entrada | `data` | Limite |
|---|---|---|---|
| `e2ee5x_translate` | `text` (≤ 5000), `target` (`pt-BR`, `en`, `es`…) | `{translation, target}` | 60/10 min |
| `e2ee5x_transcribe` | **multipart**: `file` (áudio decifrado no aparelho, ≤ 15 MB), `conversation_id`, `no_store=1`, `language?` | `{transcript, language}` | 30/10 min |
| `e2ee5x_summarize` | `messages:[{n:"nome", t:"texto"}]` (≤ 300 itens, ≤ 24.000 chars), `lang?` | `{summary}` | 30/10 min |
| `e2ee5x_ask` | `question` (≤ 2000), `excerpt:[{n,t}]` (≤ 100 itens, ≤ 16.000 chars), `lang?` | `{answer}` — o cliente **cifra e publica** com `via:"bia"` (§2.3) | 30/10 min |

Erros: `e2ee5x_bad_request` 400 · `e2ee5x_not_member` 403 · `rate_limited` 429 ·
`e2ee5x_unavailable` 502 · `e2ee5x_disabled` 503. Nada disso roda sem toque do usuário
(tradução e resumo automáticos ficam desligados em E2EE).

**Denúncia (D3)** — sem ação nova; fila central `mod_report` (`moderation_core.php`):
`{content_type:"message"|"group", content_id, conversation_id, reason, description?,
message_ids:[mid…] (≤ 10), evidence_texts:{"<mid>":"texto decifrado no aparelho"}}`.
Em conversa E2EE (ou conteúdo `{"e2e"`) o servidor usa **só** `evidence_texts` (o envelope nunca
entra na evidência) e grava `source:"reporter_supplied_unverified"`; sem texto do denunciante
a evidência fica só com ids/tipo/hora. `chat_report_user` e `chat_report_thread` aceitam os
mesmos `message_ids` + `evidence_texts` (espelho na fila central). Limites: 10/h, 40/dia.

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
| `key_request` (1.7) | 120/min por aparelho; 3.000/h por uid; dedupe 20 s por (aparelho, sessão) |
| `key_request_check` (1.7) | 300/min por aparelho |
| `devices_former` (1.7) | 60/min por aparelho |

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
  O relay **não** monta `reply_to.content` para envelopes: a prévia `reply_to` (WS e HTTP,
  `chatAuditReplyPreview`) vem com `content: ""` e o campo novo **`reply_to.e2e: true`** quando
  o pai é cifrado (ausente/`null` caso contrário). O cliente pega a citação do payload
  decifrado (`payload.reply.quote`) ou decifra o pai pelo `reply_to.id`.

### 5.3 Capacidades no auth (hub WP-06a, `HUB_E2EE5=1`)
A resposta de auth do hub ganha caps extras:
| Cap | Significado | Cliente faz |
|---|---|---|
| `e2ee5_ws` | o hub entende `e2ee5_device` e roteia `e2ee5_td`/`e2ee5_devices`/`conv_e2ee` | declara `e2ee5_device` |
| `e2ee5_ns` | o `native_send` aceita envelope `{"e2e":5…}` e impõe `e2ee_mode` (conta na allowlist do hub) | **só então** manda envelope pelo WS; sem a cap, envelope vai por HTTP (`chat_send`) |

Sockets de contas com `e2ee5_ws` aceitam frame WS de até **160 KiB** (o padrão de 64 KiB
derrubava o socket com envelope grande). O envelope continua limitado a 96 KiB (§2.6);
acima disso o hub responde o fallback atual `content_too_long`.

### 5.4 Recusa de envio pelo WS: frame `chat_send_error`
```json
{"type":"chat_send_error","success":false,"code":"e2ee5_plaintext_refused","http":409,
 "client_message_id":"…","conversation_id":"971","req_id":"…"}
```
| `code` | `http` | Quando |
|---|---|---|
| `e2ee5_plaintext_refused` | 409 | texto puro ou `{"e2e":N≠5}` em conversa `e2ee_mode=1` |
| `e2ee5_not_e2ee` | 409 | envelope em conversa `e2ee_mode=0` (cliente re-busca `conversation_state`) |
| `e2ee5_bad_request` | 400 | envelope com forma inválida |
O cliente **não** reenvia por HTTP após `chat_send_error` (a recusa é definitiva para aquele
conteúdo): marca a mensagem como falha e, em `e2ee5_not_e2ee`/`plaintext_refused`, atualiza o
estado da conversa e recifra/reenvia se fizer sentido. Flag do hub desligada ou conta fora da
allowlist ⇒ `chat_send_fallback` com `reason: "e2ee5_off"` (o cliente usa o HTTP, que impõe a mesma regra).

### 5.4bis Leaf regional e aceite regional (WP-06b)
- `LEAF_E2EE5_LOCAL=1` (arquivo de flags do edge, junto com `HUB_E2EE5=1` e a conta em
  `HUB_E2EE5_ALLOW`): envelope `{"e2e":5…}` válido, com a réplica mostrando `e2ee_mode=1`, é
  aceito **no edge** pelo mesmo caminho do texto (sem RTT ao US), sem ler conteúdo, com
  `reply_to {id}` e `sender_uid` no ack/frames. Todo o resto sobe ao US, que é a autoridade da
  recusa. O banco transforma em tombstone (`content ''`) qualquer lote com descompasso de modo.
- `REGIONAL_ACCEPT_E2EE=on` / `REGIONAL_ACCEPT_E2EE_MEDIA=on` (F3): o `regional-accept.php`
  passa envelope (e mídia cifrada sem nenhum campo de mídia em claro) ao spool do edge.
- **`chat_send_rejected`** (rejeição tardia do dreno do aceite regional, frame já existente)
  passa a levar **`data.code`** com os mesmos códigos do §5.4 (`e2ee5_plaintext_refused`,
  `e2ee5_not_e2ee`, `e2ee5_bad_request`…). Cliente: em `e2ee5_*`, atualizar
  `conversation_state` e recifrar/reenviar.

### 5.5 Canal de entrega dos avisos
O PHP publica `e2ee5_td`/`e2ee5_devices`/`conv_e2ee` em `chat_user_<e-mail canônico>` (§1.1).
O hub entrega no canal canônico **e** no alias `@onemundo.com.br` correspondente (o socket pode
estar inscrito em qualquer um dos dois). `e2ee5_td` com `device_id` pula sockets que declararam
outro `e2ee5_device`; socket sem `e2ee5_device` recebe sempre. Não gravam `ws_event_log` nem fila offline.

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
| `core_version()` | `"chatyy-crypto 0.1.0; contrato e2ee5-contrato/1.7; matrix-sdk-crypto 0.18.0; vodozemac 0.10.0"` |
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
request_room_key(conv_id, session_id, sender_uid, server_mid) -> KeyRequestResult{sent, dedup, req_id, sent_devices, reason}   // 1.7, §6.12
share_room_key(conv_id, session_id, target_uid, target_devices) -> ShareKeyResult{shared_devices, refused, reason}             // 1.7, §6.12
```
Regras de uso:
- `member_uids` em `encrypt` = membros **atuais** segundo o servidor (`conversation_state`);
  o próprio uid entra sempre (meus outros aparelhos).
- Sessão Megolm: rotação a cada **100 mensagens ou 7 dias**, ou quando a lista de aparelhos
  muda / alguém sai. Compartilhamento só com aparelhos **assinados pelo dono**
  (`IdentityBasedStrategy`); decifragem só de aparelhos assinados (`TrustRequirement::CrossSigned`).
- **Fila NSE → app (1.3)**: o `sync()` em papel `Push`/`Extension` avança o cursor do servidor.
  Para não perder nada, o núcleo grava no store os `chatyy_events` e `convs_with_new_keys` que
  esse processo consumiu (máx. 1000 eventos, 7 dias) e os entrega **uma vez** no próximo
  `sync()`/`sync_with()` do papel `App`/`Web`, antes dos eventos novos. O processo Push também
  os recebe no próprio retorno (pode ignorar). O host do app não precisa fazer nada além de
  tratar o `SyncResult` como sempre.
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
(1.7) Antes disso, com `__chatyy_e2ee5_keyreq`, o host pede a chave aos 3 s / 20 s / 50 s (§6.12).

(1.7) `unverified_sender` (**não retentável**): sessão importada (backup/vínculo/export) cuja chave
existe, mas cujo aparelho remetente não é assinado pelo dono nem na lista atual nem entre os já
desconectados (`e2ee5_devices_former`, assinatura conferida com a SSK atual). UI: "Não foi
possível decifrar" (o app não fica "aguardando" para sempre). Se o servidor não respondeu, segue
`untrusted_device` (retentável).

(1.7) `Trust::DeviceRemoved` (`trust: "device_removed"` no JS): mensagem de histórico enviada de um
aparelho do dono que JÁ FOI assinado por ele e hoje está desconectado. UI: aviso discreto
"Enviada de um aparelho que não está mais conectado" (não é alerta de segurança; `changed`
continua tendo prioridade).

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
dropped_untrusted, store_reloads, key_req_sent, key_req_served, key_req_ok, key_req_refused}` (1.7: `key_req_*`) — só contagens. `flush_metrics()` envia e zera.

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

### 6.12 Pedido de chave de sala (1.7) — "nunca perder mensagem"
Fonte: `native/chatyy-crypto/src/keyreq.rs`; testes `utd_pede_chave_remetente_reenvia_e_decifra`,
`quem_entrou_depois_nao_recebe_chave_do_passado`, `pedido_de_chave_dedupe_e_limite`,
`meu_outro_aparelho_encaminha_a_chave_automaticamente`; matriz T16.
1. **Destinatário** (UTD `missing_session`/`unknown_index` de mensagem com `mid` do servidor):
   `request_room_key(conv, session, sender_uid, mid)` → `e2ee5_key_request` (servidor atesta,
   §4.2.21) → `chatyy.key_request` por Olm a todos os aparelhos assinados do remetente. Dedupe
   local: 30 s por sessão, máx. 6/24 h; `own_session` se eu sou o criador.
2. **Remetente** (o host, ao receber `chatyy.key_request` no `SyncResult.chatyy_events`):
   `share_room_key(conv, session, sender_uid_do_evento, [sender_device_id_do_evento])`. O núcleo:
   (a) só o aparelho que CRIOU a sessão atende (`not_owner`); (b) `e2ee5_key_request_check`
   precisa atestar o aparelho (`not_attested`); (c) **registro local** `share_log` (gravado no
   `encrypt`: com quais aparelhos a sessão saiu e a partir de qual índice) — se a sessão tem
   registro e o usuário-alvo não estava nele ⇒ `not_member_at_share` (quem entrou depois nunca
   recebe, mesmo com servidor mentindo); (d) índice = max(`min_index` do servidor, índice do
   registro), exportado com `export_at_index` (nunca o passado anterior); (e) aparelho-alvo
   assinado pelo dono; dedupe 2 min por (sessão, aparelho); máx. 20 aparelhos.
3. **Destinatário**: o `sync()` importa o `chatyy.room_key` (§3) e devolve a conversa em
   `convs_with_new_keys` — o host re-tenta as mensagens "aguardando".
Por que não `m.forwarded_room_key`/`m.room_key` da biblioteca: o receptor só aceita forward de
aparelho PRÓPRIO, e reenviar a sessão de SAÍDA só serve do índice ATUAL (a catraca já passou).
Host JS (flag `__chatyy_e2ee5_keyreq`): pede aos 3/20/50 s; atende no máx. 30/min e 1×/min por
(sessão, aparelho); núcleo/servidor sem suporte (`unsupported`) ⇒ desliga sozinho. Web: o worker
expõe `requestRoomKey`/`shareRoomKey`, mas o wasm publicado só os ganha ao rodar
`vendor/chatyy-crypto-wasm/build.sh`. Nativo: BUILD.

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
| `e2e_np` | `"1"` = prévia oculta (conversa trancada / prévia "nunca" / tela bloqueada sem prévia); `"0"` = pode mostrar o decifrado. **Ausente = oculta.** A NSE/FCM só mostra texto com `e2e_np === "0"` explícito |

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
> **Estado da implementação (WP-07, 21/10):** ainda **não** implementada — só existe a ativação
> explícita `e2ee5_conversation_state {set:1}`. A regra abaixo continua sendo o alvo (F1/F7).

No `chat_send` / `conversation_state` / quando um membro ganha aparelho elegível: se elegível
e `e2ee_mode=0` ⇒ `e2ee_mode=1`, `e2ee_since_pts = next_pts`, mensagem `system`
`{"sys":"e2ee_on","since_pts":…}`, WS `conv_e2ee`. Nunca volta sozinha para 0.

### 8.4bis Edição
Oficial: edição = **linha nova** com payload `t:"edit"` e `edit_of` em claro (§2.4/§2.5). Por
compatibilidade, `chat_edit` também aceita envelope `{"e2e":5…}` no lugar do texto (substitui o
conteúdo e guarda a versão anterior como ciphertext em `chat_message_versions`); clientes novos
devem usar `edit_of`.

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
| `__chatyy_e2ee5_keyreq` (1.7) | JS global (OTA) | `services/e2ee/e2ee5.js` | pede/atende chave de sala (§6.12); desligado = só `decrypt_report` aos 60 s |
| `e2ee5_native` | `e2ee5_status.flags` | módulo nativo (WP-03) grava no store nativo ao abrir | o nativo só inicializa o núcleo se `true` |
| `e2ee5_media` / `e2ee5_calls` / `e2ee5_link` / `e2ee5_backup` / `e2ee5_push_decrypt` | `e2ee5_status.flags` (env `E2EE5_FLAGS=media,calls,…` + por conta) | clientes | um interruptor por fase |
| input `chatyy_crypto` | workflows CI | WP-02 | inclui o núcleo no binário (sem comportamento até as flags) |
| `chatyy.e2ee5.push_decrypt.u.<uid>` (bool) | UserDefaults do **App Group** (iOS) — gravada pelo WP-03 em `ChatyyCryptoHost.status()` = `e2ee5_native && flags.e2ee5_push_decrypt` | NSE (WP-10) | sem `true` explícito a NSE não abre o núcleo ("Nova mensagem") |
| `chatyy.e2ee5.push_decrypt.kill` (bool) | idem, App Group | NSE (WP-10) | `true` desliga a decifragem na NSE para todas as contas do aparelho |

Os clientes leem `e2ee5_status` no login, ao voltar ao 1º plano (máx. 1×/10 min) e após
`conv_e2ee`. Sem resposta ⇒ usa o último valor salvo; nunca liga sozinho.

---

## 10. i18n (chaves `e2ee5.*` nos arquivos de idioma atuais, dono WP-15)

As chaves ficam **nos arquivos de idioma existentes** (`i18n/pt-BR.js`, `i18n/en.js`, `i18n/es.js`,
`i18n/pt-PT.js`…), num bloco contíguo marcado `// [e2ee5]`, porque o `scripts/build-i18n-json.js`
gera os `.json` baixados pelo app a partir desses arquivos (um `i18n/e2ee5/*.js` importado não
entraria nos JSON). Formato plano `"e2ee5.<sub>.<chave>": "texto"`.
Cada pacote **só acrescenta no seu sub-namespace** (pedindo ao WP-15 ou no fim do bloco `[e2ee5]`):
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
