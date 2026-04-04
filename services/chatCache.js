import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys } from './mmkv';

// Chat cache using MMKV (native, <1ms sync) and localStorage (web)
// Provides local-first messaging: show cached messages instantly, sync only new ones from server
//
// MMKV is 10-50x faster than AsyncStorage:
//   AsyncStorage: 10-50ms per read (async, JSON file I/O)
//   MMKV: <1ms per read (sync, memory-mapped)

const MAX_CACHED_MESSAGES = 1000; // Keep last 1000 messages per conversation in MMKV

// --- Internal helpers ---

function _readMessages(key) {
  try {
    const raw = getString(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function _writeMessages(key, msgs) {
  try {
    setString(key, JSON.stringify(msgs.slice(-MAX_CACHED_MESSAGES)));
  } catch {}
}

// --- Public API ---

// Save/merge messages to local cache (used after fetching from server)
export async function cacheMessages(conversationId, messages) {
  if (!messages?.length) return;
  const key = `chat_msgs_${conversationId}`;
  const filtered = messages.filter(m => m.id && !String(m.id).startsWith('tmp_'));
  if (!filtered.length) return;

  try {
    const existing = _readMessages(key);
    const merged = mergeMessages(existing, filtered);
    _writeMessages(key, merged);
  } catch {}
  // Web: also save to IndexedDB for faster access
  if (Platform.OS === 'web') {
    try { const { webSaveMessages } = require('./localDb'); webSaveMessages(conversationId, filtered); } catch {}
  }
}

// Save a single message to cache (used for WebSocket real-time messages & sent messages)
export async function cacheSingleMessage(conversationId, msg) {
  if (!msg?.id || String(msg.id).startsWith('tmp_')) return;
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
  } catch {}
}

// Get cached messages for a conversation (INSTANT, <1ms with MMKV)
export async function getCachedMessages(conversationId, limit = 50) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    return msgs.slice(-limit);
  } catch { return []; }
}

// Get last synced message ID for a conversation
export async function getLastSyncId(conversationId) {
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
  try {
    setString('chat_conversations', JSON.stringify(conversations.slice(0, 100)));
    // Web: also save to IndexedDB
    if (Platform.OS === 'web') {
      try { const { webSaveConversations } = require('./localDb'); webSaveConversations(conversations.slice(0, 100)); } catch {}
    }
  } catch {}
}

// Get cached conversations (INSTANT)
export async function getCachedConversations() {
  // Web: try IndexedDB first
  if (Platform.OS === 'web') {
    try {
      const { webGetConversations } = require('./localDb');
      const idb = await webGetConversations();
      if (idb && idb.length > 0) return idb;
    } catch {}
  }
  try {
    const raw = getString('chat_conversations');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Delete a single message from cache
export async function deleteCachedMessage(conversationId, messageId) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = _readMessages(key);
    _writeMessages(key, msgs.filter(m => m.id !== messageId));
  } catch {}
}

// Update a message in cache (for edits, reactions, etc.)
export async function updateCachedMessage(conversationId, messageId, updates) {
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
    const keys = getAllKeys().filter(k => k.startsWith('chat_'));
    keys.forEach(k => remove(k));
  } catch {}
}

// --- Pending (unsent) message persistence ---

export async function savePendingMessage(conversationId, message) {
  const key = `chat_pending_${conversationId}`;
  try {
    const existing = _readMessages(key);
    existing.push(message);
    _writeMessages(key, existing);
  } catch {}
}

export async function getPendingMessages(conversationId) {
  const key = `chat_pending_${conversationId}`;
  try {
    return _readMessages(key);
  } catch { return []; }
}

export async function removePendingMessage(conversationId, tempId) {
  const key = `chat_pending_${conversationId}`;
  try {
    const existing = _readMessages(key);
    _writeMessages(key, existing.filter(m => m.temp_id !== tempId));
  } catch {}
}

export async function getAllPendingMessages() {
  try {
    const keys = getAllKeys().filter(k => k.startsWith('chat_pending_'));
    const results = [];
    for (const key of keys) {
      try {
        results.push(..._readMessages(key));
      } catch {}
    }
    return results;
  } catch { return []; }
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
