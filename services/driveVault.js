/**
 * driveVault — "Cofre" do Drive: pasta PRIVADA por pessoa no servidor do
 * Chatyy, com os arquivos cifrados NO APARELHO antes de subir.
 * [2026-10-09 per-user-vault]
 *
 * Mesma chave do backup das conversas (services/ownBackup.js): Keychain/
 * Keystore + senha ou chave de 64 dígitos → o usuário tem UMA senha só.
 * Só primitivas do tweetnacl (secretbox = XSalsa20-Poly1305; SHA-512):
 *   - Kv  = SHA-512('chatyy-vault-v1' | K)[0..32]   (chave do cofre)
 *   - FK  = 32 bytes aleatórios por arquivo        (chave do arquivo — permite
 *           compartilhar UM arquivo no futuro sem expor o cofre)
 *   - parte  = 'CYV1' | nonce(24) | secretbox(item(12) | idx u32 | total u32 | bytes, FK)
 *   - meta   = 'CYV1' | nonce(24) | secretbox(JSON{nome,tipo,tamanho,partes,FK,item}, Kv)
 * O servidor (api/drive-vault.php) só vê nº de partes, bytes cifrados e datas.
 * Sem a chave (senha esquecida + chave de 64 dígitos perdida) o conteúdo é
 * irrecuperável — inclusive para o Chatyy.
 *
 * Endpoints: email.php?action=chat_vault_{status,init,put,commit,list,get,delete}
 * Flag no servidor (DRIVE_VAULT): desligado para todos menos contas QA.
 */
import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import * as api from './api';
import * as ownBackup from './ownBackup';

const MAGIC = new Uint8Array([0x43, 0x59, 0x56, 0x31]); // 'CYV1'
const NONCE_LEN = 24;
const HDR_LEN = 12 + 4 + 4;
export const PART_BYTES = 4 * 1024 * 1024 - 64;          // texto em claro por parte
export const MAX_FILE_BYTES = 150 * 1024 * 1024;          // decifra em memória no aparelho
const UPLOAD_CONCURRENCY = 2;

function _err(code, msg, extra) { const e = new Error(msg || code); e.code = code; if (extra) Object.assign(e, extra); return e; }
function _cat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function _unhex(s) { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }
function _hex(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
function _email(e) {
  let v = e;
  if (!v) { try { v = api.getActiveAccountEmail?.(); } catch {} }
  return String(v || '').trim().toLowerCase();
}
function _tag(email) { return _hex(nacl.hash(decodeUTF8('chatyy-vault|' + email)).slice(0, 8)); }
function _vaultKey(K) { return nacl.hash(_cat([decodeUTF8('chatyy-vault-v1'), K])).slice(0, 32); }
function _u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function _rd32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }

function _seal(key, plain) {
  const nonce = nacl.randomBytes(NONCE_LEN);
  return _cat([MAGIC, nonce, nacl.secretbox(plain, nonce, key)]);
}
function _open(key, blob) {
  if (!blob || blob.length < 4 + NONCE_LEN + 16) throw _err('ERR_CORRUPT', 'object too small');
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) throw _err('ERR_CORRUPT', 'bad magic');
  const pt = nacl.secretbox.open(blob.subarray(4 + NONCE_LEN), blob.subarray(4, 4 + NONCE_LEN), key);
  if (!pt) throw _err('ERR_DECRYPT', 'decrypt failed');
  return pt;
}
function _openMeta(Kv, metaB64, item, email) {
  const m = JSON.parse(encodeUTF8(_open(Kv, decodeBase64(metaB64))));
  if (!m || m.v !== 1 || m.i !== item || m.a !== _tag(email)) throw _err('ERR_CORRUPT', 'meta mismatch');
  return m;
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
function _code(status) {
  return status === 507 ? 'ERR_QUOTA' : status === 401 ? 'ERR_AUTH' : status === 403 ? 'ERR_DISABLED' : status === 404 ? 'ERR_NOT_FOUND' : 'ERR_SERVER';
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
  if (!r.ok || !j?.success) throw _err(_code(r.status), j?.message || `HTTP ${r.status}`, { status: r.status, data: j?.data || null });
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

async function _putPart(item, part, sealed) {
  const url = _url('chat_vault_put', { item, part });
  if (Platform.OS !== 'web') {
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}vault-up-${item}-${part}.bin`;
    await FS.writeAsStringAsync(tmp, encodeBase64(sealed), { encoding: FS.EncodingType.Base64 });
    try {
      const r = await FS.uploadAsync(url, tmp, {
        httpMethod: 'POST',
        uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
        headers: _headers({ 'Content-Type': 'application/octet-stream' }),
      });
      let j = null; try { j = JSON.parse(r.body || ''); } catch {}
      if (r.status < 200 || r.status >= 300 || !j?.success) throw _err(_code(r.status), j?.message || `HTTP ${r.status}`, { status: r.status });
      return j.data;
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
  }
  let r;
  try { r = await fetch(url, { method: 'POST', headers: _headers({ 'Content-Type': 'application/octet-stream' }), body: sealed, credentials: 'include' }); }
  catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j?.success) throw _err(_code(r.status), j?.message || `HTTP ${r.status}`, { status: r.status });
  return j.data;
}

async function _getPart(item, part) {
  const url = _url('chat_vault_get', { item, part });
  if (Platform.OS !== 'web') {
    const FS = require('expo-file-system/legacy');
    const tmp = `${FS.cacheDirectory}vault-dl-${item}-${part}.bin`;
    try {
      const r = await FS.downloadAsync(url, tmp, { headers: _headers() });
      if (r.status !== 200) throw _err(_code(r.status), `HTTP ${r.status}`, { status: r.status });
      return decodeBase64(await FS.readAsStringAsync(tmp, { encoding: FS.EncodingType.Base64 }));
    } finally { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch {} }
  }
  let r;
  try { r = await fetch(url, { headers: _headers(), credentials: 'include' }); }
  catch (e) { throw _err('ERR_NETWORK', e?.message || 'network'); }
  if (!r.ok) throw _err(_code(r.status), `HTTP ${r.status}`, { status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

// ─── leitura do arquivo local em pedaços ────────────────────────────────
// file: web = File/Blob (input type=file); nativo = { uri, name, mimeType, size }
async function _fileSize(file) {
  if (Platform.OS === 'web') return file.size;
  if (Number(file.size) > 0) return Number(file.size);
  const FS = require('expo-file-system/legacy');
  const info = await FS.getInfoAsync(file.uri, { size: true });
  return Number(info?.size) || 0;
}
async function _readSlice(file, start, len) {
  if (Platform.OS === 'web') return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  const FS = require('expo-file-system/legacy');
  return decodeBase64(await FS.readAsStringAsync(file.uri, { encoding: FS.EncodingType.Base64, position: start, length: len }));
}

// ─── API pública ─────────────────────────────────────────────────────────
/** { enabled, count, has_password_vault, quota } — enabled=false fora da flag. */
export async function getStatus() { return _call('chat_vault_status', null, 'GET'); }

/** Este aparelho já tem a chave (a mesma do backup das conversas)? */
export async function hasKey(email) { return !!(await ownBackup.getKeyBytes(email)); }

async function _keys(email) {
  const K = await ownBackup.getKeyBytes(email);
  if (!K) throw _err('ERR_NO_KEY', 'vault key missing');
  return { Kv: _vaultKey(K) };
}

/**
 * Cria a chave neste aparelho (primeira vez, sem backup/cofre existente) e
 * guarda embrulhada pela senha no servidor (mesmo cofre de senha do backup).
 * Retorna { recoveryKey } (64 dígitos) para o usuário anotar.
 */
export async function setupWithPassword(password, email) {
  return ownBackup.setupBackupKey({ mode: 'password', password }, email);
}

/** Destrava a chave com a senha ou a chave de 64 dígitos (confere contra um item do cofre, se houver). */
export async function unlock({ password, recoveryKey }, email) {
  const em = _email(email);
  let sample = null;
  try { const d = await _call('chat_vault_list', null, 'GET'); sample = (d.items || [])[0] || null; } catch {}
  const verify = sample ? (K) => { _openMeta(_vaultKey(K), sample.meta, sample.item, em); return true; } : null;
  return ownBackup.unlockKeyOnly({ password, recoveryKey, verify }, em);
}

/** Lista e decifra os metadados no aparelho. Itens que esta chave não abre vêm com locked=true. */
export async function listFiles(email) {
  const em = _email(email);
  const { Kv } = await _keys(em);
  const out = [];
  let before = 0; let quota = null;
  for (let guard = 0; guard < 40; guard++) {
    const d = await _call('chat_vault_list', null, 'GET', before ? { before } : null);
    quota = d.quota || quota;
    for (const it of d.items || []) {
      let m = null;
      try { m = _openMeta(Kv, it.meta, it.item, em); } catch {}
      out.push(m
        ? { item: it.item, name: m.n, mime: m.m, size: m.s, parts: m.p, createdAt: it.created_at, stored: it.size_bytes, locked: false, _fk: m.k }
        : { item: it.item, name: null, mime: null, size: 0, parts: it.parts, createdAt: it.created_at, stored: it.size_bytes, locked: true });
      before = it.id;
    }
    if (!d.more) break;
  }
  return { files: out, quota };
}

/** Cifra no aparelho e sobe. onProgress(0..1). */
export async function uploadFile(file, { name, mimeType, onProgress } = {}, email) {
  const em = _email(email);
  const { Kv } = await _keys(em);
  const size = await _fileSize(file);
  if (!size) throw _err('ERR_EMPTY', 'empty file');
  if (size > MAX_FILE_BYTES) throw _err('ERR_TOO_BIG', 'file too big', { max: MAX_FILE_BYTES });
  const parts = Math.max(1, Math.ceil(size / PART_BYTES));
  const sealedEstimate = size + parts * (4 + NONCE_LEN + 16 + HDR_LEN);
  const init = await _call('chat_vault_init', { parts, size: sealedEstimate });
  const item = init.item;
  const itemB = _unhex(item);
  const FK = nacl.randomBytes(32);
  let done = 0;
  const idx = Array.from({ length: parts }, (_, i) => i);
  let next = 0;
  const worker = async () => {
    while (next < idx.length) {
      const i = idx[next++];
      const start = i * PART_BYTES;
      const plain = await _readSlice(file, start, Math.min(PART_BYTES, size - start));
      const sealed = _seal(FK, _cat([itemB, _u32(i), _u32(parts), plain]));
      await _withRetry(() => _putPart(item, i, sealed));
      done++;
      try { onProgress?.(done / (parts + 1)); } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, parts) }, worker));
  const meta = {
    v: 1, i: item, a: _tag(em),
    n: String(name || file?.name || 'arquivo').slice(0, 255),
    m: String(mimeType || file?.mimeType || file?.type || 'application/octet-stream').slice(0, 120),
    s: size, p: parts, k: _hex(FK), t: new Date().toISOString(),
  };
  const res = await _withRetry(() => _call('chat_vault_commit', { item, meta: encodeBase64(_seal(Kv, decodeUTF8(JSON.stringify(meta)))) }));
  try { onProgress?.(1); } catch {}
  return { item, quota: res.quota || null };
}

/** Baixa e decifra no aparelho → Uint8Array + metadados. entry = item de listFiles(). */
export async function downloadFile(entry, { onProgress } = {}) {
  if (!entry || entry.locked || !entry._fk) throw _err('ERR_DECRYPT', 'locked');
  const FK = _unhex(entry._fk);
  const parts = entry.parts;
  const itemB = _unhex(entry.item);
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    const pt = _open(FK, await _withRetry(() => _getPart(entry.item, i)));
    if (pt.length < HDR_LEN) throw _err('ERR_CORRUPT', 'short part');
    for (let b = 0; b < 12; b++) if (pt[b] !== itemB[b]) throw _err('ERR_CORRUPT', 'part from another file');
    if (_rd32(pt, 12) !== i || _rd32(pt, 16) !== parts) throw _err('ERR_CORRUPT', 'part order mismatch');
    chunks.push(pt.subarray(HDR_LEN));
    try { onProgress?.((i + 1) / parts); } catch {}
  }
  const bytes = _cat(chunks);
  if (bytes.length !== entry.size) throw _err('ERR_CORRUPT', 'size mismatch');
  return { bytes, name: entry.name, mime: entry.mime };
}

/** Decifra e entrega ao usuário: web = baixar arquivo; nativo = abrir/compartilhar. */
export async function openFile(entry, opts = {}) {
  const { bytes, name, mime } = await downloadFile(entry, opts);
  const safe = String(name || 'arquivo').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'arquivo';
  if (Platform.OS === 'web') {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = safe; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }
  const FS = require('expo-file-system/legacy');
  const dir = `${FS.cacheDirectory}vault-open/`;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  const path = `${dir}${safe}`;
  await FS.writeAsStringAsync(path, encodeBase64(bytes), { encoding: FS.EncodingType.Base64 });
  const Sharing = require('expo-sharing');
  await Sharing.shareAsync(path, { mimeType: mime || 'application/octet-stream', dialogTitle: safe });
  return true;
}

/** Apaga as cópias decifradas temporárias (chamar ao abrir/fechar a tela). */
export async function wipeTemp() {
  if (Platform.OS === 'web') return;
  try {
    const FS = require('expo-file-system/legacy');
    await FS.deleteAsync(`${FS.cacheDirectory}vault-open/`, { idempotent: true });
  } catch {}
}

export async function deleteFile(item) { return _call('chat_vault_delete', { item }); }

export default { getStatus, hasKey, setupWithPassword, unlock, listFiles, uploadFile, downloadFile, openFile, wipeTemp, deleteFile, PART_BYTES, MAX_FILE_BYTES };
