// [2026-10-23 midia-wa] Pré-upload de foto/vídeo (item 6, contrato B do BRIEF).
//
// Como o WhatsApp: assim que o usuário escolhe a mídia (folha nativa → prévia,
// ou Enviar direto), comprime no nível que a prévia mostra e já sobe para o R2,
// ANTES de a fila (mediaSendQueue) pegar o item. A fila chama claim(): se o
// pré-upload já tem o arquivo comprimido (e talvez o cdn_url), ela pula a
// compressão / o upload. Qualquer falta (não achou, nível diferente, em
// andamento sem espera, falhou) → claim devolve null e a fila segue o caminho
// de sempre (never-worse).
//
// Regras:
//   • só foto/vídeo; nunca GIF, "como arquivo" ou view-once (o chamador não chama);
//   • conversa E2EE (convModeSync === 1) → nada; modo desconhecido → só comprime
//     (nunca sobe texto-claro para o R2 sem saber se a conversa é cifrada);
//     o claim confere de novo e descarta se a conversa virou E2EE;
//   • enlace lento / sem rede / dados móveis com Economia de dados → só comprime;
//   • no máx. 3 fotos e 1 vídeo em paralelo;
//   • arquivo em documentDirectory/chat-outbox/pre_<hash>.<ext>; no claim é
//     renomeado para cl_<hash>.<ext> e passa a ser da fila (ela move/apaga);
//   • TTL 10 min (sem claim → aborta e apaga); objeto no R2 fica órfão.
//
// Kill switch: globalThis.__chatyy_media_preupload === false → nada roda e
// claim() devolve null.
import { Platform } from 'react-native';

const TTL_MS = 10 * 60 * 1000;
const MAX_IMG = 3;
const MAX_VID = 1;
const VIDEO_COMPRESS_MIN_BYTES = 2 * 1024 * 1024; // igual à fila: abaixo disso vai como está
const DIR = 'chat-outbox/';
const SWEEP_MAX_AGE_MS = 60 * 60 * 1000; // pre_* (nunca reivindicados) com > 1 h na partida

const _entries = new Map(); // origUri → entry
const _subs = new Set();
const _waiting = { image: [], video: [] };
const _running = { image: 0, video: 0 };
let _swept = false;

function _killed() {
  try { return globalThis.__chatyy_media_preupload === false; } catch { return false; }
}
function _FS() { try { return require('expo-file-system/legacy'); } catch { return null; } }
function _msq() { try { return require('./mediaSendQueue'); } catch { return null; } }

function _hash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + str.length.toString(36);
}

function _normLevel(q) {
  if (q === 'lite' || q === 'standard' || q === 'hd' || q === 'full') return q;
  try { return require('./mediaUploadQuality').normalizeLevel(q); } catch { return null; }
}

/** Perfil de foto {maxDim, quality} para um nível ('lite'|'standard'|'hd'|'full') ou objeto. */
function _imgProfile(q) {
  if (q && typeof q === 'object' && q.maxDim) return { maxDim: Number(q.maxDim), quality: Number(q.quality) };
  const m = _msq();
  const P = (m && m.IMAGE_PROFILES) || null;
  const lv = _normLevel(q) || 'standard';
  return (P && P[lv]) || null;
}

function _emit(e) {
  const ev = { uri: e.key, type: e.type, quality: e.quality, phase: e.state, pct: e.pct, uploaded: !!e.cdn_url };
  _subs.forEach((fn) => { try { fn(ev); } catch {} });
}

/** Progresso para a UI: fn({ uri, type, quality, phase, pct (0..1), uploaded }). Devolve unsubscribe. */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/** Estado atual de um item (ou null). */
export function getState(origUri) {
  const e = _entries.get(String(origUri || ''));
  return e ? { phase: e.state, pct: e.pct, quality: e.quality, uploaded: !!e.cdn_url } : null;
}

// ─── gates ───────────────────────────────────────────────────────────────────
/** 'plain' | 'e2ee' | 'unknown' */
function _convKind(conversationId) {
  if (conversationId == null || conversationId === '') return 'unknown';
  try {
    const e5 = require('./e2ee/e2ee5');
    const mode = e5.convModeSync ? e5.convModeSync(conversationId) : null;
    if (mode === 1) return 'e2ee';
    if (mode === null || mode === undefined) return 'unknown';
    return 'plain';
  } catch { return 'unknown'; }
}

function _canUploadNow() {
  try {
    const ni = require('./networkInfo');
    const t = ni.getNetworkType ? ni.getNetworkType() : 'unknown';
    if (t === 'none') return false;
    if (ni.getLinkClass && ni.getLinkClass() !== 'fast') return false; // enlace lento: só comprime
    if (t !== 'wifi') {
      let saver = false;
      try { saver = !!require('./mediaCache').isDataSaverOn?.(); } catch {}
      if (saver) return false; // dados móveis + Economia de dados: não gasta franquia antes do Enviar
    }
    return true;
  } catch { return false; }
}

// ─── arquivos ────────────────────────────────────────────────────────────────
async function _ensureDir() {
  const FS = _FS();
  if (!FS?.documentDirectory) return null;
  const dir = FS.documentDirectory + DIR;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  return dir;
}

async function _del(uri) {
  if (!uri) return;
  const FS = _FS();
  try { await FS?.deleteAsync(uri, { idempotent: true }); } catch {}
}

async function _size(uri) {
  const FS = _FS();
  try { const i = await FS?.getInfoAsync(uri, { size: true }); return i && i.exists ? (Number(i.size) || 0) : 0; } catch { return 0; }
}

// Partida: apaga pre_* esquecidos (app morto antes do TTL). cl_* = já é da fila.
async function _sweepOnce() {
  if (_swept) return;
  _swept = true;
  const FS = _FS();
  if (!FS?.documentDirectory || typeof FS.readDirectoryAsync !== 'function') return;
  try {
    const dir = FS.documentDirectory + DIR;
    const names = await FS.readDirectoryAsync(dir);
    const now = Date.now();
    for (const n of names || []) {
      if (!/^pre_/.test(n)) continue;
      const uri = dir + n;
      if ([..._entries.values()].some((e) => e.fileUri === uri)) continue;
      try {
        const i = await FS.getInfoAsync(uri);
        const mt = i && i.modificationTime ? Number(i.modificationTime) * 1000 : 0;
        if (!mt || now - mt > SWEEP_MAX_AGE_MS) await FS.deleteAsync(uri, { idempotent: true });
      } catch {}
    }
  } catch {}
}

// ─── fila interna (3 fotos / 1 vídeo) ────────────────────────────────────────
function _pump(type) {
  const max = type === 'video' ? MAX_VID : MAX_IMG;
  while (_running[type] < max && _waiting[type].length) {
    const e = _waiting[type].shift();
    if (!e || e.dead) continue;
    _running[type]++;
    _run(e).catch(() => {}).finally(() => { _running[type]--; _pump(type); });
  }
}

function _deferred() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

async function _compressImage(e) {
  const m = _msq();
  const prof = _imgProfile(e.quality);
  if (!m || typeof m.compressImage !== 'function' || !prof) return null;
  const out = await m.compressImage(e.asset.uri, prof, e.asset.name);
  if (!out || !out.uri) return null;
  // Mesma regra da fila: JPEG que já cabia não vira 1,5× maior só por re-encode.
  const srcSize = Number(e.asset.size) || 0;
  const isJpegSrc = /jpe?g/i.test(e.asset.mime || '') || /\.jpe?g$/i.test(e.asset.name || '');
  if (isJpegSrc && srcSize > 0 && out.size > srcSize * 1.5) { await _del(out.uri); return null; }
  return { uri: out.uri, size: out.size || 0, width: out.width || 0, height: out.height || 0, mime: 'image/jpeg', name: out.name, durationMs: 0 };
}

async function _compressVideo(e) {
  let vsp;
  try { vsp = require('./videoSendPipeline'); } catch { return null; }
  const lv = _normLevel(e.quality) || 'standard';
  if (lv === 'full') return null; // Full HD costuma ser passthrough do original: a fila resolve
  const label = lv === 'hd' ? '1080p' : '720p';
  const base = vsp.getQualityProfile ? vsp.getQualityProfile(label) : null;
  if (!base) return null;
  const aCap = label === '1080p' ? 128000 : 96000;
  const profile = { ...base, audioBitrate: Math.min(base.audioBitrate || 128000, aCap) };
  const r = await vsp.prepareCompressed(e.asset.uri, profile, (f) => {
    e.pct = Math.max(0, Math.min(1, Number(f) || 0)); _emit(e);
  }, e.ctrl.signal);
  if (!r || r.skipped || !r.uri || r.uri === e.asset.uri) return null;
  if (e.ctrl.signal.aborted) { await _del(r.uri); return null; }
  const srcSize = Number(e.asset.size) || 0;
  if (!(r.size > 0) || (srcSize && r.size >= srcSize)) { await _del(r.uri); return null; }
  const name = (String(e.asset.name || 'video').replace(/\.\w+$/, '') || 'video') + '.mp4';
  return { uri: r.uri, size: r.size, width: r.width || 0, height: r.height || 0, mime: 'video/mp4', name, durationMs: r.durationMs || 0 };
}

async function _upload(e) {
  const file = { uri: e.fileUri, name: e.prepared.file_name, type: e.prepared.mime_type, size: e.prepared.file_size };
  const signal = e.ctrl.signal;
  const onPct = (f) => { e.pct = Math.max(0, Math.min(1, Number(f) || 0)); _emit(e); };
  let rr = null;
  try {
    const rd = require('./r2DirectUpload');
    if (rd && typeof rd.uploadDirect === 'function' && (typeof rd.directEnabled !== 'function' || rd.directEnabled())) {
      rr = await rd.uploadDirect(file, { context: 'chat', signal, onPct, cmi: null });
      if (rr && !rr.success && rr.hard) return null;
    }
  } catch { rr = null; }
  if (signal.aborted) return null;
  if (!(rr && rr.success && rr.cdn_url)) {
    try {
      const api = require('./api');
      if (typeof api.rustUpload === 'function') rr = await api.rustUpload(file, null, 'chat', signal, onPct);
    } catch { rr = null; }
  }
  if (signal.aborted) return null;
  return rr && rr.success && rr.cdn_url ? { cdn_url: rr.cdn_url, size: Number(rr.size) || file.size } : null;
}

async function _run(e) {
  if (e.dead) return;
  e.state = 'compress'; e.pct = 0; _emit(e);
  let out = null;
  try { out = e.type === 'video' ? await _compressVideo(e) : await _compressImage(e); } catch { out = null; }
  if (e.dead) { if (out?.uri) await _del(out.uri); return; }
  if (!out) { _finish(e, 'skip'); return; }
  // Move para chat-outbox/pre_<hash>.<ext> (sobrevive à limpeza do cache do SO).
  const dir = await _ensureDir();
  const ext = e.type === 'video' ? 'mp4' : 'jpg';
  let fileUri = out.uri;
  if (dir) {
    const dest = dir + 'pre_' + e.hash + '.' + ext;
    try { await _del(dest); await _FS().moveAsync({ from: out.uri, to: dest }); fileUri = dest; } catch { fileUri = out.uri; }
  }
  if (e.dead) { await _del(fileUri); return; }
  e.fileUri = fileUri;
  const size = (await _size(fileUri)) || out.size || 0;
  e.prepared = {
    local_uri: fileUri,
    file_name: out.name,
    mime_type: out.mime,
    file_size: size,
    image_width: out.width || 0,
    image_height: out.height || 0,
    duration_ms: out.durationMs ? Math.round(out.durationMs) : (e.asset.duration ? Math.round(Number(e.asset.duration) * 1000) : 0),
    owned: true,
  };
  e.compressed.resolve(true);
  // Sobe só com conversa sabidamente não-E2EE e rede boa (Wi-Fi ou dados sem Economia).
  if (_convKind(e.conversationId) !== 'plain' || !_canUploadNow() || globalThis.__chatyy_media_preupload_upload === false) {
    _finish(e, 'compressed'); return;
  }
  e.state = 'upload'; e.pct = 0; _emit(e);
  let up = null;
  try { up = await _upload(e); } catch { up = null; }
  if (e.dead) return;
  if (up) { e.cdn_url = up.cdn_url; e.server_size = up.size; }
  _finish(e, up ? 'ready' : 'compressed');
}

function _finish(e, state) {
  e.state = state;
  if (state === 'ready') e.pct = 1;
  e.compressed.resolve(state !== 'skip');
  e.done.resolve(true);
  _emit(e);
  if (state === 'skip') { _entries.delete(e.key); _clearTtl(e); }
}

function _clearTtl(e) { if (e.ttl) { clearTimeout(e.ttl); e.ttl = null; } }

function _drop(e, keepFile) {
  if (!e) return;
  e.dead = true;
  _clearTtl(e);
  try { e.ctrl.abort(); } catch {}
  if (_entries.get(e.key) === e) _entries.delete(e.key);
  e.compressed.resolve(false);
  e.done.resolve(false);
  if (!keepFile && e.fileUri) _del(e.fileUri);
  e.state = 'discarded'; _emit(e);
}

// ─── API (contrato B) ────────────────────────────────────────────────────────
/**
 * asset: { uri, type:'image'|'video', mime, name, size, width, height, duration(s) }
 * quality: 'standard'|'hd'|'full' (ou 'lite') = nível que a prévia mostra.
 */
export function preupload(asset, { quality, conversationId } = {}) {
  try {
    if (_killed() || Platform.OS === 'web') return;
    if (!asset || !asset.uri) return;
    const type = asset.type === 'video' || /^video\//i.test(asset.mime || '') ? 'video' : (asset.type === 'image' || /^image\//i.test(asset.mime || '') ? 'image' : null);
    if (!type) return;
    if (type === 'image' && (/image\/gif/i.test(asset.mime || '') || /\.gif$/i.test(asset.name || asset.uri))) return;
    if (type === 'video' && (Number(asset.size) || 0) > 0 && Number(asset.size) <= VIDEO_COMPRESS_MIN_BYTES) return;
    if (_convKind(conversationId) === 'e2ee') return;
    let lv = _normLevel(quality);
    if (!lv) {
      try { lv = require('./mediaUploadQuality').defaultUploadLevel(); } catch { lv = 'standard'; }
    }
    const key = String(asset.uri);
    const prev = _entries.get(key);
    if (prev) {
      if (prev.quality === lv && !prev.dead) return; // já em andamento no mesmo nível
      _drop(prev); // chip HD mudou → refaz no nível novo
    }
    const e = {
      key, type, quality: lv, asset: { ...asset }, conversationId: conversationId != null ? String(conversationId) : null,
      hash: _hash(key + '|' + lv), state: 'queued', pct: 0, ctrl: new AbortController(),
      fileUri: null, prepared: null, cdn_url: null, server_size: 0, dead: false, at: Date.now(),
      compressed: _deferred(), done: _deferred(), ttl: null,
    };
    e.ttl = setTimeout(() => { if (_entries.get(key) === e) _drop(e); }, TTL_MS);
    _entries.set(key, e);
    _emit(e);
    _sweepOnce().catch(() => {});
    _waiting[type].push(e);
    _pump(type);
  } catch {}
}

function _sameQuality(e, quality) {
  if (quality == null) return true; // chamador não sabe o nível → aceita o da prévia
  if (typeof quality === 'object') {
    if (e.type !== 'image') return true;
    const a = _imgProfile(quality); const b = _imgProfile(e.quality);
    return !!(a && b && a.maxDim === b.maxDim && Math.abs(a.quality - b.quality) < 1e-6);
  }
  const lv = _normLevel(quality);
  return !lv || lv === e.quality;
}

function _wait(p, ms) {
  return new Promise((resolve) => {
    let t = null;
    if (ms > 0) t = setTimeout(() => resolve(false), ms); else resolve(false);
    p.then((v) => { if (t) clearTimeout(t); resolve(v); }, () => { if (t) clearTimeout(t); resolve(false); });
  });
}

/**
 * Tira do cache: depois disso o arquivo é da fila (prepared.local_uri = cl_<hash>.<ext>).
 * quality: nível ('standard'|'hd'|'full'|'lite'), perfil {maxDim,quality} ou null (aceita qualquer).
 * waitMs: espera a compressão em andamento (foto sempre; vídeo só se já passou de 50 %)
 * e, no tempo que sobrar, o upload; se o upload não terminar, devolve só o
 * arquivo (cdn_url null) e aborta o upload (a fila sobe de novo).
 */
export async function claim(origUri, quality, { waitMs = 0 } = {}) {
  try {
    const e = _entries.get(String(origUri || ''));
    if (!e) return null;
    if (_killed() || e.dead) { _drop(e); return null; }
    if (!_sameQuality(e, quality) || _convKind(e.conversationId) === 'e2ee' || Date.now() - e.at > TTL_MS) { _drop(e); return null; }
    // A partir daqui o item é desta chamada: tira do mapa já (2º claim não pega).
    _entries.delete(e.key);
    _clearTtl(e);
    const t0 = Date.now();
    const left = () => Math.max(0, (Number(waitMs) || 0) - (Date.now() - t0));
    if (e.state === 'queued' || e.state === 'compress') {
      const canWait = left() > 0 && (e.type === 'image' || (e.state === 'compress' && e.pct >= 0.5));
      if (!canWait) { _drop(e); return null; }
      const ok = await _wait(e.compressed.p, left());
      if (!ok || !e.prepared) { _drop(e); return null; }
    }
    if (e.state === 'upload') {
      await _wait(e.done.p, left());
      if (e.state === 'upload') { try { e.ctrl.abort(); } catch {} } // não terminou: fila sobe
    }
    if (!e.prepared || e.dead) { _drop(e); return null; }
    // Posse para a fila: renomeia pre_ → cl_ (a varredura da partida só apaga pre_).
    let uri = e.fileUri;
    try {
      if (uri && /\/pre_[^/]+$/.test(uri)) {
        const dest = uri.replace(/\/pre_([^/]+)$/, '/cl_$1');
        await _del(dest);
        await _FS().moveAsync({ from: uri, to: dest });
        uri = dest;
      }
    } catch {}
    e.dead = true; // libera sem apagar o arquivo
    e.state = 'claimed'; _emit(e);
    return {
      prepared: { ...e.prepared, local_uri: uri },
      cdn_url: e.cdn_url || null,
      server_size: e.cdn_url ? (e.server_size || e.prepared.file_size) : 0,
    };
  } catch { return null; }
}

/** Usuário tirou o item / fechou a prévia: aborta e apaga o arquivo (objeto no R2 fica órfão). */
export function discard(origUri) {
  try { _drop(_entries.get(String(origUri || ''))); } catch {}
}

export function discardAll() {
  try { [..._entries.values()].forEach((e) => _drop(e)); } catch {}
  try { _waiting.image.length = 0; _waiting.video.length = 0; } catch {}
}

export default { preupload, claim, discard, discardAll, subscribe, getState };
