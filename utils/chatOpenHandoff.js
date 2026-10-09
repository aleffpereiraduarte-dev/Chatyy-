// [2026-10-08 chat-open-flicker] Synchronous state for the FIRST frame of a
// conversation screen.
//
// chat-conversation used to start with defaults and fill them in from async
// sources after mount, so the pushed screen visibly changed under the user's
// eyes right after the transition ("dá uma piscada quando abre o chat"):
//   - group photo: '' → AsyncStorage/SQLite conversation cache (initials → photo)
//   - chat settings (font size, account wallpaper): defaults → chat_get_settings
//     network round-trip (wallpaper popped in, bubbles re-flowed)
//   - device prefs (bubble shape, default wallpaper, enter-sends): defaults →
//     AsyncStorage
//   - peer presence: null → WS presence_result (the "online / visto há" line
//     appeared and pushed the name up)
// Everything here is read synchronously in useState initializers: an in-memory
// map for this session backed by the boot-hydrated MMKV mirror (services/mmkv:
// on iOS/web every key is in memory before the first screen renders).
// All functions are total — never throw, return null when unknown.

const _convs = new Map(); // String(id) -> conv row tapped in the list
const _settings = new Map(); // email -> settings object
const _presence = new Map(); // email -> { status, last_seen, at }
let _localPrefs = null;

function _mmkv() {
  try { return require('../services/mmkv'); } catch { return null; }
}
function _getJSON(key) {
  try {
    const raw = _mmkv()?.getString(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function _setJSON(key, value) {
  try { _mmkv()?.setString(key, JSON.stringify(value)); } catch {}
}
function _lc(s) { return String(s || '').trim().toLowerCase(); }

// ── Conversation row handoff (list tap → thread first frame) ───────────────
/** Call right before router.push to the conversation. */
export function stashOpenConversation(conv) {
  try {
    if (!conv || conv.id == null) return;
    const k = String(conv.id);
    _convs.delete(k);
    _convs.set(k, conv);
    if (_convs.size > 40) _convs.delete(_convs.keys().next().value);
  } catch {}
}

/**
 * The conversation row for `id`: the one stashed by the list tap, else the
 * in-memory conversation snapshot (push / deep link / other screens).
 */
export function peekOpenConversation(id) {
  if (id == null || id === '' || id === 0) return null;
  const k = String(id);
  const hit = _convs.get(k);
  if (hit) return hit;
  try {
    const list = require('../services/smartChatCache').getCachedConversationsSync?.() || [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c && String(c.id) === k) return c;
    }
  } catch {}
  return null;
}

// ── chat_get_settings (per account) ────────────────────────────────────────
export function getCachedChatSettings(email) {
  const e = _lc(email);
  if (!e) return null;
  if (_settings.has(e)) return _settings.get(e);
  const v = _getJSON('chat_settings_v1:' + e);
  if (v) _settings.set(e, v);
  return v;
}
export function setCachedChatSettings(email, settings) {
  const e = _lc(email);
  if (!e || !settings || typeof settings !== 'object') return;
  _settings.set(e, settings);
  _setJSON('chat_settings_v1:' + e, settings);
}

// ── Device-local appearance prefs (mirror of the AsyncStorage KV) ──────────
export function getCachedLocalPrefs() {
  if (_localPrefs) return _localPrefs;
  _localPrefs = _getJSON('chat_local_prefs_v1');
  return _localPrefs;
}
export function setCachedLocalPrefs(kv) {
  if (!kv || typeof kv !== 'object') return;
  const next = {};
  for (const k of Object.keys(kv)) {
    const v = kv[k];
    if (typeof v === 'string' || v === null) next[k] = v;
  }
  const prev = _localPrefs ? JSON.stringify(_localPrefs) : '';
  const ser = JSON.stringify(next);
  _localPrefs = next;
  if (ser !== prev) _setJSON('chat_local_prefs_v1', next);
}

// ── Peer presence (last known) ─────────────────────────────────────────────
export function getCachedPresence(email) {
  const e = _lc(email);
  if (!e) return null;
  if (_presence.has(e)) return _presence.get(e);
  const v = _getJSON('chat_presence_v1:' + e);
  if (v) _presence.set(e, v);
  return v;
}
export function setCachedPresence(email, presence, at) {
  const e = _lc(email);
  if (!e || !presence || typeof presence !== 'object') return;
  const rec = { status: presence.status || null, last_seen: presence.last_seen || null, at: Number(at) || Date.now() };
  const prev = _presence.get(e);
  _presence.set(e, rec);
  // Persist only what changes the rendered text (status / last_seen), not
  // every heartbeat timestamp.
  if (!prev || prev.status !== rec.status || prev.last_seen !== rec.last_seen) {
    _setJSON('chat_presence_v1:' + e, rec);
  }
}
