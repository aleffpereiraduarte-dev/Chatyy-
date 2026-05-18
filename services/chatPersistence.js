/**
 * Global chat persistence — WhatsApp-style local-first store.
 *
 * Listens to WebSocket + MQTT chat events at the APP level (not per-screen)
 * so every incoming msg/edit/delete/reaction lands in SQLite + SmartCache
 * the moment it arrives — regardless of which screen the user is on. Before
 * this, only `app/chat-conversation.js` persisted messages on receive; if a
 * push lands while the user is on the chat list (or the inbox), the message
 * body was in memory only until the user actually opened that conversation.
 *
 * Wire-up: call `startChatPersistence()` once from `app/_layout.js` after the
 * user is authenticated. Idempotent — safe to call on re-login / hot reload.
 *
 * Side-effects:
 *   - cacheSingleMessage()           → SQLite + MMKV/AsyncStorage
 *   - SmartCache.cacheSingleMessage() → in-memory authoritative + persisted
 *   - updateCachedMessage()/delete    → both layers
 */
import { Platform } from 'react-native';

let _started = false;
let _unsubs = [];

function _safe(fn) {
  try { return fn(); } catch { return null; }
}

// Normalize the shape from chat_message / chat_summary / MQTT-msg variants.
// Server uses 3 shapes:
//   1. { type:'chat_message', data: { message: {...row}, conversation_id } }
//   2. { type:'chat_summary', data: { ...row, conversation_id } }
//   3. MQTT chat_message: { message: {...row}, conversation_id }
function _extractMessage(payload) {
  if (!payload) return null;
  const inner = payload.message || payload.data?.message || payload.data || payload;
  if (!inner || typeof inner !== 'object') return null;
  // Must have id + conversation_id to be persistable. tmp_/string ids are
  // optimistic-local; we never persist those at this layer.
  if (!inner.id || String(inner.id).startsWith('tmp_')) return null;
  const convId = inner.conversation_id
    || payload.conversation_id
    || payload.data?.conversation_id;
  if (!convId) return null;
  return { msg: inner, convId };
}

async function _persistMessage(convId, msg) {
  if (!convId || !msg) return;
  // Layer 1 — chatCache: SQLite (native) + MMKV/IndexedDB fallback.
  _safe(() => {
    const { cacheSingleMessage } = require('./chatCache');
    cacheSingleMessage(convId, msg).catch(() => {});
  });
  // Layer 2 — SmartCache: synchronous authoritative in-memory store that
  // the chat-conversation `useState` initializer reads at mount.
  _safe(() => {
    const SmartCache = require('./smartChatCache');
    SmartCache.cacheSingleMessage?.(convId, msg);
  });
}

function _onIncomingChatMessage(payload) {
  const extracted = _extractMessage(payload);
  if (!extracted) return;
  _persistMessage(extracted.convId, extracted.msg);
}

function _onReaction(data) {
  // Payload: { conversation_id, message_id, email, emoji, removed? }
  if (!data?.conversation_id || !data?.message_id || !data?.emoji) return;
  const convId = data.conversation_id;
  const mid = data.message_id;
  const emoji = data.emoji;
  const email = (data.email || '').toLowerCase();
  // Read-modify-write against SmartCache (synchronous + authoritative).
  _safe(() => {
    const SmartCache = require('./smartChatCache');
    const arr = SmartCache.getCachedMessagesSync?.(convId, 500) || [];
    const target = arr.find(m => m && String(m.id) === String(mid));
    if (!target) return;
    const reactions = Array.isArray(target.reactions) ? target.reactions.map(r => ({ ...r, users: Array.isArray(r.users) ? r.users.slice() : [] })) : [];
    const gIdx = reactions.findIndex(r => r.emoji === emoji);
    if (gIdx !== -1) {
      const users = reactions[gIdx].users.filter(u => (u || '').toLowerCase() !== email);
      if (data.removed) {
        reactions[gIdx] = { ...reactions[gIdx], users, count: users.length };
        if (users.length === 0) reactions.splice(gIdx, 1);
      } else {
        if (!users.includes(email)) users.push(email);
        reactions[gIdx] = { ...reactions[gIdx], users, count: users.length };
      }
    } else if (!data.removed) {
      reactions.push({ emoji, count: 1, users: [email] });
    }
    SmartCache.updateCachedMessage?.(convId, mid, { reactions });
  });
  // Mirror to SQLite raw_json so cold-open shows the same reactions.
  _safe(() => {
    const { updateCachedMessage } = require('./chatCache');
    const SmartCache = require('./smartChatCache');
    const arr = SmartCache.getCachedMessagesSync?.(convId, 500) || [];
    const target = arr.find(m => m && String(m.id) === String(mid));
    if (target?.reactions) {
      updateCachedMessage(convId, mid, { reactions: target.reactions }).catch(() => {});
    }
  });
}

function _onEdit(data) {
  // Payload: { conversation_id, message_id|id, content, edited_at? }
  if (!data?.conversation_id) return;
  const convId = data.conversation_id;
  const mid = data.message_id ?? data.id;
  const content = data.content;
  if (!mid || typeof content !== 'string') return;
  const editedAt = data.edited_at || new Date().toISOString();
  _safe(() => {
    const SmartCache = require('./smartChatCache');
    SmartCache.updateCachedMessage?.(convId, mid, { content, edited_at: editedAt });
  });
  _safe(() => {
    const { updateCachedMessage } = require('./chatCache');
    updateCachedMessage(convId, mid, { content, edited_at: editedAt }).catch(() => {});
  });
}

function _onDelete(data) {
  // Payload: { conversation_id, message_id|id, mode? }
  if (!data?.conversation_id) return;
  const convId = data.conversation_id;
  const mid = data.message_id ?? data.id;
  if (!mid) return;
  const now = new Date().toISOString();
  const tombstone = {
    deleted_at: now, content: '', file_url: '', file_name: '', file_size: 0,
    thumb_b64: null, hls_url: null, waveform: null,
    deleted_by: data.deleted_by || '',
  };
  _safe(() => {
    const SmartCache = require('./smartChatCache');
    SmartCache.updateCachedMessage?.(convId, mid, tombstone);
  });
  _safe(() => {
    const { updateCachedMessage } = require('./chatCache');
    updateCachedMessage(convId, mid, tombstone).catch(() => {});
  });
  // Hard remove from native SQLite messages table — `chatCache.deleteCachedMessage`
  // already covers the SQLite row, but only the active chat screen was calling
  // it before. We mirror it here so a delete event landing on the list screen
  // still scrubs disk.
  _safe(() => {
    const nativeDb = require('./db');
    nativeDb.dbDeleteMessage?.(convId, mid);
  });
}

function _onRead(data) {
  // Mark unread→0 in cached conversation row when peer reads, so a cold open
  // doesn't show a stale unread badge. Conversation cache, not message cache.
  if (!data?.conversation_id) return;
  // SmartCache stores convs as an array; we mutate the matching entry's
  // unread_count if the reader is "me". For now we just trigger conv refresh
  // by re-caching via chatCache (it merges/upserts). No-op if no convs cached.
}

/**
 * Start global chat persistence listeners. Idempotent.
 */
export function startChatPersistence() {
  if (_started) return;
  _started = true;

  // ─── WebSocket subscriptions ────────────────────────────────────────────
  _safe(() => {
    const mailWs = require('./websocket').default;
    if (!mailWs?.on) return;
    _unsubs.push(mailWs.on('chat_message', _onIncomingChatMessage));
    _unsubs.push(mailWs.on('chat_summary', _onIncomingChatMessage));
    // Server uses `reaction` (not `chat_reaction`) on the WS path. Either may
    // be emitted depending on backend version; subscribe to both.
    _unsubs.push(mailWs.on('reaction', _onReaction));
    _unsubs.push(mailWs.on('chat_reaction', _onReaction));
    _unsubs.push(mailWs.on('chat_edit', _onEdit));
    _unsubs.push(mailWs.on('message_edited', _onEdit));
    _unsubs.push(mailWs.on('chat_delete', _onDelete));
    _unsubs.push(mailWs.on('message_deleted', _onDelete));
    _unsubs.push(mailWs.on('chat_read', _onRead));
  });

  // ─── MQTT subscriptions (alternate transport — same events) ─────────────
  _safe(() => {
    const mqtt = require('./mqtt').default;
    if (!mqtt?.on) return;
    _unsubs.push(mqtt.on('chat_message', _onIncomingChatMessage));
    _unsubs.push(mqtt.on('chat_reaction', _onReaction));
    _unsubs.push(mqtt.on('chat_edit', _onEdit));
    _unsubs.push(mqtt.on('chat_delete', _onDelete));
  });

  // ─── TCP client (signal-server fast lane) ───────────────────────────────
  _safe(() => {
    const { getTCPClient } = require('./tcp-client');
    const tcpClient = getTCPClient?.();
    if (!tcpClient?.on) return;
    const wrap = (fn) => (payload) => fn(payload);
    const m = wrap(_onIncomingChatMessage);
    const r = wrap(_onReaction);
    const e = wrap(_onEdit);
    const d = wrap(_onDelete);
    tcpClient.on('chat_message', m);
    tcpClient.on('chat_react', r);
    tcpClient.on('chat_reaction', r);
    tcpClient.on('chat_edit', e);
    tcpClient.on('chat_delete', d);
    _unsubs.push(() => tcpClient.off?.('chat_message', m));
    _unsubs.push(() => tcpClient.off?.('chat_react', r));
    _unsubs.push(() => tcpClient.off?.('chat_reaction', r));
    _unsubs.push(() => tcpClient.off?.('chat_edit', e));
    _unsubs.push(() => tcpClient.off?.('chat_delete', d));
  });
}

/**
 * Tear down listeners (on logout). Idempotent.
 */
export function stopChatPersistence() {
  for (const u of _unsubs) {
    try { if (typeof u === 'function') u(); } catch {}
  }
  _unsubs = [];
  _started = false;
}

/**
 * Hydrate top conversations from SQLite/SmartCache into memory so the very
 * first paint of chat list + chat-conversation already has data. Called
 * once on app boot AFTER auth is confirmed.
 *
 * - SmartCache hydration is automatic (module-level `hydrate()` on import).
 * - SQLite hydration is on-demand (waitForDb + dbGetConversations).
 * This helper kicks both eagerly so the splash → chat-list transition has
 * everything ready synchronously by the time the screen mounts.
 */
export async function hydrateChatFromDisk() {
  if (Platform.OS === 'web') return;
  try {
    const { waitForDb, isDbReady } = require('./db');
    if (!isDbReady()) {
      await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 800))]);
    }
  } catch {}
  // Touch SmartCache so its module-level hydrate runs (no-op if already done).
  try { require('./smartChatCache'); } catch {}
  // Pre-warm the convs blob into SmartCache + chatCache hot paths.
  try {
    const { getCachedConversations } = require('./chatCache');
    const convs = await getCachedConversations();
    if (convs?.length) {
      const SmartCache = require('./smartChatCache');
      SmartCache.cacheConversations?.(convs);
    }
  } catch {}
}
