// Per-user contact nickname override (WhatsApp-style rename).
// Loaded from chat_nickname_list on app start, cached in MMKV for synchronous
// reads (chat list / bubbles render fast path — async lookup would flicker).

import { getString, setString, waitForCacheReady } from './mmkv';
import * as api from './api';

const MMKV_KEY = 'contact_nicknames_v1';
let _cache = {};
let _loaded = false;

function _loadFromMmkv() {
  try {
    const raw = getString(MMKV_KEY);
    if (!raw) {
      // Empty storage is a valid loaded state — don't block refresh forever.
      _loaded = true;
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _cache = parsed;
      _loaded = true;
    } else {
      _loaded = true;
    }
  } catch {
    _loaded = true;
  }
}
_loadFromMmkv();

export function getNickname(email) {
  if (!email) return '';
  const key = String(email).trim().toLowerCase();
  return _cache[key] || '';
}

export function applyNickname(email, fallbackName) {
  const nn = getNickname(email);
  return nn || fallbackName || '';
}

/** Seed cache from the server. Idempotent — safe to call often. */
export async function refreshNicknames() {
  try {
    if (!_loaded && typeof waitForCacheReady === 'function') {
      try { await waitForCacheReady(); _loadFromMmkv(); } catch {}
    }
    const r = await api.chatNicknameList();
    const next = r?.data?.nicknames || {};
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      _cache = {};
      for (const [k, v] of Object.entries(next)) {
        const key = String(k || '').trim().toLowerCase();
        const val = String(v || '').trim();
        if (key && val) _cache[key] = val;
      }
      try { setString(MMKV_KEY, JSON.stringify(_cache)); } catch {}
    }
    _loaded = true;
    return _cache;
  } catch {
    return _cache;
  }
}

/** Update a single entry locally + persist (call after chat_nickname_set). */
export function setNicknameLocal(email, nickname) {
  if (!email) return;
  const key = String(email).trim().toLowerCase();
  if (!key) return;
  if (nickname && String(nickname).trim()) _cache[key] = String(nickname).trim();
  else delete _cache[key];
  try { setString(MMKV_KEY, JSON.stringify(_cache)); } catch {}
}
