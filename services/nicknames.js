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
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _cache = parsed;
        _loaded = true;
      }
    }
  } catch {}
}
_loadFromMmkv();

export function getNickname(email) {
  if (!email) return '';
  const key = String(email).toLowerCase();
  return _cache[key] || '';
}

export function applyNickname(email, fallbackName) {
  const nn = getNickname(email);
  return nn || fallbackName || '';
}

/** Seed cache from the server. Idempotent — safe to call often. */
export async function refreshNicknames() {
  try {
    if (!_loaded && waitForCacheReady) {
      try { await waitForCacheReady(); _loadFromMmkv(); } catch {}
    }
    const r = await api.chatNicknameList();
    const next = r?.data?.nicknames || {};
    if (typeof next === 'object') {
      _cache = {};
      for (const [k, v] of Object.entries(next)) {
        if (k && v) _cache[String(k).toLowerCase()] = String(v);
      }
      try { setString(MMKV_KEY, JSON.stringify(_cache)); } catch {}
    }
    return _cache;
  } catch {
    return _cache;
  }
}

/** Update a single entry locally + persist (call after chat_nickname_set). */
export function setNicknameLocal(email, nickname) {
  if (!email) return;
  const key = String(email).toLowerCase();
  if (nickname && String(nickname).trim()) _cache[key] = String(nickname).trim();
  else delete _cache[key];
  try { setString(MMKV_KEY, JSON.stringify(_cache)); } catch {}
}
