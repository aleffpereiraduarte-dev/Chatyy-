/**
 * imageSendPipeline — WhatsApp-grade pre-upload pipeline for chat images.
 *
 * Goal: the moment the user taps "Send", the chat bubble should appear with
 * a soft blur placeholder + a progress ring, NOT a hard flash from the raw
 * camera roll JPEG into the final R2 URL. Upload runs in background, can
 * resume after network drop, strips EXIF for privacy, and persists the
 * compressed copy locally so re-renders never re-download.
 *
 * Why a separate service:
 *   chat-conversation.js already wires uploadAndSendFile + the optimistic
 *   bubble. This file adds the polish layer that CAN be called from outside
 *   (album editor, sticker editor, future call-sites) without each consumer
 *   re-implementing the LQIP + EXIF + HD-toggle logic. chat-conversation
 *   doesn't import this yet (don't touch — owned by another agent) but the
 *   pieces here (`migrateThumbB64TempToReal`, `bindLocalUriToRemoteUrl`,
 *   `generateLocalLQIP`, `getQualityPreset`, `stripExifIfNeeded`) can be
 *   wired post-OTA by a one-line require.
 *
 * Public API:
 *   - getQualityPreset()              → { maxDim, quality, label } (reads pref)
 *   - QUALITY_PRESETS                 → static catalog (Standard/HD/Original)
 *   - setQualityPref(name)            → 'standard' | 'hd' | 'original'
 *   - shouldStripExif()               → boolean (reads chatyy_strip_exif pref)
 *   - generateLocalLQIP(uri)          → small base64 string (40px, ~500B)
 *   - preflightOutgoing(uri, opts)    → { uri, sizeBytes, width, height,
 *                                          thumbB64, mime } — single call that
 *                                       does compress + EXIF strip + LQIP gen
 *   - bindOptimisticToServer(tempId, realId, localUri, serverUrl)
 *                                     → after the send round-trips, propagate
 *                                       the LQIP and the local-file mapping
 *                                       so re-renders never re-download.
 *
 * All native paths fail soft: if `expo-image-manipulator` or the native
 * toolkit aren't present (web, simulator stripped down), the helpers return
 * the input unchanged — callers can still ship the original bytes.
 */
import { Platform } from 'react-native';

let _AsyncStorage = null;
try { _AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}

// ── Quality presets ─────────────────────────────────────────────────────────
// Three-step preset matches WhatsApp 2026 (Auto/HD/Original from the camera
// roll picker). "Auto" maps to network-aware compression handled by the
// caller; we expose explicit pixel/quality targets here so consumers don't
// have to repeat the math.
export const QUALITY_PRESETS = Object.freeze({
  standard: { maxDim: 1600, quality: 0.80, label: 'Padrão' },
  hd:       { maxDim: 2400, quality: 0.88, label: 'HD' },
  original: { maxDim: 99999, quality: 0.95, label: 'Original' },
});

const QUALITY_PREF_KEY = 'chatyy_image_quality';
const STRIP_EXIF_KEY = 'chatyy_strip_exif';

// Cache the pref reads in module scope — AsyncStorage hops are 1-3ms each
// and a 30-photo album batch would otherwise pay 60+ ms before the first
// bubble paints. Refresh lazily on demand via `_refreshPrefs()`.
let _qualityPref = 'hd';
let _stripExifPref = true;
let _prefsLoaded = false;
async function _refreshPrefs() {
  if (!_AsyncStorage) return;
  try {
    const q = await _AsyncStorage.getItem(QUALITY_PREF_KEY);
    if (q && QUALITY_PRESETS[q]) _qualityPref = q;
    const s = await _AsyncStorage.getItem(STRIP_EXIF_KEY);
    _stripExifPref = (s !== 'false'); // default ON
  } catch {}
  _prefsLoaded = true;
}
_refreshPrefs();

export function getQualityPreset(override) {
  const name = override && QUALITY_PRESETS[override] ? override : _qualityPref;
  const preset = QUALITY_PRESETS[name] || QUALITY_PRESETS.hd;
  return { ...preset, name };
}

export async function setQualityPref(name) {
  if (!QUALITY_PRESETS[name]) return;
  _qualityPref = name;
  if (!_AsyncStorage) return;
  try { await _AsyncStorage.setItem(QUALITY_PREF_KEY, name); } catch {}
}

export function shouldStripExif() {
  if (!_prefsLoaded) _refreshPrefs(); // best-effort sync-ish
  return _stripExifPref;
}

// ── Local LQIP generation ──────────────────────────────────────────────────
// Generate a ~40px wide JPEG, base64-encoded. Used as the placeholder the
// bubble paints while the full image uploads + downloads. ~500-800 bytes,
// renders in <1ms via <Image source={{ uri: 'data:image/jpeg;base64,...' }}>.
// Result format matches the server's chat_messages.thumb_b64 column so the
// existing `persistThumbB64` cache accepts it unchanged.
//
// [2026-10-23 midia-wa] LQIP "tipo WhatsApp": lado maior 72 px q0.5 (era 40 px)
// com teto de 3000 caracteres em base64 (o WS/eco carregam o thumb_b64; o push
// NÃO). Passou do teto → reduz a PRÓPRIA miniatura (barato, já é minúscula)
// para 52 px q0.45; ainda grande → recai no LQIP antigo de 40 px. Do mesmo
// arquivinho sai o blurhash (expo-image, ~ms num JPEG de 72 px) + as dimensões,
// em 2º plano — o b64 volta na hora (a bolha não espera o blurhash).
// Kill: __chatyy_lqip_wa === false (40 px antigo); __chatyy_client_blurhash === false (sem blurhash).
const LQIP_MAX_B64 = 3000;
const LQIP_HARD_MAX_B64 = 4000; // persistThumbB64 recusa > 4096
function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _lqipWaOn() { try { return _g().__chatyy_lqip_wa !== false; } catch { return true; } }
function _clientBhOn() { try { return _g().__chatyy_client_blurhash !== false; } catch { return true; } }
function _lqipDim() {
  try { const d = Number(_g().__chatyy_lqip_dim); if (d >= 32 && d <= 128) return Math.round(d); } catch {}
  return 72;
}
export const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,100}$/;
// blurhash válido de verdade: tamanho = 4 + 2·cx·cy (1º caractere codifica cx/cy)
export function isValidBlurhash(bh) {
  if (typeof bh !== 'string' || !BLURHASH_RE.test(bh)) return false;
  const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  const v = B83.indexOf(bh[0]);
  if (v < 0) return false;
  const cx = (v % 9) + 1; const cy = Math.floor(v / 9) + 1;
  return bh.length === 4 + 2 * cx * cy;
}

// ── metadados do cliente (blurhash/dimensões/LQIP) por mensagem ────────────
// _lqMeta: chave do LQIP → entrada; _keyMeta: temp_id / client_message_id → entrada.
// entrada = { blurhash, w, h, lqip, done, p }  (p = promessa do cálculo)
const _lqMeta = new Map();
const _keyMeta = new Map();
const META_MAX = 200;
function _lqKey(b64) { return typeof b64 === 'string' && b64 ? b64.length + ':' + b64.slice(-80) : ''; }
function _trim(m) {
  if (m.size <= META_MAX) return;
  const drop = m.size - META_MAX;
  let i = 0;
  for (const k of m.keys()) { if (i++ >= drop) break; m.delete(k); }
}
function _newEntry(lqip) { return { blurhash: null, w: 0, h: 0, lqip: lqip || null, done: false, p: null }; }

async function _bhFromFile(fileUri, w, h) {
  if (!fileUri || !_clientBhOn()) return null;
  try {
    const EI = require('expo-image');
    const Img = EI?.Image || EI?.default?.Image;
    if (!Img || typeof Img.generateBlurhashAsync !== 'function') return null;
    const comps = (w > 0 && h > 0 && h > w) ? [3, 4] : [4, 3]; // mesmo critério do servidor
    const bh = await Promise.race([
      Img.generateBlurhashAsync(String(fileUri), comps),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    return isValidBlurhash(bh) ? bh : null;
  } catch { return null; }
}

async function _readB64(uri) {
  const FS = require('expo-file-system/legacy');
  return FS.readAsStringAsync(String(uri).replace('file://', ''), { encoding: FS.EncodingType.Base64 });
}
async function _rm(uri) { try { await require('expo-file-system/legacy').deleteAsync(uri, { idempotent: true }); } catch {} }

// Caminho novo (nativo): devolve { b64, w, h, file } — file = arquivinho p/ o blurhash (o chamador apaga).
async function _lqipWaNative(uri) {
  const dim = _lqipDim();
  try {
    const NativeImage = require('../modules/expo-native-toolkit').Image;
    if (NativeImage?.resize) {
      let r = await NativeImage.resize({ uri, maxWidth: dim, maxHeight: dim, quality: 0.5, format: 'jpeg' });
      if (r?.uri) {
        let b64 = await _readB64(r.uri);
        if (b64 && b64.length > LQIP_MAX_B64) {
          const r2 = await NativeImage.resize({ uri: r.uri, maxWidth: 52, maxHeight: 52, quality: 0.45, format: 'jpeg' }).catch(() => null);
          if (r2?.uri) {
            const b2 = await _readB64(r2.uri).catch(() => null);
            if (b2 && b2.length < b64.length) { await _rm(r.uri); r = r2; b64 = b2; } else await _rm(r2.uri);
          }
        }
        if (b64 && b64.length <= LQIP_HARD_MAX_B64) return { b64, w: r.width || 0, h: r.height || 0, file: r.uri };
        await _rm(r.uri);
      }
    }
  } catch {}
  try {
    const IM = require('expo-image-manipulator');
    let r = await IM.manipulateAsync(uri, [{ resize: { width: dim } }], { compress: 0.5, format: IM.SaveFormat.JPEG, base64: true });
    if (r && r.height > r.width && r.uri) {
      // retrato: o lado maior é a altura → reduz a própria miniatura (barato)
      const r2 = await IM.manipulateAsync(r.uri, [{ resize: { height: dim } }], { compress: 0.5, format: IM.SaveFormat.JPEG, base64: true }).catch(() => null);
      if (r2?.base64) { await _rm(r.uri); r = r2; }
    }
    if (r?.base64 && r.base64.length > LQIP_MAX_B64 && r.uri) {
      const r3 = await IM.manipulateAsync(r.uri, [{ resize: r.height > r.width ? { height: 52 } : { width: 52 } }], { compress: 0.45, format: IM.SaveFormat.JPEG, base64: true }).catch(() => null);
      if (r3?.base64 && r3.base64.length < r.base64.length) { await _rm(r.uri); r = r3; }
    }
    if (r?.base64 && r.base64.length <= LQIP_HARD_MAX_B64) return { b64: r.base64, w: r.width || 0, h: r.height || 0, file: r.uri || null };
    if (r?.uri) await _rm(r.uri);
  } catch {}
  return null;
}

/**
 * LQIP + blurhash do mesmo arquivinho. → { b64, entry } | null. entry.p resolve
 * quando o blurhash termina (ou falha). Nunca lança.
 */
export async function generateLocalLQIPWithMeta(uri) {
  if (!uri) return null;
  if (!_lqipWaOn()) {
    const b64 = await generateLocalLQIP(uri);
    return b64 ? { b64, entry: null } : null;
  }
  if (Platform.OS === 'web') {
    const r = await _generateLocalLQIPWeb(uri, _lqipDim(), true);
    if (!r || !r.b64) return null;
    const e = _newEntry(r.b64);
    e.blurhash = r.blurhash || null; e.w = r.W || 0; e.h = r.H || 0; e.done = true; e.p = Promise.resolve(e);
    _lqMeta.set(_lqKey(r.b64), e); _trim(_lqMeta);
    return { b64: r.b64, entry: e };
  }
  const r = await _lqipWaNative(uri);
  if (!r) {
    const b64 = await _generateLocalLQIPLegacy(uri);
    return b64 ? { b64, entry: null } : null;
  }
  const e = _newEntry(r.b64);
  e.p = (async () => {
    try { e.blurhash = await _bhFromFile(r.file, r.w, r.h); } catch {}
    if (r.file) await _rm(r.file);
    e.done = true;
    return e;
  })();
  _lqMeta.set(_lqKey(r.b64), e); _trim(_lqMeta);
  return { b64: r.b64, entry: e };
}

export async function generateLocalLQIP(uri) {
  if (!uri) return null;
  if (_lqipWaOn()) {
    try { const r = await generateLocalLQIPWithMeta(uri); if (r && r.b64) return r.b64; } catch {}
  }
  return _generateLocalLQIPLegacy(uri);
}

// LQIP antigo (40 px) — kill switch e reserva.
async function _generateLocalLQIPLegacy(uri) {
  if (!uri) return null;
  if (Platform.OS === 'web') return _generateLocalLQIPWeb(uri);
  // Try native toolkit first (5-10× faster, GPU path).
  try {
    const NativeImage = require('../modules/expo-native-toolkit').Image;
    if (NativeImage?.resize) {
      const r = await NativeImage.resize({
        uri,
        maxWidth: 40,
        maxHeight: 40,
        quality: 0.5,
        format: 'jpeg',
      });
      if (r?.uri) {
        const FS = require('expo-file-system/legacy');
        try {
          const b64 = await FS.readAsStringAsync(r.uri.replace('file://', ''), {
            encoding: FS.EncodingType.Base64,
          });
          // Clean the tiny temp file — we only needed the bytes.
          try { await FS.deleteAsync(r.uri, { idempotent: true }); } catch {}
          if (b64 && b64.length < 4096) return b64;
        } catch {}
      }
    }
  } catch {}
  // Fallback: expo-image-manipulator. Slower but always available.
  try {
    const ImageManipulator = require('expo-image-manipulator');
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 40 } }],
      { compress: 0.4, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (r?.base64 && r.base64.length < 4096) return r.base64;
  } catch {}
  return null;
}

// web: dim = lado maior (40 = antigo, só largura); withMeta → { b64, blurhash, W, H }
function _generateLocalLQIPWeb(uri, dim = 40, withMeta = false) {
  return new Promise((resolve) => {
    try {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          let w; let h;
          if (!withMeta) { w = 40; h = Math.max(1, Math.round((img.height / img.width) * w)); }
          else {
            const s = Math.min(1, dim / Math.max(img.width || 1, img.height || 1));
            w = Math.max(1, Math.round((img.width || 1) * s)); h = Math.max(1, Math.round((img.height || 1) * s));
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          let b64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
          if (withMeta && b64 && b64.length > LQIP_MAX_B64) {
            const s2 = 52 / Math.max(w, h);
            const c2 = document.createElement('canvas');
            c2.width = Math.max(1, Math.round(w * s2)); c2.height = Math.max(1, Math.round(h * s2));
            c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
            const b2 = c2.toDataURL('image/jpeg', 0.45).split(',')[1];
            if (b2 && b2.length < b64.length) b64 = b2;
          }
          if (!withMeta) { resolve(b64 && b64.length < 4096 ? b64 : null); return; }
          if (!b64 || b64.length > LQIP_HARD_MAX_B64) { resolve(null); return; }
          let blurhash = null;
          if (_clientBhOn()) {
            try {
              const s3 = Math.min(1, 32 / Math.max(w, h));
              const bw = Math.max(1, Math.round(w * s3)); const bhh = Math.max(1, Math.round(h * s3));
              const c3 = document.createElement('canvas'); c3.width = bw; c3.height = bhh;
              const x3 = c3.getContext('2d'); x3.drawImage(canvas, 0, 0, bw, bhh);
              const enc = require('./e2ee/e2ee5Media').blurhashEncode;
              const bh = enc(x3.getImageData(0, 0, bw, bhh).data, bw, bhh, bhh > bw ? 3 : 4, bhh > bw ? 4 : 3);
              if (isValidBlurhash(bh)) blurhash = bh;
            } catch {}
          }
          resolve({ b64, blurhash, W: img.width || 0, H: img.height || 0 });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = uri;
    } catch { resolve(null); }
  });
}

/** Liga um LQIP já gerado (preflightOutgoing/generateLocalLQIP) à mensagem. */
function _linkMeta(key, b64) {
  if (key == null || !b64) return;
  const e = _lqMeta.get(_lqKey(b64));
  if (!e) return;
  _keyMeta.set(String(key), e); _trim(_keyMeta);
}

/**
 * Metadados do cliente já prontos (síncrono) p/ o chat_send:
 * { blurhash?, w?, h?, lqip? } | null. Só devolve o que terminou.
 */
export function getClientMetaSync(...keys) {
  for (const k of keys) {
    if (k == null || k === '') continue;
    const e = _keyMeta.get(String(k));
    if (!e) continue;
    const out = {};
    if (e.blurhash && isValidBlurhash(e.blurhash)) out.blurhash = e.blurhash;
    if (e.w > 0 && e.h > 0) { out.w = e.w; out.h = e.h; }
    if (e.lqip) out.lqip = e.lqip;
    if (e.kind) out.kind = e.kind;
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/** Espera (no máx. ms) o blurhash da mensagem ficar pronto. Nunca lança. */
export async function waitClientMeta(key, ms = 150) {
  const e = key != null ? _keyMeta.get(String(key)) : null;
  if (!e || e.done || !e.p) return getClientMetaSync(key);
  await Promise.race([e.p.catch(() => null), new Promise((r) => setTimeout(r, Math.max(0, ms)))]);
  return getClientMetaSync(key);
}

/**
 * Gera LQIP + blurhash de uma mídia LOCAL e guarda sob as chaves (temp_id, cmi).
 * type 'image' → do próprio arquivo; 'video' → de um quadro (~0,5 s) pequeno.
 * Fire-and-forget: devolve a promessa da entrada (ou null). Nunca lança.
 * Uso: mediaSendQueue.enqueueMedia / sendWorker (em paralelo à compressão/upload).
 */
export function prepareClientMeta({ keys, uri, type, durationMs } = {}) {
  try {
    const ks = (Array.isArray(keys) ? keys : [keys]).filter((k) => k != null && k !== '').map(String);
    if (!ks.length || !uri) return null;
    if (!_clientBhOn() && type !== 'video') return null;
    for (const k of ks) { const e0 = _keyMeta.get(k); if (e0) return e0.p || Promise.resolve(e0); }
    const e = _newEntry(null);
    e.kind = type === 'video' ? 'video' : 'image';
    e.p = (async () => {
      try {
        let src = uri; let tmp = null;
        if (type === 'video') {
          if (Platform.OS === 'web') return e;
          let atMs = 500;
          const d = Number(durationMs) || 0;
          if (d > 0 && d < 1200) atMs = Math.max(0, Math.floor(d / 2));
          let fr = null;
          try {
            const NV = require('../modules/expo-native-video');
            const mod = NV?.default || NV;
            if (mod?.generateThumbnail) fr = await mod.generateThumbnail(uri, atMs, 160);
          } catch {}
          if (!fr?.uri) { const pp = await require('./videoSendPipeline').preparePoster(uri, d || null).catch(() => null); fr = pp ? { uri: pp.posterUri, width: pp.width, height: pp.height } : null; }
          if (!fr?.uri) return e;
          src = fr.uri; tmp = fr.uri;
          if (fr.width > 0 && fr.height > 0) { e.w = fr.width; e.h = fr.height; }
        }
        const r = await generateLocalLQIPWithMeta(src);
        if (r && r.b64) {
          e.lqip = r.b64;
          if (r.entry) { await r.entry.p?.catch(() => null); if (r.entry.blurhash) e.blurhash = r.entry.blurhash; if (!(e.w > 0) && r.entry.w > 0) { e.w = r.entry.w; e.h = r.entry.h; } }
        }
        if (type !== 'video') { e.w = 0; e.h = 0; } // dimensões de foto = as do arquivo enviado (payload)
        if (tmp) await _rm(tmp);
      } catch {}
      e.done = true;
      return e;
    })();
    for (const k of ks) _keyMeta.set(k, e);
    _trim(_keyMeta);
    return e.p;
  } catch { return null; }
}
// ── EXIF strip ─────────────────────────────────────────────────────────────
// Re-encode through the native toolkit (or ImageManipulator fallback). The
// JPEG/PNG encoders both drop EXIF chunks by default, which is what scrubs
// GPS coords + camera serial + capture timestamp. Always-on by default;
// user can disable via the chatyy_strip_exif pref.
export async function stripExifIfNeeded(uri, opts = {}) {
  if (!uri) return uri;
  if (Platform.OS === 'web') return uri; // web path strips via canvas re-encode
  if (!shouldStripExif() && !opts.force) return uri;
  // Quick size check — files <800KB usually aren't worth touching unless we
  // explicitly need EXIF off. The full uploadAndSendFile path already does
  // the heavy resize/compress for big images, which strips EXIF for free.
  // This helper exists for the small-image case where uploadAndSendFile's
  // size gate skips compression.
  try {
    const NativeImage = require('../modules/expo-native-toolkit').Image;
    if (NativeImage?.resize) {
      const r = await NativeImage.resize({
        uri, maxWidth: 99999, maxHeight: 99999, quality: 0.95, format: 'jpeg',
      });
      if (r?.uri) return r.uri;
    }
  } catch {}
  try {
    const ImageManipulator = require('expo-image-manipulator');
    const r = await ImageManipulator.manipulateAsync(uri, [],
      { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG });
    if (r?.uri) return r.uri;
  } catch {}
  return uri;
}

// ── One-shot preflight ─────────────────────────────────────────────────────
// Bundles the three pre-upload steps in the order WhatsApp does them:
//   1. Decide quality preset (Standard/HD/Original, network-aware if Auto)
//   2. Resize + compress (also strips EXIF via re-encode)
//   3. Generate LQIP from the COMPRESSED output (smaller bytes = faster LQIP)
//
// Callers use this BEFORE inserting the optimistic bubble so the bubble
// already has a `thumb_b64` + the compressed local URI, and the network
// upload can run in the background with real byte-progress.
//
// Returns null on failure — caller should fall back to uploading the raw URI.
export async function preflightOutgoing(uri, opts = {}) {
  if (!uri) return null;
  const qualityName = opts.quality || _qualityPref;
  const preset = getQualityPreset(qualityName);
  // Optionally allow caller to skip resize (e.g. sticker is already 512×512).
  const skipResize = !!opts.skipResize;

  let outUri = uri;
  let outWidth = 0, outHeight = 0, outSize = 0;
  let outMime = opts.mime || 'image/jpeg';

  if (!skipResize) {
    try {
      const NativeImage = require('../modules/expo-native-toolkit').Image;
      if (Platform.OS !== 'web' && NativeImage?.resize) {
        const r = await NativeImage.resize({
          uri,
          maxWidth: preset.maxDim,
          maxHeight: preset.maxDim,
          quality: preset.quality,
          format: 'jpeg',
        });
        if (r?.uri) {
          outUri = r.uri;
          outWidth = r.width || 0;
          outHeight = r.height || 0;
          outSize = r.sizeBytes || 0;
          outMime = 'image/jpeg';
        }
      } else if (Platform.OS !== 'web') {
        // Fallback to ImageManipulator
        const ImageManipulator = require('expo-image-manipulator');
        const r = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: preset.maxDim } }],
          { compress: preset.quality, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (r?.uri) {
          outUri = r.uri;
          outWidth = r.width || 0;
          outHeight = r.height || 0;
          outMime = 'image/jpeg';
        }
      }
    } catch (e) {
      // Compression failed — keep original URI, LQIP step still runs below.
    }
  }

  // Generate the LQIP from the (possibly compressed) output.
  let thumbB64 = null;
  try { thumbB64 = await generateLocalLQIP(outUri); } catch {}

  return {
    uri: outUri,
    sizeBytes: outSize,
    width: outWidth,
    height: outHeight,
    thumbB64,
    mime: outMime,
    quality: preset.name,
  };
}

// ── Optimistic → server reconciliation ─────────────────────────────────────
// After the upload completes and the message gets its real server id:
//   - Migrate the temp-id LQIP entry to the real id
//   - Bind the local compressed file:// to the server's R2 URL so
//     CachedImage uses the local copy on the sender's device forever
//
// Cheap, safe to call with missing args.
export function bindOptimisticToServer(tempId, realId, localUri, serverUrl) {
  try {
    const mc = require('./mediaCache');
    if (tempId != null && realId != null) {
      mc.migrateThumbB64TempToReal?.(tempId, realId);
    }
    if (localUri && serverUrl) {
      mc.bindLocalUriToRemoteUrl?.(localUri, serverUrl);
    }
  } catch {}
}

// ── Convenience: persist LQIP keyed by temp_id at insert time ──────────────
// Call after preflightOutgoing() returns, BEFORE the upload kicks off, so
// every re-render of the optimistic bubble (avatar load, reactions tick,
// scroll-in) finds the LQIP synchronously and paints the blur tile instead
// of a blank gray box. `tempId` is the optimistic message's client id.
export function attachLqipToTempMessage(tempId, thumbB64) {
  if (!tempId || !thumbB64) return;
  // [2026-10-23 midia-wa] o blurhash/dimensões do mesmo LQIP passam a valer p/ esta mensagem
  try { _linkMeta(tempId, thumbB64); } catch {}
  try {
    const mc = require('./mediaCache');
    mc.persistThumbB64?.(tempId, thumbB64);
  } catch {}
}
