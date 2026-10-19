// services/mediaUploadQuality.js — WhatsApp "Configurações › Armazenamento e
// dados › Qualidade de envio de mídia".
//
// [2026-10-19 media-quality] Three levels (was Padrão/HD, video-only):
//
//   level       photo (long edge / JPEG q)        video (H.264 High + AAC)
//   'standard'  1600 px / 0.80   (~0.3 MB 12 MP)   720p  @ 1.5 Mbps + 96 kbps  (~12 MB/min)
//   'hd'        2560 px / 0.90   (~1.2 MB 12 MP)   1080p @ 4.5 Mbps + 128 kbps (~35 MB/min)
//   'full'      original px / 0.92 (HEIC→JPEG)     1080p @ 8 Mbps + 160 kbps  (~61 MB/min);
//                                                  ≤1080p source ≤12 Mbps → sent as-is
//
// The choice is saved PER ACCOUNT with separate defaults for Wi-Fi and mobile
// data (WhatsApp-like: HD on Wi-Fi, Padrão on mobile data). The media preview's
// HD pill starts from the effective default and can override one send
// (Padrão → HD → Full HD), applied to every item of the album.
//
// Smart about data: an AUTO default drops to 'standard' while Data Saver is on
// or the link is weak (2G/3G, high RTT). An explicit pick in the preview always
// wins.
//
// Storage: one AsyncStorage (localStorage on web) JSON key
// `media_upload_quality_v2` = { "<email>": { wifi, cell }, "": {…} }. Reads are
// sync from an in-memory copy hydrated at import. The legacy key
// `media_upload_quality` ('hd'|'standard') seeds the Wi-Fi column once.
import { Platform } from 'react-native';

export const MEDIA_UPLOAD_QUALITY_KEY = 'media_upload_quality'; // legacy (v1)
export const MEDIA_UPLOAD_QUALITY_KEY_V2 = 'media_upload_quality_v2';
export const QUALITY_LEVELS = ['standard', 'hd', 'full'];
export const DEFAULT_PREFS = Object.freeze({ wifi: 'hd', cell: 'standard' });

// ─── Profiles (single source of truth for every send path) ──────────────────
// Photos: never upscaled. 'full' keeps the original pixels (cap 8192 px so a
// 48-200 MP sensor can't OOM the decoder on low-RAM phones).
export const PHOTO_PROFILES = Object.freeze({
  standard: { maxDim: 1600, quality: 0.8 },
  hd: { maxDim: 2560, quality: 0.9 },
  full: { maxDim: 8192, quality: 0.92 },
});
// Video label per level → videoSendPipeline QUALITY_PROFILES.
export const VIDEO_LABELS = Object.freeze({ standard: '720p', hd: '1080p', full: '1080p_full' });
// Approximate JPEG bytes per output pixel at each quality (camera photos).
const _JPEG_BPP = { standard: 0.16, hd: 0.25, full: 0.3 };
// Video bits/s (video + audio) per level — mirrors videoSendPipeline.
const _VIDEO_BPS = { standard: 1_500_000 + 96_000, hd: 4_500_000 + 128_000, full: 8_000_000 + 160_000 };
const _VIDEO_BOX = { standard: [1280, 720], hd: [1920, 1080], full: [1920, 1080] };
// Full HD keeps the original when it already fits 1080p and is ≤ this bitrate.
export const FULL_PASSTHROUGH_MAX_BPS = 12_000_000;

let _store = {}; // email → { wifi, cell }
let _hydrated = false;
let _legacy = null;
const _subs = new Set();

export function normalizeLevel(v) {
  if (v === true) return 'hd';
  if (v === false) return 'standard';
  if (v === 'standard' || v === 'hd' || v === 'full') return v;
  if (v === 'original' || v === 'fullhd' || v === 'full_hd') return 'full';
  return null;
}

function _acct() {
  try {
    const e = require('./api').getActiveAccountEmail?.() || '';
    return String(e).trim().toLowerCase();
  } catch { return ''; }
}

function _notify() {
  const p = getUploadQualityPrefs();
  for (const fn of _subs) { try { fn(p); } catch {} }
}

function _apply(rawV2, rawV1) {
  try {
    const o = rawV2 ? JSON.parse(rawV2) : null;
    if (o && typeof o === 'object') _store = { ...o, ..._store };
  } catch {}
  const v1 = rawV1 === 'standard' || rawV1 === 'hd' ? rawV1 : null;
  if (v1) _legacy = v1;
}

function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') {
        _apply(localStorage.getItem(MEDIA_UPLOAD_QUALITY_KEY_V2), localStorage.getItem(MEDIA_UPLOAD_QUALITY_KEY));
      }
    } catch {}
    return;
  }
  try {
    import('@react-native-async-storage/async-storage').then((m) => {
      const AS = m.default;
      Promise.all([AS.getItem(MEDIA_UPLOAD_QUALITY_KEY_V2), AS.getItem(MEDIA_UPLOAD_QUALITY_KEY)])
        .then(([v2, v1]) => { _apply(v2, v1); _notify(); })
        .catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrate();

function _persist() {
  let raw = '{}';
  try { raw = JSON.stringify(_store); } catch {}
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(MEDIA_UPLOAD_QUALITY_KEY_V2, raw); } catch {}
    return;
  }
  try {
    import('@react-native-async-storage/async-storage').then((m) => {
      m.default.setItem(MEDIA_UPLOAD_QUALITY_KEY_V2, raw).catch(() => {});
    }).catch(() => {});
  } catch {}
}

/** Saved prefs for the active account: { wifi, cell } (levels). */
export function getUploadQualityPrefs() {
  _hydrate();
  const row = _store[_acct()] || null;
  const base = _legacy ? { wifi: _legacy, cell: 'standard' } : DEFAULT_PREFS;
  return {
    wifi: normalizeLevel(row?.wifi) || base.wifi,
    cell: normalizeLevel(row?.cell) || base.cell,
  };
}

/** Save one column ('wifi' | 'cell') for the active account. */
export function setUploadQualityPref(net, level) {
  const col = net === 'cell' ? 'cell' : 'wifi';
  const lv = normalizeLevel(level) || DEFAULT_PREFS[col];
  const key = _acct();
  _store = { ..._store, [key]: { ...getUploadQualityPrefs(), [col]: lv } };
  _hydrated = true;
  _persist();
  _notify();
  try { require('./nativeShareSnapshot').refreshShareSnapshotQuality?.(); } catch {}
  return getUploadQualityPrefs();
}

export function onUploadQualityChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

function _dataSaverOn() {
  try { return !!require('./mediaCache').isDataSaverOn?.(); } catch { return false; }
}
function _weakLink() {
  try { return require('./networkInfo').getLinkClass?.() !== 'fast'; } catch { return false; }
}
/** 'wifi' | 'cell' column that applies right now (unknown → cell, conservative). */
export function currentNetColumn() {
  try {
    const t = require('./networkInfo').getNetworkType?.();
    return t === 'wifi' ? 'wifi' : 'cell';
  } catch { return 'wifi'; }
}

/** Effective AUTO level for a send right now (network column + data saver + weak link). */
export function defaultUploadLevel() {
  const lv = getUploadQualityPrefs()[currentNetColumn()];
  if (lv !== 'standard' && (_dataSaverOn() || _weakLink())) return 'standard';
  return lv;
}

/** Explicit override (level/boolean) or the AUTO default. */
export function resolveLevel(override) {
  return normalizeLevel(override) || defaultUploadLevel();
}

/** Native toggles that are still boolean (native editor/attach sheet "HD" chip):
 *  ON = the saved level when it is above Padrão, else 'hd'; OFF = 'standard'. */
export function levelFromHdToggle(on) {
  if (!on) return 'standard';
  const d = defaultUploadLevel();
  return d === 'standard' ? 'hd' : d;
}

export function nextLevel(level) {
  const i = QUALITY_LEVELS.indexOf(normalizeLevel(level) || 'standard');
  return QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length];
}

export function photoProfileFor(level) {
  return PHOTO_PROFILES[normalizeLevel(level) || 'standard'];
}

export function videoLabelFor(level) {
  return VIDEO_LABELS[normalizeLevel(level) || 'standard'];
}

// ─── Estimates (preview pill / sheet) ───────────────────────────────────────
function _fit(w, h, maxLong, maxShort) {
  if (!(w > 0 && h > 0)) return [0, 0];
  const long = Math.max(w, h); const short = Math.min(w, h);
  const s = Math.min(1, maxLong / long, (maxShort || maxLong) / short);
  return [Math.round(w * s), Math.round(h * s)];
}

/**
 * Estimated upload bytes for one item at `level`.
 * item: { isVideo, width, height, durationMs, sizeBytes }. Never above the
 * source size (a re-encode that would grow is skipped by the pipeline).
 */
export function estimateBytes(item, level) {
  const lv = normalizeLevel(level) || 'standard';
  const src = Number(item?.sizeBytes) || 0;
  if (item?.isVideo) {
    const sec = (Number(item?.durationMs) || 0) / 1000;
    if (!(sec > 0)) return src;
    // long clips: the pipeline lowers the bitrate to stay under the 190 MB cap
    const est = Math.min(190 * 1024 * 1024, Math.round((_VIDEO_BPS[lv] / 8) * sec * 1.02));
    return src > 0 ? Math.min(src, est) : est;
  }
  let w = Number(item?.width) || 0; let h = Number(item?.height) || 0;
  if (!(w > 0 && h > 0)) { w = 4032; h = 3024; } // typical 12 MP camera photo
  const p = PHOTO_PROFILES[lv];
  const [ow, oh] = _fit(w, h, p.maxDim, p.maxDim);
  const est = Math.round(ow * oh * _JPEG_BPP[lv]);
  return src > 0 && lv !== 'full' ? Math.min(src, est) : est;
}

/** Output resolution label for the sheet ("1600 px", "720p", …). */
export function resolutionLabel(isVideo, level) {
  const lv = normalizeLevel(level) || 'standard';
  if (isVideo) return lv === 'standard' ? '720p' : '1080p';
  return lv === 'full' ? null : `${PHOTO_PROFILES[lv].maxDim} px`;
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

export { _VIDEO_BOX as VIDEO_BOXES };

// ─── Receiver badge ─────────────────────────────────────────────────────────
/**
 * 'HD' | '4K' | '' for a chat message, from the dimensions the server stores
 * (no extra column): photo long edge ≥ 2000 (Padrão tops at 1600), video short
 * side ≥ 1000 (≥ 2000 → 4K). Own optimistic rows carry `_quality`/`_hd`.
 */
export function hdBadgeFor(msg) {
  if (!msg) return '';
  const type = msg.type;
  if (type !== 'image' && type !== 'video') return '';
  let w = Number(msg.width) || Number(msg.image_width) || 0;
  let h = Number(msg.height) || Number(msg.image_height) || 0;
  if (!(w > 0 && h > 0) && msg.image_variants) {
    try {
      const iv = typeof msg.image_variants === 'string' ? JSON.parse(msg.image_variants) : msg.image_variants;
      w = Number(iv?.full_w) || w; h = Number(iv?.full_h) || h;
    } catch {}
  }
  const ownHd = msg._quality === 'hd' || msg._quality === 'full' || msg._hd === true || msg.is_hd;
  if (type === 'video') {
    const short = w > 0 && h > 0 ? Math.min(w, h) : 0;
    if (short >= 2000) return '4K';
    return short >= 1000 || ownHd ? 'HD' : '';
  }
  const long = w > 0 && h > 0 ? Math.max(w, h) : 0;
  return long >= 2000 || (ownHd && !long) ? 'HD' : '';
}

// ─── Compat (pre-2026-10-19 callers) ────────────────────────────────────────
/** Legacy single value: the level of the current network column. */
export function getMediaUploadQuality() {
  return getUploadQualityPrefs()[currentNetColumn()];
}
/** Legacy setter: writes the Wi-Fi column. */
export function setMediaUploadQuality(v) {
  return setUploadQualityPref('wifi', v).wifi;
}
export function onMediaUploadQualityChange(fn) {
  if (typeof fn !== 'function') return () => {};
  return onUploadQualityChange(() => fn(getMediaUploadQuality()));
}
/** Should a boolean HD chip start ON for a VIDEO right now? */
export function defaultVideoHd() {
  return defaultUploadLevel() !== 'standard';
}
/**
 * Effective video label for one send. hd: level string, boolean chip, or
 * null/undefined = follow the default.
 * @returns {'720p'|'1080p'|'1080p_full'}
 */
export function resolveVideoQuality(hd) {
  return videoLabelFor(resolveLevel(hd));
}

export default {
  MEDIA_UPLOAD_QUALITY_KEY,
  MEDIA_UPLOAD_QUALITY_KEY_V2,
  QUALITY_LEVELS,
  PHOTO_PROFILES,
  VIDEO_LABELS,
  normalizeLevel,
  getUploadQualityPrefs,
  setUploadQualityPref,
  onUploadQualityChange,
  currentNetColumn,
  defaultUploadLevel,
  resolveLevel,
  levelFromHdToggle,
  nextLevel,
  photoProfileFor,
  videoLabelFor,
  estimateBytes,
  resolutionLabel,
  formatBytes,
  hdBadgeFor,
  getMediaUploadQuality,
  setMediaUploadQuality,
  onMediaUploadQualityChange,
  defaultVideoHd,
  resolveVideoQuality,
};
