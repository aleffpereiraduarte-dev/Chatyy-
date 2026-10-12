// snapMapPrefetch — [2026-10-12 snapmap-speed] instant first paint for
// "Amigos no Mapa" (app/snap-map.js).
//
// Before: the screen seeded the map camera at the Brazil centroid (rural Mato
// Grosso, zoom 14 = an empty beige MapKit canvas) and only fetched friends
// AFTER waiting for a GPS fix (up to 10s on iOS). Now:
//   - last region + last friends' positions are kept in memory (sync, same
//     session) and in AsyncStorage (cold start), keyed PER ACCOUNT (never mix
//     accounts — see fluidez cross-account cache leak);
//   - prefetchSnapMap() is fired when the user taps the map entry (chat tile,
//     sidebar, family) so the friends query is already in flight/landed by
//     the time the screen mounts.

import { Platform } from 'react-native';
import * as api from './api';

const KEY = (email) => `snap_map_cache:v2:${String(email || '').toLowerCase()}`;
const LAST_LOC_KEY = 'snap_map_last_loc:v1'; // legacy (pre-v2) device-wide center
const PREFETCH_TTL_MS = 15000;

let _AS = null;
function storage() {
  if (_AS) return _AS;
  try { _AS = require('@react-native-async-storage/async-storage').default; } catch { _AS = null; }
  return _AS;
}

const _mem = new Map(); // email → { center, shares, pending, ts }
let _inflight = null;   // { email, ts, promise }

function activeEmail(email) {
  if (email) return String(email).toLowerCase();
  try {
    const e = typeof api.getSavedEmail === 'function' ? api.getSavedEmail() : null;
    if (e) return String(e).toLowerCase();
  } catch {}
  if (Platform.OS === 'web') {
    try { const e = localStorage.getItem('mail_active_account'); if (e) return e.toLowerCase(); } catch {}
  }
  return '';
}

/** Sync snapshot from memory (same session) — null when nothing cached yet. */
export function getSnapMapCacheSync(email) {
  const k = activeEmail(email);
  if (!k) return null;
  return _mem.get(k) || null;
}

/** Async: memory first, then AsyncStorage (cold start). */
export async function readSnapMapCache(email) {
  const k = activeEmail(email);
  if (!k) return null;
  const m = _mem.get(k);
  if (m) return m;
  const AS = storage();
  if (!AS) return null;
  try {
    const [raw, legacy] = await Promise.all([AS.getItem(KEY(k)), AS.getItem(LAST_LOC_KEY)]);
    let v = raw ? JSON.parse(raw) : null;
    if (!v || !v.center) {
      const l = legacy ? JSON.parse(legacy) : null;
      if (l && Number.isFinite(l.lat) && Number.isFinite(l.lng)) v = { ...(v || {}), center: { lat: l.lat, lng: l.lng, ts: l.ts } };
    }
    if (v) {
      const cur = _mem.get(k);
      const merged = { ...v, ...(cur || {}) };
      _mem.set(k, merged);
      return merged;
    }
  } catch {}
  return null;
}

let _persistT = null;
/** Merge `patch` ({center?, shares?, pending?}) into the per-account cache. */
export function writeSnapMapCache(email, patch) {
  const k = activeEmail(email);
  if (!k || !patch) return;
  const next = { ...(_mem.get(k) || {}), ...patch, ts: Date.now() };
  _mem.set(k, next);
  if (_persistT) clearTimeout(_persistT);
  _persistT = setTimeout(() => {
    _persistT = null;
    const AS = storage();
    if (!AS) return;
    try {
      // Cap the persisted friends list (positions only — no message data).
      const v = _mem.get(k) || {};
      const out = { center: v.center || null, shares: Array.isArray(v.shares) ? v.shares.slice(0, 100) : [], pending: Array.isArray(v.pending) ? v.pending.slice(0, 50) : [], ts: v.ts };
      AS.setItem(KEY(k), JSON.stringify(out)).catch(() => {});
    } catch {}
  }, 400);
}

/**
 * Fire the friends + pending-requests queries now (deduped for 15s). Call it
 * on tap of the map entry; the screen consumes the same promise on mount.
 * Resolves to { shares, pending } (either may be null on failure).
 */
export function prefetchSnapMap(email, { force = false } = {}) {
  const k = activeEmail(email);
  const now = Date.now();
  // Same account (or caller couldn't resolve one — the bearer decides) + fresh → reuse.
  if (!force && _inflight && now - _inflight.ts < PREFETCH_TTL_MS
      && (_inflight.email === k || !_inflight.email || !k)) return _inflight.promise;
  // Warm the AsyncStorage copy into memory in parallel (cold start).
  readSnapMapCache(k).catch(() => {});
  const promise = Promise.all([
    Promise.resolve().then(() => api.friendsMapShares?.()).catch(() => null),
    Promise.resolve().then(() => api.friendLocationGrants?.()).catch(() => null),
  ]).then(([r, g]) => {
    const shares = r?.success && r.data && Array.isArray(r.data.shares) ? r.data.shares : null;
    const pending = g?.success && g.data ? (g.data.pending_incoming || []) : null;
    const patch = {};
    if (shares) patch.shares = shares;
    if (pending) patch.pending = pending;
    if (k && (shares || pending)) writeSnapMapCache(k, patch);
    return { shares, pending };
  });
  _inflight = { email: k, ts: now, promise };
  return promise;
}

