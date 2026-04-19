/**
 * Chat Cache — SQLite primary (native), MMKV/localStorage fallback (web)
 * Provides local-first messaging: show cached messages instantly, sync only new ones
 *
 * Storage hierarchy (fastest → most capable):
 *   1. react-native-mmkv   — <0.5ms synchronous reads (if installed)
 *   2. AsyncStorage shim   — in-memory map + async persist (current default)
 *   3. SQLite (expo-sqlite) — indexed queries, 100k+ msgs (native primary)
 *   4. IndexedDB            — web only, via localDb.js
 *
 * To upgrade to real MMKV:
 *   npx expo install react-native-mmkv
 *   npx expo prebuild --clean
 * Once installed the try/require below auto-enables it — no code changes needed.
 */
import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys } from './mmkv';
import {
  dbSaveMessages, dbGetMessages, dbGetLastMessageId, dbDeleteMessage, dbUpdateMessage,
  dbSaveConversations, dbGetConversations,
  dbSavePending, dbGetPending, dbRemovePending,
  isDbReady, waitForDb,
} from './db';

const isNative = Platform.OS !== 'web';
const MAX_CACHED_MESSAGES = 1000; // key-value store limit (web only; SQLite is unlimited)

// ─── Real MMKV fast-path (react-native-mmkv, if installed) ──────────────────
// Provides synchronous <0.5ms reads — eliminates the async gap on initial render.
// Falls back to the existing AsyncStorage-backed mmkv.js shim transparently.

let _mmkvInstance = null;
let _mmkvAvailable = false;

try {
  const { MMKV } = require('react-native-mmkv');
  _mmkvInstance = new MMKV({ id: 'chatyy-chat' });
  _mmkvAvailable = true;
} catch {
  // react-native-mmkv not installed — AsyncStorage shim handles persistence
}

function _kvGet(key) {
  if (_mmkvAvailable && _mmkvInstance) {
    try { return _mmkvInstance.getString(key) ?? null; } catch {}
  }
  return getString(key);
}

function _kvSet(key, value) {
  if (_mmkvAvailable && _mmkvInstance) {
    try { _mmkvInstance.set(key, value); return; } catch {}
  }
  setString(key, value);
}

function _kvRemove(key) {
  if (_mmkvAvailable && _mmkvInstance) {
    try { _mmkvInstance.delete(key); return; } catch {}
  }
  remove(key);
}

function _kvGetAllKeys() {
  if (_mmkvAvailable && _mmkvInstance) {
    try { return _mmkvInstance.getAllKeys(); } catch {}
  }
  return getAllKeys();
}

// ─── Key-value helpers ───────────────────────────────────────────────────────

function _readMessages(key) {
  try {
    const raw = _kvGet(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function _writeMessages(key, msgs) {
  try {
    _kvSet(key, JSON.stringify(msgs.slice(-MAX_CACHED_MESSAGES)));
  } catch {}
}

/** Whether real MMKV (react-native-mmkv) is available — exposed for diagnostics */
export function isMmkvAvailable() { return _mmkvAvailable; }

// --- Public API ---

// Save/merge messages to local cache
export async function cacheMessages(conversationId, messages) {
  if (!messages?.length) return;
  const filtered = messages.filter(m => m.id && !String(m.id).startsWith('tmp_'));
  if (!filtered.length) return;

  if (isNative) {
    if (!isDbReady()) try { await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 1500))]); } catch {}
    if (isDbReady()) {
      try { await dbSaveMessages(conversationId, filtered); }
      catch (e) { console.warn('[chatCache] dbSaveMessages error:', e?.message); }
    } else {
      console.warn('[chatCache] DB not ready after 1.5s, using MMKV fallback only');
    }
  }

  // Also save to MMKV as fallback
  try {
    const key = `chat_msgs_${conversationId}`;
    const existing = _readMessages(key);
    const merged = mergeMessages(existing, filtered);
    _writeMessages(key, merged);
  } catch {}

  // Web: also save to IndexedDB
  if (Platform.OS === 'web') {
    try { const { webSaveMessages } = require('./localDb'); webSaveMessages(conversationId, filtered); } catch {}
  }
}

// Save a single message to cache
export async function cacheSingleMessage(conversationId, msg) {
  if (!msg?.id || String(msg.id).startsWith('tmp_')) {
    console.warn('[cacheSingleMessage] skipped — no id or tmp id:', msg?.id);
    return;
  }

  // Native: wait for DB if not ready (up to 1s) — iOS cold-start race
  if (isNative) {
    if (!isDbReady()) {
      try { await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 1000))]); } catch {}
    }
    if (isDbReady()) {
      try {
        await dbSaveMessages(conversationId, [msg]);
      } catch (e) {
        console.warn('[cacheSingleMessage] dbSaveMessages FAILED for msg', msg.id, ':', e?.message || e);
      }
    } else {
      console.warn('[cacheSingleMessage] DB not ready — only MMKV will have msg', msg.id);
    }
  }

  // Always write to MMKV/localStorage fallback (works on all platforms)
  const key = `chat_msgs_${conversationId}`;
  try {
    const existing = _readMessages(key);
    const idx = existing.findIndex(m => m.id === msg.id);
    if (idx !== -1) {
      existing[idx] = msg;
    } else {
      existing.push(msg);
    }
    _writeMessages(key, existing);
  } catch (e) {
    console.warn('[cacheSingleMessage] MMKV write FAILED for msg', msg.id, ':', e?.message || e);
  }

  // Web: also append to IndexedDB so the per-message write path matches
  // the batch path (cacheMessages). Without this, a message arriving via
  // WS would only land in localStorage, which has a 5 MB cap and evicts
  // the oldest entries silently. Reopening the chat on web then showed
  // "nothing" for threads past the cap.
  if (Platform.OS === 'web') {
    try {
      const { webSaveMessages } = require('./localDb');
      webSaveMessages(conversationId, [msg]);
    } catch {}
  }
}

// Get cached messages for a conversation (INSTANT from SQLite on native,
// IndexedDB on web, falling back to MMKV/localStorage).
export async function getCachedMessages(conversationId, limit = 50) {
  // Try SQLite first (native) — wait up to 300ms for DB
  if (isNative) {
    if (!isDbReady()) {
      try { await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 300))]); } catch {}
    }
    if (isDbReady()) {
      try {
        const msgs = await dbGetMessages(conversationId, limit);
        if (msgs.length > 0) return msgs;
      } catch {}
    }
  }

  // Web: prefer IndexedDB (no size cap) over localStorage (5 MB hard cap
  // that silently dropped history on long threads). Writes already dual-
  // write to both; this just changes the preferred read source.
  if (Platform.OS === 'web') {
    try {
      const { webGetMessages } = require('./localDb');
      const msgs = await webGetMessages(conversationId);
      if (Array.isArray(msgs) && msgs.length > 0) {
        return msgs.slice(-limit);
      }
    } catch {}
  }

  // Fallback to MMKV (native non-DB) / localStorage (web)
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    return msgs.slice(-limit);
  } catch { return []; }
}

// Get last synced message ID
export async function getLastSyncId(conversationId) {
  // Try SQLite first
  if (isNative && isDbReady()) {
    try {
      const id = await dbGetLastMessageId(conversationId);
      if (id > 0) return id;
    } catch {}
  }

  // Fallback to MMKV
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    if (!msgs.length) return 0;
    return Math.max(...msgs.filter(m => typeof m.id === 'number').map(m => m.id), 0);
  } catch { return 0; }
}

// Cache conversation list
export async function cacheConversations(conversations) {
  if (!conversations?.length) return;

  if (isNative && isDbReady()) {
    try { await dbSaveConversations(conversations); } catch {}
  }

  try {
    setString('chat_conversations', JSON.stringify(conversations.slice(0, 100)));
    if (Platform.OS === 'web') {
      try { const { webSaveConversations } = require('./localDb'); webSaveConversations(conversations.slice(0, 100)); } catch {}
      // Synchronous mirror for instant-paint on next page load. IndexedDB is
      // async-only so without this, the first render still sees an empty
      // list for a few frames. localStorage is capped at ~5 MB; 100 rows
      // fits comfortably.
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('chatyy_convs_v1', JSON.stringify(conversations.slice(0, 100)));
        }
      } catch {}
    }
  } catch {}
}

// Older caches stored members without display_name (backend hadn't been
// filling the column yet), which made the chat list flash "Desconhecido"
// for a beat before the fresh fetch overwrote it. Derive a name from the
// email on read so the stale render is already correct.
function _hydrateConvNames(c) {
  if (!c) return c;
  if (!c.name && !c.display_name) {
    const other = c.other_email || c.contact_email
      || (Array.isArray(c.members) ? (c.members.find(m => m && m.email !== c.currentEmail)?.email) : null);
    if (other && typeof other === 'string' && other.includes('@')) {
      c.name = other.split('@')[0];
    }
  }
  if (Array.isArray(c.members)) {
    c.members = c.members.map(m => {
      if (m && m.email && (!m.display_name || m.display_name === '')) {
        return { ...m, display_name: String(m.email).split('@')[0] };
      }
      return m;
    });
  }
  return c;
}
function _hydrateList(list) {
  return Array.isArray(list) ? list.map(_hydrateConvNames) : list;
}

// Get cached conversations (INSTANT)
export async function getCachedConversations() {
  // Try SQLite first (native) — wait up to 500ms for DB to be ready
  if (isNative) {
    if (!isDbReady()) {
      try { await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 500))]); } catch {}
    }
    if (isDbReady()) {
      try {
        const convs = await dbGetConversations();
        if (convs.length > 0) return _hydrateList(convs);
      } catch {}
    }
  }

  // Web: try IndexedDB first
  if (Platform.OS === 'web') {
    try {
      const { webGetConversations } = require('./localDb');
      const idb = await webGetConversations();
      if (idb && idb.length > 0) return _hydrateList(idb);
    } catch {}
  }

  // Fallback to MMKV
  try {
    const raw = getString('chat_conversations');
    return _hydrateList(raw ? JSON.parse(raw) : []);
  } catch { return []; }
}

// Delete a single message from cache
export async function deleteCachedMessage(conversationId, messageId) {
  if (isNative && isDbReady()) {
    try { await dbDeleteMessage(conversationId, messageId); } catch {}
  }

  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    _writeMessages(key, msgs.filter(m => m.id !== messageId));
  } catch {}
}

// Update a message in cache
export async function updateCachedMessage(conversationId, messageId, updates) {
  if (isNative && isDbReady()) {
    try { await dbUpdateMessage(messageId, updates); } catch {}
  }

  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    const idx = msgs.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], ...updates };
      _writeMessages(key, msgs);
    }
  } catch {}
}

// Clear all chat cache
export async function clearChatCache() {
  try {
    const keys = _kvGetAllKeys().filter(k => k.startsWith('chat_'));
    keys.forEach(k => _kvRemove(k));
  } catch {}
  // Web: also clear the IndexedDB + localStorage mirror so the next user
  // doesn't momentarily see the previous user's conversations.
  if (Platform.OS === 'web') {
    try { const { webClearAll } = require('./localDb'); webClearAll(); } catch {}
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem('chatyy_convs_v1'); } catch {}
  }
  // SQLite cleared separately via dbClearAll()
}

// --- Pending (unsent) message persistence ---

export async function savePendingMessage(conversationId, message) {
  if (isNative && isDbReady()) {
    try { await dbSavePending({ ...message, conversation_id: conversationId }); return; } catch {}
  }
  const key = `chat_pending_${conversationId}`;
  try {
    // Upsert by temp_id — without this, every retry pushes a duplicate
    // row and the next chat-screen mount restores both copies, which
    // surface as a "wandering" duplicate of the same message.
    const existing = _readMessages(key);
    const tid = message.temp_id;
    const filtered = tid ? existing.filter(m => m.temp_id !== tid) : existing;
    filtered.push(message);
    _writeMessages(key, filtered);
  } catch {}
}

export async function getPendingMessages(conversationId) {
  if (isNative && isDbReady()) {
    try { return await dbGetPending(conversationId); } catch {}
  }
  const key = `chat_pending_${conversationId}`;
  try {
    return _readMessages(key);
  } catch { return []; }
}

export async function removePendingMessage(conversationId, tempId) {
  if (isNative && isDbReady()) {
    try { await dbRemovePending(tempId); return; } catch {}
  }
  const key = `chat_pending_${conversationId}`;
  try {
    const existing = _readMessages(key);
    _writeMessages(key, existing.filter(m => m.temp_id !== tempId));
  } catch {}
}

// Clear ALL pending messages for a conversation (called when server confirms messages loaded)
export async function clearPendingMessages(conversationId) {
  // Clear from SQLite
  if (isNative && isDbReady()) {
    try {
      const pending = await dbGetPending(conversationId);
      for (const p of pending) { try { await dbRemovePending(p.temp_id); } catch {} }
    } catch {}
  }
  // Clear from MMKV
  const key = `chat_pending_${conversationId}`;
  try { remove(key); } catch {}
}

export async function getAllPendingMessages() {
  if (isNative && isDbReady()) {
    try { return await dbGetPending(); } catch {}
  }
  try {
    const keys = _kvGetAllKeys().filter(k => k.startsWith('chat_pending_'));
    const results = [];
    for (const key of keys) {
      try { results.push(..._readMessages(key)); } catch {}
    }
    return results;
  } catch { return []; }
}

// One-time migration: purge all pending messages on first app open after this
// code ships. Users with messages stuck in the outbox from past backend bugs
// will have their queue cleared and the wifi-off icon will stop appearing.
// Only runs once per device (guarded by MMKV flag).
export async function purgeAllPendingOnceOnMigration() {
  try {
    const MIGRATION_FLAG = 'chat_pending_purge_v2_done';
    const done = getString(MIGRATION_FLAG);
    if (done === '1') return;
    // Clear all MMKV pending keys
    const keys = _kvGetAllKeys().filter(k => k.startsWith('chat_pending_'));
    for (const key of keys) {
      try { remove(key); } catch {}
    }
    // Clear all SQLite pending (native)
    if (isNative && isDbReady()) {
      try {
        const all = await dbGetPending();
        for (const p of (all || [])) {
          try { await dbRemovePending(p.temp_id); } catch {}
        }
      } catch {}
    }
    setString(MIGRATION_FLAG, '1');
  } catch {}
}

// Purge stale pending messages (>1 hour old) — these are usually from past
// backend bugs that left messages stuck forever in the outbox. Called on
// conversation mount so UI doesn't show wifi-off icon forever.
export async function purgeStalePending(conversationId, maxAgeMs = 3600000) {
  const cutoff = Date.now() - maxAgeMs;
  if (isNative && isDbReady()) {
    try {
      const pending = await dbGetPending(conversationId);
      for (const p of pending) {
        const createdAt = p.created_at ? Date.parse(p.created_at) : 0;
        if (createdAt && createdAt < cutoff) {
          try { await dbRemovePending(p.temp_id); } catch {}
        }
      }
    } catch {}
  }
  const key = `chat_pending_${conversationId}`;
  try {
    const existing = _readMessages(key);
    const fresh = existing.filter(m => {
      const createdAt = m.created_at ? Date.parse(m.created_at) : 0;
      return !createdAt || createdAt >= cutoff;
    });
    if (fresh.length !== existing.length) _writeMessages(key, fresh);
  } catch {}
}

// Telegram-style cache pre-warming. For conversations in the list that
// have no local message cache yet, fetch the last few messages in the
// background and persist them. The user can then tap the conversation
// and see it paint instantly from cache without a loading spinner.
//
// - Non-blocking: returns immediately; work happens on microtasks.
// - Bounded: only the top `topN` unseen conversations, `perConv` msgs each.
// - Rate-limited: concurrency = 2 to avoid hammering the API on cold open.
// - Media pre-fetch: on native, also downloads images/videos so the
//   in-conversation thumbnails don't flash placeholders.
// - Idempotent: a second call for an already-warmed conv is a no-op
//   (getLastSyncId > 0 short-circuits).
let _prewarmRunning = false;
let _prewarmedIds = new Set();
export async function prewarmConversationsCache(conversations, opts = {}) {
  if (_prewarmRunning) return;
  if (!Array.isArray(conversations) || conversations.length === 0) return;
  const topN = Math.max(1, Math.min(opts.topN ?? 10, 25));
  const perConv = Math.max(1, Math.min(opts.perConv ?? 5, 20));
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 4));
  const warmMedia = opts.media !== false && isNative;
  _prewarmRunning = true;
  try {
    const candidates = conversations
      .filter(c => c && c.id && !c.archived && !_prewarmedIds.has(c.id))
      .slice(0, topN);
    if (candidates.length === 0) return;
    let api = null;
    try { api = require('./api'); } catch { return; }
    let mediaCache = null;
    if (warmMedia) { try { mediaCache = require('./mediaCache'); } catch {} }
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const idx = cursor++;
        const conv = candidates[idx];
        try {
          // Skip if we already have cached messages — user opened this
          // conv at least once already, no prewarm needed.
          const lastId = await getLastSyncId(conv.id).catch(() => 0);
          if (lastId > 0) { _prewarmedIds.add(conv.id); continue; }
          const r = await api.chatMessages(conv.id, perConv, null, 0);
          const msgs = r?.data?.messages || [];
          if (Array.isArray(msgs) && msgs.length > 0) {
            await cacheMessages(conv.id, msgs).catch(() => {});
            if (mediaCache) {
              try { mediaCache.saveConversationMedia?.(msgs); } catch {}
            }
          }
          _prewarmedIds.add(conv.id);
        } catch {}
        // Yield to the event loop so the UI stays buttery smooth.
        await new Promise(r => setTimeout(r, 0));
      }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    _prewarmRunning = false;
  }
}

// Helper: merge two arrays of messages by ID, sorted by created_at
function mergeMessages(existing, incoming) {
  const map = new Map();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) if (m.id) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return ta - tb;
  });
}
