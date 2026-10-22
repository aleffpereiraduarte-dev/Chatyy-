/**
 * cloudBackup — "Backup da conversa" v4 (CYB4) na NOSSA nuvem (R2), cifrado no aparelho.
 * [backup-nuvem 2026-10-22] Plano: /root/backup-nuvem-2026-10-22/PLANO.md
 *
 * FLAG: tudo desligado salvo `globalThis.__chatyy_cloud_backup === true` (e o servidor
 * libera a conta: chat_cbk4_status.enabled). Desligado = nenhuma chamada, nada roda.
 *
 * Diferenças para o ownBackup (CYB3, que continua no ar e intocado):
 *  - FONTE = o APARELHO (SQLite chatyy.db + texto já decifrado do E2EE v5 via
 *    e2ee5.decryptRow). Servidor só completa conversas que não estão no aparelho
 *    (opts.serverFill, padrão ligado enquanto o servidor guarda histórico).
 *  - Conteúdo NUNCA passa pelo PHP: URL pré-assinada direto no R2 (chat_cbk4_*).
 *  - Mesma CHAVE da conta (ownBackup.getKeyBytes — a da chave de 64 dígitos/senha,
 *    também usada pelo Cofre). Com o WP-14, essa raiz passa a ser guardada no Secret
 *    Storage do E2EE (secretGet 'chatyy.backup_root.v1' quando o núcleo expuser).
 *    Subchaves por rótulo (SHA-512): enc / id / kid → v3 e v4 nunca compartilham chave.
 *
 * Formato de cada objeto:
 *   'CYB4' | ver(1)=1 | flags(1) (bit0 = gzip, reservado) | nonce(24) | secretbox(inner, Kenc)
 *   inner = ver | flags | kind(1: json, 2: bin) | payload
 *   id    = hex(SHA-512(Kid | ver | flags | kind | payload)[0..16])  → dedup + amarração:
 *           ao abrir, o id é recalculado; servidor não consegue trocar um objeto por outro.
 * Manifesto (kind json, t:'cbk4man'): conversas → blocos [{o, n, a, z, s}] + contagens.
 * Blocos de mensagens com corte definido pelo conteúdo (id) → incremental: só o bloco
 * do fim (ou o que mudou) sobe de novo.
 */

import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const MAGIC = [0x43, 0x59, 0x42, 0x34]; // 'CYB4'
const VER = 1;
const FMT = 1;
const K_JSON = 1;
const K_BIN = 2;
const NONCE_LEN = 24;
const OVERHEAD = 4 + 2 + NONCE_LEN + 16 + 3; // magic+ver/flags+nonce+tag+inner header
const BLOCK_MAX_MSGS = 1000;
const BLOCK_MIN_MSGS = 32;
const BLOCK_MAX_BYTES = 3 * 1024 * 1024;
const MANIFEST_PAGE_BYTES = 2 * 1024 * 1024;
const LOCAL_PAGE = 500;
const SERVER_PAGE = 100;
const UPLOAD_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 4;
const FULL_RESCAN_MS = 7 * 24 * 3600 * 1000;
const FREQ_MS = { daily: 20 * 3600 * 1000, weekly: 6.5 * 24 * 3600 * 1000 };
const BG_TASK = 'CHATYY_CLOUD_BACKUP_V4';

// Campos estáveis (ordem fixa = JSON determinístico = dedup). Fora: recibos/lidos/pts.
const MSG_FIELDS = [
  'id', 'conversation_id', 'sender_email', 'sender_name', 'type', 'content',
  'file_name', 'file_url', 'file_size', 'thumbnail_url', 'hls_url', 'thumb_b64', 'blurhash',
  'image_width', 'image_height', 'image_variants', 'duration',
  'reply_to_id', 'reply_to', 'reply_quote_text', 'forwarded_from',
  'edited', 'edited_at', 'created_at', 'deleted_at', 'mentions', 'reactions',
  'starred', 'pinned', 'client_message_id', 'topic_id', 'effect', 'poll_data', 'is_poll',
];

// ─── flag ────────────────────────────────────────────────────────────────
export function isOn() {
  try { return globalThis.__chatyy_cloud_backup === true; } catch { return false; }
}

// ─── estado / progresso ──────────────────────────────────────────────────
let _running = null;
let _progress = null;
const _listeners = new Set();
function _emit(p) { _progress = p ? { ...p, at: Date.now() } : null; _listeners.forEach((fn) => { try { fn(_progress); } catch {} }); }
export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
export function getProgress() { return _progress; }
export function isRunning() { return !!_running; }
function _err(code, msg, extra) { const e = new Error(msg || code); e.code = code; if (extra) Object.assign(e, extra); return e; }

// ─── bytes / chaves ──────────────────────────────────────────────────────
function _cat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; }
const _HEX = '0123456789abcdef';
function _hex(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += _HEX[u8[i] >> 4] + _HEX[u8[i] & 15]; return s; }
function _label(l, k) { return nacl.hash(_cat([decodeUTF8(l), k])).slice(0, 32); }
function _keys(K) {
  return {
    enc: _label('chatyy-cbk4-enc-v1', K),
    id: _label('chatyy-cbk4-id-v1', K),
    kid: _hex(_label('chatyy-cbk4-kid-v1', K).slice(0, 8)),
  };
}
function _email(e) { let v = e; if (!v) { try { v = api.getActiveAccountEmail?.(); } catch {} } return String(v || '').trim().toLowerCase(); }
function _tag(email) { return _hex(nacl.hash(decodeUTF8('chatyy-cbk4|' + email)).slice(0, 8)); }

/** Payload em claro → {id, size, plain(inner)} sem cifrar (tamanho final é determinístico). */
function _prep(keys, kind, payload) {
  const hdr = new Uint8Array([VER, 0, kind]);
  const inner = _cat([hdr, payload]);
  const id = _hex(nacl.hash(_cat([keys.id, inner])).slice(0, 16));
  return { id, size: OVERHEAD + payload.length, inner };
}
function _seal(keys, inner) {
  const nonce = nacl.randomBytes(NONCE_LEN);
  return _cat([new Uint8Array(MAGIC), new Uint8Array([VER, 0]), nonce, nacl.secretbox(inner, nonce, keys.enc)]);
}
function _open(keys, blob, expectId) {
  if (!blob || blob.length < OVERHEAD) throw _err('ERR_CORRUPT', 'object too small');
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) throw _err('ERR_CORRUPT', 'bad magic');
  const inner = nacl.secretbox.open(blob.subarray(6 + NONCE_LEN), blob.subarray(6, 6 + NONCE_LEN), keys.enc);
  if (!inner) throw _err('ERR_DECRYPT', 'decrypt failed');
  if (inner[0] !== blob[4] || inner[1] !== blob[5]) throw _err('ERR_CORRUPT', 'header mismatch');
  if (expectId && _hex(nacl.hash(_cat([keys.id, inner])).slice(0, 16)) !== expectId) throw _err('ERR_CORRUPT', 'object id mismatch');
  const body = inner.subarray(3);
  if (inner[2] === K_JSON) return JSON.parse(encodeUTF8(body));
  if (inner[2] === K_BIN) return body;
  throw _err('ERR_CORRUPT', 'unknown kind');
}
const _json = (keys, obj) => _prep(keys, K_JSON, decodeUTF8(JSON.stringify(obj)));

/** Raiz da chave: WP-14 (Secret Storage) quando o núcleo expuser; senão a chave do ownBackup. */
async function _rootKey(email) {
  try {
    const C = require('./crypto');
    if (typeof C.secretGet === 'function') {
      const b64 = await C.secretGet('chatyy.backup_root.v1');
      if (b64) { const k = decodeBase64(String(b64)); if (k.length === 32) return k; }
    }
  } catch {}
  try { return await require('./ownBackup').getKeyBytes(email); } catch { return null; }
}

// ─── prefs ───────────────────────────────────────────────────────────────
const DEFAULT_PREFS = { freq: 'daily', allowCellular: false, serverFill: true };
const _prefsKey = (t) => `@chatyy_cbk4_prefs:${t}`;
const _stateKey = (t) => `@chatyy_cbk4_state:${t}`; // só ids/contagens (sem conteúdo)
export async function getPrefs(email) {
  const em = _email(email);
  try { const raw = em ? await AsyncStorage.getItem(_prefsKey(_tag(em))) : null; return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) }; }
  catch { return { ...DEFAULT_PREFS }; }
}
export async function setPrefs(patch, email) {
  const em = _email(email);
  if (!em) return null;
  const next = { ...(await getPrefs(em)), ...(patch || {}) };
  try { await AsyncStorage.setItem(_prefsKey(_tag(em)), JSON.stringify(next)); } catch {}
  return next;
}
async function _getState(tag) { try { const r = await AsyncStorage.getItem(_stateKey(tag)); return r ? JSON.parse(r) : null; } catch { return null; } }
async function _setState(tag, st) { try { await AsyncStorage.setItem(_stateKey(tag), JSON.stringify(st)); } catch {} }

// ─── HTTP (só metadados; o conteúdo vai direto ao R2) ────────────────────
function _apiUrl() { return api.getApiUrl?.() || 'https://chatyy.com.br/api/email.php'; }
function _headers(extra) { const h = { Accept: 'application/json', ...(extra || {}) }; const tk = api.getAuthToken?.(); if (tk) h.Authorization = `Bearer ${tk}`; return h; }
async function _call(action, body, method = 'POST') {
  let r;
  const qs = method === 'GET' && body ? '&' + Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  try {
    r = await fetch(`${_apiUrl()}?action=${action}${qs}`, {
      method, credentials: 'include',
      headers: _headers(method === 'GET' ? null : { 'Content-Type': 'application/json' }),
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j?.success) {
    const code = r.status === 507 ? 'ERR_QUOTA' : r.status === 401 ? 'ERR_AUTH' : r.status === 404 && j?.data?.error === 'cbk4_disabled' ? 'ERR_DISABLED'
      : r.status === 413 ? 'ERR_TOO_LARGE' : r.status === 429 ? 'ERR_RATE' : 'ERR_SERVER';
    throw _err(code, j?.message || `HTTP ${r.status}`, { status: r.status, data: j?.data || null });
  }
  return j.data || {};
}
async function _retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e?.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      await new Promise((res) => setTimeout(res, 700 * Math.pow(2, i)));
    }
  }
  throw last;
}
async function _pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function _putRaw(url, sealed, name) {
  if (Platform.OS !== 'web') {
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}cbk4-${name}.bin`;
    await FS.writeAsStringAsync(tmp, encodeBase64(sealed), { encoding: FS.EncodingType.Base64 });
    try {
      const r = await FS.uploadAsync(url, tmp, {
        httpMethod: 'PUT',
        uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
        sessionType: FS.FileSystemSessionType?.BACKGROUND ?? 0,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (r.status < 200 || r.status >= 300) throw _err('ERR_STORAGE', `PUT ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
    return;
  }
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: sealed });
  if (!r.ok) throw _err('ERR_STORAGE', `PUT ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
}
async function _getRaw(url, name) {
  if (Platform.OS !== 'web') {
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}cbk4-dl-${name}.bin`;
    try {
      const r = await FS.downloadAsync(url, tmp);
      if (r.status !== 200) throw _err('ERR_STORAGE', `GET ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
      return decodeBase64(await FS.readAsStringAsync(tmp, { encoding: FS.EncodingType.Base64 }));
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
  }
  const r = await fetch(url);
  if (!r.ok) throw _err('ERR_STORAGE', `GET ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
  return new Uint8Array(await r.arrayBuffer());
}

// ─── coleta (aparelho primeiro) ──────────────────────────────────────────
function _db() { try { return require('./db'); } catch { return null; } }
function _e2() { try { const m = require('./e2ee/e2ee5'); return m.isOn?.() ? m : null; } catch { return null; } }

async function _listConvs(serverFill) {
  const out = new Map();
  try { const rows = await _db()?.dbGetConversations?.(true); for (const c of rows || []) { const id = c?.id ?? c?.conversation_id; if (id != null) out.set(String(id), c); } } catch {}
  if (serverFill && typeof api.apiCall === 'function') {
    for (let pg = 0, off = 0; pg < 40; pg++, off += 500) {
      let d;
      try { d = await _retry(() => api.apiCall('chat_list', { include_archived: 1, limit: 500, offset: off })); } catch { break; }
      const data = d && 'success' in d ? d.data : d;
      const list = Array.isArray(data?.conversations) ? data.conversations : (Array.isArray(data) ? data : []);
      let active = 0;
      for (const c of list) { const id = c?.id ?? c?.conversation_id; if (id == null) continue; if (!(c.archived || c.is_archived)) active++; if (!out.has(String(id))) out.set(String(id), c); }
      if (active < 500) break;
    }
  }
  return [...out.values()];
}

/** Todas as mensagens locais da conversa, antiga → nova. */
async function _localMsgs(cid) {
  const db = _db();
  if (!db?.dbGetMessages) return [];
  const pages = [];
  let before = null;
  for (let i = 0; i < 2000; i++) {
    let rows;
    try { rows = await db.dbGetMessages(cid, LOCAL_PAGE, before); } catch { break; }
    if (!rows?.length) break;
    pages.unshift(rows);
    let min = null;
    for (const m of rows) { const n = Number(m?.id); if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n; }
    if (rows.length < LOCAL_PAGE || min == null || String(min) === String(before)) break;
    before = min;
  }
  return pages.flat();
}
async function _serverMsgs(cid) {
  const pages = [];
  let before = null;
  for (let i = 0; i < 3000; i++) {
    let r;
    try { r = await _retry(() => api.chatMessages(cid, SERVER_PAGE, before, 0)); } catch { break; }
    const data = r && typeof r === 'object' && 'success' in r ? r.data : r;
    const rows = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
    if (!rows.length) break;
    pages.unshift(rows);
    const cur = rows[0]?.id;
    if (rows.length < SERVER_PAGE || data?.has_more === false || cur == null || String(cur) === String(before)) break;
    before = cur;
  }
  return pages.flat();
}

let _e2Budget = 0;
async function _pick(m, cid) {
  if (!m || m.id == null || !Number.isFinite(Number(m.id))) return null;
  if (m.is_view_once || m.view_once || m.vanish) return null; // visualização única nunca entra
  const o = {};
  for (const f of MSG_FIELDS) {
    const v = f === 'conversation_id' ? cid : m[f];
    if (v === undefined || v === null || v === '') continue;
    o[f] = v;
  }
  // E2EE v5: o servidor só tem o envelope; o backup leva o texto decifrado NESTE aparelho.
  const e2 = typeof m.content === 'string' && m.content.startsWith('{"e2e":5') ? _e2() : null;
  if (e2) {
    let ent = null;
    try { ent = e2.peek?.(m.content) || null; } catch {}
    if (!ent && _e2Budget > 0) {
      _e2Budget--;
      try { ent = await Promise.race([e2.decryptRow(m, cid), new Promise((r) => setTimeout(() => r(null), 4000))]); } catch {}
    }
    if (ent && typeof ent.text === 'string' && !ent.error) {
      o.content = ent.text;
      o.e2ee = 5;
      if (ent.t && ent.t !== 'text') o.e2ee_t = ent.t;
      if (ent.payload && typeof ent.payload === 'object') o.e2ee_payload = ent.payload; // inclui chave da mídia cifrada
    } else {
      o.e2ee = 5; o.e2ee_missing = 1; // envelope sem texto local (aguardando chave) — restauração mostra "indisponível"
    }
  }
  return o;
}

function _isBoundary(id) {
  const n = Number(id) || 0;
  if (n >= 0 && n < 4294967296) return ((Math.imul(n, 2654435761) >>> 0) & 255) === 255;
  const lo = n % 4294967296; const hi = Math.floor(n / 4294967296);
  let h = Math.imul(lo ^ Math.imul(hi, 0x9E3779B1), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 24) === 255;
}
function _blocks(msgs) {
  const out = []; let cur = []; let bytes = 0;
  for (const m of msgs) {
    cur.push(m); bytes += JSON.stringify(m).length;
    if (cur.length >= BLOCK_MAX_MSGS || bytes >= BLOCK_MAX_BYTES || (cur.length >= BLOCK_MIN_MSGS && _isBoundary(m.id))) { out.push(cur); cur = []; bytes = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}
function _convMeta(c) {
  return {
    id: String(c.id ?? c.conversation_id), type: c.type || 'direct', name: c.name || c.display_name || null,
    avatar: c.avatar || c.avatar_url || null, members: Array.isArray(c.members) ? c.members.map((x) => (typeof x === 'string' ? x : x?.email)).filter(Boolean) : null,
    archived: !!(c.archived ?? c.is_archived), e2ee: c.e2ee_v5 || c.e2ee5 || null,
  };
}

async function _networkOk(prefs, manual) {
  if (manual || Platform.OS === 'web') return true;
  try {
    const NetInfo = require('@react-native-community/netinfo');
    const st = await (NetInfo.default || NetInfo).fetch();
    if (!st?.isConnected || st?.isInternetReachable === false) return false;
    if (st.type === 'wifi' || st.type === 'ethernet') return true;
    return !!prefs.allowCellular;
  } catch { return true; }
}
function _appVersion() { try { return String(require('expo-constants').default?.expoConfig?.version || ''); } catch { return ''; } }

// ─── backup ──────────────────────────────────────────────────────────────
export async function status() {
  if (!isOn()) return { enabled: false };
  const d = await _call('chat_cbk4_status', null, 'GET');
  return { enabled: !!d.enabled, sets: d.sets || [], quota: d.quota || null, keep: d.keep || 3 };
}

/** Faz o backup agora (incremental). opts.manual = botão "Fazer backup agora". */
export async function runBackup(opts = {}) {
  if (!isOn()) throw _err('ERR_DISABLED', 'cloud backup off');
  if (_running) throw _err('ERR_BUSY', 'backup already running');
  const p = _runBackup(opts);
  _running = p;
  try { return await p; } catch (e) { _emit({ phase: 'error', code: e?.code || 'ERR' }); throw e; } finally { _running = null; }
}

async function _runBackup(opts) {
  const em = _email(opts.email);
  if (!em) throw _err('ERR_AUTH', 'no account');
  const K = await _rootKey(em);
  if (!K) throw _err('ERR_NOT_SETUP', 'backup key not set up');
  const keys = _keys(K);
  const tag = _tag(em);
  const prefs = await getPrefs(em);
  if (!(await _networkOk(prefs, !!opts.manual))) throw _err('ERR_NETWORK_POLICY', 'wifi only');
  const st0 = (await _getState(tag)) || {};
  const full = !st0.fullAt || Date.now() - Date.parse(st0.fullAt) > FULL_RESCAN_MS || st0.kid !== keys.kid || !!opts.full;
  const prevConvs = full ? {} : (st0.convs || {});
  _e2Budget = 2000;
  _emit({ phase: 'scan', done: 0, total: 0 });

  const begin = await _retry(() => _call('chat_cbk4_begin', { objs: [], platform: Platform.OS, app_version: _appVersion(), key_id: keys.kid, resume_uid: st0.pendingUid || '' }));
  const uid = begin.uid;
  await _setState(tag, { ...st0, pendingUid: uid });

  const convs = await _listConvs(prefs.serverFill !== false);
  const allObjs = new Set();
  const manConvs = [];
  const nextConvs = {};
  let msgCount = 0; let uploadedBytes = 0; let uploaded = 0; let reused = 0;

  // Sobe um lote de objetos preparados: URLs → PUT direto no R2 → confirm.
  const flush = async (items) => {
    for (let i = 0; i < items.length; i += 200) {
      const part = items.slice(i, i + 200);
      const d = await _retry(() => _call('chat_cbk4_put_urls', { uid, objs: part.map((x) => ({ o: x.id, s: x.size })) }));
      const byId = new Map(part.map((x) => [x.id, x]));
      const put = d.put || [];
      reused += part.length - put.length;
      await _pool(put, UPLOAD_CONCURRENCY, async (p) => {
        const it = byId.get(p.o);
        if (!it) return;
        await _retry(() => _putRaw(p.url, _seal(keys, it.inner), p.o));
        uploaded++; uploadedBytes += it.size;
      });
      const done = put.map((p) => p.o);
      for (let j = 0; j < done.length; j += 100) {
        const c = await _retry(() => _call('chat_cbk4_confirm', { uid, objs: done.slice(j, j + 100) }));
        if (c.missing?.length) throw _err('ERR_STORAGE', 'upload not confirmed', { missing: c.missing.length });
      }
    }
  };

  for (let ci = 0; ci < convs.length; ci++) {
    const meta = _convMeta(convs[ci]);
    const cid = meta.id;
    _emit({ phase: 'backup', done: ci, total: convs.length, uploaded, uploadedBytes });
    let local = await _localMsgs(cid);
    let src = 'device';
    if (!local.length && prefs.serverFill !== false) { local = await _serverMsgs(cid); src = 'server'; }
    const newest = local.length ? String(local[local.length - 1].id) : '';
    const sig = `${local.length}:${newest}:${local.reduce((a, m) => (m.edited_at && m.edited_at > a ? m.edited_at : a), '')}`;
    const prev = prevConvs[cid];
    let blocks;
    if (prev && prev.sig === sig && Array.isArray(prev.blocks)) {
      blocks = prev.blocks; // conversa sem mudança desde o último backup
    } else {
      const picked = [];
      for (const m of local) { const p = await _pick(m, cid); if (p) picked.push(p); }
      const prepared = _blocks(picked).map((b) => ({ ...(_json(keys, { t: 'cbk4msgs', c: cid, m: b })), n: b.length, a: String(b[0].id), z: String(b[b.length - 1].id) }));
      await flush(prepared);
      blocks = prepared.map((x) => ({ o: x.id, n: x.n, a: x.a, z: x.z, s: x.size }));
    }
    for (const b of blocks) { allObjs.add(b.o); msgCount += b.n || 0; }
    manConvs.push({ ...meta, src, n: blocks.reduce((a, b) => a + (b.n || 0), 0), blocks });
    nextConvs[cid] = { sig, blocks };
  }

  // Manifesto (em páginas se grande).
  _emit({ phase: 'manifest', done: convs.length, total: convs.length, uploaded, uploadedBytes });
  const pages = []; let cur = []; let curBytes = 0;
  for (const c of manConvs) {
    const sz = JSON.stringify(c).length;
    if (cur.length && curBytes + sz > MANIFEST_PAGE_BYTES) { pages.push(cur); cur = []; curBytes = 0; }
    cur.push(c); curBytes += sz;
  }
  if (cur.length || !pages.length) pages.push(cur);
  const pageObjs = pages.length > 1 ? pages.map((p, i) => _json(keys, { t: 'cbk4mp', i, convs: p })) : [];
  if (pageObjs.length) await flush(pageObjs);
  pageObjs.forEach((p) => allObjs.add(p.id));
  const root = _json(keys, {
    t: 'cbk4man', v: FMT, a: tag, kid: keys.kid, at: new Date().toISOString(), plat: Platform.OS, app: _appVersion(),
    counts: { convs: manConvs.length, msgs: msgCount },
    convs: pageObjs.length ? null : pages[0], pages: pageObjs.length ? pageObjs.map((p) => p.id) : null,
  });
  await flush([root]);
  allObjs.add(root.id);

  const r = await _retry(() => _call('chat_cbk4_commit', {
    uid, manifest: root.id, objs: [...allObjs], msg_count: msgCount, conv_count: manConvs.length, media_count: 0, key_id: keys.kid, fmt: FMT,
  }));
  const now = new Date().toISOString();
  await _setState(tag, { kid: keys.kid, convs: nextConvs, fullAt: full ? now : st0.fullAt, lastAt: now, lastUid: uid, pendingUid: null, lastSize: r?.set?.size_bytes || 0 });
  await setPrefs({ lastAt: now, lastErrorAt: null, lastError: null }, em);
  _emit({ phase: 'done', done: convs.length, total: convs.length, uploaded, uploadedBytes });
  return { uid, msg_count: msgCount, conv_count: manConvs.length, size_bytes: r?.set?.size_bytes || 0, uploaded, uploaded_bytes: uploadedBytes, reused, full };
}

// ─── automático (1º plano + tarefa de 2º plano quando o binário tiver) ───
export async function maybeRunAuto(opts = {}) {
  try {
    if (!isOn() || _running) return { skipped: 'off_or_busy' };
    if (Platform.OS === 'web') return { skipped: 'web' };
    const em = _email(opts.email);
    if (!em || !api.getAuthToken?.()) return { skipped: 'no_account' };
    const prefs = await getPrefs(em);
    const iv = FREQ_MS[prefs.freq];
    if (!iv) return { skipped: 'freq_off' };
    if (Date.now() - (Date.parse(prefs.lastAt || 0) || 0) < iv) return { skipped: 'recent' };
    if (prefs.lastErrorAt && Date.now() - Date.parse(prefs.lastErrorAt) < 3600 * 1000) return { skipped: 'backoff' };
    if (!(await _rootKey(em))) return { skipped: 'not_setup' };
    if (!(await _networkOk(prefs, false))) return { skipped: 'network' };
    const st = await status();
    if (!st.enabled) return { skipped: 'server_off' };
    try { return { ran: true, result: await runBackup({ email: em }) }; }
    catch (e) { await setPrefs({ lastErrorAt: new Date().toISOString(), lastError: e?.code || 'ERR' }, em); return { error: e?.code || 'ERR' }; }
  } catch (e) { return { error: e?.code || String(e?.message || e) }; }
}

let _started = false;
/** Gatilhos: 90 s após o boot, volta ao app (≥ 30 min), e BGTask/WorkManager se o binário tiver. */
export function startRunner() {
  if (_started || !isOn() || Platform.OS === 'web') return;
  _started = true;
  setTimeout(() => { maybeRunAuto().catch(() => {}); }, 90 * 1000);
  try {
    const { AppState } = require('react-native');
    let last = 0;
    AppState.addEventListener('change', (s) => {
      if (s !== 'active' || Date.now() - last < 30 * 60 * 1000) return;
      last = Date.now();
      setTimeout(() => { maybeRunAuto().catch(() => {}); }, 20 * 1000);
    });
  } catch {}
  _registerBg().catch(() => {});
}
async function _registerBg() {
  let TM, BT;
  try { TM = require('expo-task-manager'); BT = require('expo-background-task'); } catch { return; }
  if (!TM?.defineTask || !BT?.registerTaskAsync) return;
  try {
    if (!TM.isTaskDefined?.(BG_TASK)) {
      TM.defineTask(BG_TASK, async () => {
        try { await maybeRunAuto(); } catch {}
        return BT.BackgroundTaskResult?.Success ?? 1;
      });
    }
    await BT.registerTaskAsync(BG_TASK, { minimumInterval: 12 * 60 });
  } catch {}
}

// ─── restauração ─────────────────────────────────────────────────────────
async function _getObjs(uid, ids, keys, onEach) {
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const d = await _retry(() => _call('chat_cbk4_get_urls', { uid, objs: part }));
    if (d.missing?.length) throw _err('ERR_MISSING', 'objects missing', { missing: d.missing.length });
    await _pool(d.get || [], DOWNLOAD_CONCURRENCY, async (g) => {
      const blob = await _retry(() => _getRaw(g.url, g.o));
      await onEach(g.o, _open(keys, blob, g.o));
    });
  }
}

/** Backup mais recente do servidor (para oferecer "Restaurar"). null se não houver. */
export async function findRestoreCandidate() {
  if (!isOn()) return null;
  try { const st = await status(); return st.enabled && st.sets?.length ? st.sets[0] : null; } catch { return null; }
}

/** Abre o manifesto (confere a chave). Sem chave local: opts.password | opts.recoveryKey via ownBackup. */
export async function unlock(set, opts = {}) {
  const em = _email(opts.email);
  let K = await _rootKey(em);
  const tryKey = async (k) => {
    const keys = _keys(k);
    if (set.key_id && set.key_id !== keys.kid) return false;
    let man = null;
    await _getObjs(set.uid, [set.manifest], keys, async (_o, v) => { man = v; });
    return man?.t === 'cbk4man' ? man : false;
  };
  if (K) { const man = await tryKey(K); if (man) return { keys: _keys(K), man }; }
  if (!opts.password && !opts.recoveryKey) throw _err('ERR_NEED_KEY', 'recovery key or password required');
  let found = null;
  await require('./ownBackup').unlockKeyOnly({
    password: opts.password, recoveryKey: opts.recoveryKey,
    verify: async (k) => { const m = await tryKey(k); if (m) { found = { keys: _keys(k), man: m }; return true; } return false; },
  }, em);
  if (!found) throw _err('ERR_BAD_KEY', 'key does not open this backup');
  return found;
}

/** Restaura um backup para o aparelho (SQLite local). Não manda nada em claro ao servidor. */
export async function restore(set, opts = {}) {
  if (!isOn()) throw _err('ERR_DISABLED', 'cloud backup off');
  if (_running) throw _err('ERR_BUSY', 'busy');
  const p = (async () => {
    const { keys, man } = await unlock(set, opts);
    let convs = man.convs || [];
    if (Array.isArray(man.pages) && man.pages.length) {
      const got = new Map();
      await _getObjs(set.uid, man.pages, keys, async (o, v) => { got.set(o, v?.convs || []); });
      convs = man.pages.flatMap((o) => got.get(o) || []);
    }
    const db = _db();
    if (!db?.dbSaveMessages) throw _err('ERR_LOCAL', 'local store unavailable');
    try { await db.dbSaveConversations?.(convs.map((c) => ({ id: c.id, type: c.type, name: c.name, avatar: c.avatar, archived: c.archived ? 1 : 0, members: c.members || undefined }))); } catch {}
    let done = 0; let msgs = 0;
    const total = convs.reduce((a, c) => a + (c.blocks?.length || 0), 0);
    for (const c of convs) {
      const ids = (c.blocks || []).map((b) => b.o);
      await _getObjs(set.uid, ids, keys, async (_o, blk) => {
        const rows = (blk?.m || []).map((m) => (m.e2ee === 5 ? { ...m, _cbk4_restored: 1 } : m));
        if (rows.length) { await db.dbSaveMessages(String(c.id), rows); msgs += rows.length; }
        done++;
        _emit({ phase: 'restore', done, total, msgs });
      });
    }
    _emit({ phase: 'restored', done, total, msgs });
    return { conv_count: convs.length, msg_count: msgs };
  })();
  _running = p;
  try { return await p; } catch (e) { _emit({ phase: 'error', code: e?.code || 'ERR' }); throw e; } finally { _running = null; }
}

export async function deleteAll(email) {
  const r = await _call('chat_cbk4_delete', { all: 1 });
  const em = _email(email);
  if (em) { try { await AsyncStorage.removeItem(_stateKey(_tag(em))); } catch {} await setPrefs({ lastAt: null }, em); }
  return r;
}

export async function localSummary(email) {
  const em = _email(email);
  const st = em ? await _getState(_tag(em)) : null;
  return { lastAt: st?.lastAt || null, lastSize: st?.lastSize || 0, hasKey: !!(em && (await _rootKey(em))) };
}

// Para testes (node): formato puro, sem rede.
export const __test = { _keys, _prep, _seal, _open, _json, _blocks, _isBoundary };

export default { isOn, status, runBackup, maybeRunAuto, startRunner, findRestoreCandidate, unlock, restore, deleteAll, getPrefs, setPrefs, subscribe, getProgress, isRunning, localSummary };
