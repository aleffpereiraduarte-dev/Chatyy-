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
 *   'CYB4' | ver(1)=1 | flags(1) | nonce(24) | secretbox(inner, Kenc)
 *   inner = ver | flags | kind(1: json, 2: bin) | payload        flags bit0 = payload DEFLATE cru
 *   id    = hex(SHA-512(Kid | inner)[0..16])  → dedup + amarração: ao abrir, o id é recalculado;
 *           o servidor não consegue trocar um objeto por outro. Mesmo conteúdo = mesmo id (só com
 *           a chave da conta) → mídia repetida (encaminhada, mesma foto em 2 conversas) sobe 1 vez.
 * Compressão [cbk4b 2026-10-22]: JSON sempre tenta (fflateLite, nível 6, só fica se ganhar ≥ 5%);
 *   mídia só em tipos compressíveis (texto/planilha/doc antigos). Comprime ANTES de cifrar.
 * Manifesto (kind json, t:'cbk4man', v:2): conversas → blocos [{o, n, a, z, s}] + media[] + contagens.
 * Blocos de mensagens com corte definido pelo conteúdo (id) → incremental: só o bloco
 * do fim (ou o que mudou) sobe de novo.
 * Mídia [cbk4b 2026-10-22] (fotos/áudios/documentos; vídeos só com prefs.includeVideos):
 *   pedaços de 3 MB (kind bin) a partir do arquivo LOCAL decifrado. E2EE v5: arquivo decifrado
 *   pelo e2ee5Media (nunca sobe em claro — recifrado com a chave do backup aqui); legado: cópia
 *   local do mediaCache/mediaStore ou download da URL. Entrada no manifesto:
 *   {m: id da msg, r: 'f'|'t'|'p' (arquivo/miniatura/pôster), u: url original, ct, n, s, c:[ids], e?:1}.
 *   Cota: 507 do servidor (teto do backup ou do plano) → texto não coube = falha ERR_QUOTA;
 *   mídia não coube = backup sai com o que coube (media_skipped / quota_hit).
 * Restauração retomável: @chatyy_cbk4_rst:<tag> guarda {uid, done:{conversa:1}}; caiu → continua
 *   da próxima conversa (resumePendingRestore no boot / 2º plano).
 */

import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const MAGIC = [0x43, 0x59, 0x42, 0x34]; // 'CYB4'
const VER = 1;
const FMT = 2; // manifesto v2 = com media[] (v1 = só texto; restauração lê os dois)
const F_DEFLATE = 1;
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
const FLAG_MIRROR = '@chatyy_cbk4_flag'; // cópia da flag p/ a tarefa de 2º plano (bundle sem a flag em memória)
// mídia
const MEDIA_CHUNK = 3 * 1024 * 1024;
const MEDIA_MAX_FILE = 200 * 1024 * 1024;
const MEDIA_BATCH_BYTES = 8 * 1024 * 1024;       // memória máx. de pedaços prontos antes de subir
const MEDIA_DL_MAX_BYTES = 1536 * 1024 * 1024;   // por execução: o que falta no aparelho e precisa baixar
const MEDIA_DL_MAX_FILES = 3000;
const MEDIA_DL_TIMEOUT = 90 * 1000;
const MEDIA_T = { image: 'image', photo: 'image', video: 'video', video_note: 'video', short_video: 'video', audio: 'audio', voice: 'audio', file: 'file', document: 'file' };
const E2_MEDIA_T = { image: 'image', video: 'video', voice: 'audio', audio: 'audio', file: 'file' };
const COMPRESSIBLE_EXT = /\.(txt|csv|tsv|json|xml|svg|html?|md|log|rtf|doc|xls|ppt|ics|vcf|sql|js|css)$/i;

// Campos estáveis (ordem fixa = JSON determinístico = dedup). Fora: recibos/lidos/pts.
const MSG_FIELDS = [
  'id', 'conversation_id', 'sender_email', 'sender_name', 'type', 'content',
  'file_name', 'file_url', 'file_size', 'thumbnail_url', 'hls_url', 'thumb_b64', 'blurhash',
  'image_width', 'image_height', 'image_variants', 'duration',
  'reply_to_id', 'reply_to', 'reply_quote_text', 'forwarded_from',
  'edited', 'edited_at', 'created_at', 'deleted_at', 'mentions', 'reactions',
  'starred', 'pinned', 'client_message_id', 'topic_id', 'effect', 'poll_data', 'is_poll',
  // cópia pessoal importada (WhatsApp → store local): só existe no aparelho; ausente = nada muda no JSON
  'imported', 'is_imported', 'import_source', 'imported_at', 'original_sender', 'original_sender_name',
  // [wa-import-local 2026-10-22] marcas da linha importada (eu/mídia ausente/omitida) + anexo cifrado WP-11 (flag)
  'is_mine', 'media_missing', 'media_omitted', 'e2ee_media', 'mime',
];

// ─── flag ────────────────────────────────────────────────────────────────
let _bgOn = false; // só dentro da tarefa de 2º plano (espelho da flag)
export function isOn() {
  try { return globalThis.__chatyy_cloud_backup === true || _bgOn; } catch { return false; }
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

// MD5 (RFC 1321) do objeto CIFRADO → o servidor confere com o ETag do R2 (hash do que ficou guardado).
const _MD5K = new Int32Array(64).map((_, i) => (Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
const _MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
function _md5(u8) {
  const n = u8.length; const words = ((n + 8) >>> 6) + 1; const W = new Int32Array(words * 16);
  for (let i = 0; i < n; i++) W[i >> 2] |= u8[i] << ((i & 3) * 8);
  W[n >> 2] |= 0x80 << ((n & 3) * 8);
  W[words * 16 - 2] = (n * 8) | 0; W[words * 16 - 1] = Math.floor(n / 536870912) | 0;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let o = 0; o < W.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g; const r = i >> 4;
      if (r === 0) { f = (b & c) | (~b & d); g = i; } else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; } else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d; d = c; c = b;
      const x = (a + f + _MD5K[i] + W[o + g]) | 0; const sh = _MD5S[(r << 2) | (i & 3)];
      b = (b + ((x << sh) | (x >>> (32 - sh)))) | 0; a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  let h = '';
  for (const v of [a0, b0, c0, d0]) for (let k = 0; k < 4; k++) { const by = (v >>> (k * 8)) & 255; h += _HEX[by >> 4] + _HEX[by & 15]; }
  return h;
}

function _ffl() { return require('./fflateLite'); }
function _deflate(u8) { try { return _ffl().deflateSync(u8, { level: 6 }); } catch { return null; } }

/** Payload em claro → {id, size, inner} sem cifrar (tamanho final é determinístico). */
function _prep(keys, kind, payload, compress) {
  let flags = 0; let body = payload;
  if ((compress ?? kind === K_JSON) && payload.length >= 256) {
    const c = _deflate(payload);
    if (c && c.length < payload.length * 0.95) { body = c; flags = F_DEFLATE; }
  }
  const inner = _cat([new Uint8Array([VER, flags, kind]), body]);
  const id = _hex(nacl.hash(_cat([keys.id, inner])).slice(0, 16));
  return { id, size: OVERHEAD + body.length, inner };
}
function _seal(keys, inner) {
  const nonce = nacl.randomBytes(NONCE_LEN);
  return _cat([new Uint8Array(MAGIC), new Uint8Array([VER, inner[1]]), nonce, nacl.secretbox(inner, nonce, keys.enc)]);
}
function _open(keys, blob, expectId) {
  if (!blob || blob.length < OVERHEAD) throw _err('ERR_CORRUPT', 'object too small');
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) throw _err('ERR_CORRUPT', 'bad magic');
  const inner = nacl.secretbox.open(blob.subarray(6 + NONCE_LEN), blob.subarray(6, 6 + NONCE_LEN), keys.enc);
  if (!inner) throw _err('ERR_DECRYPT', 'decrypt failed');
  if (inner[0] !== blob[4] || inner[1] !== blob[5] || inner[0] !== VER) throw _err('ERR_CORRUPT', 'header mismatch');
  if (expectId && _hex(nacl.hash(_cat([keys.id, inner])).slice(0, 16)) !== expectId) throw _err('ERR_CORRUPT', 'object id mismatch');
  if (inner[1] & ~F_DEFLATE) throw _err('ERR_CORRUPT', 'unknown flags');
  let body = inner.subarray(3);
  if (inner[1] & F_DEFLATE) { try { body = _ffl().inflateSync(body); } catch { throw _err('ERR_CORRUPT', 'inflate failed'); } }
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
const DEFAULT_PREFS = { freq: 'daily', allowCellular: false, serverFill: true, includeMedia: true, includeVideos: false };
const _prefsKey = (t) => `@chatyy_cbk4_prefs:${t}`;
const _stateKey = (t) => `@chatyy_cbk4_state:${t}`; // só ids/contagens/urls (sem conteúdo nem chaves)
const _rstKey = (t) => `@chatyy_cbk4_rst:${t}`;     // restauração em andamento (retomada)
const _promptKey = (t) => `@chatyy_cbk4_prompted:${t}`;
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
async function _getJ(k) { try { const r = await AsyncStorage.getItem(k); return r ? JSON.parse(r) : null; } catch { return null; } }
async function _setJ(k, v) { try { if (v == null) await AsyncStorage.removeItem(k); else await AsyncStorage.setItem(k, JSON.stringify(v)); } catch {} }
// Estado do incremental: no nativo vai num ARQUIVO (milhares de mídias passam do limite de ~2 MB por
// chave do AsyncStorage no Android); web/testes: AsyncStorage.
function _stateFile(tag) {
  if (Platform.OS === 'web') return null;
  try { const FS = _FSL(); return FS.documentDirectory ? `${FS.documentDirectory}cbk4-state-${tag}.json` : null; } catch { return null; }
}
async function _getState(tag) {
  const f = _stateFile(tag);
  if (f) { try { const i = await _FSL().getInfoAsync(f); if (i?.exists) return JSON.parse(await _FSL().readAsStringAsync(f)); } catch {} }
  return _getJ(_stateKey(tag));
}
async function _setState(tag, st) {
  const f = _stateFile(tag);
  if (f) {
    try {
      if (st == null) await _rm(f); else await _FSL().writeAsStringAsync(f, JSON.stringify(st));
      await _setJ(_stateKey(tag), null);
      return;
    } catch {}
  }
  await _setJ(_stateKey(tag), st);
}

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
      : r.status === 413 ? 'ERR_TOO_LARGE' : r.status === 429 ? 'ERR_RATE' : r.status === 409 && j?.data?.missing ? 'ERR_MISSING' : 'ERR_SERVER';
    throw _err(code, j?.message || `HTTP ${r.status}`, { status: r.status, data: j?.data || null });
  }
  return j.data || {};
}
const _NO_RETRY = new Set(['ERR_QUOTA', 'ERR_TOO_LARGE', 'ERR_DISABLED', 'ERR_AUTH', 'ERR_MISSING', 'ERR_DECRYPT', 'ERR_CORRUPT']);
async function _retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (_NO_RETRY.has(e?.code)) throw e;
      if (e?.http && e.http >= 400 && e.http < 500 && e.http !== 408 && e.http !== 429) throw e;
      if (e?.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      await new Promise((res) => setTimeout(res, (e?.code === 'ERR_RATE' ? 5000 : 700) * Math.pow(2, i)));
    }
  }
  throw last;
}
async function _pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
function _timeout(p, ms) { return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]); }

// ─── arquivos (nativo) ───────────────────────────────────────────────────
function _FSN() { try { const m = require('expo-file-system'); return m && m.File ? m : null; } catch { return null; } }
function _FSL() { return require('expo-file-system/legacy'); }
const _furi = (u) => { const s = String(u || ''); return s.startsWith('/') ? 'file://' + s : s; };
function _fileSize(uri) {
  const N = _FSN();
  if (N) { try { const f = new N.File(_furi(uri)); return f.exists ? (Number(f.size) || 0) : -1; } catch {} }
  return -2; // desconhecido (sem a API nova) → _fileSizeAsync
}
async function _fileSizeAsync(uri) {
  const s = _fileSize(uri);
  if (s !== -2) return s;
  try { const i = await _FSL().getInfoAsync(_furi(uri)); return i?.exists ? (Number(i.size) || 0) : -1; } catch { return -1; }
}
async function _readRange(uri, pos, len) {
  const N = _FSN();
  if (N) {
    const h = new N.File(_furi(uri)).open();
    try { h.offset = pos; return h.readBytes(len); } finally { try { h.close(); } catch {} }
  }
  const L = _FSL();
  return decodeBase64(await L.readAsStringAsync(_furi(uri), { encoding: L.EncodingType.Base64, position: pos, length: len }));
}
async function _writeFile(path, bytes) {
  const N = _FSN();
  if (N) { const f = new N.File(path); try { if (f.exists) f.delete(); } catch {} f.create(); f.write(bytes); return; }
  const L = _FSL();
  await L.writeAsStringAsync(path, encodeBase64(bytes), { encoding: L.EncodingType.Base64 });
}
async function _readFile(path) {
  const N = _FSN();
  if (N) { const f = new N.File(path); return typeof f.bytes === 'function' ? new Uint8Array(await f.bytes()) : f.bytesSync(); }
  const L = _FSL();
  return decodeBase64(await L.readAsStringAsync(path, { encoding: L.EncodingType.Base64 }));
}
async function _rm(path) { try { await _FSL().deleteAsync(path, { idempotent: true }); } catch {} }
async function _mkdir(dir) { try { await _FSL().makeDirectoryAsync(dir, { intermediates: true }); } catch {} }
/** Gravador sequencial (restauração de mídia em pedaços, sem juntar tudo na memória). */
function _sink(path) {
  const N = _FSN();
  if (N) {
    const f = new N.File(path);
    try { if (f.exists) f.delete(); } catch {}
    f.create();
    const h = f.open();
    return { write: async (b) => { h.writeBytes(b); }, close: async () => { try { h.close(); } catch {} } };
  }
  const parts = []; // sem API nova: junta (arquivos pequenos) e grava no fim
  return { write: async (b) => { parts.push(b); }, close: async () => { await _writeFile(path, _cat(parts)); parts.length = 0; } };
}

async function _putRaw(url, sealed, name) {
  if (Platform.OS !== 'web') {
    const FS = _FSL();
    const tmp = `${FS.cacheDirectory}cbk4-${name}.bin`;
    await _writeFile(tmp, sealed);
    try {
      const r = await FS.uploadAsync(url, tmp, {
        httpMethod: 'PUT',
        uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
        sessionType: FS.FileSystemSessionType?.BACKGROUND ?? 0,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (r.status < 200 || r.status >= 300) throw _err('ERR_STORAGE', `PUT ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
    } finally { await _rm(tmp); }
    return;
  }
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: sealed });
  if (!r.ok) throw _err('ERR_STORAGE', `PUT ${r.status}`, { status: r.status >= 500 ? r.status : 0 });
}
async function _getRaw(url, name) {
  if (Platform.OS !== 'web') {
    const FS = _FSL();
    const tmp = `${FS.cacheDirectory}cbk4-dl-${name}.bin`;
    try {
      const r = await FS.downloadAsync(url, tmp);
      if (r.status !== 200) throw _err('ERR_STORAGE', `GET ${r.status}`, { status: r.status >= 500 ? r.status : 0, http: r.status });
      return await _readFile(tmp);
    } finally { await _rm(tmp); }
  }
  const r = await fetch(url);
  if (!r.ok) throw _err('ERR_STORAGE', `GET ${r.status}`, { status: r.status >= 500 ? r.status : 0, http: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

// ─── coleta (aparelho primeiro) ──────────────────────────────────────────
function _db() { try { return require('./db'); } catch { return null; } }
function _e2() { try { const m = require('./e2ee/e2ee5'); return m.isOn?.() ? m : null; } catch { return null; } }
function _e2m() { try { return require('./e2ee/e2ee5Media'); } catch { return null; } }
function _mc() { try { return require('./mediaCache'); } catch { return null; } }
function _ms() { try { return require('./mediaStore'); } catch { return null; } }

/** SQL direto no chatyy.db (sem o LIMIT 200 da lista; mesma regra de conta do db.js). null = indisponível. */
async function _sqlAll(sql, params) {
  const db = _db();
  const h = db?.getDb?.();
  if (!h?.getAllAsync || typeof db.dbAcctClause !== 'function') return null;
  const ac = db.dbAcctClause();
  return h.getAllAsync(sql.replace('/*ACCT*/', ac.sql), [...params.slice(0, 1), ...ac.params, ...params.slice(1)]);
}
const _parse = (rows) => (rows || []).map((r) => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);

async function _listConvs(serverFill) {
  const out = new Map();
  // Conversas do APARELHO — todas (inclusive arquivadas e as importadas, que só existem aqui).
  let local = null;
  try { const rows = await _sqlAll('SELECT raw_json FROM conversations WHERE 1 = ? /*ACCT*/', [1]); if (rows) local = _parse(rows); } catch { local = null; }
  if (!local) { try { local = await _db()?.dbGetConversations?.(true); } catch { local = null; } }
  for (const c of local || []) { const id = c?.id ?? c?.conversation_id; if (id != null) out.set(String(id), c); }
  // Conversa com mensagens no aparelho mas sem linha em conversations (ex.: importação gravou só mensagens)
  try {
    const rows = await _sqlAll('SELECT DISTINCT conversation_id AS cid FROM messages WHERE 1 = ? /*ACCT*/', [1]);
    for (const r of rows || []) { const id = r?.cid; if (id != null && !out.has(String(id))) out.set(String(id), { id: String(id), type: 'direct' }); }
  } catch {}
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

/** Todas as mensagens locais da conversa, antiga → nova (por id; vale p/ id negativo/importado). */
async function _localMsgs(cid) {
  try {
    const out = []; let after = null;
    for (let i = 0; i < 4000; i++) {
      const rows = after == null
        ? await _sqlAll('SELECT raw_json, id FROM messages WHERE conversation_id = ? /*ACCT*/ ORDER BY id ASC LIMIT ?', [cid, LOCAL_PAGE])
        : await _sqlAll('SELECT raw_json, id FROM messages WHERE conversation_id = ? /*ACCT*/ AND id > ? ORDER BY id ASC LIMIT ?', [cid, after, LOCAL_PAGE]);
      if (rows == null) { if (i === 0) throw _err('NO_SQL'); break; }
      for (const m of _parse(rows)) out.push(m);
      if (rows.length < LOCAL_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    return out;
  } catch (e) { if (e?.code !== 'NO_SQL') { /* cai no caminho antigo */ } }
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
    for (const m of rows) { const n = Number(m?.id); if (Number.isFinite(n) && n !== 0 && (min == null || n < min)) min = n; }
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

/**
 * Mídia de uma mensagem já escolhida (_pick) → candidatos [{k, m, r, u, ct, n, s, kind, F?}].
 * F = objeto de mídia do payload E2EE (com a chave) — fica só na memória desta execução.
 */
function _mediaCands(o, prefs) {
  if (!o || o.deleted_at || prefs.includeMedia === false) return [];
  const out = [];
  const mid = String(o.id);
  const add = (r, u, kind, extra) => { if (typeof u === 'string' && u) out.push({ k: `${mid}|${r}`, m: mid, r, u, kind, ...extra }); };
  if (o.e2ee === 5) {
    if (o.e2ee_missing || !o.e2ee_payload) return [];
    const kind = E2_MEDIA_T[o.e2ee_t || ''];
    const M = Array.isArray(o.e2ee_payload.media) ? o.e2ee_payload.media[0] : null;
    if (!kind || !M || !M.url) return [];
    if (kind !== 'video' || prefs.includeVideos) add('f', M.url, kind, { F: M, ct: M.mime || '', n: M.name || '', s: Number(M.size) || 0 });
    const thumbs = Array.isArray(M.thumbs) ? M.thumbs : [];
    const t320 = thumbs.find((x) => x && x.kind === 't320');
    const poster = M.poster && M.poster.url ? M.poster : thumbs.find((x) => x && x.kind === 'poster');
    if (t320?.url && t320.file) add('t', t320.url, 'image', { F: { ...t320, mime: t320.mime || 'image/jpeg' }, ct: t320.mime || 'image/jpeg', n: '', s: Number(t320.size) || 0 });
    if (poster?.url && poster.file) add('p', poster.url, 'image', { F: { ...poster, kind: 'poster', mime: poster.mime || 'image/jpeg' }, ct: poster.mime || 'image/jpeg', n: '', s: Number(poster.size) || 0 });
    return out;
  }
  const kind = MEDIA_T[String(o.type || '')];
  if (!kind) return [];
  const u = String(o.file_url || '');
  if (/^https?:\/\//i.test(u) && (kind !== 'video' || prefs.includeVideos)) add('f', u, kind, { ct: '', n: o.file_name || '', s: Number(o.file_size) || 0 });
  if (kind === 'video' && /^https?:\/\//i.test(String(o.thumbnail_url || ''))) add('t', String(o.thumbnail_url), 'image', { ct: 'image/jpeg', n: '', s: 0 });
  return out;
}

/** Arquivo local EM CLARO do candidato (decifrado se E2EE). → {uri, tmp?} | null. Nunca sobe em claro. */
async function _mediaSource(c, cid, budget) {
  if (Platform.OS === 'web') return null;
  if (c.F) {
    const EM = _e2m();
    if (!EM) return null;
    let uri = null;
    try { uri = EM.localSync?.(c.F)?.uri || null; } catch {}
    if (!uri && budget.files > 0 && budget.bytes > (c.s || 0)) {
      budget.files--; budget.bytes -= c.s || 0;
      try { uri = await _timeout(EM.ensure(c.F, { conv: cid, mid: c.m }), MEDIA_DL_TIMEOUT); } catch { uri = null; }
    }
    return uri && !/^blob:|^https?:/i.test(uri) ? { uri } : null;
  }
  const MC = _mc();
  let uri = null;
  try { if (c.r === 'f') uri = MC?.getLocalUriForMessage?.(c.m) || null; } catch {}
  try { if (!uri) uri = MC?.getLocalUriIfCached?.(c.u) || null; } catch {}
  if (!uri) { try { const u2 = await MC?.getCachedUri?.(c.u); if (u2 && u2 !== c.u && !/^https?:/i.test(u2)) uri = u2; } catch {} }
  if (uri) return { uri };
  if (budget.files <= 0 || budget.bytes <= (c.s || 0)) return null;
  budget.files--;
  const FS = _FSL();
  const tmp = `${FS.cacheDirectory}cbk4-src-${_hex(nacl.hash(decodeUTF8(c.k)).slice(0, 8))}.bin`;
  try {
    const headers = /^https:\/\/([a-z0-9-]+\.)?chatyy\.com\.br\/api\//i.test(c.u) ? _headers() : undefined;
    const r = await _timeout(FS.downloadAsync(c.u, tmp, headers ? { headers } : undefined), MEDIA_DL_TIMEOUT);
    if (!r || r.status !== 200) { await _rm(tmp); return null; }
    const sz = await _fileSizeAsync(tmp);
    budget.bytes -= Math.max(0, sz);
    return { uri: tmp, tmp: true };
  } catch { await _rm(tmp); return null; }
}
function _compressible(c) { return COMPRESSIBLE_EXT.test(String(c.n || '')) || /^text\/|json|xml|csv/i.test(String(c.ct || '')); }
const _manMedia = (e) => { const o = { m: e.m, r: e.r, u: e.u, ct: e.ct || '', n: e.n || '', s: e.s, c: e.c.slice() }; if (e.e) o.e = 1; return o; };

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
    ...(c.imported || c.is_imported ? { imported: 1, import_source: c.import_source || c.source || null } : {}),
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
  // [cbk4c] só o ÚLTIMO backup: sets = [atual]; previous = o anterior (ainda restaurável na janela de 24 h)
  return { enabled: !!d.enabled, sets: d.sets || [], previous: d.previous || [], quota: d.quota || null, keep: d.keep || 1, media: !!d.media, window: d.window };
}

/** Faz o backup agora (incremental). opts.manual = botão "Fazer backup agora". */
export async function runBackup(opts = {}) {
  if (!isOn()) throw _err('ERR_DISABLED', 'cloud backup off');
  if (_running) throw _err('ERR_BUSY', 'backup already running');
  const p = (async () => {
    try { return await _runBackup(opts); } catch (e) {
      // Servidor não tem mais algo que o estado local dava como "já lá" (outro aparelho girou as
      // gerações, backup apagado em outro lugar…) → esquece o que faltou e refaz UMA vez.
      if (e?.code !== 'ERR_MISSING' || opts._retried) throw e;
      await _invalidate(_tag(_email(opts.email)), e.data);
      return _runBackup({ ...opts, _retried: true });
    }
  })();
  _running = p;
  try { return await p; } catch (e) { _emit({ phase: 'error', code: e?.code || 'ERR' }); throw e; } finally { _running = null; }
}
async function _invalidate(tag, data) {
  const st = (await _getState(tag)) || {};
  const miss = new Set(Array.isArray(data?.missing) ? data.missing : []);
  if (!miss.size || (data?.missing_count || 0) > miss.size) { await _setState(tag, { kid: st.kid, pendingUid: st.pendingUid || null }); return; }
  const convs = { ...(st.convs || {}) };
  for (const [cid, c] of Object.entries(convs)) if ((c.blocks || []).some((b) => miss.has(b.o))) delete convs[cid];
  const media = { ...(st.media || {}) };
  for (const [k, e] of Object.entries(media)) if ((e.c || []).some((o) => miss.has(o))) delete media[k];
  for (const c of Object.values(convs)) if ((c.mk || []).some((k) => !media[k])) c.mp = 1;
  await _setState(tag, { ...st, convs, media });
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
  const sameKey = st0.kid === keys.kid;
  const mediaSig = `${prefs.includeMedia === false ? 0 : 1}${prefs.includeVideos ? 1 : 0}`;
  const full = !st0.fullAt || Date.now() - Date.parse(st0.fullAt) > FULL_RESCAN_MS || !sameKey || !!opts.full || st0.fmt !== FMT;
  const prevConvs = full || st0.mediaSig !== mediaSig ? {} : (st0.convs || {});
  const prevMedia = sameKey ? (st0.media || {}) : {}; // pedaços de mídia já no servidor (o arquivo não muda)
  _e2Budget = 2000;
  _emit({ phase: 'scan', done: 0, total: 0 });

  const begin = await _retry(() => _call('chat_cbk4_begin', { objs: [], platform: Platform.OS, app_version: _appVersion(), key_id: keys.kid, resume_uid: st0.pendingUid || '' }));
  const uid = begin.uid;
  const quota = begin.quota || {};
  await _setState(tag, { ...st0, pendingUid: uid });

  const convs = await _listConvs(prefs.serverFill !== false);
  const allObjs = new Set();
  const manConvs = [];
  const nextConvs = {};
  const mediaByConv = new Map(); // cid → candidatos a processar
  let msgCount = 0; let uploadedBytes = 0; let uploaded = 0; let reused = 0;

  // Sobe um lote de objetos preparados: URLs → PUT direto no R2 → confirm.
  const flush = async (items) => {
    for (let i = 0; i < items.length; i += 200) {
      const part = items.slice(i, i + 200);
      const d = await _retry(() => _call('chat_cbk4_put_urls', { uid, objs: part.map((x) => ({ o: x.id, s: x.size })) }));
      const byId = new Map(part.map((x) => [x.id, x]));
      const put = d.put || [];
      reused += part.length - put.length;
      const md5 = new Map();
      await _pool(put, UPLOAD_CONCURRENCY, async (p) => {
        const it = byId.get(p.o);
        if (!it) return;
        const sealed = _seal(keys, it.inner);
        md5.set(p.o, _md5(sealed));
        await _retry(() => _putRaw(p.url, sealed, p.o));
        uploaded++; uploadedBytes += it.size;
      });
      const done = put.map((p) => ({ o: p.o, m: md5.get(p.o) }));
      for (let j = 0; j < done.length; j += 100) {
        const c = await _retry(() => _call('chat_cbk4_confirm', { uid, objs: done.slice(j, j + 100) }));
        if (c.missing?.length) throw _err('ERR_STORAGE', 'upload not confirmed', { missing: c.missing.length });
      }
    }
  };

  // 1) TEXTO de todas as conversas primeiro (é o que mais importa; mídia vem depois e respeita a cota).
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
    let cands = null;
    if (prev && prev.sig === sig && Array.isArray(prev.blocks) && !prev.mp) {
      blocks = prev.blocks; // conversa sem mudança desde o último backup (mídia: a lista mk do estado)
    } else {
      const picked = [];
      cands = [];
      for (const m of local) { const p = await _pick(m, cid); if (p) { picked.push(p); for (const c of _mediaCands(p, prefs)) cands.push(c); } }
      const prepared = _blocks(picked).map((b) => ({ ...(_json(keys, { t: 'cbk4msgs', c: cid, m: b })), n: b.length, a: String(b[0].id), z: String(b[b.length - 1].id) }));
      await flush(prepared);
      blocks = prepared.map((x) => ({ o: x.id, n: x.n, a: x.a, z: x.z, s: x.size }));
    }
    for (const b of blocks) { allObjs.add(b.o); msgCount += b.n || 0; }
    manConvs.push({ ...meta, src, n: blocks.reduce((a, b) => a + (b.n || 0), 0), blocks });
    nextConvs[cid] = { sig, blocks, mk: cands ? [] : (prev?.mk || []), mp: 0 };
    if (cands) mediaByConv.set(cid, cands);
  }

  // 2) MÍDIA (pedaços próprios, cifrados com a chave do backup; dedup pelo id do conteúdo).
  const nextMedia = {};
  let mediaCount = 0; let mediaSkipped = 0; let quotaHit = false;
  const permSkip = new Set(); // grande demais / vazio: não adianta tentar de novo
  const budget = { files: MEDIA_DL_MAX_FILES, bytes: MEDIA_DL_MAX_BYTES };
  const cap = Number(quota.cap) || 0;
  let capRoom = cap > 0 ? cap - (Number(quota.backup_used) || 0) - uploadedBytes : Infinity;
  const total = [...mediaByConv.values()].reduce((a, l) => a + l.length, 0);
  let mDone = 0;
  let pend = []; let pendBytes = 0; let pendEntries = [];
  const isQuota = (e) => e?.code === 'ERR_QUOTA' || e?.code === 'ERR_TOO_LARGE';
  const commitEnt = (e) => { const cv = e.cv; delete e.cv; nextMedia[e.k] = e; cv.mk.push(e.k); };
  const flushMedia = async () => {
    if (!pend.length && !pendEntries.length) return;
    const items = pend; const ents = pendEntries;
    pend = []; pendBytes = 0; pendEntries = [];
    try { await flush(items); ents.forEach(commitEnt); return; } catch (e) { if (!isQuota(e)) throw e; quotaHit = true; }
    // o lote não coube na cota: tenta arquivo a arquivo (entra o que couber; o resto fica para depois)
    const byId = new Map(items.map((x) => [x.id, x]));
    for (const e of ents) {
      try { await flush(e.c.map((o) => byId.get(o)).filter(Boolean)); commitEnt(e); }
      catch (er) { if (!isQuota(er)) throw er; mediaSkipped++; }
    }
  };
  // conversas sem mudança: a mídia já feita continua valendo
  for (const [cid, cv] of Object.entries(nextConvs)) {
    if (mediaByConv.has(cid)) continue;
    cv.mk = (cv.mk || []).filter((k) => { const e = prevMedia[k]; if (!e || !Array.isArray(e.c) || typeof e.c[0] !== 'string') { cv.mp = 1; return false; } nextMedia[k] = e; return true; });
  }
  try {
    for (const [cid, cands] of mediaByConv) {
      const cv = nextConvs[cid];
      for (const c of cands) {
        _emit({ phase: 'media', done: mDone++, total, uploaded, uploadedBytes });
        const old = prevMedia[c.k];
        if (old && old.u === c.u && Array.isArray(old.c) && old.c.length && typeof old.c[0] === 'string') { nextMedia[c.k] = old; cv.mk.push(c.k); continue; }
        if (quotaHit) { mediaSkipped++; continue; }
        const src = await _mediaSource(c, cid, budget);
        if (!src) { mediaSkipped++; continue; }
        try {
          const size = await _fileSizeAsync(src.uri);
          if (size <= 0 || size > MEDIA_MAX_FILE) { mediaSkipped++; permSkip.add(c.k); continue; }
          if (size + OVERHEAD > capRoom) { quotaHit = true; mediaSkipped++; continue; }
          const comp = _compressible(c);
          const ent = { k: c.k, m: c.m, r: c.r, u: c.u, ct: c.ct || '', n: c.n || '', s: size, c: [], cv };
          if (c.F) ent.e = 1;
          let aborted = false;
          for (let pos = 0; pos < size; pos += MEDIA_CHUNK) {
            const bytes = await _readRange(src.uri, pos, Math.min(MEDIA_CHUNK, size - pos));
            const it = _prep(keys, K_BIN, bytes, comp);
            ent.c.push(it.id);
            pend.push(it); pendBytes += it.size; capRoom -= it.size;
            if (pendBytes >= MEDIA_BATCH_BYTES) { await flushMedia(); if (quotaHit) { aborted = true; break; } }
          }
          if (aborted) { mediaSkipped++; pend = pend.filter((x) => !ent.c.includes(x.id)); continue; }
          pendEntries.push(ent);
          if (pendBytes >= MEDIA_BATCH_BYTES || pendEntries.length >= 60) await flushMedia();
        } finally { if (src.tmp) await _rm(src.uri); }
      }
    }
    await flushMedia();
  } catch (e) {
    if (!isQuota(e)) throw e;
    quotaHit = true; // o que já subiu e foi confirmado fica; o lote que estourou fica de fora
    mediaSkipped += pendEntries.length;
    pend = []; pendEntries = [];
  }
  // conversa com mídia que ficou para depois (cota, sem arquivo local, orçamento de download) → relê na próxima
  for (const [cid, cands] of mediaByConv) if (cands.some((c) => !nextMedia[c.k] && !permSkip.has(c.k))) nextConvs[cid].mp = 1;
  for (const cv of Object.values(nextConvs)) for (const k of cv.mk) { const e = nextMedia[k]; if (e) { for (const o of e.c) allObjs.add(o); mediaCount++; } }
  for (const mc of manConvs) { const cv = nextConvs[mc.id]; const list = (cv?.mk || []).map((k) => nextMedia[k]).filter(Boolean).map(_manMedia); if (list.length) mc.media = list; }

  // 3) Manifesto (em páginas se grande).
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
    counts: { convs: manConvs.length, msgs: msgCount, media: mediaCount },
    convs: pageObjs.length ? null : pages[0], pages: pageObjs.length ? pageObjs.map((p) => p.id) : null,
  });
  await flush([root]);
  allObjs.add(root.id);

  const r = await _retry(() => _call('chat_cbk4_commit', {
    uid, manifest: root.id, objs: [...allObjs], msg_count: msgCount, conv_count: manConvs.length, media_count: mediaCount, key_id: keys.kid, fmt: FMT,
    verify: pageObjs.map((p) => p.id), // o servidor confere (ETag = MD5) manifesto + páginas + amostra ANTES de trocar o backup
  }));
  const now = new Date().toISOString();
  await _setState(tag, {
    kid: keys.kid, fmt: FMT, mediaSig, convs: nextConvs, media: nextMedia, fullAt: full ? now : st0.fullAt, lastAt: now, lastUid: uid,
    pendingUid: null, lastSize: r?.set?.size_bytes || 0, lastMedia: mediaCount, lastMediaSkipped: mediaSkipped, quotaHit,
  });
  await setPrefs({ lastAt: now, lastErrorAt: null, lastError: quotaHit ? 'MEDIA_QUOTA' : null }, em);
  _emit({ phase: 'done', done: convs.length, total: convs.length, uploaded, uploadedBytes });
  return {
    uid, msg_count: msgCount, conv_count: manConvs.length, media_count: mediaCount, media_skipped: mediaSkipped, quota_hit: quotaHit,
    size_bytes: r?.set?.size_bytes || 0, uploaded, uploaded_bytes: uploadedBytes, reused, full,
  };
}

// ─── automático (1º plano + tarefa de 2º plano) ──────────────────────────
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
/** Gatilhos: 90 s após o boot, volta ao app (≥ 30 min), BGTask/WorkManager; retoma restauração parada. */
export function startRunner() {
  if (Platform.OS === 'web') return;
  if (!isOn()) { _setJ(FLAG_MIRROR, null); _unregisterBg().catch(() => {}); return; }
  if (_started) return;
  _started = true;
  _setJ(FLAG_MIRROR, 1);
  setTimeout(() => { resumePendingRestore().catch(() => {}); }, 15 * 1000);
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
let _unregTried = false;
async function _unregisterBg() {
  if (_unregTried) return;
  _unregTried = true;
  try {
    const TM = require('expo-task-manager');
    if (await TM?.isTaskRegisteredAsync?.(BG_TASK)) await require('expo-background-task').unregisterTaskAsync(BG_TASK);
  } catch {}
}
async function _registerBg() {
  let BT;
  try { BT = require('expo-background-task'); } catch { return; }
  if (!BT?.registerTaskAsync) return;
  try { defineBackgroundTask(); await BT.registerTaskAsync(BG_TASK, { minimumInterval: 12 * 60 }); } catch {}
}
/**
 * Corpo da tarefa de 2º plano (iOS BGTaskScheduler / Android WorkManager via expo-background-task,
 * já no binário). O SO acorda o app sem a UI: a flag em memória pode não existir → usa o espelho
 * gravado pelo startRunner (apagado quando a flag sai). Chamado por services/cloudBackupTask.js.
 */
export async function runBackgroundTask() {
  if (Platform.OS === 'web') return { skipped: 'web' };
  if (globalThis.__chatyy_cloud_backup === false) return { skipped: 'off' };
  if (globalThis.__chatyy_cloud_backup !== true) {
    if ((await _getJ(FLAG_MIRROR)) !== 1) return { skipped: 'off' };
    _bgOn = true;
  }
  try {
    try { await _timeout(api.waitForTokenReady?.(), 15000); } catch {}
    const rr = await resumePendingRestore().catch(() => null);
    if (rr?.ran) return rr;
    return await maybeRunAuto();
  } finally { _bgOn = false; }
}
export function defineBackgroundTask() {
  try {
    const TM = require('expo-task-manager');
    const BT = require('expo-background-task');
    if (!TM?.defineTask || TM.isTaskDefined?.(BG_TASK)) return;
    TM.defineTask(BG_TASK, async () => {
      try { await runBackgroundTask(); } catch {}
      return BT?.BackgroundTaskResult?.Success ?? 1;
    });
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
/** URL GET de um objeto (renova se a assinatura venceu no meio de uma mídia longa). */
async function _getOne(uid, o, urls) {
  let url = urls.get(o);
  for (let i = 0; i < 2; i++) {
    if (!url) {
      const d = await _retry(() => _call('chat_cbk4_get_urls', { uid, objs: [o] }));
      url = d.get?.[0]?.url;
      if (!url) throw _err('ERR_MISSING', 'object missing');
      urls.set(o, url);
    }
    try { return await _retry(() => _getRaw(url, o)); } catch (e) {
      if (e?.http === 403 || e?.http === 400) { urls.delete(o); url = null; continue; }
      throw e;
    }
  }
  throw _err('ERR_STORAGE', 'GET expired');
}

/** Grava a mídia restaurada onde o app procura primeiro (offline). */
async function _restoreMedia(uid, keys, cid, list, onEach) {
  if (Platform.OS === 'web' || !list?.length) { for (const x of list || []) onEach(x, false); return; }
  const FS = _FSL();
  const urls = new Map();
  const queue = list.slice();
  while (queue.length) {
    const batch = []; let n = 0;
    while (queue.length && n + (queue[0].c?.length || 0) <= 200) { const e = queue.shift(); batch.push(e); n += e.c?.length || 0; }
    if (!batch.length) batch.push(queue.shift()); // > 200 pedaços: _getOne busca o resto
    const ids = batch.flatMap((e) => e.c || []).slice(0, 200);
    try { const d = await _retry(() => _call('chat_cbk4_get_urls', { uid, objs: ids })); for (const g of d.get || []) urls.set(g.o, g.url); } catch {}
    await _pool(batch, 2, async (e) => {
      let ok = false;
      try { ok = await _restoreOneMedia(uid, keys, cid, e, urls, FS); } catch { ok = false; }
      for (const o of e.c || []) urls.delete(o);
      onEach(e, ok);
    });
  }
}
async function _restoreOneMedia(uid, keys, cid, e, urls, FS) {
  if (!Array.isArray(e.c) || !e.c.length || !e.u) return false;
  let dest; let plan = null; let MS = null; let urlKey = null;
  if (e.e) {
    dest = `${FS.cacheDirectory}cbk4-rst-${_hex(nacl.hash(decodeUTF8(e.u)).slice(0, 10))}`;
  } else {
    MS = _ms(); const MC = _mc();
    try { urlKey = MC?.mediaUrlKey?.(e.u) || null; } catch {}
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(e.n || '')) || [])[1];
    try { plan = urlKey && MS?.isEnabled?.() ? MS.planPath({ urlKey, conversationId: cid, messageId: e.r === 'f' ? e.m : null, ext }) : null; } catch { plan = null; }
    if (plan?.existing && (await _fileSizeAsync(plan.abs)) > 0) return true; // já está no aparelho
    if (!plan) return false; // sem o store de mídia da conta não há onde o app ache o arquivo
    await _mkdir(plan.dir); dest = plan.abs;
  }
  const sink = _sink(dest);
  let bytes = 0;
  try {
    for (const o of e.c) { const plain = _open(keys, await _getOne(uid, o, urls), o); await sink.write(plain); bytes += plain.length; }
  } catch (err) { await sink.close(); await _rm(dest); throw err; }
  await sink.close();
  if (e.s && bytes !== e.s) { await _rm(dest); return false; }
  if (e.e) {
    const EM = _e2m();
    const kind = e.r === 't' ? 't320' : e.r === 'p' ? 'poster' : undefined;
    try { await EM?.adoptLocal?.({ url: e.u, name: e.n || undefined, mime: e.ct || undefined, kind }, dest); } catch {}
    await _rm(dest);
    return true;
  }
  if (plan && MS) { try { MS.record(plan, { urlKey, messageId: e.r === 'f' ? e.m : null, size: bytes }); } catch {} }
  return true;
}

/** Backup mais recente do servidor (para oferecer "Restaurar" num aparelho novo). null se não houver. */
export async function findRestoreCandidate(email) {
  if (!isOn()) return null;
  const em = _email(email);
  if (!em || !api.getAuthToken?.()) return null;
  const tag = _tag(em);
  try { if ((await AsyncStorage.getItem(_promptKey(tag))) === '1') return null; } catch {}
  let st;
  try { st = await status(); } catch { return null; }
  const set = st.enabled && st.sets?.length ? st.sets[0] : null;
  if (!set) return null;
  const rs = await _getJ(_rstKey(tag));
  if (rs?.uid === set.uid) return null;               // já restaurando/restaurado (retomada cuida)
  const mine = await _getState(tag);
  if (mine?.lastUid === set.uid) return null;           // este aparelho fez esse backup
  let hasKey = false;
  try { const K = await _rootKey(em); hasKey = !!(K && (!set.key_id || _keys(K).kid === set.key_id)); } catch {}
  if (hasKey) {
    // mesma chave e o aparelho já tem conversas = não é aparelho novo
    try { const rows = await _db()?.dbGetConversations?.(true); if (Array.isArray(rows) && rows.length > 0) return null; } catch {}
  }
  let hasPassword = false;
  if (!hasKey) { try { hasPassword = !!(await require('./ownBackup').listBackups()).hasPassword; } catch {} }
  try { await AsyncStorage.setItem(_promptKey(tag), '1'); } catch {}
  return { v: 4, email: em, set, hasPassword, hasKey };
}

/** Abre o manifesto (confere a chave). Sem chave local: opts.password | opts.recoveryKey via ownBackup. */
export async function unlock(set, opts = {}) {
  const em = _email(opts.email);
  const K = opts.key || (await _rootKey(em));
  const tryKey = async (k) => {
    const keys = _keys(k);
    if (set.key_id && set.key_id !== keys.kid) return false; // chave errada: nem baixa nada
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

/**
 * Restaura um backup para o aparelho (SQLite local + mídia no cache local). Não manda nada em claro
 * ao servidor. Retomável: conversa a conversa (opts.restart = começa do zero).
 */
export async function restore(set, opts = {}) {
  if (!isOn()) throw _err('ERR_DISABLED', 'cloud backup off');
  if (_running) throw _err('ERR_BUSY', 'busy');
  const p = _restore(set, opts);
  _running = p;
  try { return await p; } catch (e) { _emit({ phase: 'error', code: e?.code || 'ERR', restore: true }); throw e; } finally { _running = null; }
}
async function _restore(set, opts) {
  const em = _email(opts.email);
  const tag = _tag(em);
  _emit({ phase: 'restore', done: 0, total: 0, msgs: 0 });
  const { keys, man } = await unlock(set, opts);
  let convs = man.convs || [];
  if (Array.isArray(man.pages) && man.pages.length) {
    const got = new Map();
    await _getObjs(set.uid, man.pages, keys, async (o, v) => { got.set(o, v?.convs || []); });
    convs = man.pages.flatMap((o) => got.get(o) || []);
  }
  const db = _db();
  if (!db?.dbSaveMessages) throw _err('ERR_LOCAL', 'local store unavailable');
  const prevRs = await _getJ(_rstKey(tag));
  const rs = !opts.restart && prevRs?.uid === set.uid && prevRs.kid === keys.kid
    ? { ...prevRs, done: prevRs.done || {} }
    : { uid: set.uid, kid: keys.kid, manifest: set.manifest, at: new Date().toISOString(), done: {}, msgs: 0, media: 0 };
  rs.state = 'running';
  await _setJ(_rstKey(tag), rs);
  try {
    await db.dbSaveConversations?.(convs.map((c) => ({
      id: c.id, type: c.type, name: c.name, avatar: c.avatar, archived: c.archived ? 1 : 0, members: c.members || undefined,
      ...(c.imported ? { imported: 1, import_source: c.import_source || undefined } : {}),
    })));
  } catch {}
  const total = convs.reduce((a, c) => a + (c.blocks?.length || 0) + (c.media?.length || 0), 0);
  let done = convs.reduce((a, c) => a + (rs.done[c.id] ? (c.blocks?.length || 0) + (c.media?.length || 0) : 0), 0);
  let msgs = rs.msgs || 0; let media = rs.media || 0; let mediaFailed = 0;
  for (const c of convs) {
    if (rs.done[c.id]) continue;
    const ids = (c.blocks || []).map((b) => b.o);
    await _getObjs(set.uid, ids, keys, async (_o, blk) => {
      const rows = (blk?.m || []).map((m) => (m.e2ee === 5 ? { ...m, _cbk4_restored: 1 } : m));
      if (rows.length) { await db.dbSaveMessages(String(c.id), rows); msgs += rows.length; }
      done++;
      _emit({ phase: 'restore', done, total, msgs, media });
    });
    await _restoreMedia(set.uid, keys, String(c.id), c.media || [], (_e, ok) => {
      done++; if (ok) media++; else mediaFailed++;
      _emit({ phase: 'restore', done, total, msgs, media });
    });
    rs.done[c.id] = 1; rs.msgs = msgs; rs.media = media;
    await _setJ(_rstKey(tag), rs);
  }
  rs.state = 'done'; rs.doneAt = new Date().toISOString();
  await _setJ(_rstKey(tag), { uid: rs.uid, kid: rs.kid, state: 'done', doneAt: rs.doneAt, msgs, media });
  _emit({ phase: 'restored', done, total, msgs, media });
  return { conv_count: convs.length, msg_count: msgs, media_count: media, media_failed: mediaFailed };
}

/** Dispara a restauração sem prender a tela (progresso via subscribe). */
export function restoreInBackground(set, opts = {}) {
  const p = restore(set, opts);
  p.catch(() => {});
  return p;
}

/** Restauração que caiu (app fechado, rede) → continua de onde parou. Precisa da chave já no aparelho. */
export async function resumePendingRestore(email) {
  if (!isOn() || _running) return { skipped: 'off_or_busy' };
  const em = _email(email);
  if (!em || !api.getAuthToken?.()) return { skipped: 'no_account' };
  const tag = _tag(em);
  const rs = await _getJ(_rstKey(tag));
  if (!rs?.uid || rs.state === 'done') return { skipped: 'none' };
  const K = await _rootKey(em);
  if (!K || _keys(K).kid !== rs.kid) return { skipped: 'no_key' };
  let set = null; let restart = false;
  try {
    const st = await status();
    set = [...(st.sets || []), ...(st.previous || [])].find((s) => s.uid === rs.uid) || null;
    // o backup que estava sendo restaurado foi substituído e já saiu da janela → continua pelo atual (mesma chave)
    if (!set && st.sets?.[0] && (!st.sets[0].key_id || st.sets[0].key_id === rs.kid)) { set = st.sets[0]; restart = true; }
  } catch { return { skipped: 'network' }; }
  if (!set) { await _setJ(_rstKey(tag), null); return { skipped: 'gone' }; }
  try { return { ran: true, restart, result: await restore(set, { email: em, key: K, restart }) }; } catch (e) { return { error: e?.code || 'ERR' }; }
}
export async function pendingRestore(email) {
  const em = _email(email);
  const rs = em ? await _getJ(_rstKey(_tag(em))) : null;
  return rs && rs.state !== 'done' ? { uid: rs.uid, done: Object.keys(rs.done || {}).length, msgs: rs.msgs || 0, media: rs.media || 0 } : null;
}

export async function deleteAll(email) {
  const r = await _call('chat_cbk4_delete', { all: 1 });
  const em = _email(email);
  if (em) { const tag = _tag(em); await _setState(tag, null); await _setJ(_rstKey(tag), null); await setPrefs({ lastAt: null }, em); }
  return r;
}

export async function localSummary(email) {
  const em = _email(email);
  const st = em ? await _getState(_tag(em)) : null;
  return {
    lastAt: st?.lastAt || null, lastSize: st?.lastSize || 0, lastMedia: st?.lastMedia || 0, lastMediaSkipped: st?.lastMediaSkipped || 0,
    quotaHit: !!st?.quotaHit, hasKey: !!(em && (await _rootKey(em))),
  };
}

// Para testes (node): formato puro, sem rede.
export const __test = { _keys, _prep, _seal, _open, _json, _blocks, _isBoundary, _mediaCands, _md5, K_BIN, K_JSON };

export default {
  isOn, status, runBackup, maybeRunAuto, startRunner, runBackgroundTask, defineBackgroundTask, findRestoreCandidate, unlock, restore,
  restoreInBackground, resumePendingRestore, pendingRestore, deleteAll, getPrefs, setPrefs, subscribe, getProgress, isRunning, localSummary,
};
