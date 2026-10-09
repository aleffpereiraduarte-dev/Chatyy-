// [2026-10-08 chat-open-flicker] Registry of image URIs that already PAINTED.
//
// expo-image on iOS runs the `transition` cross-dissolve on EVERY set, memory
// cache hits included (ImageView.renderSourceImage → UIView.transition). So a
// bubble photo / header avatar / video poster that remounts when a conversation
// is reopened faded in again from its placeholder (initials gradient, blurhash,
// dark box) = the "piscada" on chat open. Callers ask `wasImageLoaded(uri)`
// before choosing a transition and call `markImageLoaded(uri)` from onLoad.
//
//   session set   — painted in this JS session: the bytes are in expo-image's
//                   memory/disk cache → safe to skip placeholders too.
//   persisted set — painted in a previous launch (MMKV, capped): only used to
//                   skip the fade (the disk cache may have been purged, so the
//                   caller keeps its loading placeholders).
import { Platform } from 'react-native';

const KEY = 'img_seen_v1';
const CAP = 600;
const _session = new Set();
let _persisted = null; // Set<string> | null (lazy)
let _order = [];       // insertion order for the persisted cap
let _saveTimer = null;

function _norm(uri) {
  if (typeof uri !== 'string' || !uri) return '';
  // data: URIs are inline (no fetch) and can be huge — never track them.
  if (uri.startsWith('data:')) return '';
  return uri.length > 512 ? uri.slice(0, 512) : uri;
}

function _loadPersisted() {
  if (_persisted) return _persisted;
  _persisted = new Set();
  try {
    const raw = require('../services/mmkv').getString(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        _order = arr.filter((s) => typeof s === 'string').slice(-CAP);
        for (const s of _order) _persisted.add(s);
      }
    }
  } catch {}
  return _persisted;
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { require('../services/mmkv').setString(KEY, JSON.stringify(_order.slice(-CAP))); } catch {}
  }, 1500);
}

/** Record that `uri` painted successfully (call from expo-image onLoad). */
export function markImageLoaded(uri) {
  const k = _norm(uri);
  if (!k) return;
  _session.add(k);
  if (_session.size > 4000) { _session.clear(); _session.add(k); }
  const p = _loadPersisted();
  if (!p.has(k)) {
    p.add(k);
    _order.push(k);
    if (_order.length > CAP * 1.25) {
      const drop = _order.splice(0, _order.length - CAP);
      for (const d of drop) p.delete(d);
    }
    _scheduleSave();
  }
}

/** Painted in THIS session (bytes certainly in expo-image's cache). */
export function wasImageLoaded(uri) {
  const k = _norm(uri);
  return !!k && _session.has(k);
}

/** Painted now or in a previous launch — use only to skip the fade-in. */
export function wasImageEverLoaded(uri) {
  const k = _norm(uri);
  if (!k) return false;
  if (_session.has(k)) return true;
  return _loadPersisted().has(k);
}

/**
 * Transition for an image that may already be cached: 0 for local files and
 * anything that painted before, `fallback` otherwise (first-ever network load).
 */
export function seenAwareTransition(uri, fallback) {
  if (typeof uri !== 'string' || !uri) return fallback;
  if (/^(file|content|ph|asset|assets-library|data|blob):/i.test(uri)) return 0;
  if (Platform.OS === 'web') return wasImageLoaded(uri) ? 0 : fallback;
  return wasImageEverLoaded(uri) ? 0 : fallback;
}
