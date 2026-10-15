# Store local NATIVO do chat (expo-chat-store) — desenho + prova (fase 1)

2026-10-15 · status: **PoC implementada, NÃO buildada/commitada** · kill switch `globalThis.__chatyy_native_store = false`

O objetivo é o modelo do Telegram: um banco local nativo (conversas, mensagens,
recibos, mídia baixada) de onde as listas nativas renderizam direto. O sync de
rede escreve no banco em segundo plano e a UI nunca espera a rede nem o JS.

---

## 1. Como funciona hoje (medido)

### 1.1 Abrir a HOME (lista de conversas)

```
ChatListTab useState(() => …)                         [JS thread, síncrono, frame 1]
  └ chatStore.getConversationsSync()
      ├ smartChatCache.getCachedConversationsSync()   MMKV/memória (já aquecido no splash)
      └ sqliteStore.getConversationsSync()            expo-sqlite getAllSync (JSI)
            SELECT raw_json … LIMIT 200 → JSON.parse ×N → _overlayNewer (merge)
  └ (fallbacks: _getPreloadedConversations / SmartCache)
NativeConversationList
  └ buildRow(c, ctx) ×N  (prévia, hora, presença, digitando, avatar, anel…)  [JS]
  └ patcher.diff → prop rowsPatch                     [1 travessia JS→nativo, todas as linhas]
ChatyyConversationList (Swift/Kotlin) desenha
rede: chat_list / chat_sync (SWR) → setConversations → buildRow/diff → rowsPatch
```

Travessias da ponte na abertura: ~3–5 chamadas JSI síncronas (MMKV + SQLite +
PRAGMAs) + 1 prop grande (todas as linhas) + depois um patch por atualização.

### 1.2 Abrir uma CONVERSA

```
toque na linha → router.push → ChatConversationInner (≈40k linhas, 327 useState)
  render (JS):
    _readInitialCached()  (1×/conversa)
      chatStore.getMessagesSync(cid, 50) → sqliteStore: SELECT raw_json (JSI) → JSON.parse ×50
      _hydrateLocalMediaRows (índice de mídia local)
    → messages → threadListData (agrupamento, separadores, recibos, tradução…)
    → useNativeThreadList: unsupportedReason ×linhas
  commit (Fabric): cria TODAS as views da tela (header, composer, lista…)
  useEffect da ChatyyMessageList (depois do commit, na fila de efeitos da tela):
    buildRow ×N + JSON.stringify ×N (diff) → view.applyRows({keys, rows})   [1 travessia, ~6–8 KB/50 linhas]
  nativo: CMLRow(dict) → layout CoreText/StaticLayout em fila de fundo → main → snapshot do data source
  rede (em paralelo, não bloqueia a pintura): chat_messages, chat_info, chat_sync, mark_read, …
```

### 1.3 Números

**JS do caminho de dados (bench no Seattle, Node 24, `buildRow` REAL de
`components/chat/nativeThreadList.js` transpilado, mensagens reais da conv 971):**

| janela | raw_json lido | parse | enrich* | buildRow | stringify | total | payload p/ nativo |
|---|---|---|---|---|---|---|---|
| 50 texto | 42,7 KB | 0,15–0,25 ms | ~0,03 | 0,4–1,3 ms | 0,04 | **0,6–1,6 ms** | 6,2 KB |
| 50 (30% mídia) | 42,8 KB | 0,14 | ~0,01 | 0,3–0,4 | 0,03 | **0,4–0,6 ms** | 8,2 KB |
| 200 (30% mídia) | 171 KB | 0,5 | ~0,05 | 1,1–1,5 | 0,1 | **1,8–2,2 ms** | 28,5 KB |

\* enrich = aproximação barata do `threadListData` (o real faz mais coisa).
`--jitless` (proxy de interpretador, como o Hermes) deu o mesmo patamar.
Num Android médio com Hermes a regra prática é 4–8× um core de servidor →
**≈3–15 ms para 50 linhas, 10–25 ms para 200**. É o custo dos DADOS + LINHAS.

**Web no Seattle (Playwright, chatyy.com.br, conta QA, conv 971):**

| medida | valor |
|---|---|
| home: recarregar → linhas visíveis (cache) | 487–591 ms (inclui avaliar o bundle) |
| home a frio (sem cache) → linhas | 1,6–2,9 s (≈ resposta do chat_list) |
| conversa: toque → handler devolve | 82–204 ms (navegação + render da tela) |
| conversa: → bolhas visíveis | +47–82 ms → **130–290 ms toque→bolhas** |
| long tasks na abertura | 80–266 ms |
| commits React em 3 s | 25–82 |
| 1ª resposta de mensagens da rede | 454–1229 ms DEPOIS das bolhas (pintou do cache) |

**Conclusão da medição.** Os dados já são locais (o web pinta do cache antes
da rede; o nativo lê SQLite síncrono no 1º render). O custo de abrir NÃO é
ler/montar linhas (≈1–15 ms); é o **React montar a tela de 40k linhas** (long
task de 80–270 ms no web; 2,5–4k fibers) e a lista nativa só receber as linhas
**depois** disso: render → commit → fila de efeitos da tela → `applyRows` →
layout em fundo → snapshot. No nativo, a lista é a última a saber.

Também medido no código: persistência de mensagem hoje tem 4 cópias
(chatCache MMKV + smartChatCache MMKV + chatyy.db SQLite + IndexedDB no web) e
duas leituras paralelas no abrir (chatStore → sqliteStore, fallback SmartCache).

## 2. O que muda com o store nativo

A lista nativa ganha uma fonte que NÃO depende do JS: no instante em que a view
é criada (no mesmo commit da tela), ela lê o store e pinta. O JS deixa de estar
no caminho crítico da primeira pintura e de cada atualização vinda do sync.

Ganhos esperados por fase (estimativa):
- **Fase 1 (PoC, esta):** some o trecho "efeitos da tela → buildRow → ponte →
  applyRows" da 1ª pintura: 1–3 frames + a fila de efeitos (que numa tela deste
  tamanho é dezenas de ms no Android). Reabrir conversa = foto pinta no frame da
  montagem.
- **Fase 3 (casca leve):** com a lista lendo sozinha, dá para montar a lista
  nativa ANTES do resto da tela (rota leve que monta lista + composer, e o
  resto da tela depois). Aí o ganho é o long task inteiro (≈100–300 ms no
  Android médio) → abrir conversa em 1 frame, nível Telegram.

## 3. Arquitetura

```
             ┌──────────────── JS ────────────────┐
             │ chatSync / initialSync / WS (fase 1-2)│
             └──────┬───────────────────────────────┘
                    │ lote (1 string JSON / lote)  ← fase 2
                    ▼
┌─────────────────────────── expo-chat-store (nativo) ───────────────────────────┐
│ ChatyyStoreDB (Swift/Kotlin, SQLite do SISTEMA, 1 arquivo por conta, WAL)       │
│  fila serial dona da conexão · observadores por conversa · corrupção → recria  │
│  tabelas: thread_snap/thread_rows (fase 1) · conversations/messages/receipts/  │
│           reactions/media_local/cursors (fase 2)                                │
│  RowBuilder nativo (fase 2-3): mensagem → linha da lista (perfil de formato     │
│           vindo do JS: textos i18n, cores, flags)                                │
└───────▲───────────────────────────▲──────────────────────────────▲──────────────┘
        │ lê direto                 │ lê direto                    │ escreve direto (fase 2b)
  ChatyyMessageList           ChatyyConversationList        expo-chat-transport (WS nativo,
  (conversa)                   (home) — fase 1.5            outro agente)
```

### 3.1 Princípios
1. **SQLite do sistema** (iOS `libsqlite3`, Android `android.database.sqlite`).
   Nada de GRDB/Room/SQLCipher: zero dependência nova, zero bytes no binário.
2. **Um arquivo por conta**: `Application Support/chatyy-store/<sha256(email)[0..24]>.db`
   (iOS) / `noBackupFilesDir/chatyy-store/…` (Android). Isolamento físico: não
   existe "WHERE account_email esquecido" (a classe de bug de 05/10 e 14/10).
3. **Uma fila serial é dona da conexão** (lição do `sqliteWriteLane`): escrita e
   leitura nunca disputam handle; leituras síncronas para o JS são `queue.sync`
   curtas (PK lookup).
4. **Leitura direta pelas listas**: a view recebe só ids (`{a, c, …}`) e lê.
5. **O JS continua dono da lógica de sync no começo**; escreve em LOTE (uma
   string JSON por lote, decodificada no nativo fora da main). Na fase 2b o
   transporte WS nativo escreve direto (mesma API Swift/Kotlin, sem JS).
6. **É derivado do servidor**: corrupção/downgrade → apaga o arquivo e recomeça;
   fora do backup (iCloud/Auto Backup).
7. **Kill switch por fase** e fallback sempre para o caminho atual.

### 3.2 Esquema

Fase 1 (implementado, `user_version = 1`):
```sql
meta(k TEXT PRIMARY KEY, v TEXT)
thread_snap(conv TEXT PRIMARY KEY, rev TEXT, keys TEXT /*json, antiga→nova*/,
            newest TEXT, n INTEGER, updated_at INTEGER)       -- idx updated_at
thread_rows(conv TEXT, k TEXT, row TEXT /*json da linha*/, PRIMARY KEY(conv,k)) WITHOUT ROWID
```
Teto: 400 conversas com foto por conta (poda a cada 50 gravações), 60 linhas por
conversa. ~8–15 KB por conversa → ≤ 6 MB por conta no pior caso.

Fase 2 (canônico, `user_version = 2`, mesma base):
```sql
conversations(id TEXT PRIMARY KEY, type, name, avatar, last_msg_id, last_ts,
              unread INTEGER, pinned, muted, archived, folder_ids, pts INTEGER,
              read_watermark INTEGER, raw TEXT, row TEXT /*linha montada p/ home*/,
              row_rev TEXT, updated_at INTEGER)
messages(conv TEXT, id INTEGER, ckey TEXT /*msgKeyExtractor*/, client_id TEXT,
         sender TEXT, type TEXT, created_at INTEGER, edited_at INTEGER,
         deleted INTEGER, reply_to INTEGER, flags INTEGER, raw TEXT,
         row TEXT, row_rev TEXT, PRIMARY KEY(conv, id)) WITHOUT ROWID
         -- idx (conv, created_at), (client_id)
receipts(conv TEXT, msg_id INTEGER, delivered_at, read_at, PRIMARY KEY(conv,msg_id))
reactions(conv TEXT, msg_id INTEGER, emoji TEXT, users TEXT, PRIMARY KEY(conv,msg_id,emoji))
media_local(url_key TEXT PRIMARY KEY, path TEXT, w, h, bytes, last_used)
cursors(scope TEXT PRIMARY KEY, pts INTEGER, last_id INTEGER, updated_at)
outbox(client_id TEXT PRIMARY KEY, conv TEXT, payload TEXT, state, tries, created_at)  -- fase 4
```
`raw` = JSON do servidor (fonte de verdade p/ o JS e p/ reconstruir `row`);
`row` = linha pronta da lista no formato do `applyRows`; `row_rev` = assinatura
do formato com que foi montada (troca de bundle/tema/idioma → remonta).

### 3.3 API nativa (Swift/Kotlin, usada pelas views e pelo transporte)
- fase 1 (pronto): `saveThread(account, conv, rev, keys, rows)`,
  `loadThread(account, conv, rev, done)`, `newestSync`, `statsSync`,
  `wipeAccount`, `wipeAll`.
- fase 2: `applyBatch(account, json)` — upsert de conversas/mensagens/recibos/
  reações/tombstones + cursores numa transação; notifica observadores
  `(account, conv)` → a lista montada daquela conversa relê só as chaves
  afetadas. `messages(account, conv, beforeId?, limit)`; `conversations(account)`.

### 3.4 API JS (`modules/expo-chat-store/index.ts` + `services/nativeChatStore.js`)
- fase 1: `apiVersion`, `threadNewestSync`, `statsSync`, `wipeAccount`, `wipeAll`.
- fase 2: `applyBatchAsync(account, jsonString)` (1 string por lote, nunca
  arrays de objetos: o custo de conversão JSI→dicionário some),
  `setFormatProfile(account, profileJson)` (ver 3.5), `getMessagesSync`
  (substitui `chatStore.getMessagesSync` p/ quem ainda precisa no JS).

### 3.5 Montagem de linha (o ponto difícil)
Hoje a linha é montada no JS (`buildRow` + `nativeRowCards` + `nativeNodes`,
~2,6k linhas, com i18n, cores, ícones SVG, cartões). Portar tudo de uma vez p/
Swift+Kotlin é o maior risco do projeto. Estratégia em 3 degraus:
1. **Fase 1 — foto**: o nativo guarda a linha que o JS montou (sem portar nada).
2. **Fase 2 — linhas montadas na escrita**: quando o sync (JS) grava mensagens
   no store, o JS manda junto a `row` já montada (o `buildRow` roda FORA do
   caminho crítico, no momento do sync, com um contexto mínimo independente da
   tela: `rowCtx` derivado de tema/idioma/conta — extrair de `_nlCtx`).
   Mensagem nova de conversa fechada → linha já pronta no store → abrir pinta
   tudo, inclusive o que chegou com a conversa fechada.
3. **Fase 3 — RowBuilder nativo** para os tipos comuns (texto/markdown simples,
   mídia, áudio, arquivo, sistema, data): o que o transporte WS nativo grava
   vira linha sem JS. Tipos ricos continuam vindo montados do JS (degrau 2).
   O "perfil de formato" (strings i18n: Hoje/Ontem/editada/apagada…, cores,
   formato de hora) vem do JS 1× por sessão (`setFormatProfile`).

## 4. Fluxos

**Leitura (abrir conversa).** JS renderiza `<ChatyyMessageList storeConv={{a, c, x, n}}>`.
A view: `setStore` → `loadThread` na fila do store (SELECT + JSON decode) → main
→ `applyRowsCore(fromStore)` → layout em fundo → pinta. O 1º `applyRows` do JS
substitui; linha idêntica à da foto mantém linha+layout (sem piscar).

**Escrita (fase 1).** Depois de cada `applyRows` do JS a view agenda (1,2 s,
debounce; e ao sair da janela/destruir) a gravação das 60 linhas mais novas
exatamente como o JS mandou — sem seleção, progresso de upload, "N não lidas"
e mensagens `tmp`. Nada cruza a ponte (a view já tem os dicionários).

**Escrita (fase 2).** `chatSync`/`initialSync`/WS (JS) chamam
`applyBatchAsync` com o mesmo lote que hoje vai para `chatStore.upsertMessages`.
Durante a transição o store nativo SUBSTITUI uma das cópias (não soma uma 5ª):
primeiro o `smartChatCache` de mensagens (MMKV), depois o `chatyy.db`.

**Escrita (fase 2b).** `expo-chat-transport` (WS nativo, outro agente) chama a
API Swift/Kotlin `applyBatch` direto ao receber `chat_message`/`receipt`/
`reaction`/`delete` e avisa o JS por evento só para estado de UI.

**Atualização ao vivo.** Fase 1: JS manda tudo como hoje. Fase 2: observador
por conversa no store → a lista montada relê as chaves tocadas; o JS só manda
estado efêmero (seleção, áudio tocando, destaque).

## 5. Migração do SQLite JS (chatyy.db)

O chatyy.db (expo-sqlite, `services/db.js` dono do esquema) tem `messages`/
`conversations` com `raw_json` e `account_email` (NULL = legado, visível só ao
"legacy owner" — `chatStore/schema.js acctClause`).
1. **Importação nativa 1×/conta (fase 2):** o store abre o chatyy.db do
   expo-sqlite **somente leitura** (iOS `Documents/SQLite/chatyy.db`, Android
   `files/SQLite/chatyy.db` — confirmar o caminho do expo-sqlite 55 no binário)
   e copia `raw_json` das últimas 200 mensagens de cada conversa com
   `account_email = conta OR (account_email IS NULL AND conta = legacy_owner)`
   (o `legacy_owner` está em `chatstore_meta`). Marca `meta.imported_from_jsdb`.
   Lê numa conexão própria em WAL — não precisa da `sqliteWriteLane` (não
   escreve lá).
2. **Escrita dupla** (JS → chatyy.db + store nativo) até o store ser a leitura
   padrão por 1 build inteiro sem regressão (beacons `store_ready`).
3. **Corte:** `chatStore.getMessagesSync` lê do nativo; `smartChatCache`
   (mensagens) e o mirror MMKV de conversas saem; chatyy.db fica só p/
   outbox/bgJournal até a fase 4.
Rollback em qualquer passo = kill switch (JS volta a ler o chatyy.db, que
continuou sendo escrito).

## 6. Isolamento por conta e criptografia em repouso

- **Isolamento**: 1 arquivo por conta (hash SHA-256 do e-mail normalizado). A
  lista só abre o arquivo da conta que o JS passou. Logout/troca:
  `AuthContext.clearLocalChatStore` → `wipeNativeStore()` (apaga o diretório
  inteiro, igual ao que hoje acontece com o chatyy.db). Implementado na PoC.
- **Criptografia hoje no app**: NÃO há SQLCipher (chatyy.db em claro) nem
  `encryptionKey` no MMKV. Proteção = a do SO. O store nativo segue o mesmo
  nível, explícito: iOS `NSFileProtectionCompleteUntilFirstUserAuthentication`
  no diretório e no arquivo (permite push/sync em 2º plano após o 1º desbloqueio)
  + fora do backup do iCloud; Android `noBackupFilesDir` (credential-encrypted
  pelo FBE, fora do Auto Backup).
- **Se quiserem cifrar além do SO (fase 4, opcional):** cifrar só as colunas
  `raw`/`row` com AES-GCM (CryptoKit / `javax.crypto`), chave por conta no
  Keychain (`AfterFirstUnlockThisDeviceOnly`) / Android Keystore. Custo ~µs por
  linha; não exige SQLCipher. Não recomendado antes da fase 2 estabilizar.

## 7. A prova de conceito (fase 1) — o que foi entregue

| arquivo | o quê |
|---|---|
| `modules/expo-chat-store/` (novo) | módulo `ChatyyChatStore`: `ios/ChatyyStoreDB.swift` + `ChatyyChatStoreModule.swift` + podspec `ExpoChatStore` (libsqlite3, DEFINES_MODULE); `android/…/ChatyyStoreDB.kt` + `ChatyyChatStoreModule.kt` (sem deps novas); `index.ts` |
| `modules/expo-chat-message-list` | apiVersion **4**: prop `store {a,c,r,n}`, evento `onStore`, `onReady.src` ('store'/'js'); `setStore`/`persistNow`/`applyRowsCore` em `CMLListView.swift` e `MLListView.kt`; toques/long-press/arrastar ignorados enquanto só a foto está na tela; podspec `s.dependency 'ExpoChatStore'`; gradle `project(':expo-chat-store')` |
| `services/nativeChatStore.js` (novo) | gate + kill switch `__chatyy_native_store`, `fnv`, `localDay`, `threadNewestSync`, `wipeNativeStore` |
| `components/chat/nativeThreadList.js` | prop `storeConv` → `store` (rev = bundle+api+tema+fonte+escuro+idioma/grupo+dia local); beacon `native_list store_ready src=… ms=… store=why/ms/rows` (6 primeiras aberturas da sessão) |
| `app/chat-conversation.js` (bloco `_nl*`) | `_nlStore` + `storeConv={_nlStore}`; lista nativa monta com cache JS vazio se existir foto (só enquanto `loading`) |
| `context/AuthContext.js` | `clearLocalChatStore` também apaga o store nativo |

Regras de segurança da foto:
- só pinta se `rev` bater (bundle/tema/fonte/idioma/dia diferentes → ignora);
- só pinta se a chave mais nova da foto == a mais nova que o JS tem (`n`) —
  foto mais velha que o SQLite JS não aparece (evita "mensagem nova surge depois");
- só pinta se o JS ainda não mandou linhas; o JS sempre vence;
- é cache: erro/corrupção → apaga e segue no caminho atual.

Verificado aqui: Kotlin dos 2 módulos compila (kotlinc 2.1.20 + android.jar 35 +
expo-modules-core, `nice -n 19`); Swift passa no parser (tree-sitter) e foi
revisado à mão (tipos/bridging); SQL validado no sqlite3; JS babel OK + scan de
escopo dos identificadores novos. **Não buildado.**

Como validar no aparelho (após build): abrir uma conversa, sair, reabrir →
beacon `native_list store_ready src=store ms=…` (vs `src=js`) no `callkit_diag`;
`require('services/nativeChatStore').nativeStoreStats(email)` mostra
threads/rows/bytes. Desligar: `globalThis.__chatyy_native_store = false` (OTA).

Limitação conhecida da fase 1: conversa que recebeu mensagem com ela fechada →
foto "stale" → caminho atual (JS). É exatamente o que a fase 2 resolve.

## 8. Fases seguintes

| fase | entrega | depende de | binário? |
|---|---|---|---|
| 1 (esta) | foto por conversa lida/gravada pela lista nativa | — | sim |
| 1.5 | mesma foto p/ a HOME (`ChatyyConversationList` lê `conv_snap`) + **prewarm no pressIn** da linha da home (lê + decodifica a foto antes da navegação) | 1 | sim |
| 2 | tabelas canônicas + `applyBatchAsync` (JS sync escreve em lote com `row` montada via `rowCtx` fora da tela) + importação do chatyy.db + observadores; lista lê `messages.row` (sem stale) | 1 | sim |
| 2b | `expo-chat-transport` grava direto (sem JS) | 2 + transporte | sim |
| 3 | casca leve da conversa (lista+composer montados antes do resto da tela) + RowBuilder nativo p/ tipos comuns | 2 | sim + JS |
| 4 | outbox nativo, mídia local indexada, cifra de colunas (opcional), aposentar smartChatCache/chatCache MMKV | 3 | sim |

## 9. Riscos

- **Formato da linha muda por OTA** → foto com linha que o nativo novo não
  entende ou o JS novo monta diferente. Mitigado: `rev` inclui a versão do
  bundle e a apiVersion; foto de outro formato não é pintada.
- **Foto mostrando estado velho** (recibo ✓ cinza que já é azul, reação) por
  1 frame até o JS → aceitável na fase 1; some na fase 2 (recibos no store).
- **Privacidade multi-conta**: arquivo por conta + wipe no logout/troca. Risco
  residual: crash entre trocar de conta e o wipe → a foto da conta A continua no
  arquivo DELA (nunca é lida pela B, pois a chave é o hash da conta).
- **Dependência entre módulos nativos** (message-list → chat-store): se o pod/
  projeto não for autolinkado o build quebra (o autolinking do Expo pega tudo
  em `modules/`; iOS: `s.dependency 'ExpoChatStore'` + código guardado por
  `canImport(ExpoChatStore)`; Android: mesmo padrão do
  `expo-callkit → :expo-screen-share`). Conferir no 1º build que o pod
  `ExpoChatStore` e o projeto `:expo-chat-store` aparecem.
- **Duas fontes de verdade durante a migração** (fase 2) — mitigado por escrita
  dupla + kill switch + importação idempotente.
- **Portar `buildRow`** (fase 3) é o item mais caro; por isso o degrau 2 (linha
  montada no JS na hora do sync) vem antes e já entrega o "nunca stale".
- **Disco**: teto de 400 conversas × 60 linhas por conta (≤ ~6 MB).
- **Concorrência com o transporte nativo**: uma fila serial por processo é a
  dona; o transporte usa a mesma `ChatyyStoreDB.shared` (nunca abre conexão
  própria).

## 10. Coordenação
- `services/websocket.js`: não tocado. `app/chat-conversation.js`: só o bloco
  `_nl*` (+1 prop no JSX da lista nativa).
- Transporte WS nativo (outro agente): deve depender de `expo-chat-store` e
  gravar via `ChatyyStoreDB.shared` (Swift) / `ChatyyStoreDB.get(ctx)` (Kotlin)
  a partir da fase 2 (API `applyBatch`, a definir junto).

---

## 11. Fases 1.5, 2 e 3 — entregues (2026-10-15, NÃO buildado/commitado)

Kill switches: `__chatyy_native_store = false` (tudo), `__chatyy_conv_light_shell = false` (só a casca).
Binário sem o módulo / phase-1 (store apiVersion 1) / web → caminho atual idêntico.

**Store nativo v2** (`user_version = 2`, migra do v1 sem perder fotos; store `apiVersion 2`):
- tabelas `home_snap/home_rows` (foto da home) + canônicas `conversations, messages (≤400/conv),
  receipts (monotônico), reactions (troca por msg), cursors (monotônico)`. Sem UPSERT (Android API 24).
- `applyBatch(account, json)` (Swift/Kotlin **públicos** — 2b: o `expo-chat-transport` chama direto) /
  JS `applyBatchAsync`. Lote = `{conversations, conv_deletes, messages, msg_deletes, receipts, reactions,
  cursors, threads}`; `threads[] = {conv, rev, ops}` com ops na foto: `append {after, rows}`,
  `set {k, set}`, `put {k, nk?, row, keep[]}`, `stUpTo {id, st}`, `drop`. Uma transação; poda; observadores.
- `prewarmThread` + `cachedThread` (LRU 4 em memória), `addObserver/removeObserver` (main),
  `messagesJSONSync`, `saveHome/loadHome/homeTopSync`.

**1.5 home**: `ChatyyConversationList` apiVersion 2, prop `store {a, r, n, s}`. Sem linhas do JS → pinta a
foto; 1º reset do JS substitui; regrava 60 linhas (debounce 1,5 s / saída) sem digitando/seleção/online.
`NativeConversationList` (só lista principal: filtro "Todas", sem busca/seleção) adia o buildRow p/ depois do
1º frame quando `homeTopSync` bate (rev = bundle+api+escuro+idioma+dia; top = 1ª conversa).
**pressIn**: `ChatListTab.rowPrefetch` → `prewarmThread` → a lista da conversa pinta SÍNCRONA no set da prop
(`onStore why=mem`).

**2 escrita dupla**: `services/db.js` (`dbSaveMessages/dbSaveConversations/dbDeleteMessage`),
`sqliteStore.upsertMessagesSync`, `bgJournal` (merge de 2º plano) → `nativeChatStore.mirror*` → lote
coalescido 150 ms. `services/nativeStoreRows.js` monta FORA DA TELA (buildRow real + o ctx que a
`<ChatyyMessageList>` registrou nesta sessão) as linhas novas das conversas fechadas → `append` (agrupamento
60 s, separador de dia), `put` (editada/apagada/reação, mantém first/last/name/st), `stUpTo` (✓✓/azul),
`drop` (álbum/tipo não suportado). Limite: conversa que não abriu nesta sessão (sem ctx) segue a regra da fase 1.
Não implementado: importação nativa do chatyy.db (§5.1) e leitura pelo nativo (corte) — o JS continua lendo o chatyy.db.

**3 casca leve**: `ChatConversationScreen` → `ConvLightShellHost`. 1º frame = cabeçalho + lista nativa
(foto, `shell`) + composer nativo (sem toque); `ChatConversationInner` (inalterado) monta por baixo após a
transição (`transitionEnd` ou 400 ms) e a casca sai quando a lista dele dá `onReady` (teto 1,5 s). Só entra
com registro `services/convShell` (props exatas da lista + posição na janela + inset do composer, gravados
pela tela completa), layout simples (lista colada no cabeçalho), sem params extras, `unread=0`, mesmo
tema/idioma e foto no store. Beacons `conv_shell shell_paint ms=… / full_ready ms=…` (t0 = toque na home)
e `native_list store_ready`.

Medição web (Seattle, conta QA, conv 971; casca é só nativa): sem mudança mensurável — x1: toque→bolhas
≈165–180 ms antes/depois; x4 CPU: long tasks ≈930–1000 ms nos dois (ruído ±100 ms). Fibras da tela no web:
6219, 95% são as linhas da FlashList — no nativo (lista nativa) a tela JS tem ~300 fibras + ~670 hooks; o
ganho da casca é tirar esse render inteiro da frente da 1ª pintura (medir nos beacons após o build).

---

## 12. Fases 2b e 4 — transporte grava direto + fila de envio NATIVA (2026-10-15, NÃO buildado/commitado)

Binários: transporte `ChatyyTransport.version() = 2`, store `apiVersion = 3` (`user_version = 3`, tabela
`outbox`). Binário velho / web → caminho atual idêntico (gates por versão).

**Kill switches (OTA):** `__chatyy_native_ingest = false` (transporte não grava no store),
`__chatyy_native_text_rows = true` (LIGA as linhas nativas de texto; padrão DESLIGADO),
`__chatyy_native_outbox = false` (volta tudo à fila JS; o que já está no nativo ele termina de enviar).

### 12.1 Fase 2b — transporte → store sem JS
- `open(config)` ganhou `account` (do JS) e `storeIngest`. A conta é confirmada pelo e-mail de TOPO do
  `auth_success` (último `"email"` do frame; chaves do Go em ordem alfabética) — divergiu → não grava
  (`authAccountMismatch`). `caps` → `native_send`.
- Frames `chat_message/chat_summary/edit/delete/reaction/chat_read/chat_delivered` (pré-filtro por agulha,
  sem parse no transporte) vão em lote, no mesmo flush de 16 ms da entrega ao JS, para
  `ChatyyStoreDB.ingestFrames` (fila do store). O JS continua recebendo tudo igual (lógica dele).
- `StoreIngest.kt` / `ChatyyStoreIngest.swift` (puros): frame → lote (`messages`, `receipts`, `reactions`)
  + chaves internas: `self_reads` (minha leitura → `conversations.unread=0`, cursor `read:<conv>`),
  `peer_reads` (cursor `peer_read:<conv>:<email>`; **só conversa direct**: recibos `read_at` das minhas +
  `stUpTo st 3` na foto), `delivs` (`delivered_at` + `stUpTo st 2` só direct), `conv_types`, `touch`.
- Foto: mensagem nova/editada/apagada/reação que a foto não tem → marca `meta stale:<conv> = id`.
  Limpa quando a lista grava a foto (`saveThread`) ou quando uma operação do JS leva a foto até ≥ esse id.
  JS: `nativeChatStore.threadStaleSync`; a casca leve (fase 3) não entra com foto desatualizada.
- **RowBuilder nativo de texto simples** (flag): `nativeStoreRows` manda por conversa (1:1, aberta nesta
  sessão) um perfil tirado do ctx REAL (`setThreadProfile`: rev, conta, formato de hora 24h/12h, rótulo
  "Hoje", `allow`/`deny` — sem marcação/link/@/#/dígitos/palavras de lembrete-reunião). Nova mensagem
  qualificada, sem lacuna no canônico e com a foto em dia → `set last:0` (agrupa ≤60 s) + `append` (+
  separador "Hoje"). Quando o JS processa a mesma mensagem, o `append` dele (com `after` antigo) **troca a
  linha no lugar** (`append` passou a aceitar linhas já presentes; divergência com lacuna → apaga a foto).
- Testes: `StoreIngest` na JVM com frames REAIS do hub (capturados com apitest↔qa2); `ChatyyStoreDB.kt`
  inteiro na JVM com shim de `android.database.sqlite` sobre sqlite-jdbc (21/21: stale, linha nativa,
  troca pela oficial, lacuna, recibos ✓✓/azul, edição, frames reais, SQL do outbox).

### 12.2 Fase 4 — fila de envio nativa
- Tabela `outbox(cmi PK, conv, seq, kind text|media, body (JSON do chat_send), frame (chat_send WS),
  file, up, state queued|uploading|sending|sent|failed, tries, next_at, err, server, …)` no arquivo da conta.
- Motor: `OutboxCore.kt` (puro: org.json + OkHttp — o MESMO arquivo roda no app e na JVM) /
  `ChatOutbox.swift`. Roda na fila do transporte. WS nativo autenticado + `native_send` → frame `chat_send`
  (ack 4 s) → senão HTTP `https://chatyy.com.br/api/email.php?action=chat_send` (origem US, Bearer).
  FIFO por conversa; mídia sem `file_url` sobe em paralelo (`/api/rust/upload`, POST único) e entra na
  ordem pelo seq. Backoff 1-2-4-8-15-30-60-120-300 s ±20 %; offline não conta; 401 → `auth_needed` (JS
  renova e reconfigura); 429 → `retry_after`; só 4xx definitivo vira `failed`. `sending` órfão → `queued`
  no próximo processo. `sent`/`failed` ficam até o JS conciliar (`outboxAck`) ou 7 dias.
- Store reflete: `outboxSent` grava a mensagem canônica + op `ack` na foto (relógio → ✓ + id do servidor,
  nunca rebaixa ✓✓/azul); falha → op `fail` (`st -1`, só de relógio).
- 2º plano: iOS — `beginBackgroundTask` (até ~25 s drenando ao ir pro fundo) + `BGAppRefreshTask`
  `com.onemundo.mail.outbox` (Info.plist via app.json; registro no `didFinishLaunching` por
  `ChatOutboxAppDelegateSubscriber`, só se o id estiver permitido) + `URLSession` de 2º plano
  `com.onemundo.mail.nativeOutbox` para upload de mídia (corpo multipart em arquivo; relança o app e
  conclui o chat_send). Android — `ChatyyOutboxWorker` (WorkManager, rede obrigatória, KEEP, backoff
  exponencial; agendado ao enfileirar (+15 s, rede de segurança) e ao ir pro fundo com pendência).
- Credenciais p/ reenviar sem o JS: iOS Keychain (`AfterFirstUnlockThisDeviceOnly`), Android arquivo
  privado em `noBackupFilesDir/chatyy-outbox`. Logout (`wipeNativeStore`) → `outboxForget`.
- JS (`services/nativeOutbox.js`): `sendTextNow` (api.chatSend → `_tryNativeWsSend`: grava no nativo e
  espera o ack ~8 s; sem ack → `{_deferred, _native_queued}` = relógio, SEM fallback JS),
  `sendRowAndWait` (sendWorker: texto e commit de mídia com `cdn_url`), `handoffUpload` (mediaSendQueue:
  arquivo ≤ 1 MB, não-áudio, link rápido), eventos `onOutboxState` → `markSent/markFailed` + eco local
  `chat_message` (+ `onCommitted` da mídia, `promoteReady` do álbum). A varredura global do sendWorker
  entrega TODAS as linhas elegíveis de cada conversa ao nativo (não só a cabeça) e segura as linhas
  não-elegíveis atrás delas. `isOwnedSending` considera "possuída pelo nativo" (TTL 10 min). Boot:
  `reconcile` (o que o nativo enviou com o JS morto) + `migratePending` (linhas de texto da fila JS).
- Fica no JS: web, envelope/E2EE, tópico, meta/replyExt, voz/áudio (PHP transcodifica), sessão de voz,
  view-once, mídia > 1 MB (pedaços retomáveis + bgTransfer, que já é nativo).
- Testes (scratchpad `nob/`): `jvm/OutboxTest.kt` = OutboxCore REAL contra hub + chat.php de produção
  (apitest→qa2, conv 971): rajada 25 (WS, 1,3 s, ordem OK, 0 dup), queda de rede no meio (12/12, ordem
  OK, 0 dup), processo morto com `Runtime.halt` no meio (10/10 após reabrir, 0 dup), duplicata (mesmo
  cmi → 1 linha / reenvio forçado → mesmo id), só HTTP (6/6), mídia (upload + commit; texto não fica
  preso atrás). `js/run-nob.js` = JS real (messageOutbox/sendWorker/mediaSendQueue/nativeOutbox) com
  fake do módulo: 29/29 (rajada, deferido offline, JS morto → nativo envia → boot concilia, nativo morto,
  migração, kill switch, mídia/álbum, corrida de duplicata, 403). Regressões: `harness/run-mw.js` 51/51,
  transporte `tr/h run.js native` igual ao de antes.
- Riscos: Swift NÃO compilado (só tree-sitter + revisão); BGAppRefreshTask é oportunista (o iOS decide
  quando roda); HTTP nativo vai à origem US (sem aceite regional do edge: +100–250 ms no BR/EU quando o
  WS não está pronto); upload nativo sem barra de progresso real (fases 10 %→commit); `native_send`
  hoje só p/ contas com a capability no hub (as demais: HTTP nativo).
