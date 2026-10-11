// services/mediaUploadQuality.js — [2026-10-11 video-fullhd]
//
// WhatsApp "Configurações › Armazenamento e dados › Qualidade de envio de
// mídia": Padrão / HD. This is the DEFAULT the media preview's "HD" chip
// starts from; the chip still flips it for a single send.
//
//   'hd'       (default) → videos 1080p (short side 1080, ~4.5 Mbps H.264)
//   'standard'           → videos 720p  (short side 720,  ~1.5 Mbps H.264)
//
// Smart about data: even with 'hd' saved, the AUTO default drops to standard
// when the in-app/system Data Saver is on or the link is weak (2G/3G, high
// RTT). An explicit tap on the chip always wins (WhatsApp honours HD even on
// cellular when the user asks for it).
//
// Persisted under the plain KV key `media_upload_quality` (localStorage on
// web, AsyncStorage on native — same store settings.js uses). Reads are sync
// from an in-memory copy hydrated at import; writes update memory first so the
// next preview opens with the new value without a relaunch.
import { Platform } from 'react-native';

export const MEDIA_UPLOAD_QUALITY_KEY = 'media_upload_quality';
const DEFAULT_QUALITY = 'hd';

let _quality = DEFAULT_QUALITY;
let _hydrated = false;
const _subs = new Set();

function _coerce(v) {
  return v === 'standard' || v === 'hd' ? v : null;
}

function _notify() {
  for (const fn of _subs) { try { fn(_quality); } catch {} }
}

function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') {
        const v = _coerce(localStorage.getItem(MEDIA_UPLOAD_QUALITY_KEY));
        if (v) _quality = v;
      }
    } catch {}
    return;
  }
  try {
    import('@react-native-async-storage/async-storage').then((m) => {
      m.default.getItem(MEDIA_UPLOAD_QUALITY_KEY).then((raw) => {
        const v = _coerce(raw);
        if (v && v !== _quality) { _quality = v; _notify(); }
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrate();

/** Saved preference: 'hd' | 'standard'. */
export function getMediaUploadQuality() {
  _hydrate();
  return _quality;
}

export function setMediaUploadQuality(v) {
  const q = _coerce(v) || DEFAULT_QUALITY;
  _quality = q;
  _hydrated = true;
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(MEDIA_UPLOAD_QUALITY_KEY, q); } catch {}
  } else {
    try {
      import('@react-native-async-storage/async-storage').then((m) => {
        m.default.setItem(MEDIA_UPLOAD_QUALITY_KEY, q).catch(() => {});
      }).catch(() => {});
    } catch {}
  }
  _notify();
  return q;
}

export function onMediaUploadQualityChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** True when Data Saver (in-app or iOS Low Data / Android Data Saver) is on. */
function _dataSaverOn() {
  try { return !!require('./mediaCache').isDataSaverOn?.(); } catch { return false; }
}

/** True on 2G/3G / high-RTT links (same classifier the upload queue uses). */
function _weakLink() {
  try { return require('./networkInfo').getLinkClass?.() !== 'fast'; } catch { return false; }
}

/**
 * Should the HD chip start ON for a VIDEO right now?
 * Saved 'hd' AND not data-saver AND link not weak.
 */
export function defaultVideoHd() {
  if (getMediaUploadQuality() !== 'hd') return false;
  if (_dataSaverOn()) return false;
  if (_weakLink()) return false;
  return true;
}

/**
 * Resolve the effective video label for one send.
 * @param {boolean|null|undefined} hd  explicit chip choice (true/false) or
 *                                     null/undefined = follow the default.
 * @returns {'1080p'|'720p'}
 */
export function resolveVideoQuality(hd) {
  if (hd === true) return '1080p';
  if (hd === false) return '720p';
  return defaultVideoHd() ? '1080p' : '720p';
}

export default {
  MEDIA_UPLOAD_QUALITY_KEY,
  getMediaUploadQuality,
  setMediaUploadQuality,
  onMediaUploadQualityChange,
  defaultVideoHd,
  resolveVideoQuality,
};
