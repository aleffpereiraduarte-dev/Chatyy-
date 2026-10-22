// [e2ee5 WP-04] Host WEB do núcleo chatyy-crypto (wasm em Web Worker dedicado).
//
// Mesma API (promessas) que services/crypto/index.native.js (WP-03) expõe no celular. A
// interface está em /root/e2ee-2026-10-21/spec/proposta-host-api.md (proposta ao WP-00).
//
// PESO ZERO NO BOOT: este arquivo não importa nada pesado. O cliente do worker, o código do
// worker (≈80 KB) e o .wasm (≈3 MB, ≈1 MB gzip) só são buscados na 1ª chamada real, via
// import() (chunk separado do Metro web) e fetch do asset.
//
// FLAG: tudo atrás de `globalThis.__chatyy_e2ee5 === true` (OTA, desligada por padrão). Com a
// flag desligada nenhuma função carrega o worker: `isEnabled()` dá false e o resto rejeita
// com code 'disabled'. A allowlist do servidor (`e2ee5_status.enabled`) é conferida por
// quem chama (WP-08c) com `status()`; o servidor também recusa (403 e2ee5_disabled).
//
// Erros: rejeitam com Error cujo `.code` é um de
//   disabled | unsupported | not_ready | not_open | wasm_integrity | wasm_fetch | wasm_trap |
//   worker_error | terminated | utd | invalid_input | transport | server | store | lock_busy |
//   identity | identity_violation | media | link | backup | internal
// e `.details` (sem conteúdo). Para `utd`: `.reason` (UtdReason) e `.retryable`.

let clientP = null;

export function isEnabled() {
  try {
    return globalThis.__chatyy_e2ee5 === true;
  } catch (_) {
    return false;
  }
}

function disabled() {
  const e = new Error('e2ee5:disabled');
  e.code = 'disabled';
  return Promise.reject(e);
}

function client() {
  if (!clientP) {
    clientP = import('./worker/client.web').catch((e) => {
      clientP = null;
      throw e;
    });
  }
  return clientP;
}

function op(name) {
  return (args) => (isEnabled() ? client().then((c) => c.rpc(name, args || {})) : disabled());
}

const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

// ---------------------------------------------------------------- ciclo de vida

/** O navegador consegue rodar o E2EE? `{ok, worker, wasm, subtle, indexedDB, locks}`. Sem flag: ok=false. */
export async function isSupported() {
  if (!isEnabled()) return { ok: false, reason: 'disabled' };
  try {
    const c = await client();
    return await c.probe();
  } catch (e) {
    return { ok: false, reason: (e && e.code) || 'unsupported' };
  }
}

/**
 * Credenciais do transporte (CONTRATO §4.1/§6.2): `{base, bearer}`. `base` = origem da API
 * (ex.: 'https://chatyy.com.br' ou '' = mesma origem). Chamar no login e quando o bearer muda.
 * Testes: `{mode:'main', transport:(action, body, deviceId) => Promise<{status, body}>}`.
 */
export function setAuth(a) {
  if (!isEnabled()) return disabled();
  return client().then((c) => c.setAuth(a || {}));
}

/** Abre (ou cria) o store IndexedDB `chatyy-e2ee5-<uid>` e o aparelho deste navegador. Sem rede. → `{uid, deviceId, created}` */
export const open = (uid, opts) => op('open')({ uid: String(uid), prefix: opts && opts.prefix });
export const close = op('close');
/** Logout / "desvincular": apaga o store e o aparelho (próximo open = aparelho novo). */
export const wipe = (uid) => op('wipe')({ uid: uid == null ? '' : String(uid) });
/** `e2ee5_status` do servidor (flags, uid, contrato). */
export const status = op('status');

/** Encerra o worker (o store fica). A próxima chamada recria. */
export async function terminate() {
  if (!clientP) return;
  const c = await clientP;
  c.terminate();
}

// ---------------------------------------------------------------- funções livres (§6.3)
export const coreVersion = () => op('coreVersion')();
export const newDeviceId = (prefix) => op('newDeviceId')({ prefix });
/** 5, outro N, ou null (não é envelope). */
export const envelopeVersion = (content) => op('envelopeVersion')({ content });
/** → `{data: Uint8Array, infoJson}` */
export const encryptBytes = (data) => op('encryptBytes')({ data: toU8(data) });
/** → `Uint8Array` (rejeita com code 'media' se adulterado). */
export const decryptBytes = (data, infoJson) => op('decryptBytes')({ data: toU8(data), infoJson }).then((r) => r.data);
export const safetyNumberFor = (uidA, mskA, uidB, mskB) => op('safetyNumberFor')({ uidA, mskA: toU8(mskA), uidB, mskB: toU8(mskB) });

// ---------------------------------------------------------------- CryptoCore (§6.4)
export const thisDevice = () => op('thisDevice')();
export const sync = () => op('sync')();
export const syncWith = (syncData) => op('syncWith')({ syncData });
export const trackUsers = (uids) => op('trackUsers')({ uids });
/** → `{envelopeJson, sessionId, keyShareRequests, keyShareBytes}` */
export const encrypt = (convId, memberUids, payload) => op('encrypt')({ convId, memberUids, payload });
/** input `{convId, envelopeJson, senderUid, serverMid, cmid, tsMs}` → `{payloadJson, senderUid, senderDeviceId, trust, sessionId}` */
export const decrypt = (input) => op('decrypt')(input);
export const sendToDevice = (eventType, targets, content) => op('sendToDevice')({ eventType, targets, content });
export const rotateConversation = (convId) => op('rotateConversation')({ convId });
/** [1.7] → `{sent, dedup, reqId, sentDevices, reason}` (destinatário sem a chave da sessão) */
export const requestRoomKey = (convId, sessionId, senderUid, serverMid) => op('requestRoomKey')({ convId, sessionId, senderUid, serverMid });
/** [1.7] → `{sharedDevices, refused, reason}` (remetente dono da sessão reenvia a chave) */
export const shareRoomKey = (convId, sessionId, targetUid, targetDevices) => op('shareRoomKey')({ convId, sessionId, targetUid, targetDevices: targetDevices || [] });
export const onMembersChanged = (convId, memberUids, removedUids) => op('onMembersChanged')({ convId, memberUids, removedUids });
export const forgetDevice = (deviceId) => op('forgetDevice')({ deviceId });
export const listDevices = (uid) => op('listDevices')({ uid });
export const bootstrapIdentity = () => op('bootstrapIdentity')();
export const signDevice = (deviceId, expectedEd25519) => op('signDevice')({ deviceId, expectedEd25519 });
export const identityStatus = (uid) => op('identityStatus')({ uid });
export const pinIdentity = (uid) => op('pinIdentity')({ uid });
export const safetyNumber = (uid) => op('safetyNumber')({ uid });
export const verifySafetyQr = (uid, scanned) => op('verifySafetyQr')({ uid, scanned });
export const markVerified = (uid) => op('markVerified')({ uid });
/** → `Uint8Array` (SEGREDO). filter `{convIds, sinceMs}` */
export const exportRoomKeys = (filter) => op('exportRoomKeys')({ filter: filter || {} }).then((r) => r.data);
export const importRoomKeys = (data) => op('importRoomKeys')({ data: toU8(data) });
export const exportRoomKeysWithPassphrase = (passphrase) => op('exportRoomKeysWithPassphrase')({ passphrase });
export const importRoomKeysWithPassphrase = (data, passphrase) => op('importRoomKeysWithPassphrase')({ data, passphrase });
export const backupEnable = (passphrase) => op('backupEnable')({ passphrase: passphrase || '' });
export const backupStep = (maxBatches) => op('backupStep')({ maxBatches });
export const backupStatus = () => op('backupStatus')();
export const backupDisable = () => op('backupDisable')();
export const backupRestore = (keyOrPassphrase) => op('backupRestore')({ keyOrPassphrase });
export const metricsSnapshot = () => op('metricsSnapshot')();
export const flushMetrics = () => op('flushMetrics')();

// ---------------------------------------------------------------- vínculo QR, lado web (§6.7, F4)
/** → `{linkId, qrPayload}` (qrPayload tem segredo: só desenhar o QR, nunca logar). */
export const linkBegin = () => op('linkBegin')();
/** → `{state: waiting|hello|granted|importing|done, ...}` */
export const linkPoll = (linkId) => op('linkPoll')({ linkId });
export const linkSendDevice = (linkId) => op('linkSendDevice')({ linkId });
export const linkCompleteUpload = (linkId) => op('linkCompleteUpload')({ linkId });
export const linkCancel = (linkId) => op('linkCancel')({ linkId });

export const platform = 'web';
