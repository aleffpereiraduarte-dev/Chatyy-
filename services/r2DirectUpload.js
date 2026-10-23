// [2026-10-23 midia-wa] Upload DIRETO ao R2 por URL pré-assinada (contrato A do BRIEF).
//
// O app pede ao edge mais próximo (BASE_URL regional; qualquer edge assina local — mesma
// chave S3 nos 11 hosts — ou encaminha só o JSON ao US) uma URL PUT assinada e sobe os
// BYTES celular → R2. PHP/Rust do US não tocam no conteúdo. Servidor: api/media-presign.php
// (kit /root/envio-midia-wa-2026-10-23/presign).
//
//   directEnabled()                       → boolean (síncrono; cap do servidor em cache)
//   uploadDirect(file, {context, signal, onPct, cmi, onState, resume})
//        → { success:true, cdn_url, size, via:'r2' } | { success:false, error, hard?, aborted? }
//   presignFor(file, {context})           → { put_url, headers, cdn_url, expires_at, size } | null  (fila nativa)
//   nativePutSupported(nativeModule)      → binário sabe fazer PUT direto (BUILD)?
//   prefetchCap() / abortDirect(cmi)
//
// Falha NÃO-hard ⇒ quem chama segue o caminho atual (api.rustUpload / rustChunkedUpload).
// Kill: globalThis.__chatyy_r2_direct === false (e o servidor: cap.enabled=false / 503).
// > MP_MIN (8 MB) → multipart com retomada: estado {token, done{n:etag}} salvo no
// AsyncStorage por cmi (e entregue em onState p/ a fila) — app morto retoma das partes feitas.
import { Platform } from 'react-native';

const US_ORIGIN = 'https://chatyy.com.br';
const CAP_TTL_OK_MS = 10 * 60 * 1000;
const CAP_TTL_FAIL_MS = 2 * 60 * 1000;
const CAP_STORE_KEY = '@chatyy_r2direct_cap_v1';
const MP_STORE_PREFIX = '@chatyy_r2mp_v1:';
const PRESIGN_TIMEOUT_MS = 8000;
const PART_TRIES = 4;
const MP_MIN_DEFAULT = 8 * 1024 * 1024;
const HOST_RE = /^https:\/\/([a-z0-9-]+\.)*chatyy\.com\.br$/i;
const CDN_RE = /^https:\/\/media\.chatyy\.com\.br\/(chat|e2e)\/[0-9a-f]{32}_[A-Za-z0-9._-]+$/;

function _api() { try { return require('./api'); } catch { return null; } }
function _AS() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }
function _FSL() { try { return require('expo-file-system/legacy'); } catch { return null; } }
function _FSN() { try { const m = require('expo-file-system'); return m && m.File ? m : null; } catch { return null; } }
function _killed() { try { return globalThis.__chatyy_r2_direct === false; } catch { return false; } }
function _now() { return Date.now(); }
function _furi(u) { const s = String(u || ''); return s.startsWith('/') ? 'file://' + s : s; }
function _err(error, extra) { return { success: false, error: String(error || 'r2_failed'), ...(extra || {}) }; }
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _token() {
  const a = _api();
  try { return String((a && (a.getAuthToken?.() || a.getToken?.())) || ''); } catch { return ''; }
}

/** Base do presign: web = mesma origem (CORS do PHP só p/ *.chatyy.com.br); nativo = BASE_URL regional. */
function _base() {
  if (Platform.OS === 'web') {
    try { const o = String(globalThis.location?.origin || ''); if (HOST_RE.test(o)) return o; } catch {}
    return US_ORIGIN;
  }
  const a = _api();
  let b = '';
  try { b = String((a && (a.getBaseUrl?.() || a.BASE_URL)) || ''); } catch {}
  b = b.replace(/\/+$/, '');
  return HOST_RE.test(b) ? b : US_ORIGIN;
}

// ─── cap do servidor ─────────────────────────────────────────────────────────
const _cap = { key: '', at: 0, ok: null, data: null, inflight: null, loaded: false };
function _capKey() { const t = _token(); return _base() + '|' + (t ? t.slice(-6) : '-'); }

function _loadCapOnce() {
  if (_cap.loaded) return;
  _cap.loaded = true;
  const AS = _AS();
  if (!AS) return;
  AS.getItem(CAP_STORE_KEY).then((s) => {
    try {
      const j = s ? JSON.parse(s) : null;
      if (j && j.key === _capKey() && _cap.ok === null && (_now() - j.at) < CAP_TTL_OK_MS * 6) {
        _cap.key = j.key; _cap.at = j.at; _cap.ok = !!j.ok; _cap.data = j.data || null;
      }
    } catch {}
  }).catch(() => {});
}

async function _fetchJson(url, body, { timeoutMs = PRESIGN_TIMEOUT_MS, signal } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => { try { ctrl && ctrl.abort(); } catch {} }, timeoutMs);
  const onAbort = () => { try { ctrl && ctrl.abort(); } catch {} };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener?.('abort', onAbort, { once: true }); }
  try {
    const tok = _token();
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl ? ctrl.signal : undefined });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { status: r.status, j };
  } catch (e) {
    return { status: 0, j: null, aborted: !!(signal && signal.aborted), err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}

async function _probeCap() {
  const key = _capKey();
  if (_cap.inflight) return _cap.inflight;
  _cap.inflight = (async () => {
    let r = await _fetchJson(_base() + '/api/media-presign.php', { action: 'cap' }, { timeoutMs: 4000 });
    if ((!r.j || r.status === 0 || r.status >= 500) && _base() !== US_ORIGIN) r = await _fetchJson(US_ORIGIN + '/api/media-presign.php', { action: 'cap' }, { timeoutMs: 4000 });
    const ok = !!(r.status === 200 && r.j && r.j.success && r.j.enabled === true && r.j.auth !== false && Number(r.j.v) >= 1);
    _cap.key = key; _cap.at = _now(); _cap.ok = ok; _cap.data = ok ? r.j : null;
    try { const AS = _AS(); if (AS) AS.setItem(CAP_STORE_KEY, JSON.stringify({ key, at: _cap.at, ok, data: _cap.data })).catch(() => {}); } catch {}
    return ok;
  })().finally(() => { _cap.inflight = null; });
  return _cap.inflight;
}

export function prefetchCap() { if (_killed()) return Promise.resolve(false); _loadCapOnce(); return _probeCap().catch(() => false); }

/** Síncrono: true só com cap fresca dizendo enabled (1º uso da sessão: dispara a sonda e responde false). */
export function directEnabled() {
  try {
    if (_killed()) return false;
    if (typeof fetch !== 'function') return false;
    _loadCapOnce();
    const fresh = _cap.key === _capKey() && _cap.ok !== null && (_now() - _cap.at) < (_cap.ok ? CAP_TTL_OK_MS : CAP_TTL_FAIL_MS);
    if (!fresh) { _probeCap().catch(() => {}); return _cap.key === _capKey() && _cap.ok === true; }
    return _cap.ok === true;
  } catch { return false; }
}
function _capNum(k, d) { const v = Number(_cap.data && _cap.data[k]); return v > 0 ? v : d; }
function _capOff(code) {
  // 503 disabled / 401 do edge (réplica sem o token ainda) → para de tentar por CAP_TTL_FAIL_MS
  if (code === 503 || code === 404 || code === 405) { _cap.ok = false; _cap.at = _now(); }
}

// ─── presign (POST JSON; regional → US uma vez) ──────────────────────────────
async function _presign(body, signal) {
  let base = _base();
  let r = await _fetchJson(base + '/api/media-presign.php', body, { signal });
  if (!r.aborted && base !== US_ORIGIN && (r.status === 0 || r.status === 401 || r.status === 404 || r.status >= 500)) {
    base = US_ORIGIN;
    r = await _fetchJson(base + '/api/media-presign.php', body, { signal });
  }
  r.base = base;
  return r;
}

// coalescer: vários PUT simples pedidos juntos (álbum) → 1 chamada com files[] (≤ 30)
const _batch = { q: [], timer: null };
function _presignPutBatched(f, signal) {
  return new Promise((resolve) => {
    _batch.q.push({ f, resolve, signal });
    if (_batch.q.length >= 30) { _flushBatch(); return; }
    if (!_batch.timer) _batch.timer = setTimeout(_flushBatch, 25);
  });
}
async function _flushBatch() {
  if (_batch.timer) { clearTimeout(_batch.timer); _batch.timer = null; }
  const q = _batch.q.splice(0, 30);
  if (!q.length) return;
  const live = q.filter((x) => !(x.signal && x.signal.aborted));
  q.filter((x) => x.signal && x.signal.aborted).forEach((x) => x.resolve({ aborted: true }));
  if (!live.length) return;
  const r = await _presign({ action: 'put', files: live.map((x) => x.f) }, null);
  const items = (r.j && Array.isArray(r.j.items)) ? r.j.items : null;
  live.forEach((x, i) => x.resolve({ status: r.status, item: items ? items[i] : null, j: r.j, base: r.base }));
  if (_batch.q.length) _flushBatch();
}

// ─── arquivo ─────────────────────────────────────────────────────────────────
function _webBlob(file) {
  if (!file) return null;
  if (typeof Blob !== 'undefined') {
    if (file._raw instanceof Blob) return file._raw;
    if (file.blob instanceof Blob) return file.blob;
    if (file instanceof Blob) return file;
  }
  return null;
}
async function _size(file) {
  if (Platform.OS === 'web') {
    let b = _webBlob(file);
    if (!b && file?.uri) { try { b = await (await fetch(file.uri)).blob(); file.blob = b; } catch {} }
    return b ? Number(b.size) || 0 : Number(file?.size) || 0;
  }
  const uri = _furi(file?.uri);
  const N = _FSN();
  if (N) { try { const f = new N.File(uri); if (f.exists) return Number(f.size) || 0; } catch {} }
  const L = _FSL();
  if (L) { try { const i = await L.getInfoAsync(uri, { size: true }); if (i?.exists) return Number(i.size) || 0; } catch {} }
  return Number(file?.size) || 0;
}
function _hdr(h, name) {
  if (!h) return '';
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || '');
  return '';
}

/**
 * PUT de um corpo. Nativo: expo-file-system createUploadTask (stream do arquivo, progresso
 * nativo — mesmo caminho do driveUploadQueue em produção). Web: XHR com Blob.
 * → { status, etag, aborted }
 */
function _putFile({ url, headers, uri, blob, signal, onLoaded }) {
  if (signal && signal.aborted) return Promise.resolve({ status: 0, aborted: true });
  if (Platform.OS === 'web' || blob) {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        Object.keys(headers || {}).forEach((k) => { try { xhr.setRequestHeader(k, headers[k]); } catch {} });
        xhr.timeout = 10 * 60 * 1000;
        if (xhr.upload && onLoaded) xhr.upload.onprogress = (e) => { if (e.lengthComputable) { try { onLoaded(e.loaded); } catch {} } };
        xhr.onload = () => resolve({ status: xhr.status, etag: String(xhr.getResponseHeader('ETag') || '').replace(/"/g, '') });
        xhr.onerror = () => resolve({ status: 0 });
        xhr.ontimeout = () => resolve({ status: 0, timeout: true });
        xhr.onabort = () => resolve({ status: 0, aborted: true });
        if (signal) signal.addEventListener?.('abort', () => { try { xhr.abort(); } catch {} }, { once: true });
        xhr.send(blob);
      } catch (e) { resolve({ status: 0, err: String(e?.message || e) }); }
    });
  }
  const FS = _FSL();
  if (!FS || typeof FS.createUploadTask !== 'function') return Promise.resolve({ status: 0, err: 'no_fs' });
  return new Promise((resolve) => {
    let task = null; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      task = FS.createUploadTask(url, _furi(uri), {
        httpMethod: 'PUT',
        uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
        sessionType: FS.FileSystemSessionType?.FOREGROUND ?? 1,
        headers: headers || {},
      }, (p) => { if (onLoaded) { try { onLoaded(Number(p?.totalBytesSent) || 0); } catch {} } });
    } catch (e) { finish({ status: 0, err: String(e?.message || e) }); return; }
    const onAbort = () => { try { task.cancelAsync?.(); } catch {} finish({ status: 0, aborted: true }); };
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
    task.uploadAsync().then((r) => {
      if (!r) { finish({ status: 0, aborted: !!(signal && signal.aborted) }); return; }
      finish({ status: Number(r.status) || 0, etag: _hdr(r.headers, 'etag').replace(/"/g, '') });
    }).catch((e) => finish({ status: 0, aborted: !!(signal && signal.aborted), err: String(e?.message || e) }))
      .finally(() => { if (signal) signal.removeEventListener?.('abort', onAbort); });
  });
}

function _desc(file, context, size) {
  const ctx = context === 'e2e' ? 'e2e' : 'chat';
  return { name: String(file?.name || 'upload'), type: ctx === 'e2e' ? 'application/octet-stream' : String(file?.type || file?.mime || ''), size, context: ctx };
}
function _okCdn(u, context) { return typeof u === 'string' && CDN_RE.test(u) && u.indexOf('/' + (context === 'e2e' ? 'e2e' : 'chat') + '/') > 0; }
function _fail(status, j, fallback) {
  const e = (j && (j.code || j.error)) || fallback || ('http_' + status);
  const hard = status === 413 || e === 'file_too_large' || e === 'dangerous_type';
  return _err(hard && e !== 'dangerous_type' ? 'file_too_large' : e, hard ? { hard: true, status } : { status });
}

// ─── PUT simples ─────────────────────────────────────────────────────────────
let _put403 = 0;
async function _single(file, ctx, size, o) {
  const pr = await _presignPutBatched(_desc(file, ctx, size), o.signal);
  if (pr.aborted || (o.signal && o.signal.aborted)) return _err('aborted', { aborted: true });
  const it = pr.item;
  if (!it || !it.ok || !it.put_url) { _capOff(pr.status); return _fail(pr.status, it || pr.j, 'presign_failed'); }
  if (!_okCdn(it.cdn_url, ctx)) return _err('bad_cdn_url');
  const blob = Platform.OS === 'web' ? _webBlob(file) : null;
  if (Platform.OS === 'web' && !blob) return _err('no_blob');
  const t0 = _now();
  const r = await _putFile({ url: it.put_url, headers: it.headers, uri: file.uri, blob, signal: o.signal,
    onLoaded: (n) => { if (o.onPct && size > 0) { try { o.onPct(Math.min(0.99, n / size)); } catch {} } } });
  if (r.aborted || (o.signal && o.signal.aborted)) return _err('aborted', { aborted: true });
  if (r.status < 200 || r.status >= 300) {
    // 403 = assinatura não bateu (Content-Length/Type alterado pelo HTTP do aparelho): 2 seguidos → desliga na sessão
    if (r.status === 403 && ++_put403 >= 2) { _cap.ok = false; _cap.at = _now() + 6 * 3600 * 1000; }
    return _err('r2_put_' + (r.status || 'network'), { status: r.status });
  }
  _put403 = 0;
  try { o.onPct && o.onPct(1); } catch {}
  return { success: true, cdn_url: it.cdn_url, size, via: 'r2', filename: file?.name, put_ms: _now() - t0, presign_base: pr.base };
}

// ─── multipart com retomada ──────────────────────────────────────────────────
function _mpKey(file, size, cmi) { return MP_STORE_PREFIX + (cmi ? 'c:' + cmi : 'u:' + String(file?.uri || '').slice(-80) + '|' + size); }
async function _mpLoad(k) { try { const AS = _AS(); const s = AS ? await AS.getItem(k) : null; return s ? JSON.parse(s) : null; } catch { return null; } }
async function _mpSave(k, st, onState) {
  try { const AS = _AS(); if (AS) await AS.setItem(k, JSON.stringify(st)); } catch {}
  if (onState) { try { onState(st); } catch {} }
}
async function _mpDrop(k, onState) { try { const AS = _AS(); if (AS) await AS.removeItem(k); } catch {} if (onState) { try { onState(null); } catch {} } }

function _partLen(st, n) { return n < st.parts ? st.part_size : st.size - (st.parts - 1) * st.part_size; }

/** Bytes da parte n → arquivo temporário (nativo, API nova de arquivo) | Blob (web). */
async function _partBody(file, st, n) {
  const off = (n - 1) * st.part_size; const len = _partLen(st, n);
  if (Platform.OS === 'web') {
    const b = _webBlob(file);
    return b ? { blob: b.slice(off, off + len) } : null;
  }
  const N = _FSN(); const L = _FSL();
  if (!N || !L || !L.cacheDirectory) return null;
  const h = new N.File(_furi(file.uri)).open();
  let bytes;
  try { h.offset = off; bytes = h.readBytes(len); } finally { try { h.close(); } catch {} }
  if (!bytes || bytes.length !== len) return null;
  const tmp = L.cacheDirectory + 'r2mp-' + String(st.key || '').slice(-24).replace(/[^A-Za-z0-9]/g, '') + '-' + n + '.part';
  const f = new N.File(tmp);
  try { if (f.exists) f.delete(); } catch {}
  f.create(); f.write(bytes);
  return { uri: tmp, cleanup: () => { try { f.delete(); } catch {} } };
}

function _mpCapable() {
  if (Platform.OS === 'web') return typeof Blob !== 'undefined' && typeof Blob.prototype.slice === 'function';
  const N = _FSN(); const L = _FSL();
  return !!(N && L && typeof L.createUploadTask === 'function' && typeof N.File === 'function');
}

async function _multipart(file, ctx, size, o) {
  const k = _mpKey(file, size, o.cmi);
  let st = (o.resume && o.resume.token && Number(o.resume.size) === size) ? o.resume : await _mpLoad(k);
  if (st && (Number(st.size) !== size || st.ctx !== ctx || !(Number(st.token_expires_at) * 1000 > _now() + 120000))) st = null;
  let urls = {};
  if (st) {
    // retomada: o que o R2 já tem vale mais que o salvo (ETag perdido → recupera)
    const s = await _presign({ action: 'mp_status', token: st.token }, o.signal);
    if (s.aborted) return _err('aborted', { aborted: true });
    if (s.status === 200 && s.j && s.j.success && Array.isArray(s.j.parts)) {
      const done = {};
      s.j.parts.forEach((p) => { if (p && p.n && p.etag) done[String(p.n)] = String(p.etag); });
      st = { ...st, done };
    } else if (s.status === 403 || s.status === 404) { await _mpDrop(k, o.onState); st = null; }
  }
  if (!st) {
    const c = await _presign({ action: 'mp_create', ..._desc(file, ctx, size) }, o.signal);
    if (c.aborted) return _err('aborted', { aborted: true });
    if (!(c.status === 200 && c.j && c.j.success && c.j.token)) { _capOff(c.status); return _fail(c.status, c.j, 'mp_create_failed'); }
    if (!_okCdn(c.j.cdn_url, ctx)) return _err('bad_cdn_url');
    st = { v: 1, ctx, token: c.j.token, token_expires_at: c.j.token_expires_at, key: c.j.key, cdn_url: c.j.cdn_url,
      size, part_size: c.j.part_size, parts: c.j.parts, done: {}, created_at: _now() };
    urls = c.j.urls || {};
    await _mpSave(k, st, o.onState);
  }
  const todo = [];
  for (let n = 1; n <= st.parts; n++) if (!st.done[String(n)]) todo.push(n);
  const inflight = {};
  let doneBytes = 0;
  Object.keys(st.done).forEach((n) => { doneBytes += _partLen(st, Number(n)); });
  const pct = () => { if (!o.onPct || size <= 0) return; let b = doneBytes; Object.values(inflight).forEach((v) => { b += v; }); try { o.onPct(Math.min(0.99, b / size)); } catch {} };
  pct();
  let fatal = null;
  let urlsAt = _now();
  let urlReq = null; // 1 pedido mp_parts por vez (os workers esperam o mesmo)
  const refill = (n) => {
    if (!urlReq) {
      const want = [n, ...todo.filter((x) => x !== n && !st.done[String(x)])].slice(0, 20);
      urlReq = _presign({ action: 'mp_parts', token: st.token, parts: want }, o.signal).then((r) => {
        if (r.status === 200 && r.j && r.j.urls) { urls = { ...urls, ...r.j.urls }; urlsAt = _now(); }
        else if (r.status === 403) fatal = 'invalid_token';
      }).finally(() => { urlReq = null; });
    }
    return urlReq;
  };
  const getUrl = async (n, force) => {
    // URL vale 15 min no servidor: renova com folga (12 min) ou depois de uma falha
    if (force || (_now() - urlsAt) > 12 * 60 * 1000) { delete urls[String(n)]; if ((_now() - urlsAt) > 12 * 60 * 1000) urls = {}; }
    if (!urls[String(n)]) await refill(n);
    if (!urls[String(n)] && !fatal) await refill(n);
    return urls[String(n)] || null;
  };
  const worker = async () => {
    while (!fatal && todo.length) {
      if (o.signal && o.signal.aborted) return;
      const n = todo.shift();
      let ok = false;
      for (let a = 0; a < PART_TRIES && !ok && !fatal; a++) {
        if (o.signal && o.signal.aborted) return;
        const url = await getUrl(n, a > 0);
        if (!url) { await _sleep(800 * (a + 1)); continue; }
        let body = null;
        try { body = await _partBody(file, st, n); } catch { body = null; }
        if (!body) { fatal = 'part_read_failed'; break; }
        inflight[n] = 0;
        const r = await _putFile({ url, headers: {}, uri: body.uri, blob: body.blob, signal: o.signal, onLoaded: (b) => { inflight[n] = b; pct(); } });
        try { body.cleanup && body.cleanup(); } catch {}
        delete inflight[n];
        if (r.aborted) return;
        if (r.status >= 200 && r.status < 300 && r.etag) {
          st.done[String(n)] = r.etag; doneBytes += _partLen(st, n); ok = true; pct();
          await _mpSave(k, st, o.onState);
        } else {
          await _sleep(Math.min(8000, 600 * Math.pow(2, a)));
        }
      }
      if (!ok && !fatal && !(o.signal && o.signal.aborted)) fatal = 'part_failed_' + n;
    }
  };
  const W = Math.min(Platform.OS === 'web' ? 4 : 3, Math.max(1, todo.length));
  await Promise.all(Array.from({ length: W }, worker));
  if (o.signal && o.signal.aborted) return _err('aborted', { aborted: true }); // estado fica salvo p/ retomar
  if (fatal) {
    if (fatal === 'invalid_token') await _mpDrop(k, o.onState);
    return _err('mp_' + fatal);
  }
  const parts = Object.keys(st.done).map((n) => ({ n: Number(n), etag: st.done[n] }));
  const c = await _presign({ action: 'mp_complete', token: st.token, parts }, o.signal);
  if (c.aborted) return _err('aborted', { aborted: true });
  if (!(c.status === 200 && c.j && c.j.success && _okCdn(c.j.cdn_url, ctx))) {
    if (c.j && c.j.hard) await _mpDrop(k, o.onState);
    return _err((c.j && c.j.error) || ('mp_complete_' + c.status), { status: c.status });
  }
  await _mpDrop(k, o.onState);
  try { o.onPct && o.onPct(1); } catch {}
  return { success: true, cdn_url: c.j.cdn_url, size, via: 'r2', filename: file?.name, multipart: true, parts: st.parts };
}

// ─── API pública ─────────────────────────────────────────────────────────────
export async function uploadDirect(file, opts = {}) {
  const o = opts || {};
  try {
    if (_killed()) return _err('disabled');
    if (!file || (!file.uri && !_webBlob(file))) return _err('no_file');
    if (!_token()) return _err('no_auth');
    if (o.signal && o.signal.aborted) return _err('aborted', { aborted: true });
    if (!directEnabled()) {
      // cap ainda não sondada nesta sessão: espera no máx. 1,5 s
      const ok = await Promise.race([_probeCap().catch(() => false), _sleep(1500).then(() => false)]);
      if (!ok) return _err('disabled');
    }
    const ctx = o.context === 'e2e' ? 'e2e' : 'chat';
    const size = await _size(file);
    if (!(size > 0)) return _err('no_size');
    if (size > _capNum('max_bytes', 200 * 1024 * 1024)) return _err('file_too_large', { hard: true, status: 413 });
    const mpMin = _capNum('mp_min', MP_MIN_DEFAULT);
    if (size > mpMin && _mpCapable()) return await _multipart(file, ctx, size, o);
    return await _single(file, ctx, size, o);
  } catch (e) {
    return _err('r2_exception:' + String(e?.message || e).slice(0, 80));
  }
}

/** Para a fila NATIVA (BUILD): só a URL (o nativo faz o PUT do arquivo). null = use o caminho atual. */
export async function presignFor(file, { context = 'chat' } = {}) {
  try {
    if (_killed() || !directEnabled()) return null;
    const ctx = context === 'e2e' ? 'e2e' : 'chat';
    const size = await _size(file);
    if (!(size > 0) || size > _capNum('max_bytes', 200 * 1024 * 1024)) return null;
    const pr = await _presignPutBatched(_desc(file, ctx, size), null);
    const it = pr && pr.item;
    if (!it || !it.ok || !it.put_url || !_okCdn(it.cdn_url, ctx)) { _capOff(pr && pr.status); return null; }
    return { put_url: it.put_url, headers: it.headers || {}, cdn_url: it.cdn_url, expires_at: Number(it.expires_at) || 0, size };
  } catch { return null; }
}

/** O binário da fila nativa entende item.up.put_url? (BUILD: outboxCaps().put_url === true) */
export function nativePutSupported(m) {
  try { return !!(m && typeof m.outboxCaps === 'function' && m.outboxCaps()?.put_url === true); } catch { return false; }
}

/** Esquece (e aborta no servidor) uma sessão multipart salva — p/ quando a mensagem é cancelada. */
export async function abortDirect(cmi) {
  if (!cmi) return;
  const k = MP_STORE_PREFIX + 'c:' + cmi;
  const st = await _mpLoad(k);
  try { if (st && st.token) await _presign({ action: 'mp_abort', token: st.token }, null); } catch {}
  await _mpDrop(k, null);
}

export default { directEnabled, uploadDirect, presignFor, nativePutSupported, prefetchCap, abortDirect };
