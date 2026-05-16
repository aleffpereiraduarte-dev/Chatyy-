/**
 * Per-account device registry sync (SQLite-first chat migration — Stage 2).
 *
 * Each surface (web/desktop/companion-mobile) registers its own X25519
 * pubkey via chat_device_key_publish after QR pairing. This module fetches
 * the registry list on app foreground + on linked-devices.js mount and
 * caches it locally so the phone can target each device in Stage 5
 * envelope encryption without an extra round-trip per send.
 *
 * Cache shape (per-account, keyed by lowercased email):
 *   { fetched_at: ms, devices: [{ device_id, pubkey, kind, created_at, last_seen_at }] }
 *
 * TTL: 5 minutes. We always serve cached data on a cache hit (no stampede
 * on cold UI mount); a background refresh on foreground keeps it fresh.
 */
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const REGISTRY_TTL_MS = 5 * 60 * 1000;
const STORAGE_PREFIX = 'chat_device_registry:'; // + lowercased email

// In-memory cache mirrors the persisted blob so repeated lookups during a
// single session don't hit storage. Keyed by email.
const _memCache = new Map(); // email -> { fetched_at, devices }

function _storage() {
  // AsyncStorage is the lowest-common denom (web has the SDK shim, native
  // has the real impl). Avoids pulling in expo-secure-store for what is
  // non-sensitive cached pubkey data (pubkeys are public by definition).
  return AsyncStorage;
}

function _storageKey(email) {
  return STORAGE_PREFIX + (email || '').toLowerCase();
}

async function _readPersisted(email) {
  try {
    const raw = await _storage().getItem(_storageKey(email));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.devices)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function _writePersisted(email, blob) {
  try {
    await _storage().setItem(_storageKey(email), JSON.stringify(blob));
  } catch {
    // Storage quota / serialization edge — non-fatal.
  }
}

/**
 * Resolve the currently-active account email from the api module's
 * in-memory state. We avoid a circular import on AuthContext by reading
 * the same source api.js uses for Bearer attachment.
 */
function _activeEmail() {
  try {
    if (typeof api.getActiveAccountEmail === 'function') return api.getActiveAccountEmail() || null;
    if (typeof api.getSavedEmail === 'function') return api.getSavedEmail() || null;
  } catch {}
  return null;
}

/**
 * Fetch the device registry for the current account. By default uses the
 * cached copy if fresh (<5min); pass { force: true } to skip TTL.
 *
 * Returns { devices: [...] } — same shape the backend returns. On network
 * failure with a cached copy present, returns the cache (stale-while-error).
 */
export async function loadDeviceRegistry(opts = {}) {
  const email = opts.email || _activeEmail();
  if (!email) return { devices: [], cached: false, email: null };
  const lcEmail = email.toLowerCase();
  const force = !!opts.force;
  const now = Date.now();

  // Memory hit first.
  const mem = _memCache.get(lcEmail);
  if (!force && mem && now - mem.fetched_at < REGISTRY_TTL_MS) {
    return { devices: mem.devices, cached: true, email: lcEmail };
  }

  // Persisted fallback — hydrate mem on first call this session.
  if (!mem) {
    const persisted = await _readPersisted(lcEmail);
    if (persisted) {
      _memCache.set(lcEmail, persisted);
      if (!force && now - persisted.fetched_at < REGISTRY_TTL_MS) {
        return { devices: persisted.devices, cached: true, email: lcEmail };
      }
    }
  }

  // Network fetch.
  try {
    const r = await api.chatDeviceKeysList();
    if (r?.success && r.data && Array.isArray(r.data.devices)) {
      const blob = { fetched_at: Date.now(), devices: r.data.devices };
      _memCache.set(lcEmail, blob);
      _writePersisted(lcEmail, blob).catch(() => {});
      return { devices: blob.devices, cached: false, email: lcEmail };
    }
  } catch (e) {
    // Swallow — fall through to stale cache or empty.
  }

  // Network failed; return the best cache we have.
  const fallback = _memCache.get(lcEmail);
  if (fallback) {
    return { devices: fallback.devices, cached: true, email: lcEmail, stale: true };
  }
  return { devices: [], cached: false, email: lcEmail };
}

/**
 * Look up a specific device's pubkey from the locally cached registry.
 * Returns null if the registry hasn't been loaded yet or the device id
 * isn't present. Synchronous on purpose — Stage 5 send path needs to
 * resolve pubkeys without await per recipient.
 */
export function getDevicePubkeyFor(deviceId, email) {
  if (!deviceId) return null;
  const lcEmail = (email || _activeEmail() || '').toLowerCase();
  if (!lcEmail) return null;
  const blob = _memCache.get(lcEmail);
  if (!blob) return null;
  const hit = blob.devices.find((d) => d.device_id === deviceId);
  return hit ? hit.pubkey : null;
}

/**
 * Drop the cache for an account (or all accounts if none passed). Useful
 * on logout so the next user doesn't see the previous user's device list.
 */
export async function clearDeviceRegistry(email) {
  if (email) {
    const lc = email.toLowerCase();
    _memCache.delete(lc);
    try { await _storage().removeItem(_storageKey(lc)); } catch {}
    return;
  }
  _memCache.clear();
  // Nuking every prefixed key requires AsyncStorage.getAllKeys; cheap on
  // this size of data but only do it on a hard wipe.
  try {
    const keys = await _storage().getAllKeys();
    const ours = (keys || []).filter((k) => k.startsWith(STORAGE_PREFIX));
    if (ours.length) await _storage().multiRemove(ours);
  } catch {}
}

// ────────────────────────────────────────────────────────────────────────
// AppState hook — refresh on foreground.
// ────────────────────────────────────────────────────────────────────────
// Wired once per process. Calling installAppStateHook multiple times is a
// no-op so screens (linked-devices.js, chat.js) can each defensively call
// it on mount without piling listeners.

let _hookInstalled = false;
let _appStateSub = null;

export function installAppStateHook() {
  if (_hookInstalled) return;
  _hookInstalled = true;
  try {
    // RN AppState — on web this resolves to a no-op stub that fires once
    // with state='active' on mount. That's still a fine cache-warm trigger.
    const handler = (state) => {
      if (state === 'active') {
        loadDeviceRegistry({ force: true }).catch(() => {});
      }
    };
    if (AppState && typeof AppState.addEventListener === 'function') {
      // RN >=0.65 returns a subscription object with .remove().
      _appStateSub = AppState.addEventListener('change', handler);
    }
  } catch {
    // Platform without AppState (very old web stub) — skip.
  }
}

export function uninstallAppStateHook() {
  if (_appStateSub) {
    try { _appStateSub.remove?.(); } catch {}
    _appStateSub = null;
  }
  _hookInstalled = false;
}

export default {
  loadDeviceRegistry,
  getDevicePubkeyFor,
  clearDeviceRegistry,
  installAppStateHook,
  uninstallAppStateHook,
};
