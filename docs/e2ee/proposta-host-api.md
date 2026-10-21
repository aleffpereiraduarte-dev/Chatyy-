# Proposta: API JS do host de cripto (`services/crypto`) — web (WP-04) e nativo (WP-03)

Autor: WP-04 (host web), 21/10/2026. Estado: **NORMATIVA desde o contrato 1.1 (§6.11)**; as
decisões do WP-00 no §6.11 prevalecem sobre este texto. Antes era proposta ao
`docs/e2ee/CONTRATO.md` (o contrato 1.0 fixa a API do núcleo em §6, mas não a API JS que o
app importa). Implementação de referência web: `services/crypto/index.web.js` (commitado).

## 1. Princípios

1. `import * as crypto from '../services/crypto'` resolve `index.web.js` na web e
   `index.native.js` no iOS/Android (WP-03). **Mesmos nomes, mesmos argumentos, mesmos
   formatos de retorno e mesmos códigos de erro** nos dois.
2. Tudo é **Promise** (exceto `isEnabled()` e `platform`).
3. Nomes = os do CONTRATO §6.3/§6.4 em camelCase. Argumentos posicionais simples; objetos
   em camelCase. Os campos de retorno são os das structs Rust em camelCase
   (`envelope_json` → `envelopeJson`).
4. Payload/conteúdo podem ir como objeto **ou** string JSON; retornos JSON aninhados que o
   núcleo devolve como string continuam string (`payloadJson`, `contentJson`, `infoJson`,
   `utdJson`) para o chamador não re-serializar (o payload decifrado deve ser preservado).
5. Bytes = `Uint8Array`.
6. O host esconde `store_dir`, `store_passphrase`, `role` e `holder_suffix` (são do host: Keychain/
   Keystore/WebCrypto). O JS só passa `uid`.
7. **Flag**: `isEnabled()` = `globalThis.__chatyy_e2ee5 === true` (web) / idem + `e2ee5_native`
   do servidor gravado pelo módulo (nativo). Com flag desligada nenhuma função carrega o
   núcleo; todas rejeitam com `code: 'disabled'`.

## 2. Funções

### Ciclo de vida
| Função | Retorno | Notas |
|---|---|---|
| `isEnabled()` | `boolean` (síncrono) | flag do cliente |
| `isSupported()` | `{ok, reason?, worker?, wasm?, subtle?, indexedDB?, locks?}` | web: sem IndexedDB (modo privado) ⇒ `ok:false` e o app mostra aviso, não ativa |
| `setAuth({base, bearer})` | `void` | `base` = origem da API (`''` = mesma origem). Chamar no login e quando o bearer muda. Nativo: pode ignorar (usa o do `ChatTransport`). |
| `status()` | `data` de `e2ee5_status` (§4.2.1) | sem precisar de `open` |
| `open(uid, {prefix?})` | `{uid, deviceId, created}` | sem rede; cria aparelho na 1ª vez. `prefix` só `'X'` em testes (web padrão `'W'`, celular `'P'`). |
| `close()` | `void` | |
| `wipe(uid)` | `{deleted}` | logout/desvincular: apaga store + aparelho; próximo `open` = aparelho novo |
| `terminate()` | `void` | web: encerra o worker (store fica) |

### Funções livres (§6.3)
`coreVersion()` → string · `newDeviceId(prefix)` → string · `envelopeVersion(content)` → `5 | N | null` ·
`encryptBytes(u8)` → `{data: Uint8Array, infoJson}` · `decryptBytes(u8, infoJson)` → `Uint8Array` ·
`safetyNumberFor(uidA, mskA_u8, uidB, mskB_u8)` → `{digits, qrPayload}`.
Nativo acrescenta `encryptFile(inPath, outPath)` → `{infoJson, size}` e
`decryptFile(inPath, outPath, infoJson)` → `number` (não existem na web: a web só tem bytes).

### CryptoCore (§6.4)
| Função | Retorno |
|---|---|
| `thisDevice()` | `DeviceSummary {uid, deviceId, ed25519, curve25519, signedByOwner, isThisDevice}` |
| `sync()` / `syncWith(syncData)` | `SyncResult {toDeviceProcessed, toDeviceUtd, convsWithNewKeys[], chatyyEvents[{eventType, senderUid, senderDeviceId, contentJson}], identityChangedUids[], more}` |
| `trackUsers(uids[])` | `{}` |
| `encrypt(convId, memberUids[], payload)` | `{envelopeJson, sessionId, keyShareRequests, keyShareBytes}` |
| `decrypt({convId, envelopeJson, senderUid, serverMid, cmid, tsMs})` | `{payloadJson, senderUid, senderDeviceId, trust: 'verified'|'tofu'|'changed', sessionId}` |
| `sendToDevice(eventType, targets[{uid, deviceId}], content)` | `{sentDevices, withheld[]}` |
| `rotateConversation(convId)` | `boolean` |
| `onMembersChanged(convId, memberUids[], removedUids[])` | `{}` |
| `forgetDevice(deviceId)` | `number` |
| `listDevices(uid)` | `DeviceSummary[]` |
| `bootstrapIdentity()` / `identityStatus(uid)` | `IdentityStatus {uid, hasIdentity, masterKey, verified, needsApproval, isPrimary}` |
| `signDevice(deviceId, expectedEd25519)` · `pinIdentity(uid)` · `markVerified(uid)` | `{}` |
| `safetyNumber(uid)` | `{digits, qrPayload}` |
| `verifySafetyQr(uid, scanned)` | `boolean` |
| `exportRoomKeys({convIds, sinceMs})` | `Uint8Array` (SEGREDO) |
| `importRoomKeys(u8)` / `importRoomKeysWithPassphrase(data, pass)` | `{imported, total, convs[]}` |
| `exportRoomKeysWithPassphrase(pass)` | `string` |
| `backupEnable(pass?)` | `{recoveryKey, version}` |
| `backupStep(maxBatches)` | `number` |
| `backupStatus()` | `{enabled, version, totalKeys, backedUpKeys}` |
| `backupDisable()` | `{}` |
| `backupRestore(keyOrPass)` | `{imported, total, identityRestored, convs[]}` |
| `metricsSnapshot()` | `{encrypt, decryptOk, utdJson, utdTotal, toDeviceIn, toDeviceUtd, droppedUntrusted, storeReloads}` |
| `flushMetrics()` | `{}` |

### Vínculo QR, lado web (§6.7, F4 — só web)
`linkBegin()` → `{linkId, qrPayload}` · `linkPoll(linkId)` → `{state:'waiting'} | {state:'hello', uid, checkCode} |
{state:'granted', bearer} | {state:'importing', receivedChunks, totalChunks} | {state:'done', imported}` ·
`linkSendDevice(linkId)` (depois de `hello` + `open(uid)`) · `linkCompleteUpload(linkId)` (depois de `granted`;
o host já instalou o bearer no transporte) · `linkCancel(linkId)`.
Lado celular (nativo, WP-03/WP-12): `linkAccept(qrPayload, {convIds, sinceMs})` → `{checkCode}` e
`linkPhonePoll()` → `{state:'waiting_device'|'waiting_upload'|'sent'|'done', deviceId?, chunks?}` — **a confirmar pelo WP-03**.

## 3. Erros

A Promise rejeita com `Error` cujo `.code` é:

| `.code` | Origem | `.details` |
|---|---|---|
| `disabled` | flag desligada | — |
| `unsupported` | navegador sem Worker/WebAssembly/IndexedDB/WebCrypto | `{what}` |
| `not_ready` / `not_open` | chamada antes do init / do `open` | — |
| `wasm_fetch` / `wasm_integrity` | web: .wasm não baixou / SHA-256 diferente do embutido | `{status?}` |
| `wasm_trap` / `worker_error` / `terminated` | web: o wasm abortou ou o worker caiu; a próxima chamada recria o worker (store intacto) | — |
| `utd` | `CoreError::Utd` | `.reason` = `UtdReason` (§6.5), `.retryable`, `details.session_id` |
| `invalid_input` | `{field, msg}` |
| `transport` | `{msg}` |
| `server` | `{status, server_code}` (código §4.3) |
| `store`, `lock_busy`, `identity` (`{msg}`: `not_primary`…), `identity_violation` (`{uids}`), `media`, `link`, `backup`, `internal` | variantes de `CoreError` |

Nunca há conteúdo, chave, bearer ou QR em `.message`/`.details`.

## 4. Modelo de execução (web, implementado)

- **Worker dedicado** (`new Worker(blob:)`), um por aba, criado na 1ª chamada. O código do worker
  (glue wasm-bindgen no-modules + `services/crypto/worker/worker.src.js`) vem embutido como string
  num chunk JS carregado por `import()` — **nada no boot**. O `.wasm` é asset do Metro
  (`vendor/chatyy-crypto-wasm/chatyy_crypto_bg.wasm`); o worker confere o SHA-256 (embutido no
  chunk) antes de instanciar (equivalente a SRI; CSP atual já permite `worker-src 'self' blob:` e
  `'unsafe-eval'` cobre `WebAssembly.instantiate`).
- **Store**: IndexedDB `chatyy-e2ee5-<uid>` (`::matrix-sdk-crypto` + `-meta`) com
  `open_with_passphrase`. Senha = `base64(HMAC-SHA256(K, "chatyy-e2ee5-store-v1|<uid>|<device_id>"))`,
  com `K` = `CryptoKey` HMAC **não-exportável** gerada por `crypto.subtle.generateKey(..., false)`
  e guardada (como objeto CryptoKey) no IndexedDB `chatyy-e2ee5-meta`, junto do `device_id`.
  Sem esse registro ⇒ aparelho novo (store órfão é apagado). "Limpar dados do site" = aparelho novo.
- **Abas**: cada operação que toca o store roda sob `navigator.locks.request('chatyy-e2ee5-core-<uid>',
  {mode:'exclusive'})`; o núcleo também usa a trava própria (holder `web-<id da aba>`) e recarrega a
  OlmMachine quando outra aba escreveu (`Dirty`).
- **Transporte**: `fetch` dentro do worker para `{base}/api/email.php?action=e2ee5_<action>` com
  `Authorization`, `X-E2EE-Device`, timeout 15 s; devolve `{status, body}` cru ao núcleo (§6.2).
  Modo de teste `setAuth({mode:'main', transport})`: o worker pede cada chamada à página (usado no
  teste headless, porque o fetch de um worker `blob:` não é interceptável pelo Playwright).
- Teste: `vendor/chatyy-crypto-wasm/qa/run.sh` (edge, nunca no US); último resultado em
  `vendor/chatyy-crypto-wasm/qa/ultimo-resultado.json`.

## 5. Pedidos ao WP-00 (atendidos no contrato 1.1 §6.11; mantidos como histórico)

1. Incluir esta API JS como §6.11 ("API JS do host — web e nativo"), ou apontar para este arquivo.
2. Confirmar o formato da senha do store web acima (§6.10 diz só "derivada de chave WebCrypto
   não-exportável").
3. Fixar os nomes do lado celular do vínculo (`linkAccept`/`linkPhonePoll`) com o WP-03/WP-12.
4. Registrar que **a web não tem `encryptFile/decryptFile`** (só bytes).
5. O cabeçalho do CONTRATO diz que `/root/e2ee-2026-10-21/spec/` é espelho de `docs/e2ee/`; a pasta
   não existia, então o WP-04 a criou com este arquivo. Se o espelho virar link simbólico, mover
   este arquivo para `docs/e2ee/proposta-host-api.md` antes.
