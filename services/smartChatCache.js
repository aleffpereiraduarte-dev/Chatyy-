// Smart Chat Cache — Telegram-style instant paint.
//
// Strategy:
//   - In-memory Map is the authoritative read source (< 1 μs reads).
//   - Persisted via `services/mmkv.js` (synchronous on native via the in-mem
//     layer populated from AsyncStorage at splash; localStorage on web).
//   - Per-conversation keys so writes are granular (no monolithic blob).
//   - Write coalescing: debounced 500ms per conversation.
//   - LRU eviction when the total persisted footprint exceeds 5 MB.
//   - Pure JS, no native modules, no SQLite, no FTS — zero crash surface.
//
// Hot path (called inside `useState(() => ...)` initializers):
//   - getCachedMessagesSync(convId)
//   - getCachedConversationsSync()
//   - getLastCachedIdSync(convId)
//
// Writes are fire-and-forget; the caller never awaits.

import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys, getJSON, setJSON, waitForCacheReady } from './mmkv';
import { normAccount, accountKeyHash } from './chatStore/schema';

// ─── Configuration ─────────────────────────────────────────────────────────
// These are BASE roots. When an active account is set (via setActiveAccount,
// wired from AuthContext) every persisted key gains a per-account suffix so two
// accounts on the same device never share a blob. While no account is set the
// keys equal the legacy ones → byte-for-byte identical behaviour.
const MSG_KEY_PREFIX = 'chat_msgs_v2_';
const CONV_KEY = 'chat_convs_v2';
const INDEX_KEY = 'chat_index_v2';
const MIGRATION_FLAG = 'chat_migrate_v2_done';

// ─── Active-account scoping ──────────────────────────────────────────────────
let _acct = '';          // normalized active account email ('' = unscoped/legacy)
let _acctSuffix = '';    // cached '_<hash>' suffix for the active account
function _msgKey(convId) { return MSG_KEY_PREFIX + (_acctSuffix ? _acctSuffix + '_' : '') + convId; }
function _convKey() { return CONV_KEY + _acctSuffix; }
function _indexKey() { return INDEX_KEY + _acctSuffix; }

// [2026-09-28] Bump grande p/ o celular guardar MUITO mais localmente, mais perto
// do WhatsApp (histórico offline). Antes: 200 msgs/conv, teto 5MB. Agora: 1500
// msgs/conv, teto 40MB. Assim rolar pra cima raramente rebusca do servidor — abre
// tudo instantâneo do disco. (Pra histórico infinito 100% igual WhatsApp o ideal é
// SQLite local nativo — projeto maior; isto já cobre a esmagadora maioria dos casos.)
const MAX_MSGS_PER_CONV = 1500;      // persisted cap por conversa (era 200)
const MAX_MEMORY_MSGS = 1000;        // in-memory scroll window (era 500)
const FLUSH_DEBOUNCE_MS = 500;
const TOTAL_BYTE_BUDGET = 40 * 1024 * 1024;  // 40 MB (era 5MB — LRU ainda protege)
const EVICT_DOWN_TO = 36 * 1024 * 1024;    // hysteresis (~90% do teto)

// ─── In-memory authoritative state ─────────────────────────────────────────
const _msgs = new Map();  // convId → Message[]
let _convs = [];          // Conversation[]
const _index = { lru: {}, bytes: {}, totalBytes: 0 }; // { convId: lastAccessMs }

// Debounced write timers
const _timers = new Map(); // convId → TimeoutId
let _convTimer = null;

// ─── Hydration — two-phase, sync-then-async-retry ─────────────────────────
// On native, mmkv.js reads from an in-memory _mem Map that's populated by an
// async AsyncStorage.multiGet at module load. If smartChatCache hydrates
// BEFORE that multiGet resolves, getString returns null and the in-memory
// _msgs stays empty — users see "mensagens sumindo" after restart (they're
// still in AsyncStorage, just invisible to this cache layer).
//
// Fix: do the sync hydrate first (covers web + hot-start native), then await
// mmkv.waitForCacheReady and retry. Second pass populates anything the
// first pass missed due to the race.
function _doHydrate() {
  try {
    const convRaw = getString(_convKey());
    if (convRaw) {
      try { _convs = JSON.parse(convRaw) || []; } catch { _convs = []; }
    }
    const idxRaw = getString(_indexKey());
    if (idxRaw) {
      try {
        const parsed = JSON.parse(idxRaw);
        if (parsed && typeof parsed === 'object') {
          _index.lru = parsed.lru || {};
          _index.bytes = parsed.bytes || {};
          _index.totalBytes = parsed.totalBytes || 0;
        }
      } catch {}
    }
    for (const idStr of Object.keys(_index.lru)) {
      const convId = Number(idStr) || idStr;
      const raw = getString(_msgKey(idStr));
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && !_msgs.has(convId)) _msgs.set(convId, parsed);
      } catch {}
    }
  } catch {}
}
(function hydrate() {
  _doHydrate();
  _runMigrationOnce();
  // Async retry once the MMKV async layer has loaded. Covers the cold-start
  // case where the first pass ran before AsyncStorage→_mem hydration.
  if (Platform.OS !== 'web' && typeof waitForCacheReady === 'function') {
    waitForCacheReady().then(() => _doHydrate()).catch(() => {});
  }
})();

function _runMigrationOnce() {
  try {
    if (getString(MIGRATION_FLAG) === '1') return;
    const allKeys = getAllKeys();
    if (!Array.isArray(allKeys) || allKeys.length === 0) {
      setString(MIGRATION_FLAG, '1');
      return;
    }
    const legacyKeys = allKeys.filter(k => k.startsWith('chat_msgs_') && !k.startsWith('chat_msgs_v2_'));
    for (const k of legacyKeys) {
      try {
        const raw = getString(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        const convId = k.replace('chat_msgs_', '');
        const trimmed = parsed.slice(-MAX_MSGS_PER_CONV);
        _msgs.set(convId, trimmed);
        _index.lru[convId] = Date.now();
        _scheduleFlush(convId);
        remove(k);
      } catch {}
    }
    setString(MIGRATION_FLAG, '1');
  } catch {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const _isPersistableId = (id) => typeof id === 'number' && id > 0;

// Sanitize a message for persistence — strip transient JS-only fields AND
// any nested state that could blow up JSON.parse on the next read.
function _sanitize(m) {
  if (!m || typeof m !== 'object') return null;
  const c = { ...m };
  delete c._e2eRaw;
  delete c._pending;
  delete c._failed;
  delete c._queued;
  delete c._negId;
  delete c._client_id;
  // Keep reply_to as-is here — JSON.stringify handles it fine. This is NOT
  // the Swift SQLite cache; we're serializing to pure JSON string.
  return c;
}

function _mergeIntoMemory(convId, incoming) {
  const existing = _msgs.get(convId) || [];
  const byId = new Map();
  for (const m of existing) {
    if (!m) continue;
    byId.set(String(m.id), m);
  }
  for (const raw of incoming) {
    const m = _sanitize(raw);
    if (!m || m.id == null) continue;
    byId.set(String(m.id), m);
  }
  // Order by numeric id if possible, falling back to created_at
  const arr = Array.from(byId.values()).sort((a, b) => {
    const ai = typeof a.id === 'number' ? a.id : 0;
    const bi = typeof b.id === 'number' ? b.id : 0;
    if (ai !== bi) return ai - bi;
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return at - bt;
  });
  // Keep a generous window in memory for scroll-up
  const capped = arr.length > MAX_MEMORY_MSGS ? arr.slice(-MAX_MEMORY_MSGS) : arr;
  _msgs.set(convId, capped);
  _index.lru[convId] = Date.now();
}

function _scheduleFlush(convId) {
  const existing = _timers.get(convId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _timers.delete(convId);
    _flushOne(convId);
  }, FLUSH_DEBOUNCE_MS);
  _timers.set(convId, t);
}

function _flushOne(convId) {
  try {
    const arr = _msgs.get(convId) || [];
    // Only persist confirmed (numeric-id) messages, capped to MAX_MSGS_PER_CONV newest.
    const persistable = arr.filter(m => _isPersistableId(m.id)).slice(-MAX_MSGS_PER_CONV);
    if (persistable.length === 0) {
      remove(_msgKey(convId));
      // Decrementa totalBytes e remove a entrada do bytes — antes só zerava
      // bytes[convId] sem decrementar totalBytes, fazendo o orçamento
      // de evicção ficar inflado.
      const prev = _index.bytes[convId] || 0;
      _index.totalBytes = Math.max(0, _index.totalBytes - prev);
      delete _index.bytes[convId];
      delete _index.lru[convId];
      _writeIndex();
      return;
    }
    const json = JSON.stringify(persistable);
    setString(_msgKey(convId), json);
    const bytes = json.length;
    const prev = _index.bytes[convId] || 0;
    _index.bytes[convId] = bytes;
    _index.totalBytes = Math.max(0, _index.totalBytes - prev) + bytes;
    _index.lru[convId] = Date.now();
    _maybeEvict();
    _writeIndex();
  } catch {}
}

function _writeIndex() {
  try {
    setString(_indexKey(), JSON.stringify({
      lru: _index.lru,
      bytes: _index.bytes,
      totalBytes: _index.totalBytes,
    }));
  } catch {}
}

function _maybeEvict() {
  if (_index.totalBytes < TOTAL_BYTE_BUDGET) return;
  // Sort conversations by LRU (oldest first)
  const sorted = Object.entries(_index.lru).sort((a, b) => a[1] - b[1]);
  for (const [convId] of sorted) {
    if (_index.totalBytes <= EVICT_DOWN_TO) break;
    try {
      remove(_msgKey(convId));
      // [2026-07-03] _index.lru keys are always STRING (object-property
      // coercion) but _msgs is keyed by the raw convId (a Number in practice),
      // so `_msgs.delete(convId)` with the string key never matched → evicted
      // conversations' message arrays stayed resident in memory (defeating the
      // eviction). Delete all key shapes like clearConversation does.
      _msgs.delete(convId); _msgs.delete(String(convId)); _msgs.delete(Number(convId));
      _index.totalBytes = Math.max(0, _index.totalBytes - (_index.bytes[convId] || 0));
      delete _index.bytes[convId];
      delete _index.lru[convId];
    } catch {}
  }
}

// ─── Cache-scope lock bridge ───────────────────────────────────────────────
// Lazy require to dodge the circular chatCache → smartChatCache import (the
// latter is also required from chatCache for write-through). Cached after the
// first successful resolve to skip the require() cost on the hot path.
let _scopeCheck = null;
function _isLocked() {
  try {
    if (!_scopeCheck) {
      const mod = require('./chatCache');
      _scopeCheck = (typeof mod?.isCacheScopeLocked === 'function') ? mod.isCacheScopeLocked : (() => false);
    }
    return _scopeCheck();
  } catch { return false; }
}

// ─── Public API — sync reads ───────────────────────────────────────────────
export function getCachedMessagesSync(convId, limit = 50) {
  // Account-switch race: return empty during the lock window so the new
  // account's screen never paints the previous user's messages.
  if (_isLocked()) return [];
  if (convId == null) return [];
  // Accept both numeric and string ids
  let arr = _msgs.get(convId) || _msgs.get(String(convId)) || _msgs.get(Number(convId)) || [];
  // [2026-07-03 telegram-speed] Cold-start fallback. The parsed in-memory Map
  // (_msgs) is only warm AFTER _doHydrate() finishes. If the user taps a
  // conversation in the first few hundred ms after launch, _msgs is still cold
  // → the screen fell back to the ASYNC SQLite read and flashed a skeleton
  // ("demora abrir"). But the raw JSON is ALREADY available synchronously via
  // MMKV's in-mem layer — read+parse it on demand and warm _msgs so the thread
  // paints from frame 1. Cheap (one getString + parse), only when the Map is
  // cold for this conv.
  if (arr.length === 0) {
    try {
      const raw = getString(_msgKey(String(convId)));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          _msgs.set(convId, parsed);
          arr = parsed;
        }
      }
    } catch {}
  }
  _index.lru[convId] = Date.now();
  if (!limit || arr.length <= limit) return arr.slice();
  return arr.slice(-limit);
}

export function getCachedConversationsSync() {
  if (_isLocked()) return [];
  return Array.isArray(_convs) ? _convs.slice() : [];
}

export function getLastCachedIdSync(convId) {
  if (_isLocked()) return 0;
  const arr = getCachedMessagesSync(convId, MAX_MEMORY_MSGS);
  let max = 0;
  for (const m of arr) {
    if (typeof m?.id === 'number' && m.id > max) max = m.id;
  }
  return max;
}

// ─── Public API — writes (fire-and-forget) ─────────────────────────────────
export function cacheMessages(convId, messages) {
  if (convId == null || !Array.isArray(messages) || messages.length === 0) return;
  _mergeIntoMemory(convId, messages);
  _scheduleFlush(convId);
}

export function cacheSingleMessage(convId, msg) {
  if (convId == null || !msg) return;
  _mergeIntoMemory(convId, [msg]);
  _scheduleFlush(convId);
}

export function updateCachedMessage(convId, msgId, patch) {
  if (convId == null || msgId == null || !patch) return;
  const arr = _msgs.get(convId) || [];
  let touched = false;
  const next = arr.map(m => {
    if (m && String(m.id) === String(msgId)) {
      touched = true;
      return { ..._sanitize(m), ...patch };
    }
    return m;
  });
  if (touched) {
    _msgs.set(convId, next);
    _scheduleFlush(convId);
  }
}

export function deleteCachedMessage(convId, msgId) {
  if (convId == null || msgId == null) return;
  const arr = _msgs.get(convId) || [];
  const next = arr.filter(m => m && String(m.id) !== String(msgId));
  if (next.length !== arr.length) {
    _msgs.set(convId, next);
    _scheduleFlush(convId);
  }
}

export function cacheConversations(convs) {
  if (!Array.isArray(convs)) return;
  _convs = convs.slice();
  if (_convTimer) clearTimeout(_convTimer);
  _convTimer = setTimeout(() => {
    _convTimer = null;
    try { setString(_convKey(), JSON.stringify(_convs)); } catch {}
  }, FLUSH_DEBOUNCE_MS);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────
export function flushPendingWrites() {
  for (const [convId, timer] of _timers.entries()) {
    try { clearTimeout(timer); } catch {}
    _flushOne(convId);
  }
  _timers.clear();
  if (_convTimer) {
    try { clearTimeout(_convTimer); } catch {}
    _convTimer = null;
    try { setString(_convKey(), JSON.stringify(_convs)); } catch {}
  }
}

// Wipe a single conversation — used when user deletes a chat so its messages
// don't resurrect from the cache on next open.
export function clearConversation(convId) {
  if (convId == null) return;
  _msgs.delete(convId);
  _msgs.delete(String(convId));
  _msgs.delete(Number(convId));
  delete _index.lru[convId];
  const bytes = _index.bytes[convId] || 0;
  _index.totalBytes = Math.max(0, _index.totalBytes - bytes);
  delete _index.bytes[convId];
  try { remove(_msgKey(convId)); } catch {}
  _writeIndex();
}

export function clearChatCache() {
  _msgs.clear();
  _convs = [];
  _index.lru = {};
  _index.bytes = {};
  _index.totalBytes = 0;
  try {
    const keys = getAllKeys() || [];
    for (const k of keys) {
      // startsWith on the BASE roots catches every per-account variant
      // (chat_convs_v2, chat_convs_v2_<hash>, chat_msgs_v2_<hash>_<id>, …) so a
      // logout/clear wipes ALL accounts' accelerator blobs.
      if (k.startsWith(MSG_KEY_PREFIX) || k.startsWith(CONV_KEY) || k.startsWith(INDEX_KEY)) {
        remove(k);
      }
    }
  } catch {}
}

// ─── Active-account scoping ──────────────────────────────────────────────────
// Switch the accelerator to a different account. On a real change we flush the
// outgoing account's pending writes, drop ALL in-memory authoritative state
// (so a read can never serve the previous account, not even for one frame), then
// re-hydrate from the new account's scoped keys. Wired from AuthContext on
// login / account switch. Idempotent for the same account.
export function setActiveAccount(email) {
  const next = normAccount(email);
  if (next === _acct) return;
  // Flush the outgoing account so nothing queued is lost, then wipe memory.
  try { flushPendingWrites(); } catch {}
  _msgs.clear();
  _convs = [];
  _index.lru = {};
  _index.bytes = {};
  _index.totalBytes = 0;
  _acct = next;
  _acctSuffix = next ? ('_' + accountKeyHash(next)) : '';
  // Re-hydrate synchronously from the new account's keys so the next sync read
  // paints the correct account from frame 1. Async MMKV layer retries below.
  try { _doHydrate(); } catch {}
  if (Platform.OS !== 'web' && typeof waitForCacheReady === 'function') {
    try { waitForCacheReady().then(() => { try { _doHydrate(); } catch {} }).catch(() => {}); } catch {}
  }
}

export function getActiveAccount() { return _acct; }

// Install lifecycle flushers (AppState + web beforeunload) so we never lose
// the last ~500ms of writes.
try {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushPendingWrites);
    window.addEventListener('pagehide', flushPendingWrites);
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingWrites();
    });
  } else {
    const { AppState } = require('react-native');
    AppState.addEventListener?.('change', (next) => {
      if (next === 'background' || next === 'inactive') flushPendingWrites();
    });
  }
} catch {}
