// [e2ee5 WP-11 2026-10-21] Mídia cifrada no CLIENTE (CONTRATO §2.4.1, F3).
//
// Envio: as variantes saem do APARELHO (miniatura t320, LQIP, blurhash, pôster, dimensões, duração,
// waveform), cada arquivo é cifrado pelo núcleo (nativo: encryptFile; web: encryptBytes) e sobe como
// blob OPACO (`context=e2e`, Content-Type octet-stream, nome aleatório) — o servidor não processa
// nada. A chave/IV/sha256 (MediaEncryptionInfo) vão só dentro do payload cifrado (`media:[M]`).
// Recepção: baixa o ciphertext para um cache LOCAL CIFRADO (nativo: documentDirectory/e2ee5-media/enc;
// web: Cache Storage) e decifra sob demanda para uma cópia de exibição descartável (nativo:
// cacheDirectory/e2ee5-media/plain — o sistema pode limpar e o app refaz do .enc sem rede; web: blob:
// em memória da aba). Vídeo/áudio: baixa e decifra inteiro antes de tocar (o SHA-256 do arquivo só
// confere no fim; tocar em partes exibiria bytes não verificados — v2 em blocos fica para depois).
// Byte trocado ⇒ decryptFile/decryptBytes rejeita (code 'media') ⇒ estado 'failed' ("Não foi possível
// abrir"), nunca mostra o arquivo.
//
// FLAG: só roda com globalThis.__chatyy_e2ee5 === true e conversa e2ee_mode=1 (quem chama confere).
// Logs: só tamanhos/ids/códigos (nunca chave, URL+chave juntas, nome de arquivo ou conteúdo).
import { Platform } from 'react-native';

const ORIGIN = 'https://chatyy.com.br';
export const E2E_URL_RE = /^https:\/\/media\.chatyy\.com\.br\/e2e\/[A-Za-z0-9_-]{8,}(?:_[A-Za-z0-9_.-]+)?$/;
const MAX_BYTES = 200 * 1024 * 1024;
const CHUNKED_MIN = 1024 * 1024;
const MAX_DL = 2;
const WEB_CACHE = 'chatyy-e2ee5-media-v1';

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _C() { return require('../crypto'); }
function _A() { return require('../api'); }
function _E() { return require('./e2ee5'); }
function _P() { return require('./payload'); }
function _FS() { try { return require('expo-file-system/legacy'); } catch (_) { return null; } }
function _log(what, kv) { try { if (_g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5.media] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch (_) {} }
function _err(code, msg) { const e = new Error('e2ee5:' + code + (msg ? ' ' + msg : '')); e.code = code; return e; }

export function isE2eUrl(u) { return typeof u === 'string' && E2E_URL_RE.test(u); }

function _rand(n) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let bytes = null;
  try { const c = _g().crypto; if (c && typeof c.getRandomValues === 'function') bytes = c.getRandomValues(new Uint8Array(n)); } catch (_) {}
  let s = '';
  for (let i = 0; i < n; i++) s += A[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) & 63];
  return s;
}
const _strip = (u) => { const s = String(u || ''); const p = s.startsWith('file://') ? s.slice(7) : s; try { return decodeURI(p); } catch (_) { return p; } };
const _fileUri = (p) => (String(p).startsWith('file://') ? String(p) : 'file://' + String(p));
function _keyOfUrl(url) { const m = /\/e2e\/([A-Za-z0-9_.-]+)$/.exec(String(url || '')); return m ? m[1].replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) : ''; }
function _extOf(F) {
  const n = String((F && F.name) || '');
  const m = /\.([a-z0-9]{1,5})$/i.exec(n);
  if (m) return '.' + m[1].toLowerCase();
  const mime = String((F && F.mime) || '').toLowerCase();
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/mp4': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'application/pdf': '.pdf', 'application/json': '.json', 'image/heif': '.heif', 'video/3gpp': '.3gp', 'video/webm': '.webm', 'video/x-m4v': '.m4v' };
  if (map[mime]) return map[mime];
  if (F && F.kind === 't320' || F && F.kind === 'poster') return '.jpg';
  return '.bin';
}

// ───────────────────────────────────────────────────────────── estado local (url → arquivo decifrado)

const _plain = new Map();   // url → uri (file:// ou blob:)
const _state = new Map();   // url → 'loading' | 'failed' | 'ready'
const _inflight = new Map();
const _subs = new Set();
let _active = 0;
const _queue = [];

/** fn({url, state, conv, mid}) quando um arquivo fica pronto ou falha. */
export function subscribe(fn) { if (typeof fn === 'function') _subs.add(fn); return () => _subs.delete(fn); }
function _notify(ev) { for (const f of Array.from(_subs)) { try { f(ev); } catch (_) {} } }

function _dirs() {
  const FS = _FS();
  if (!FS || !FS.documentDirectory || !FS.cacheDirectory) return null;
  return { enc: FS.documentDirectory + 'e2ee5-media/enc/', plain: FS.cacheDirectory + 'e2ee5-media/plain/' };
}
let _dirsOk = null;
async function _ensureDirs() {
  const d = _dirs();
  if (!d) return null;
  if (_dirsOk) return d;
  const FS = _FS();
  for (const x of [d.enc, d.plain]) { try { await FS.makeDirectoryAsync(x, { intermediates: true }); } catch (_) {} }
  _dirsOk = true;
  return d;
}
// Reabrir o app: o que já está decifrado no disco volta ao índice (sem rede).
let _hydP = null;
function _hydrate() {
  if (Platform.OS === 'web' || _hydP) return _hydP;
  _hydP = (async () => {
    const d = await _ensureDirs();
    if (!d) return;
    try {
      const names = await _FS().readDirectoryAsync(d.plain);
      for (const n of names || []) { const k = n.replace(/\.[a-z0-9]{1,5}$/i, ''); if (k) _hydKeys.set(k, d.plain + n); }
    } catch (_) {}
  })();
  return _hydP;
}
const _hydKeys = new Map(); // chave do blob → uri decifrada (do disco)

function _lookup(url) {
  if (!url) return null;
  const u = _plain.get(url);
  if (u) return u;
  const k = _keyOfUrl(url);
  if (k && _hydKeys.has(k)) { const p = _hydKeys.get(k); _plain.set(url, p); _state.set(url, 'ready'); return p; }
  return null;
}

/** Arquivos já decifrados deste objeto de mídia (síncrono): {uri, thumb, poster, state}. */
export function localSync(M) {
  if (!M || !M.url) return {};
  if (Platform.OS !== 'web') _hydrate();
  const P = _P();
  const t = P.thumbOf(M, 't320');
  const poster = M.poster && M.poster.url ? M.poster : P.thumbOf(M, 'poster');
  const out = {};
  const u = _lookup(M.url);
  if (u) out.uri = u;
  const tu = t ? _lookup(t.url) : null;
  if (tu) out.thumb = tu;
  const pu = poster ? _lookup(poster.url) : null;
  if (pu) out.poster = pu;
  out.state = _state.get(M.url) || (u ? 'ready' : 'idle');
  return out;
}

/** O REMETENTE já tem o arquivo em claro: registra (cópia própria no cache de exibição). */
export async function adoptLocal(F, srcUri) {
  if (!F || !F.url || !srcUri) return;
  if (Platform.OS === 'web') { _plain.set(F.url, srcUri); _state.set(F.url, 'ready'); return; }
  const d = await _ensureDirs();
  if (!d) return;
  const k = _keyOfUrl(F.url);
  const dst = d.plain + k + _extOf(F);
  try { await _FS().copyAsync({ from: srcUri, to: dst }); _plain.set(F.url, dst); _hydKeys.set(k, dst); _state.set(F.url, 'ready'); } catch (_) {}
}

/**
 * Pede os arquivos de um objeto de mídia (miniatura e pôster primeiro, depois o principal).
 * meta: {conv, mid} — vai no aviso de "pronto" (a conversa repinta a linha).
 */
export function want(M, meta) {
  if (!M || !M.url || !M.file) return;
  const P = _P();
  const t = P.thumbOf(M, 't320');
  const poster = M.poster && M.poster.url ? M.poster : P.thumbOf(M, 'poster');
  if (t && t.file && !_lookup(t.url)) _enqueue({ ...t, mime: t.mime || 'image/jpeg' }, meta, true);
  if (poster && poster.file && !_lookup(poster.url)) _enqueue({ ...poster, mime: poster.mime || 'image/jpeg' }, meta, true);
  if (!_lookup(M.url) && _state.get(M.url) !== 'failed') _enqueue(M, meta, false);
}

/** Garante o arquivo decifrado (promessa da uri). */
export function ensure(F, meta) {
  const u = _lookup(F && F.url);
  if (u) return Promise.resolve(u);
  return _enqueue(F, meta, true);
}

function _enqueue(F, meta, front) {
  if (_inflight.has(F.url)) return _inflight.get(F.url).p;
  let res; let rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  p.catch(() => {});
  const job = { F, meta: meta || {}, res, rej, p };
  _inflight.set(F.url, job);
  _state.set(F.url, 'loading');
  if (front) _queue.unshift(job); else _queue.push(job);
  _pump();
  return p;
}
function _pump() {
  while (_active < MAX_DL && _queue.length) {
    const job = _queue.shift();
    _active += 1;
    _fetchDecrypt(job.F).then((uri) => {
      _plain.set(job.F.url, uri); _state.set(job.F.url, 'ready');
      job.res(uri);
      _notify({ url: job.F.url, state: 'ready', conv: job.meta.conv, mid: job.meta.mid });
    }, (e) => {
      _state.set(job.F.url, 'failed');
      _log('dl_fail', { code: e && e.code, size: Number(job.F.size) || 0 });
      job.rej(e);
      _notify({ url: job.F.url, state: 'failed', conv: job.meta.conv, mid: job.meta.mid, code: e && e.code });
    }).finally(() => { _active -= 1; _inflight.delete(job.F.url); _pump(); });
  }
}

async function _fetchDecrypt(F) {
  if (!isE2eUrl(F.url)) throw _err('bad_url');
  const info = typeof F.file === 'string' ? F.file : JSON.stringify(F.file || {});
  if (Platform.OS === 'web') {
    let buf = null;
    let cache = null;
    try { cache = await _g().caches.open(WEB_CACHE); } catch (_) { cache = null; }
    try { const hit = cache ? await cache.match(F.url) : null; if (hit) buf = new Uint8Array(await hit.arrayBuffer()); } catch (_) { buf = null; }
    if (!buf) {
      const r = await fetch(F.url, { credentials: 'omit' });
      if (!r.ok) throw _err('http_' + r.status);
      const ab = await r.arrayBuffer();
      buf = new Uint8Array(ab);
      try { if (cache) await cache.put(F.url, new Response(ab, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (_) {}
    }
    const plain = await _C().decryptBytes(buf, info);
    const blob = new Blob([plain], { type: F.mime || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }
  const FS = _FS();
  const d = await _ensureDirs();
  if (!FS || !d) throw _err('no_fs');
  const k = _keyOfUrl(F.url);
  if (!k) throw _err('bad_url');
  const enc = d.enc + k + '.bin';
  const out = d.plain + k + _extOf(F);
  let have = false;
  try { const i = await FS.getInfoAsync(enc); have = !!(i && i.exists && i.size > 0); } catch (_) {}
  if (!have) {
    const tmp = enc + '.part';
    const r = await FS.downloadAsync(F.url, tmp);
    if (!r || r.status !== 200) { try { await FS.deleteAsync(tmp, { idempotent: true }); } catch (_) {} throw _err('http_' + (r ? r.status : 0)); }
    await FS.moveAsync({ from: tmp, to: enc });
  }
  try {
    await _C().decryptFile(_strip(enc), _strip(out), info);
  } catch (e) {
    // adulterado / chave errada: apaga o .enc (pode ter sido download truncado) e falha claro
    try { await FS.deleteAsync(enc, { idempotent: true }); } catch (_) {}
    throw e;
  }
  _hydKeys.set(k, out);
  return out;
}

// ───────────────────────────────────────────────────────────── variantes no aparelho

function _imgSize(uri) {
  return new Promise((resolve) => {
    try {
      const { Image } = require('react-native');
      Image.getSize(uri, (w, h) => resolve({ w, h }), () => resolve(null));
    } catch (_) { resolve(null); }
  });
}

async function _resizeJpeg(uri, width, quality) {
  try {
    const IM = require('expo-image-manipulator');
    const r = await IM.manipulateAsync(uri, [{ resize: { width } }], { compress: quality, format: IM.SaveFormat.JPEG });
    return r && r.uri ? { uri: r.uri, w: r.width || 0, h: r.height || 0 } : null;
  } catch (_) { return null; }
}

async function _lqip(uri) {
  try { return await require('../imageSendPipeline').generateLocalLQIP(uri); } catch (_) { return null; }
}

// Blurhash (algoritmo público blurha.sh — não é criptografia). Nativo: expo-image; web: canvas + este codificador.
const _B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
function _b83(v, len) { let s = ''; for (let i = 1; i <= len; i++) s += _B83[Math.floor(v / Math.pow(83, len - i)) % 83]; return s; }
function _s2l(v) { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function _l2s(v) { const x = Math.max(0, Math.min(1, v)); return x <= 0.0031308 ? Math.round(x * 12.92 * 255 + 0.5) : Math.round((1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255 + 0.5); }
function _sp(v, e) { return Math.sign(v) * Math.pow(Math.abs(v), e); }
export function blurhashEncode(px, w, h, cx = 4, cy = 3) {
  const f = [];
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const norm = (x === 0 && y === 0) ? 1 : 2;
    let r = 0; let g = 0; let b = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const basis = norm * Math.cos(Math.PI * x * i / w) * Math.cos(Math.PI * y * j / h);
      const o = 4 * (j * w + i);
      r += basis * _s2l(px[o]); g += basis * _s2l(px[o + 1]); b += basis * _s2l(px[o + 2]);
    }
    const sc = 1 / (w * h);
    f.push([r * sc, g * sc, b * sc]);
  }
  const dc = f[0]; const ac = f.slice(1);
  let hash = _b83((cx - 1) + (cy - 1) * 9, 1);
  let maxV = 1;
  if (ac.length) {
    const actual = Math.max(...ac.map((c) => Math.max(Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]))));
    const q = Math.floor(Math.max(0, Math.min(82, Math.floor(actual * 166 - 0.5))));
    maxV = (q + 1) / 166;
    hash += _b83(q, 1);
  } else hash += _b83(0, 1);
  hash += _b83((_l2s(dc[0]) << 16) + (_l2s(dc[1]) << 8) + _l2s(dc[2]), 4);
  for (const c of ac) {
    const q = (v) => Math.floor(Math.max(0, Math.min(18, Math.floor(_sp(v / maxV, 0.5) * 9 + 9.5))));
    hash += _b83(q(c[0]) * 19 * 19 + q(c[1]) * 19 + q(c[2]), 2);
  }
  return hash;
}
function _webPixels(uri, max) {
  return new Promise((resolve) => {
    try {
      const img = new (_g().Image)();
      img.onload = () => {
        try {
          const s = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
          resolve({ px: cx.getImageData(0, 0, w, h).data, w, h, W: img.width, H: img.height });
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = uri;
    } catch (_) { resolve(null); }
  });
}
async function _blurhash(uri) {
  if (!uri) return null;
  if (Platform.OS === 'web') {
    const p = await _webPixels(uri, 32);
    return p ? blurhashEncode(p.px, p.w, p.h) : null;
  }
  try { const { Image } = require('expo-image'); if (Image && typeof Image.generateBlurhashAsync === 'function') return (await Image.generateBlurhashAsync(uri, [4, 3])) || null; } catch (_) {}
  return null;
}

async function _webPoster(uri) {
  return new Promise((resolve) => {
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = uri;
      const done = (x) => { try { v.removeAttribute('src'); v.load(); } catch (_) {} resolve(x); };
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (_) { done(null); } };
      v.onseeked = () => {
        try {
          const s = Math.min(1, 720 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
          const cv = document.createElement('canvas'); cv.width = Math.round((v.videoWidth || 320) * s); cv.height = Math.round((v.videoHeight || 240) * s);
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
          cv.toBlob((b) => done(b ? { uri: URL.createObjectURL(b), blob: b, w: v.videoWidth, h: v.videoHeight, durMs: Math.round((v.duration || 0) * 1000) } : null), 'image/jpeg', 0.8);
        } catch (_) { done(null); }
      };
      v.onerror = () => done(null);
      setTimeout(() => done(null), 8000);
    } catch (_) { resolve(null); }
  });
}

// ───────────────────────────────────────────────────────────── cifrar + subir

async function _readBlob(src) {
  if (src.blob) return src.blob;
  const r = await fetch(src.uri);
  return r.blob();
}

/** Cifra um arquivo e sobe como blob opaco. src = {uri} (nativo) | {blob|uri} (web). → {url, file, size} */
export async function encryptUpload(conv, src, opts) {
  const o = opts || {};
  const C = _C();
  if (Platform.OS === 'web') {
    const blob = await _readBlob(src);
    if (blob.size > MAX_BYTES) throw _err('too_large');
    const plain = new Uint8Array(await blob.arrayBuffer());
    const r = await C.encryptBytes(plain);
    const encBlob = new Blob([r.data], { type: 'application/octet-stream' });
    const url = await _uploadOpaque(conv, { blob: encBlob, size: encBlob.size }, o);
    return { url, file: JSON.parse(r.infoJson), size: plain.length };
  }
  const FS = _FS();
  const d = await _ensureDirs();
  if (!FS || !d) throw _err('no_fs');
  const info = await FS.getInfoAsync(src.uri);
  if (!info || !info.exists) throw _err('file_missing');
  if (info.size > MAX_BYTES) throw _err('too_large');
  const out = FS.cacheDirectory + 'e2ee5-media/up_' + _rand(12) + '.bin';
  try {
    const r = await C.encryptFile(_strip(src.uri), _strip(out));
    const url = await _uploadOpaque(conv, { uri: _fileUri(_strip(out)), size: Number(r.size) || 0 }, o);
    return { url, file: JSON.parse(r.infoJson), size: Number(info.size) || 0 };
  } finally {
    try { await FS.deleteAsync(out, { idempotent: true }); } catch (_) {}
  }
}

async function _uploadOpaque(conv, f, o) {
  const api = _A();
  const name = _rand(22);
  const file = Platform.OS === 'web'
    ? { blob: f.blob, name, type: 'application/octet-stream', size: f.size }
    : { uri: f.uri, name, type: 'application/octet-stream', size: f.size };
  let r = null;
  try {
    if (f.size > CHUNKED_MIN && api.rustChunkedUpload) r = await api.rustChunkedUpload(file, null, 'e2e', o.onPct || null, o.signal || null, null);
    else if (api.rustUpload) r = await api.rustUpload(file, null, 'e2e', o.signal || null, o.onPct || null);
  } catch (e) { r = null; }
  if (o.signal && o.signal.aborted) throw _err('aborted');
  if (r && r.success && isE2eUrl(r.cdn_url)) return r.cdn_url;
  if (r && Number(r.status) === 413) throw _err('too_large');
  // reserva: PHP do US (chat_upload opaque=1 — o servidor só guarda o blob, sem processar)
  const j = await _phpOpaque(conv, file, o);
  if (j && j.success && j.data && isE2eUrl(j.data.url)) return j.data.url;
  throw _err((j && j.data && j.data.code) || 'upload_failed');
}

function _phpOpaque(conv, file, o) {
  return new Promise((resolve) => {
    try {
      const api = _A();
      const tok = String((api.getAuthToken && api.getAuthToken()) || (api.getToken && api.getToken()) || '');
      const fd = new FormData();
      fd.append('action', 'chat_upload');
      fd.append('conversation_id', String(conv));
      fd.append('opaque', '1');
      if (Platform.OS === 'web') fd.append('file', file.blob, file.name);
      else fd.append('file', { uri: file.uri, name: file.name, type: 'application/octet-stream' });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ORIGIN + '/api/email.php?action=chat_upload&opaque=1');
      if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
      xhr.timeout = 10 * 60 * 1000;
      if (o.onPct) xhr.upload.onprogress = (e) => { if (e.lengthComputable) { try { o.onPct(e.loaded / e.total); } catch (_) {} } };
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch (_) { resolve({ success: false, data: { code: 'http_' + xhr.status } }); } };
      xhr.onerror = () => resolve({ success: false, data: { code: 'network' } });
      xhr.ontimeout = () => resolve({ success: false, data: { code: 'timeout' } });
      if (o.signal) o.signal.addEventListener && o.signal.addEventListener('abort', () => { try { xhr.abort(); } catch (_) {} }, { once: true });
      xhr.send(fd);
    } catch (_) { resolve({ success: false, data: { code: 'exception' } }); }
  });
}

/**
 * Monta o objeto de mídia M (§2.4.1) de um arquivo LOCAL: variantes no aparelho + cada uma cifrada e
 * enviada em separado. src = {uri, blob?, name, mime, size, width, height, durationMs, waveform, round}
 * kind = t do payload (image|gif|sticker|video|voice|audio|file). → {M, extra:{round}}
 */
export async function buildMedia(conv, kind, src, opts) {
  const o = opts || {};
  const P = _P();
  const pct = (a, b) => (f) => { try { o.onPct && o.onPct(a + (b - a) * Math.max(0, Math.min(1, Number(f) || 0))); } catch (_) {} };
  const M = { kind: kind === 'voice' || kind === 'audio' ? 'audio' : (kind === 'video' ? 'video' : (kind === 'file' ? 'file' : 'image')), mime: src.mime || 'application/octet-stream' };
  let uri = src.uri;
  if (Platform.OS === 'web' && !uri && src.blob) uri = URL.createObjectURL(src.blob);
  const thumbs = [];
  const later = [];
  if (kind === 'image' || kind === 'gif' || kind === 'sticker') {
    let w = Number(src.width) || 0; let h = Number(src.height) || 0;
    if (!(w > 0 && h > 0)) { const s = await _imgSize(uri); if (s) { w = s.w; h = s.h; } }
    if (w > 0 && h > 0) { M.w = w; M.h = h; }
    // [2026-10-22 figurinha-e2ee] figurinha (transparente): sem LQIP/blurhash (JPEG pintaria um quadro de fundo)
    if (!o.noPreview) { const lq = await _lqip(uri); if (lq) M.lqip = lq; }
    if (!o.noPreview) { const bh = await _blurhash(uri); if (bh) M.blurhash = bh; }
    if (kind === 'image' && Math.max(w, h) > 400) {
      const t = await _resizeJpeg(uri, w >= h ? 320 : Math.round(320 * w / Math.max(1, h)), 0.7);
      if (t) {
        const up = await encryptUpload(conv, { uri: t.uri }, { signal: o.signal });
        thumbs.push({ kind: 't320', url: up.url, file: up.file, w: t.w, h: t.h, size: up.size, mime: 'image/jpeg' });
        later.push({ F: thumbs[thumbs.length - 1], uri: t.uri });
      }
    }
  } else if (kind === 'video') {
    let poster = null;
    if (Platform.OS === 'web') poster = await _webPoster(uri);
    else { try { const r = await require('../videoSendPipeline').preparePoster(uri, Number(src.durationMs) || null); if (r && r.posterUri) poster = { uri: r.posterUri, w: r.width, h: r.height }; } catch (_) {} }
    const w = Number(src.width) || (poster && poster.w) || 0; const h = Number(src.height) || (poster && poster.h) || 0;
    if (w > 0 && h > 0) { M.w = w; M.h = h; }
    const durMs = Number(src.durationMs) || (poster && poster.durMs) || 0;
    if (durMs > 0) M.dur = Math.max(1, Math.round(durMs / 1000));
    if (poster) {
      const lq = await _lqip(poster.uri); if (lq) M.lqip = lq;
      const bh = await _blurhash(poster.uri); if (bh) M.blurhash = bh;
      const up = await encryptUpload(conv, poster.blob ? { blob: poster.blob } : { uri: poster.uri }, { signal: o.signal });
      M.poster = { kind: 'poster', url: up.url, file: up.file, w: poster.w || w || 0, h: poster.h || h || 0, size: up.size, mime: 'image/jpeg' };
      later.push({ F: M.poster, uri: poster.uri });
    }
  } else if (kind === 'voice' || kind === 'audio') {
    const dur = Number(src.durationSec) || (Number(src.durationMs) ? Math.round(Number(src.durationMs) / 1000) : 0);
    if (dur > 0) M.dur = dur;
    if (kind === 'voice') { const wf = P.waveformToB64(src.waveform); if (wf) M.waveform = wf; }
    if (kind === 'audio' && src.name) M.title = String(src.name).replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 120);
  }
  if (kind === 'file' || kind === 'audio') M.name = String(src.name || 'arquivo').slice(0, 200);
  if (kind === 'voice') M.name = 'voice' + (/\.([a-z0-9]{1,5})$/i.exec(String(src.name || '')) ? '.' + /\.([a-z0-9]{1,5})$/i.exec(String(src.name || ''))[1].toLowerCase() : '.m4a');
  if (o.signal && o.signal.aborted) throw _err('aborted');
  const main = await encryptUpload(conv, src.blob && Platform.OS === 'web' ? { blob: src.blob } : { uri }, { signal: o.signal, onPct: pct(0.05, 1) });
  M.url = main.url; M.file = main.file; M.size = main.size;
  if (thumbs.length) M.thumbs = thumbs;
  // o remetente já tem os arquivos em claro (não baixa o que acabou de mandar)
  try { await adoptLocal(M, uri); for (const x of later) await adoptLocal(x.F, x.uri); } catch (_) {}
  _log('built', { kind, size: M.size, thumbs: thumbs.length, poster: !!M.poster });
  return M;
}

/** Tipo do app → t do payload de mídia. */
export function kindOfAppType(type, name, mime) {
  const t = String(type || '');
  if (t === 'video_note' || t === 'short_video' || t === 'video') return 'video';
  if (t === 'voice') return 'voice';
  if (t === 'audio') return /voice|ptt/i.test(String(name || '')) ? 'voice' : 'audio';
  if (t === 'image') return /gif/i.test(String(mime || '')) || /\.gif$/i.test(String(name || '')) ? 'gif' : 'image';
  if (t === 'gif') return 'gif';
  if (t === 'sticker' || t === 'lottie_sticker') return 'sticker';
  return 'file';
}

// ───────────────────────────────────────────────────────────── envio completo (chat_upload / fila)

/**
 * Gancho do api.chatUploadFile (web e caminho legado do nativo): em conversa E2EE cifra, sobe opaco,
 * sela e manda pelo chat_send. null = não é E2EE (caminho de hoje). Formato do retorno = chatUploadFile.
 */
export async function uploadViaChatUpload(conv, file, o) {
  const e5 = _E();
  if (!e5.isOn() || conv == null) return null;
  let mode = e5.convModeSync(conv);
  if (mode == null) { const st = await e5.convState(conv).catch(() => null); mode = st ? st.mode : 0; }
  if (mode !== 1) return null;
  if (o && o.viewOnce) return { success: false, code: 'e2ee5_unsupported_type', message: 'Visualização única ainda não está disponível em conversa protegida.' };
  const kind = kindOfAppType((o && o.msgType) || _guessType(file), file && file.name, file && file.type);
  try {
    const M = await buildMedia(conv, kind, {
      uri: file.uri, blob: file.blob || file._raw || null, name: file.name, mime: file.type, size: file.size,
      width: file.width, height: file.height, durationSec: o && o.durationSec, durationMs: file.duration_ms || null, waveform: file.waveform,
    }, { signal: o && o.signal, onPct: o && o.onProgress });
    const payload = { t: kind, media: [M] };
    if (o && o.content && typeof o.content === 'string' && o.content.trim()) payload.caption = o.content.slice(0, 4096);
    if ((o && o.msgType) === 'video_note') payload.round = true;
    const r = await _A().chatSend(conv, await e5.sealPayload(conv, payload, { cmid: o && o.clientMessageId, reply: o && o.replyToId ? { id: o.replyToId } : null }), _P().coarseOf(kind), (o && o.replyToId) || null, null, null, null, (o && o.clientMessageId) || null, (o && o.topicId) || null, { skipRust: true });
    return r;
  } catch (e) {
    return { success: false, code: (e && e.code) || 'e2ee5_media_failed', message: (e && e.code) === 'too_large' ? 'Arquivo muito grande (máx. 200 MB)' : 'Não foi possível enviar a mídia protegida. Nada foi enviado em claro.' };
  }
}
function _guessType(file) {
  const m = String((file && file.type) || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Fila durável do nativo (mediaSendQueue._process): em conversa E2EE faz o passo de upload cifrado e
 * deixa a linha pronta com o ENVELOPE (o sendWorker só faz o chat_send). → true = tratou (o chamador
 * para), false = não é E2EE (caminho de hoje).
 * h = {emit(pct0..100), signal, updatePayload, markUploadReady, markFailed, promoteReady, poke}
 */
export async function queueStep(row, p, file, h) {
  const e5 = _E();
  if (!e5.isOn()) return false;
  const cmi = row.client_message_id;
  const conv = p.conversation_id;
  let mode0 = e5.convModeSync(conv);
  if (mode0 == null && !p.e2e_draft && !p.e2e_env) { const s0 = await e5.convState(conv).catch(() => null); mode0 = s0 ? s0.mode : 0; }
  if (!p.e2e_draft && !p.e2e_env && mode0 !== 1) return false;
  if (p.e2e_env && p.cdn_url) {
    await h.markUploadReady(cmi, null);
    const pr = await h.promoteReady(conv); if (pr && pr.length) h.poke();
    return true;
  }
  const st = await e5.convState(conv).catch(() => null);
  if (!st || st.mode !== 1) {
    if (st && st.mode === 0 && p.e2e_draft) {
      // a conversa deixou de ser protegida antes do envio: volta ao caminho de hoje com a legenda
      await h.updatePayload(cmi, { caption: p.e2e_draft.caption || '', content: p.e2e_draft.caption || '', e2e_draft: null, _e2eWanted: false, _e2e: false });
      return false;
    }
    await h.markFailed(cmi, 'e2ee5_state_unknown', { kind: 'transient' });
    return true;
  }
  if (p.view_once) { await h.markFailed(cmi, 'e2ee5_unsupported_type', { kind: 'hard' }); return true; }
  const draft = p.e2e_draft || { caption: p.caption || p.content || '', reply_to_id: p.reply_to_id || null };
  const kind = kindOfAppType(p.type, p.file_name, p.mime_type);
  try {
    h.emit(0);
    const M = await buildMedia(conv, kind, {
      uri: file.uri, name: file.name, mime: file.type, size: file.size,
      width: p.image_width || p.width, height: p.image_height || p.height,
      durationMs: Number(p.duration_ms) || ((p.type === 'video' || p.type === 'video_note') && Number(p.duration) >= 1000 ? Number(p.duration) : 0),
      durationSec: (p.type === 'voice' || p.type === 'audio') ? Number(p.duration) || 0 : 0,
      waveform: p.waveform,
    }, { signal: h.signal, onPct: (f) => h.emit(Math.round(f * 100)) });
    if (h.signal && h.signal.aborted) return true;
    const payload = { t: kind, media: [M] };
    if (typeof draft.caption === 'string' && draft.caption.trim()) payload.caption = draft.caption.slice(0, 4096);
    if (p.type === 'video_note') payload.round = true;
    if (p.batch_id) payload.batch = String(p.batch_id);
    const env = await e5.sealPayload(conv, payload, { cmid: cmi, reply: (draft.reply_to_id || p.reply_to_id) ? { id: draft.reply_to_id || p.reply_to_id } : null });
    await h.updatePayload(cmi, { e2e_env: env, _e2e: true, e2e_draft: null, cdn_url: M.url, server_size: M.size });
    await h.markUploadReady(cmi, { cdn_url: M.url, server_size: M.size, server_file_name: null, rust_upload_id: null });
    h.emit(100);
    const pr = await h.promoteReady(conv); if (pr && pr.length) h.poke();
    return true;
  } catch (e) {
    if (h.signal && h.signal.aborted) return true;
    const code = (e && e.code) || 'e2ee5_media_failed';
    const hard = code === 'too_large' || code === 'file_missing' || code === 'not_e2ee' || code === 'not_linked' || code === 'identity_violation';
    await h.markFailed(cmi, code === 'too_large' ? 'muito grande (413 too large)' : 'e2ee5:' + code, { kind: hard ? 'hard' : 'transient' });
    return true;
  }
}

const e2ee5Media = { isE2eUrl, localSync, want, ensure, adoptLocal, subscribe, encryptUpload, buildMedia, kindOfAppType, uploadViaChatUpload, queueStep, blurhashEncode };
export default e2ee5Media;
