/**
 * ownBackup — backup das conversas NO SERVIDOR DO CHATYY, criptografado de
 * ponta a ponta no aparelho. [2026-10-09 own-backup]
 *
 * Decisão do founder: o backup não depende de iCloud nem Google Drive (esses
 * ficam como opção secundária, desligada, em chatBackupCloud.js).
 *
 * Criptografia (só primitivas auditadas do tweetnacl, já usado no app):
 *   - chave do backup K = 32 bytes aleatórios (nacl.randomBytes), guardada no
 *     Keychain/Keystore (expo-secure-store; no web: localStorage da conta).
 *   - cada pedaço: 'CYB3' | nonce(24) | nacl.secretbox(texto, nonce, Kenc)
 *   - id do pedaço = SHA-512(Kid | texto)[0..16] em hex → mesmo conteúdo, mesmo
 *     id → incremental/dedup sem o servidor ver nada (Kid/Kenc = SHA-512 com
 *     rótulo sobre K, separação de domínio).
 *   - para restaurar em outro aparelho: a CHAVE DE 64 DÍGITOS (K em hex, igual
 *     ao WhatsApp) ou a SENHA do backup — K embrulhado (secretbox) com chave
 *     derivada da senha (SHA-512 iterado 100k + sal, mesmo KDF de e2e.js), no
 *     cofre chat_backup_keyvault (trava de tentativas no servidor). Argon2id
 *     exige libsodium nativo (build) — kdf_params é versionado p/ trocar depois.
 *   O servidor só guarda blobs opacos + data/tamanho/nº de mensagens.
 *
 * Conteúdo: conversas (metadados), mensagens (blocos por conversa com corte
 * definido pelo id → só o bloco que mudou sobe de novo), configurações locais
 * (lista branca) e, opcional, mídia que só existe no aparelho. Mídia que já
 * está no R2 do chat NÃO é duplicada: o backup guarda a referência (file_url).
 * Mensagens de visualização única não entram. E2EE v4 (web): guarda também o
 * texto já decifrado neste aparelho (via e2eeV4.decryptForDisplay).
 *
 * Servidor: email.php?action=chat_backup_{init,put_chunk,commit,sets,get,delete}
 * (api/chat-backup-v3.php). Guarda os 2 backups mais recentes por conta.
 */

import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as api from './api';

const MAGIC = new Uint8Array([0x43, 0x59, 0x42, 0x33]); // 'CYB3'
const NONCE_LEN = 24;
const T_JSON = 0x01;
const T_BIN = 0x02;
const KDF_ITERS = 100000;
const PAGE = 100;                         // máx do chat_messages
const BLOCK_MAX_MSGS = 1000;
const BLOCK_MIN_MSGS = 32;
const BLOCK_MAX_BYTES = 3 * 1024 * 1024;  // texto em claro por bloco
const MEDIA_PART_BYTES = 3 * 1024 * 1024;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const FULL_RESCAN_MS = 7 * 24 * 3600 * 1000;
const AUTO_MIN_INTERVAL_MS = 20 * 3600 * 1000;
const UPLOAD_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 4;

// Campos estáveis da mensagem (ordem fixa = JSON determinístico = dedup).
// Fora: read_by/delivered_to/viewed_by/played_at/conv_pts/_read/_delivered…
const MSG_FIELDS = [
  'id', 'conversation_id', 'sender_email', 'sender_name', 'type', 'content',
  'file_name', 'file_url', 'file_size', 'thumbnail_url', 'hls_url', 'thumb_b64',
  'image_width', 'image_height', 'image_variants', 'duration',
  'reply_to_id', 'reply_to', 'reply_quote_text', 'forwarded_from',
  'edited', 'edited_at', 'created_at', 'deleted_at', 'mentions', 'reactions',
  'starred', 'pinned', 'client_message_id', 'topic_id', 'effect',
];
// Configurações locais restauráveis (nada de token/senha/chave).
const SETTINGS_KEYS = [
  'theme_mode', 'theme_dark', 'theme_accent', 'density', 'inbox_type',
  'undo_send_delay', 'smart_compose', 'silence_unknown_callers',
  'chatyy_strip_exif', 'chatyy_sealed_sender', 'chatyy_low_data_calls',
  'chatyy_notif_prefs', 'call_video_filter', 'app_language_manual',
  'ai_summary', 'ai_smart_reply', 'ai_enhance', 'one_notif_level',
];
const SETTINGS_PREFIXES = ['chat_notif_settings_', 'cleared_at_'];
const SETTINGS_DENY = /(token|bearer|password|passwd|secret|session|cookie|credential|private|_key$|^key_)/i;

// ─── estado do módulo ────────────────────────────────────────────────────
let _running = null;          // Promise do backup/restauração em andamento
let _progress = null;         // último evento de progresso
const _listeners = new Set();

function _emit(p) {
  _progress = p ? { ...p, at: Date.now() } : null;
  _listeners.forEach((fn) => { try { fn(_progress); } catch {} });
}
export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
export function getProgress() { return _progress; }
export function isRunning() { return !!_running; }

function _err(code, msg, extra) { const e = new Error(msg || code); e.code = code; if (extra) Object.assign(e, extra); return e; }

// ─── bytes ───────────────────────────────────────────────────────────────
function _cat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const _HEX = '0123456789abcdef';
function _hex(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += _HEX[u8[i] >> 4] + _HEX[u8[i] & 15]; return s; }
function _unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function _label(l, k) { return nacl.hash(_cat([decodeUTF8(l), k])).slice(0, 32); }

function _keys(K) { return { K, enc: _label('chatyy-ownbk-enc-v1', K), id: _label('chatyy-ownbk-id-v1', K) }; }
function _objId(keys, plain) { return _hex(nacl.hash(_cat([keys.id, plain])).slice(0, 16)); }
function _seal(keys, plain) {
  const nonce = nacl.randomBytes(NONCE_LEN);
  return _cat([MAGIC, nonce, nacl.secretbox(plain, nonce, keys.enc)]);
}
function _open(keys, blob) {
  if (!blob || blob.length < 4 + NONCE_LEN + 16) throw _err('ERR_CORRUPT', 'backup object too small');
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) throw _err('ERR_CORRUPT', 'bad magic');
  const pt = nacl.secretbox.open(blob.subarray(4 + NONCE_LEN), blob.subarray(4, 4 + NONCE_LEN), keys.enc);
  if (!pt) throw _err('ERR_DECRYPT', 'decrypt failed');
  return pt;
}
function _jsonPlain(obj) { return _cat([new Uint8Array([T_JSON]), decodeUTF8(JSON.stringify(obj))]); }
function _parsePlain(pt) {
  if (pt[0] === T_JSON) return JSON.parse(encodeUTF8(pt.subarray(1)));
  if (pt[0] === T_BIN) return pt.subarray(1);
  throw _err('ERR_CORRUPT', 'unknown frame');
}

// KDF da senha — mesmo esquema de services/e2e.js (SHA-512 iterado + sal).
function _kek(password, salt, iters) {
  const pw = decodeUTF8(String(password));
  let out = nacl.hash(_cat([pw, salt]));
  for (let i = 1; i < iters; i++) out = nacl.hash(out);
  return out.slice(0, 32);
}

// ─── conta / armazenamento ───────────────────────────────────────────────
function _email(e) {
  let v = e;
  if (!v) { try { v = api.getActiveAccountEmail?.(); } catch {} }
  return String(v || '').trim().toLowerCase();
}
function _tag(email) { return _hex(nacl.hash(decodeUTF8('chatyy-ownbk|' + email)).slice(0, 8)); }
const _kKey = (tag) => `chatyy_ownbk_k_${tag}`;
const _prefsKey = (tag) => `@chatyy_ownbk_prefs:${tag}`;
const _promptedKey = (tag) => `@chatyy_ownbk_prompted:${tag}`;

async function _secGet(k) {
  if (Platform.OS === 'web') { try { return globalThis.localStorage?.getItem(k) || null; } catch { return null; } }
  try { return await SecureStore.getItemAsync(k); } catch { return null; }
}
async function _secSet(k, v) {
  if (Platform.OS === 'web') { try { if (v == null) globalThis.localStorage?.removeItem(k); else globalThis.localStorage?.setItem(k, v); } catch {} return; }
  try {
    if (v == null) await SecureStore.deleteItemAsync(k);
    // AFTER_FIRST_UNLOCK: o backup automático em segundo plano precisa ler.
    else await SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  } catch {}
}

async function _loadK(email) {
  const v = await _secGet(_kKey(_tag(email)));
  if (!v || !/^[a-f0-9]{64}$/.test(v)) return null;
  return _unhex(v);
}
async function _saveK(email, K) { await _secSet(_kKey(_tag(email)), K ? _hex(K) : null); }

const DEFAULT_PREFS = { auto: true, allowCellular: false, includeMedia: false, keyMode: null };
export async function getPrefs(email) {
  const em = _email(email);
  if (!em) return { ...DEFAULT_PREFS };
  try {
    const raw = await AsyncStorage.getItem(_prefsKey(_tag(em)));
    return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) };
  } catch { return { ...DEFAULT_PREFS }; }
}
export async function setPrefs(patch, email) {
  const em = _email(email);
  if (!em) return null;
  const next = { ...(await getPrefs(em)), ...(patch || {}) };
  try { await AsyncStorage.setItem(_prefsKey(_tag(em)), JSON.stringify(next)); } catch {}
  return next;
}

// ─── HTTP ────────────────────────────────────────────────────────────────
function _apiUrl() { return (api.getApiUrl?.() || 'https://chatyy.com.br/api/email.php'); }
function _headers(extra) {
  const h = { Accept: 'application/json', ...(extra || {}) };
  const tk = api.getAuthToken?.();
  if (tk) h.Authorization = `Bearer ${tk}`;
  return h;
}
function _url(action, q) {
  const qs = Object.entries(q || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${_apiUrl()}?action=${action}${qs ? '&' + qs : ''}`;
}
async function _call(action, body, method = 'POST', q) {
  let r;
  try {
    r = await fetch(_url(action, method === 'GET' ? { ...(q || {}), ...(body || {}) } : q), {
      method,
      headers: _headers(method === 'GET' ? null : { 'Content-Type': 'application/json' }),
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      credentials: 'include',
    });
  } catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j?.success) {
    throw _err(r.status === 507 ? 'ERR_QUOTA' : r.status === 401 ? 'ERR_AUTH' : r.status === 423 ? 'ERR_LOCKED' : 'ERR_SERVER',
      j?.message || `HTTP ${r.status}`, { status: r.status, data: j?.data || null });
  }
  return j.data || {};
}

async function _withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e?.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      await new Promise((res) => setTimeout(res, 600 * Math.pow(2, i)));
    }
  }
  throw last;
}

async function _putChunk(uid, obj, sealed) {
  const url = _url('chat_backup_put_chunk', { uid, obj });
  if (Platform.OS !== 'web') {
    // Nativo: arquivo temporário + uploadAsync (sessão em segundo plano no iOS).
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}ownbk-${obj}.bin`;
    await FS.writeAsStringAsync(tmp, encodeBase64(sealed), { encoding: FS.EncodingType.Base64 });
    try {
      const r = await FS.uploadAsync(url, tmp, {
        httpMethod: 'POST',
        uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
        sessionType: FS.FileSystemSessionType?.BACKGROUND ?? 0,
        headers: _headers({ 'Content-Type': 'application/octet-stream' }),
      });
      let j = null; try { j = JSON.parse(r.body || ''); } catch {}
      if (r.status < 200 || r.status >= 300 || !j?.success) throw _err(r.status === 507 ? 'ERR_QUOTA' : 'ERR_SERVER', j?.message || `HTTP ${r.status}`, { status: r.status });
      return j.data;
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
  }
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: _headers({ 'Content-Type': 'application/octet-stream' }), body: sealed, credentials: 'include' });
  } catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j?.success) throw _err(r.status === 507 ? 'ERR_QUOTA' : 'ERR_SERVER', j?.message || `HTTP ${r.status}`, { status: r.status });
  return j.data;
}

async function _getObj(uid, obj) {
  const url = _url('chat_backup_get', { uid, obj });
  if (Platform.OS !== 'web') {
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}ownbk-dl-${obj}.bin`;
    try {
      const r = await FS.downloadAsync(url, tmp, { headers: _headers() });
      if (r.status !== 200) throw _err('ERR_SERVER', `HTTP ${r.status}`, { status: r.status });
      return decodeBase64(await FS.readAsStringAsync(tmp, { encoding: FS.EncodingType.Base64 }));
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
  }
  let r;
  try { r = await fetch(url, { headers: _headers(), credentials: 'include' }); }
  catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  if (!r.ok) throw _err('ERR_SERVER', `HTTP ${r.status}`, { status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

async function _pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

function _appVersion() {
  try { return String(require('expo-constants').default?.expoConfig?.version || ''); } catch { return ''; }
}

// ─── chave do backup: configurar / mostrar / senha ───────────────────────
/** Chave de 64 dígitos (hex) em grupos de 4, para anotar. */
export function formatRecoveryKey(hex) { return String(hex || '').replace(/(.{4})/g, '$1 ').trim(); }
export function parseRecoveryKey(s) {
  const h = String(s || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  return h.length === 64 ? h : null;
}

export async function isSetUp(email) { return !!(await _loadK(_email(email))); }

/**
 * Configura o backup neste aparelho. mode 'key' = só chave de 64 dígitos;
 * 'password' = também guarda a chave embrulhada pela senha no cofre.
 * Reaproveita a chave existente (não invalida backups anteriores).
 */
export async function setupBackupKey({ mode, password } = {}, email) {
  const em = _email(email);
  if (!em) throw _err('ERR_AUTH', 'no account');
  let K = await _loadK(em);
  if (!K) { K = nacl.randomBytes(32); await _saveK(em, K); }
  if (mode === 'password') await setBackupPassword(password, em);
  await setPrefs({ keyMode: mode === 'password' ? 'password' : 'key', setupAt: new Date().toISOString() }, em);
  return { recoveryKey: _hex(K) };
}

export async function getRecoveryKey(email) {
  const K = await _loadK(_email(email));
  return K ? _hex(K) : null;
}

export async function setBackupPassword(password, email) {
  const em = _email(email);
  if (!password || String(password).length < 8) throw _err('ERR_PASSWORD_SHORT', 'password too short');
  const K = await _loadK(em);
  if (!K) throw _err('ERR_NOT_SETUP', 'backup key missing');
  const salt = nacl.randomBytes(16);
  const kek = _kek(password, salt, KDF_ITERS);
  const nonce = nacl.randomBytes(NONCE_LEN);
  const wrapped = _cat([nonce, nacl.secretbox(K, nonce, kek)]);
  await _call('chat_backup_vault_put', {
    wrapped_key: encodeBase64(wrapped), kdf_salt: encodeBase64(salt),
    kdf_params: { algo: 'sha512-iter-v1', iter: KDF_ITERS, wrap: 'secretbox' }, max_attempts: 10,
  });
  await setPrefs({ keyMode: 'password' }, em);
  return true;
}

// ─── [2026-10-09 per-user-vault] chave compartilhada com o Cofre do Drive ──
/** Chave do backup (32 bytes) deste aparelho, ou null. Usada pelo driveVault. */
export async function getKeyBytes(email) { return _loadK(_email(email)); }

/**
 * Destrava a chave SEM precisar de um backup de conversas (Cofre do Drive):
 * senha (cofre do servidor, trava de tentativas) OU chave de 64 dígitos.
 * verify(K) opcional: lança/retorna false se a chave não abrir o conteúdo.
 */
export async function unlockKeyOnly({ password, recoveryKey, verify } = {}, email) {
  const em = _email(email);
  let K = null; let attemptsLeft = null; let wrappedB64 = null; let saltB64 = null; let params = null;
  if (recoveryKey) {
    const h = parseRecoveryKey(recoveryKey);
    if (!h) throw _err('ERR_BAD_KEY', 'invalid recovery key');
    K = _unhex(h);
  } else if (password) {
    const v = await _call('chat_backup_vault_get', null, 'GET');
    attemptsLeft = v.attempts_left;
    wrappedB64 = v.wrapped_key; saltB64 = v.kdf_salt; params = v.kdf_params || {};
    const wrapped = decodeBase64(wrappedB64);
    const kek = _kek(password, decodeBase64(saltB64), Number(params.iter) || KDF_ITERS);
    K = nacl.secretbox.open(wrapped.subarray(NONCE_LEN), wrapped.subarray(0, NONCE_LEN), kek);
    if (!K) throw _err('ERR_BAD_PASSWORD', 'wrong password', { attemptsLeft });
  } else throw _err('ERR_BAD_KEY', 'password or key required');
  if (typeof verify === 'function') {
    let ok = false;
    try { ok = (await verify(K)) !== false; } catch { ok = false; }
    if (!ok) throw _err(password ? 'ERR_BAD_PASSWORD' : 'ERR_BAD_KEY', 'key does not open this content', { attemptsLeft });
  }
  await _saveK(em, K);
  if (password && wrappedB64) {
    try { await _call('chat_backup_vault_put', { wrapped_key: wrappedB64, kdf_salt: saltB64, kdf_params: params, max_attempts: 10 }); } catch {}
  }
  await setPrefs({ keyMode: password ? 'password' : 'key' }, em);
  return true;
}

// ─── coleta (mensagens / conversas / configurações / mídia) ──────────────
function _pickMsg(m, cid) {
  const o = {};
  for (const f of MSG_FIELDS) {
    let v = f === 'conversation_id' ? cid : m[f];
    if (v === undefined || v === null || v === '') continue;
    o[f] = v;
  }
  return o;
}
function _isBoundary(id) {
  // corte definido pelo conteúdo (id) → mesmos blocos a cada backup
  const n = Number(id) || 0;
  return ((Math.imul(n, 2654435761) >>> 0) & 255) === 255;
}
function _chunkMessages(msgs) {
  const blocks = [];
  let cur = []; let bytes = 0;
  for (const m of msgs) {
    const sz = JSON.stringify(m).length;
    cur.push(m); bytes += sz;
    if (cur.length >= BLOCK_MAX_MSGS || bytes >= BLOCK_MAX_BYTES || (cur.length >= BLOCK_MIN_MSGS && _isBoundary(m.id))) {
      blocks.push(cur); cur = []; bytes = 0;
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// Orçamento por backup p/ decifrar E2EE v4 (não travar o backup).
let _e2eBudget = { n: 0, until: 0 };
async function _e2eePlain(m, cid) {
  if (Platform.OS !== 'web' || typeof m.content !== 'string' || !m.content.startsWith('{"e2e":4')) return null;
  try {
    const v4 = require('./e2eeV4');
    const peek = v4.peekPlaintext?.(m.content);
    if (peek) return String(peek);
    if (!v4.isSupported?.() || _e2eBudget.n >= 300 || Date.now() > _e2eBudget.until) return null;
    _e2eBudget.n++;
    const r = await Promise.race([
      v4.decryptForDisplay(m.content, { convId: cid, senderEmail: m.sender_email }),
      new Promise((res) => setTimeout(() => res(null), 4000)),
    ]);
    return r?.ok ? String(r.text ?? '') : null;
  } catch { return null; }
}

// api.chatConversations/chatMessages devolvem { success, data } (apiCall).
function _unwrap(r) {
  if (r && typeof r === 'object' && !Array.isArray(r) && 'success' in r) {
    if (!r.success) throw _err(r.status === 401 ? 'ERR_AUTH' : 'ERR_SERVER', r.error || r.message || 'api error', { status: r.status });
    return r.data;
  }
  return r;
}

/** Mensagens (asc) com id >= minId (0 = todas). */
async function _fetchConv(cid, minId, onPage) {
  const out = [];
  let before = null;
  for (let page = 0; page < 3000; page++) {
    const r = await _withRetry(async () => _unwrap(await api.chatMessages(cid, PAGE, before, 0)));
    const rows = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r) ? r : []);
    if (!rows.length) break;
    let stop = false;
    for (const m of rows) {
      if (m?.id == null || !Number.isFinite(Number(m.id))) continue;
      if (minId && Number(m.id) < minId) { stop = true; continue; }
      out.push(m);
    }
    onPage?.(out.length);
    const oldest = rows.reduce((a, m) => (Number(m.id) < a ? Number(m.id) : a), Infinity);
    if (stop || rows.length < PAGE || !Number.isFinite(oldest) || r?.has_more === false) break;
    before = oldest;
  }
  const seen = new Set();
  return out.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function _collectSettings() {
  const out = {};
  try {
    const keys = await AsyncStorage.getAllKeys();
    const want = keys.filter((k) => !SETTINGS_DENY.test(k)
      && (SETTINGS_KEYS.includes(k) || SETTINGS_PREFIXES.some((p) => k.startsWith(p))));
    if (want.length) {
      const pairs = await AsyncStorage.multiGet(want);
      for (const [k, v] of pairs) if (v != null && v.length < 64 * 1024) out[k] = v;
    }
  } catch {}
  return out;
}

function _isLocalUri(u) { return typeof u === 'string' && /^(file|content|ph|assets-library):/i.test(u); }

async function _prevManifest(keys, email) {
  try {
    const d = await _call('chat_backup_sets', null, 'GET');
    const latest = (d.sets || [])[0];
    if (!latest?.manifest) return null;
    const blob = await _getObj(latest.uid, latest.manifest);
    const man = _parsePlain(_open(keys, blob));
    if (man?.t !== 'man' || man.a !== _tag(email)) return null;
    return man;
  } catch { return null; } // chave diferente / sem backup → backup completo
}

// ─── backup ──────────────────────────────────────────────────────────────
async function _networkOk(prefs) {
  if (Platform.OS === 'web') return true;
  try {
    const NetInfo = require('@react-native-community/netinfo');
    const st = await (NetInfo.default || NetInfo).fetch();
    if (!st?.isConnected || st?.isInternetReachable === false) return false;
    if (st.type === 'wifi' || st.type === 'ethernet') return true;
    return !!prefs.allowCellular; // 4G/5G só se o usuário ligou
  } catch { return true; }
}

/**
 * Faz o backup agora (incremental). opts.manual = botão "Fazer backup agora"
 * (ignora o Wi-Fi-only; a UI avisa). Devolve { uid, msg_count, conv_count,
 * size_bytes, uploaded_bytes, uploaded, reused }.
 */
export async function runBackup(opts = {}) {
  if (_running) throw _err('ERR_BUSY', 'backup already running');
  const p = _runBackup(opts);
  _running = p;
  try { return await p; } finally { _running = null; }
}

async function _runBackup(opts) {
  const em = _email(opts.email);
  if (!em) throw _err('ERR_AUTH', 'no account');
  const K = await _loadK(em);
  if (!K) throw _err('ERR_NOT_SETUP', 'backup not set up');
  const keys = _keys(K);
  const tag = _tag(em);
  const prefs = await getPrefs(em);
  const includeMedia = opts.includeMedia ?? !!prefs.includeMedia;
  _e2eBudget = { n: 0, until: Date.now() + 45000 };
  _emit({ phase: 'scan', done: 0, total: 0 });

  try {
    const prev = opts.forceFull ? null : await _prevManifest(keys, em);
    const full = !prev || !prev.full_at || (Date.now() - Date.parse(prev.full_at) > FULL_RESCAN_MS);
    const objects = new Map(); // id → Uint8Array (texto em claro) | null (já no servidor)
    const add = (plain) => { const id = _objId(keys, plain); if (!objects.has(id) || objects.get(id) === null) objects.set(id, plain); return id; };
    const reuse = (id) => { if (id && !objects.has(id)) objects.set(id, null); return id; };

    const convResp = await _withRetry(async () => _unwrap(await api.chatConversations('', true)));
    const convList = (Array.isArray(convResp?.conversations) ? convResp.conversations : Array.isArray(convResp) ? convResp : [])
      .filter((c) => c && (c.id || c.conversation_id));
    const manConvs = {};
    let msgCount = 0; let mediaCount = 0;
    const mediaMap = {};

    for (let ci = 0; ci < convList.length; ci++) {
      const c = convList[ci];
      const cid = c.id || c.conversation_id;
      _emit({ phase: 'scan', done: ci, total: convList.length });
      const meta = { id: cid, type: c.type || 'direct', name: c.name || null, avatar: c.avatar || null,
        other_email: c.other_email || null, members: Array.isArray(c.members) ? c.members.map((m) => ({ email: m.email, role: m.role, display_name: m.display_name })) : null,
        archived: c.archived ?? null, pinned: c.pinned ?? null, muted: c.muted ?? null, created_at: c.created_at || null };
      const pc = prev?.convs?.[cid];
      const serverLast = Number(c.last_message?.id || c.last_message_id || 0);
      let blocks = [];
      if (pc && !full && serverLast && serverLast <= Number(pc.last || 0)) {
        for (const b of pc.b) { reuse(b[0]); msgCount += b[3] || 0; mediaCount += b[4] || 0; }
        manConvs[cid] = { ...pc, meta };
        continue;
      }
      let keep = []; let minId = 0;
      if (pc && !full && pc.b.length) {
        keep = pc.b.slice(0, -1);
        minId = Number(pc.b[pc.b.length - 1][1]) || 0;
      }
      const raw = await _fetchConv(cid, minId);
      const picked = [];
      for (const m of raw) {
        if (m.is_view_once && Number(m.is_view_once)) continue;
        const o = _pickMsg(m, cid);
        const pt = await _e2eePlain(m, cid);
        if (pt != null) o.pt = pt;
        if (includeMedia && _isLocalUri(o.file_url) && Platform.OS !== 'web') {
          const mid = await _backupLocalMedia(o.file_url, keys, add);
          if (mid) { mediaMap[`${cid}:${o.id}`] = mid; }
        }
        picked.push(o);
      }
      for (const b of keep) reuse(b[0]);
      blocks = keep.slice();
      for (const blk of _chunkMessages(picked)) {
        const id = add(_jsonPlain({ t: 'blk', a: tag, c: cid, m: blk }));
        const nMedia = blk.reduce((a, m) => a + (m.file_url || m.thumbnail_url ? 1 : 0), 0);
        blocks.push([id, blk[0].id, blk[blk.length - 1].id, blk.length, nMedia]);
      }
      for (const b of blocks) { msgCount += b[3] || 0; mediaCount += b[4] || 0; }
      manConvs[cid] = { meta, b: blocks, last: blocks.length ? blocks[blocks.length - 1][2] : 0 };
    }

    const settings = await _collectSettings();
    const settingsId = Object.keys(settings).length ? add(_jsonPlain({ t: 'set', a: tag, s: settings })) : null;
    const manifest = {
      t: 'man', v: 3, a: tag, created_at: new Date().toISOString(),
      full_at: full ? new Date().toISOString() : prev.full_at,
      platform: Platform.OS, app_version: _appVersion(),
      counts: { conv: convList.length, msg: msgCount, media: mediaCount },
      include_media: !!includeMedia, settings: settingsId, media: mediaMap, convs: manConvs,
    };
    const manId = add(_jsonPlain(manifest));
    const allIds = Array.from(objects.keys());
    let est = 0; objects.forEach((v) => { if (v) est += v.length + 48; });

    const init = await _withRetry(() => _call('chat_backup_init', {
      objs: allIds, est_new_bytes: est, resume_uid: prefs.resumeUid || '',
      platform: Platform.OS, app_version: _appVersion(), key_mode: prefs.keyMode || 'key',
    }));
    await setPrefs({ resumeUid: init.uid }, em);
    const have = new Set(init.have || []);
    const missingNoPlain = allIds.filter((id) => !have.has(id) && objects.get(id) === null);
    if (missingNoPlain.length) {
      // Bloco antigo sumiu do servidor (GC/apagado) → refaz completo uma vez.
      if (opts._retried) throw _err('ERR_SERVER', 'objects missing on server');
      return _runBackup({ ...opts, forceFull: true, _retried: true });
    }
    const todo = allIds.filter((id) => !have.has(id));
    let sent = 0; let sentBytes = 0;
    _emit({ phase: 'upload', done: 0, total: todo.length });
    await _pool(todo, UPLOAD_CONCURRENCY, async (id) => {
      const sealed = _seal(keys, objects.get(id));
      await _withRetry(() => _putChunk(init.uid, id, sealed));
      sent++; sentBytes += sealed.length;
      _emit({ phase: 'upload', done: sent, total: todo.length, bytes: sentBytes });
    });

    _emit({ phase: 'commit', done: todo.length, total: todo.length });
    let res;
    try {
      res = await _call('chat_backup_commit', {
        uid: init.uid, manifest: manId, objs: allIds,
        msg_count: msgCount, conv_count: convList.length, media_count: mediaCount, key_mode: prefs.keyMode || 'key',
      });
    } catch (e) {
      const miss = e?.status === 409 ? (e.data?.missing || []) : [];
      if (!miss.length || !miss.every((id) => objects.get(id))) throw e;
      await _pool(miss, UPLOAD_CONCURRENCY, async (id) => { await _withRetry(() => _putChunk(init.uid, id, _seal(keys, objects.get(id)))); });
      res = await _call('chat_backup_commit', {
        uid: init.uid, manifest: manId, objs: allIds,
        msg_count: msgCount, conv_count: convList.length, media_count: mediaCount, key_mode: prefs.keyMode || 'key',
      });
    }
    const set = res.set || {};
    const out = {
      uid: set.uid || init.uid, msg_count: msgCount, conv_count: convList.length, media_count: mediaCount,
      size_bytes: set.size_bytes || 0, uploaded: todo.length, reused: allIds.length - todo.length,
      uploaded_bytes: sentBytes, full, quota: res.quota || null,
    };
    await setPrefs({
      resumeUid: null, lastAt: new Date().toISOString(), lastUid: out.uid, lastSize: out.size_bytes,
      lastMsgCount: msgCount, lastError: null, lastErrorAt: null,
    }, em);
    _emit({ phase: 'done', done: 1, total: 1, result: out });
    return out;
  } catch (e) {
    await setPrefs({ lastError: e?.code || 'ERR_UNKNOWN', lastErrorAt: new Date().toISOString() }, em);
    _emit({ phase: 'error', code: e?.code || 'ERR_UNKNOWN', message: e?.message });
    throw e;
  }
}

async function _backupLocalMedia(uri, keys, add) {
  try {
    const FS = require('expo-file-system/legacy');
    const info = await FS.getInfoAsync(uri, { size: true });
    if (!info?.exists || !info.size || info.size > MEDIA_MAX_BYTES) return null;
    const bytes = decodeBase64(await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 }));
    const parts = [];
    for (let o = 0; o < bytes.length; o += MEDIA_PART_BYTES) {
      parts.push(add(_cat([new Uint8Array([T_BIN]), bytes.subarray(o, o + MEDIA_PART_BYTES)])));
    }
    return { parts, size: bytes.length, name: String(uri).split('/').pop()?.slice(0, 120) || 'media' };
  } catch { return null; }
}

/**
 * Backup automático (diário). Chamado no boot/retorno ao app e pela tarefa em
 * segundo plano. Só roda se: configurado, auto ligado, >20h do último, rede
 * permitida (Wi-Fi por padrão; 4G se o usuário ligou) e nada rodando.
 */
export async function maybeRunAutoBackup(opts = {}) {
  try {
    if (_running) return { skipped: 'busy' };
    const em = _email(opts.email);
    if (!em || !api.getAuthToken?.()) return { skipped: 'no_account' };
    if (!(await _loadK(em))) return { skipped: 'not_setup' };
    const prefs = await getPrefs(em);
    if (!prefs.auto) return { skipped: 'auto_off' };
    const last = Date.parse(prefs.lastAt || 0) || 0;
    if (Date.now() - last < AUTO_MIN_INTERVAL_MS) return { skipped: 'recent' };
    const errAt = Date.parse(prefs.lastErrorAt || 0) || 0;
    if (errAt && Date.now() - errAt < 60 * 60 * 1000) return { skipped: 'backoff' };
    if (!(await _networkOk(prefs))) return { skipped: 'network' };
    const r = await runBackup({ email: em });
    return { ran: true, result: r };
  } catch (e) { return { error: e?.code || String(e?.message || e) }; }
}

let _autoStarted = false;
/** Liga o gatilho em primeiro plano (boot + volta do app). Idempotente. */
export function startAutoBackupRunner() {
  if (_autoStarted || Platform.OS === 'web') return;
  _autoStarted = true;
  setTimeout(() => { maybeRunAutoBackup().catch(() => {}); }, 90 * 1000);
  try {
    const { AppState } = require('react-native');
    let lastKick = 0;
    AppState.addEventListener('change', (s) => {
      if (s !== 'active' || Date.now() - lastKick < 30 * 60 * 1000) return;
      lastKick = Date.now();
      setTimeout(() => { maybeRunAutoBackup().catch(() => {}); }, 20 * 1000);
    });
  } catch {}
}

// ─── listar / apagar ─────────────────────────────────────────────────────
export async function listBackups() {
  const d = await _call('chat_backup_sets', null, 'GET');
  return { sets: d.sets || [], hasPassword: !!d.has_password_vault, quota: d.quota || null, keep: d.keep || 2 };
}

export async function deleteAllBackups(email) {
  const em = _email(email);
  const r = await _call('chat_backup_delete', { all: 1 });
  await setPrefs({ lastAt: null, lastUid: null, lastSize: 0, lastMsgCount: 0, resumeUid: null }, em);
  return r;
}

/** Desliga o backup neste aparelho (apaga a chave local; backups no servidor ficam). */
export async function forgetLocalKey(email) {
  const em = _email(email);
  await _saveK(em, null);
  await setPrefs({ keyMode: null }, em);
}

// ─── restaurar ───────────────────────────────────────────────────────────
/**
 * Pós-login: há backup no servidor e este aparelho ainda não tem a chave da
 * conta (aparelho novo/limpo) e ainda não perguntamos? → candidato.
 */
export async function findRestoreCandidate(email) {
  const em = _email(email);
  if (!em || !api.getAuthToken?.()) return null;
  const tag = _tag(em);
  try { if ((await AsyncStorage.getItem(_promptedKey(tag))) === '1') return null; } catch {}
  if (await _loadK(em)) return null;
  let d;
  try { d = await listBackups(); } catch { return null; }
  const set = d.sets[0];
  if (!set) return null;
  try { await AsyncStorage.setItem(_promptedKey(tag), '1'); } catch {}
  return { email: em, set, hasPassword: d.hasPassword };
}

/**
 * Destrava a chave do backup (senha OU chave de 64 dígitos), confere contra o
 * manifesto do backup e guarda no Keychain. Senha: cada tentativa consome 1
 * no cofre do servidor (trava ao estourar).
 */
export async function unlockBackup({ uid, manifest, password, recoveryKey }, email) {
  const em = _email(email);
  let K = null; let attemptsLeft = null; let wrappedB64 = null; let saltB64 = null; let params = null;
  if (recoveryKey) {
    const h = parseRecoveryKey(recoveryKey);
    if (!h) throw _err('ERR_BAD_KEY', 'invalid recovery key');
    K = _unhex(h);
  } else if (password) {
    const v = await _call('chat_backup_vault_get', null, 'GET');
    attemptsLeft = v.attempts_left;
    wrappedB64 = v.wrapped_key; saltB64 = v.kdf_salt; params = v.kdf_params || {};
    const iters = Number(params.iter) || KDF_ITERS;
    const wrapped = decodeBase64(wrappedB64);
    const kek = _kek(password, decodeBase64(saltB64), iters);
    K = nacl.secretbox.open(wrapped.subarray(NONCE_LEN), wrapped.subarray(0, NONCE_LEN), kek);
    if (!K) throw _err('ERR_BAD_PASSWORD', 'wrong password', { attemptsLeft });
  } else throw _err('ERR_BAD_KEY', 'password or key required');
  const keys = _keys(K);
  let man;
  try { man = _parsePlain(_open(keys, await _getObj(uid, manifest))); }
  catch (e) {
    if (e?.code === 'ERR_DECRYPT') throw _err(password ? 'ERR_BAD_PASSWORD' : 'ERR_BAD_KEY', 'key does not open this backup', { attemptsLeft });
    throw e;
  }
  if (man?.t !== 'man' || man.a !== _tag(em)) throw _err('ERR_BAD_KEY', 'backup belongs to another account');
  await _saveK(em, K);
  if (password && wrappedB64) {
    // senha certa → zera o contador do cofre regravando o mesmo embrulho
    try { await _call('chat_backup_vault_put', { wrapped_key: wrappedB64, kdf_salt: saltB64, kdf_params: params, max_attempts: 10 }); } catch {}
  }
  await setPrefs({ keyMode: password ? 'password' : 'key' }, em);
  return { manifest: man };
}

async function _writeLocal(cid, msgs) {
  const ldb = require('./localDb');
  if (Platform.OS === 'web') { if (ldb.webSaveMessages) await ldb.webSaveMessages(cid, msgs); }
  else if (ldb.saveMessages) await ldb.saveMessages(cid, msgs);
}
async function _writeConvs(convs) {
  // Só preenche a lista local se ela estiver vazia (aparelho novo) — não
  // sobrescreve conversas já sincronizadas com dados mais ricos do servidor.
  const ldb = require('./localDb');
  if (Platform.OS === 'web') {
    const cur = ldb.webGetConversations ? await ldb.webGetConversations() : null;
    if (!cur?.length && ldb.webSaveConversations) await ldb.webSaveConversations(convs);
  } else {
    const cur = ldb.getConversations ? await ldb.getConversations() : null;
    if (!cur?.length && ldb.saveConversations) await ldb.saveConversations(convs);
  }
}

/**
 * Restaura um backup para o armazenamento local do aparelho (não reenvia nada
 * ao servidor — mensagens não são re-postadas para os outros participantes).
 * Precisa da chave destravada (unlockBackup) ou já presente no aparelho.
 */
export async function restoreBackup(uid, opts = {}) {
  if (_running) throw _err('ERR_BUSY', 'busy');
  const p = _restore(uid, opts);
  _running = p;
  try { return await p; } finally { _running = null; }
}

async function _restore(uid, opts) {
  const em = _email(opts.email);
  const K = await _loadK(em);
  if (!K) throw _err('ERR_NOT_SETUP', 'backup key missing');
  const keys = _keys(K);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const prog = (p) => { _emit(p); try { onProgress?.(p); } catch {} };
  try {
    let man = opts.manifest || null;
    if (!man) {
      const meta = await _call('chat_backup_get', { uid }, 'GET');
      man = _parsePlain(_open(keys, await _getObj(uid, meta.set.manifest)));
    }
    if (man?.t !== 'man' || man.a !== _tag(em)) throw _err('ERR_BAD_KEY', 'manifest mismatch');
    const convs = Object.values(man.convs || {});
    const jobs = [];
    for (const c of convs) for (const b of (c.b || [])) jobs.push({ cid: c.meta?.id, obj: b[0], n: b[3] || 0 });
    const total = jobs.reduce((a, j) => a + j.n, 0);
    let done = 0;
    prog({ phase: 'restore', done: 0, total });
    try {
      await _writeConvs(convs.map((c) => ({ ...(c.meta || {}), id: c.meta?.id, _restored: 1 })).filter((c) => c.id));
    } catch {}
    await _pool(jobs, DOWNLOAD_CONCURRENCY, async (j) => {
      const blk = _parsePlain(_open(keys, await _withRetry(() => _getObj(uid, j.obj))));
      if (blk?.t !== 'blk' || blk.a !== man.a) throw _err('ERR_CORRUPT', 'block mismatch');
      const msgs = (blk.m || []).map((m) => {
        const r = { ...m, conversation_id: blk.c, _restored: 1 };
        if (m.pt != null) { r.content = m.pt; r._restored_e2e = 1; delete r.pt; }
        return r;
      });
      await _restoreLocalMedia(msgs, man, keys, uid);
      await _writeLocal(blk.c, msgs);
      done += msgs.length;
      prog({ phase: 'restore', done, total });
    });
    if (man.settings) {
      try {
        const st = _parsePlain(_open(keys, await _getObj(uid, man.settings)));
        const pairs = Object.entries(st?.s || {}).filter(([k]) => !SETTINGS_DENY.test(k)
          && (SETTINGS_KEYS.includes(k) || SETTINGS_PREFIXES.some((p) => k.startsWith(p))));
        if (pairs.length) await AsyncStorage.multiSet(pairs.map(([k, v]) => [k, String(v)]));
      } catch {}
    }
    await setPrefs({ restoredAt: new Date().toISOString(), restoredUid: uid }, em);
    const out = { restored: done, total, conversations: convs.length, created_at: man.created_at };
    prog({ phase: 'done', done: total, total, result: out });
    return out;
  } catch (e) {
    prog({ phase: 'error', code: e?.code || 'ERR_UNKNOWN', message: e?.message });
    throw e;
  }
}

async function _restoreLocalMedia(msgs, man, keys, uid) {
  if (Platform.OS === 'web' || !man.media) return;
  for (const m of msgs) {
    const ent = man.media[`${m.conversation_id}:${m.id}`];
    if (!ent?.parts?.length) continue;
    try {
      const FS = require('expo-file-system/legacy');
      const chunks = [];
      for (const pid of ent.parts) chunks.push(_parsePlain(_open(keys, await _getObj(uid, pid))));
      const dir = `${FS.documentDirectory}chatyy-restored-media/`;
      try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
      const dest = `${dir}${m.conversation_id}-${m.id}-${String(ent.name || 'media').replace(/[^A-Za-z0-9._-]/g, '_')}`;
      await FS.writeAsStringAsync(dest, encodeBase64(_cat(chunks)), { encoding: FS.EncodingType.Base64 });
      m.file_url = dest;
    } catch {}
  }
}

export default {
  subscribe, getProgress, isRunning, getPrefs, setPrefs, isSetUp, setupBackupKey, getRecoveryKey,
  setBackupPassword, formatRecoveryKey, parseRecoveryKey, runBackup, maybeRunAutoBackup,
  startAutoBackupRunner, listBackups, deleteAllBackups, forgetLocalKey, findRestoreCandidate,
  unlockBackup, restoreBackup, getKeyBytes, unlockKeyOnly,
};
