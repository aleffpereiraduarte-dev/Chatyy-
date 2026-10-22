// [e2ee5 WP-03] Host NATIVO (iOS/Android) do núcleo chatyy-crypto — API JS normativa do
// CONTRATO §6.11 (mesmos nomes, argumentos, retornos e `.code` de erro que index.web.js, WP-04).
//
// Ponte: modules/expo-chatyy-crypto (módulo Expo "ChatyyCrypto"). Toda operação vai como
// `invoke(op, argsJson)` e volta como JSON `{"v": resultado}`; bytes atravessam em base64 e
// aqui viram Uint8Array.
//
// GATES (nada liga para usuários):
//   1. `globalThis.__chatyy_e2ee5 === true` (OTA, desligado por padrão) — sem ele TODAS as
//      funções rejeitam com code 'disabled' e o módulo nativo nem é tocado;
//   2. o módulo precisa estar no binário, com apiVersion >= REQUIRED_API_VERSION e o núcleo
//      linkado (build com `chatyy_crypto=true`); senão code 'unsupported';
//   3. `open()` só abre se o último `status()` gravou `flags.e2ee5_native === true` para a conta
//      (o nativo recusa com 'disabled'). `isEnabled()` = 1 && 2 && 3.
// Ordem esperada (WP-08c): setAuth({base, bearer, account}) → status() → open(uid) → …
//
// Erros: Error com `.code` (disabled | unsupported | not_ready | not_open | utd | invalid_input |
// transport | server | store | lock_busy | identity | identity_violation | media | link | backup |
// internal), `.details` (sem conteúdo) e, para utd, `.reason` + `.retryable`.
//
// Eventos (extensão nativa do §6.11): addListener(nome, cb) → {remove()}, nomes
// 'onSyncResult' | 'onNewKeys' | 'onIdentityChanged' | 'onIdentityViolation' | 'onNativeFlag'.

let _bridge; // undefined = não resolvido; null = indisponível

function jsFlag() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    return g.__chatyy_e2ee5 === true;
  } catch (_) {
    return false;
  }
}

function bridge() {
  if (_bridge !== undefined) return _bridge;
  _bridge = null;
  try {
    // require tardio: nada do módulo é carregado no boot nem com a flag desligada.
    const m = require('../../modules/expo-chatyy-crypto');
    _bridge = (m && m.getNative && m.getNative()) || null;
  } catch (_) {
    _bridge = null;
  }
  return _bridge;
}

function codeErr(code, details) {
  const e = new Error(`e2ee5:${code}`);
  e.code = code;
  e.details = details || {};
  if (code === 'utd') {
    e.reason = e.details.reason;
    e.retryable = !!e.details.retryable;
  }
  return e;
}

function reject(code, details) {
  return Promise.reject(codeErr(code, details));
}

// O nativo rejeita com code = código e message "e2ee5:<code> <detalhes JSON>" (o Expo pode
// embrulhar a mensagem — por isso a busca e não um parse do texto inteiro).
const MSG_RE = /e2ee5:([a-z_]+) (\{.*\})/;
function fromNative(err) {
  const msg = String((err && err.message) || '');
  const m = MSG_RE.exec(msg);
  let code = (m && m[1]) || (err && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : '') || 'internal';
  let details = {};
  if (m) {
    try {
      details = JSON.parse(m[2]) || {};
    } catch (_) {
      details = {};
    }
  }
  if (code === 'ERR_UNKNOWN' || code === 'E_UNKNOWN') code = 'internal';
  return codeErr(code, details);
}

function call(op, args) {
  if (!jsFlag()) return reject('disabled');
  const b = bridge();
  if (!b) return reject('unsupported', { what: 'native_module' });
  let json;
  try {
    json = JSON.stringify(args || {});
  } catch (_) {
    return reject('invalid_input', { field: 'args', msg: 'json' });
  }
  const ms = opTimeoutMs(op);
  let timer = null;
  const t0 = Date.now();
  const p = b.invoke(op, json);
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => {
      timer = null;
      _noteNative(op, 'timeout', ms);
      rej(codeErr('timeout', { op, ms }));
    }, ms);
  });
  return Promise.race([p, guard]).then(
    (s) => {
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        const o = JSON.parse(s);
        return o ? o.v : undefined;
      } catch (_) {
        throw codeErr('internal', { msg: 'bad_result' });
      }
    },
    (e) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (e && e.code === 'timeout' && e.message === 'e2ee5:timeout') throw e;
      const ne = fromNative(e);
      if (ne.code !== 'utd') _noteNative(op, ne.code, Date.now() - t0);
      throw ne;
    }
  );
}

// [2026-10-21 android754] TODA chamada nativa tem prazo: uma chamada pendurada no núcleo (ex.: o
// deadlock do RustFuture no Android, ver E2eeNative.callSuspend) não pode prender a fila de envio
// nem o `_inflight` do decrypt para sempre. Rede no núcleo (status/sync/keys_*) = até 15 s por ida.
const _NET_OPS = new Set(['status', 'sync', 'syncWith', 'bootstrapIdentity', 'sendToDevice', 'flushMetrics', 'forgetDevice', 'signDevice',
  'backupEnable', 'backupStep', 'backupRestore', 'backupDisable', 'linkAccept', 'linkPhonePoll', 'onMembersChanged', 'rotateConversation']);
function opTimeoutMs(op) {
  if (op === 'encrypt') return 20000; // keys_query + keys_claim + to_device_send no 1º envio da sessão
  if (op === 'decryptFile' || op === 'encryptFile') return 60000;
  if (_NET_OPS.has(op)) return 35000;
  return 8000; // decrypt/thisDevice/listDevices/open/close/… são locais
}
// Beacon callkit_diag kind "e2ee5" (só op/código/plataforma; nunca conteúdo). 1x por op+código.
const _noted = new Set();
function _noteNative(op, code, ms) {
  try {
    const k = op + ':' + code;
    if (_noted.has(k) || _noted.size >= 32) return;
    _noted.add(k);
    let os = '';
    try { os = require('react-native').Platform.OS; } catch (_) {}
    require('../nativeTelemetry').nativeBeacon('e2ee5', 'native_' + (code === 'timeout' ? 'timeout' : 'err'), 'op=' + op + ' code=' + code + ' ms=' + (Number(ms) || 0) + ' os=' + os);
  } catch (_) {}
}

// ---------------------------------------------------------------- base64 ↔ Uint8Array
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => {
  const r = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) r[B64.charCodeAt(i)] = i;
  r['-'.charCodeAt(0)] = 62;
  r['_'.charCodeAt(0)] = 63;
  return r;
})();

function toU8(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (Array.isArray(b)) return Uint8Array.from(b);
  throw codeErr('invalid_input', { field: 'data', msg: 'bytes' });
}

export function _u8ToB64(u8) {
  let out = '';
  const n = u8.length;
  let i = 0;
  const parts = [];
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (out.length >= 16384) {
      parts.push(out);
      out = '';
    }
  }
  if (i < n) {
    const v = (u8[i] << 16) | ((i + 1 < n ? u8[i + 1] : 0) << 8);
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '=';
  }
  parts.push(out);
  return parts.join('');
}

export function _b64ToU8(s) {
  const str = String(s || '').replace(/[^A-Za-z0-9+/\-_]/g, '');
  const n = str.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = B64_REV[str.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

const bytesArg = (data) => _u8ToB64(toU8(data));

// ---------------------------------------------------------------- ciclo de vida

/** Flag do cliente (síncrono): JS + módulo com núcleo + e2ee5_native gravado pelo último status(). */
export function isEnabled() {
  if (!jsFlag()) return false;
  const b = bridge();
  if (!b) return false;
  try {
    return b.nativeEnabled('') === true;
  } catch (_) {
    return false;
  }
}

/** O aparelho consegue rodar o E2EE? `{ok, reason?, native, apiVersion, coreLinked}`. */
export async function isSupported() {
  if (!jsFlag()) return { ok: false, reason: 'disabled' };
  let info = null;
  try {
    const m = require('../../modules/expo-chatyy-crypto');
    info = (m && m.nativeInfo && m.nativeInfo()) || null;
  } catch (_) {
    info = null;
  }
  const ok = !!bridge();
  return {
    ok,
    reason: ok ? undefined : !info ? 'native_module' : info.coreLinked ? 'api_version' : 'core_not_linked',
    native: !!info,
    apiVersion: info ? info.apiVersion : 0,
    coreLinked: !!(info && info.coreLinked),
  };
}

/**
 * Credenciais do transporte: `{base, bearer, account}` (o mesmo bearer/base do ChatTransport).
 * Chamar no login e a cada refresh do bearer. `account` = e-mail da conta (amarra uid ↔ bearer
 * para a fila nativa/NSE). Sem setAuth o nativo usa a credencial do ChatOutbox da conta.
 */
export function setAuth(a) {
  const o = a || {};
  return call('setAuth', { base: o.base == null ? '' : String(o.base), bearer: o.bearer == null ? '' : String(o.bearer), account: o.account == null ? '' : String(o.account) }).then(() => undefined);
}

/** `e2ee5_status` do servidor (§4.2.1). Também grava `flags.e2ee5_native` no nativo. */
export const status = () => call('status', {});
/** Abre (ou cria) o store do uid. Sem rede. → `{uid, deviceId, created}` (`prefix` só 'X' em testes). */
export const open = (uid, opts) => call('open', { uid: String(uid), prefix: (opts && opts.prefix) || 'P' });
export const close = () => call('close', {}).then(() => undefined);
/** Logout / desvincular: apaga store + aparelho (próximo open = aparelho novo). → `{deleted}` */
export const wipe = (uid) => call('wipe', { uid: uid == null ? '' : String(uid) });
/** Web encerra o worker; no nativo não há o que encerrar (o store fica). */
export async function terminate() {}

// ---------------------------------------------------------------- funções livres (§6.3)
export const coreVersion = () => call('coreVersion', {});
export const newDeviceId = (prefix) => call('newDeviceId', { prefix: String(prefix || '') });
/** 5, outro N, ou null (não é envelope). */
export const envelopeVersion = (content) => call('envelopeVersion', { content: String(content == null ? '' : content) });
/** → `{data: Uint8Array, infoJson}` */
export function encryptBytes(data) {
  let d;
  try {
    d = bytesArg(data);
  } catch (e) {
    return Promise.reject(e);
  }
  return call('encryptBytes', { data: d }).then((r) => ({ data: _b64ToU8(r.data), infoJson: r.infoJson }));
}
/** → `Uint8Array` (rejeita com code 'media' se adulterado). */
export function decryptBytes(data, infoJson) {
  let d;
  try {
    d = bytesArg(data);
  } catch (e) {
    return Promise.reject(e);
  }
  return call('decryptBytes', { data: d, infoJson: String(infoJson || '') }).then(_b64ToU8);
}
/** Não exportada pelo UniFFI (CONTRATO §6.3): no nativo use `safetyNumber(uid)`. */
export const safetyNumberFor = () => (jsFlag() ? reject('unsupported', { what: 'safetyNumberFor' }) : reject('disabled'));
/** Só nativo: cifra arquivo → `{infoJson, size}` (caminhos de arquivo locais, sem `file://`). */
export const encryptFile = (inPath, outPath) => call('encryptFile', { inPath: String(inPath), outPath: String(outPath) });
/** Só nativo: decifra em `<out>.part` e renomeia se o SHA-256 conferir → bytes escritos. */
export const decryptFile = (inPath, outPath, infoJson) =>
  call('decryptFile', { inPath: String(inPath), outPath: String(outPath), infoJson: String(infoJson || '') });

// ---------------------------------------------------------------- CryptoCore (§6.4)
const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x)) : []);
const jsonArg = (v) => (typeof v === 'string' ? v : JSON.stringify(v == null ? {} : v));

export const thisDevice = () => call('thisDevice', {});
export const sync = () => call('sync', {});
export const syncWith = (syncData) => call('syncWith', { syncData: jsonArg(syncData) });
export const trackUsers = (uids) => call('trackUsers', { uids: strs(uids) }).then(() => ({}));
/** → `{envelopeJson, sessionId, keyShareRequests, keyShareBytes}` */
export const encrypt = (convId, memberUids, payload) =>
  call('encrypt', { convId: String(convId), memberUids: strs(memberUids), payload: jsonArg(payload) });
/** input `{convId, envelopeJson, senderUid, serverMid, cmid, tsMs}` → `{payloadJson, senderUid, senderDeviceId, trust, sessionId}` */
export const decrypt = (input) => {
  const i = input || {};
  return call('decrypt', {
    convId: String(i.convId == null ? '' : i.convId),
    envelopeJson: typeof i.envelopeJson === 'string' ? i.envelopeJson : JSON.stringify(i.envelopeJson || {}),
    senderUid: String(i.senderUid == null ? '' : i.senderUid),
    serverMid: String(i.serverMid == null ? '' : i.serverMid),
    cmid: String(i.cmid == null ? '' : i.cmid),
    tsMs: Number(i.tsMs) || 0,
  });
};
export const sendToDevice = (eventType, targets, content) =>
  call('sendToDevice', {
    eventType: String(eventType),
    targets: (Array.isArray(targets) ? targets : []).map((t) => ({ uid: String((t && t.uid) || ''), deviceId: String((t && t.deviceId) || '') })),
    content: jsonArg(content),
  });
export const rotateConversation = (convId) => call('rotateConversation', { convId: String(convId) });
export const onMembersChanged = (convId, memberUids, removedUids) =>
  call('onMembersChanged', { convId: String(convId), memberUids: strs(memberUids), removedUids: strs(removedUids) }).then(() => ({}));
export const forgetDevice = (deviceId) => call('forgetDevice', { deviceId: String(deviceId) });
export const listDevices = (uid) => call('listDevices', { uid: String(uid) });
export const bootstrapIdentity = () => call('bootstrapIdentity', {});
export const signDevice = (deviceId, expectedEd25519) =>
  call('signDevice', { deviceId: String(deviceId), expectedEd25519: String(expectedEd25519) }).then(() => ({}));
export const identityStatus = (uid) => call('identityStatus', { uid: String(uid) });
export const pinIdentity = (uid) => call('pinIdentity', { uid: String(uid) }).then(() => ({}));
export const safetyNumber = (uid) => call('safetyNumber', { uid: String(uid) });
export const verifySafetyQr = (uid, scanned) => call('verifySafetyQr', { uid: String(uid), scanned: String(scanned) });
export const markVerified = (uid) => call('markVerified', { uid: String(uid) }).then(() => ({}));
/** → `Uint8Array` (SEGREDO). filter `{convIds, sinceMs}` */
export const exportRoomKeys = (filter) => {
  const f = filter || {};
  return call('exportRoomKeys', { filter: { convIds: strs(f.convIds), sinceMs: Number(f.sinceMs) || 0 } }).then(_b64ToU8);
};
export function importRoomKeys(data) {
  let d;
  try {
    d = bytesArg(data);
  } catch (e) {
    return Promise.reject(e);
  }
  return call('importRoomKeys', { data: d });
}
export const exportRoomKeysWithPassphrase = (passphrase) => call('exportRoomKeysWithPassphrase', { passphrase: String(passphrase) });
export const importRoomKeysWithPassphrase = (data, passphrase) =>
  call('importRoomKeysWithPassphrase', { data: String(data), passphrase: String(passphrase) });
export const backupEnable = (passphrase) => call('backupEnable', { passphrase: passphrase ? String(passphrase) : '' });
export const backupStep = (maxBatches) => call('backupStep', { maxBatches: Number(maxBatches) || 0 });
export const backupStatus = () => call('backupStatus', {});
export const backupDisable = () => call('backupDisable', {}).then(() => ({}));
export const backupRestore = (keyOrPassphrase) => call('backupRestore', { keyOrPassphrase: String(keyOrPassphrase) });
export const metricsSnapshot = () => call('metricsSnapshot', {});
export const flushMetrics = () => call('flushMetrics', {}).then(() => ({}));

// ---------------------------------------------------------------- vínculo QR
// Lado celular (§6.11.5, WP-12): ler o QR da web e mandar as chaves.
/** → `{checkCode}` (2 dígitos para conferência). filter `{convIds, sinceMs}` (D5: tudo por padrão). */
export const linkAccept = (qrPayload, filter) => {
  const f = filter || {};
  return call('linkAccept', { qrPayload: String(qrPayload), filter: { convIds: strs(f.convIds), sinceMs: Number(f.sinceMs) || 0 } });
};
/** → `{state: 'waiting_device'|'waiting_upload'|'sent'|'done', deviceId?, chunks?}` */
export const linkPhonePoll = () => call('linkPhonePoll', {});
/** Descarta o vínculo em andamento (lado celular). */
export const linkCancel = () => call('linkCancel', {}).then(() => undefined);
// Lado web (só existe em index.web.js).
const webOnly = (what) => () => (jsFlag() ? reject('unsupported', { what }) : reject('disabled'));
export const linkBegin = webOnly('linkBegin');
export const linkPoll = webOnly('linkPoll');
export const linkSendDevice = webOnly('linkSendDevice');
export const linkCompleteUpload = webOnly('linkCompleteUpload');

// ---------------------------------------------------------------- eventos (nativo)
/** Assina um evento nativo. Sem flag/módulo → no-op. → `{remove()}` */
export function addListener(eventName, cb) {
  const noop = { remove() {} };
  if (!jsFlag() || typeof cb !== 'function') return noop;
  const b = bridge();
  if (!b || typeof b.addListener !== 'function') return noop;
  try {
    return b.addListener(eventName, cb) || noop;
  } catch (_) {
    return noop;
  }
}

export const platform = 'native';
