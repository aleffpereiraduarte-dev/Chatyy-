/**
 * Chat Cache — SQLite primary (native), MMKV/localStorage fallback (web)
 * Provides local-first messaging: show cached messages instantly, sync only new ones
 *
 * Native: SQLite (expo-sqlite) — indexed, queryable, handles 100k+ messages
 * Web: MMKV (localStorage) — simple key-value, max 1000 msgs per conversation
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
const MAX_CACHED_MESSAGES = 1000; // MMKV limit (web only)

// --- MMKV helpers (web fallback) ---

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

// Save/merge messages to local cache
export async function cacheMessages(conversationId, messages) {
  if (!messages?.length) return;
  const filtered = messages.filter(m => m.id && !String(m.id).startsWith('tmp_'));
  if (!filtered.length) return;

  if (isNative) {
    if (!isDbReady()) try { await Promise.race([waitForDb(), new Promise(r => setTimeout(r, 300))]); } catch {}
    if (isDbReady()) try { await dbSaveMessages(conversationId, filtered); } catch {}
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
  if (!msg?.id || String(msg.id).startsWith('tmp_')) return;

  if (isNative && isDbReady()) {
    try { await dbSaveMessages(conversationId, [msg]); } catch {}
  }

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

// Get cached messages for a conversation (INSTANT from SQLite)
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

  // Fallback to MMKV
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
    }
  } catch {}
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
        if (convs.length > 0) return convs;
      } catch {}
    }
  }

  // Web: try IndexedDB first
  if (Platform.OS === 'web') {
    try {
      const { webGetConversations } = require('./localDb');
      const idb = await webGetConversations();
      if (idb && idb.length > 0) return idb;
    } catch {}
  }

  // Fallback to MMKV
  try {
    const raw = getString('chat_conversations');
    return raw ? JSON.parse(raw) : [];
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
    const keys = getAllKeys().filter(k => k.startsWith('chat_'));
    keys.forEach(k => remove(k));
  } catch {}
  // SQLite cleared separately via dbClearAll()
}

// --- Pending (unsent) message persistence ---

export async function savePendingMessage(conversationId, message) {
  if (isNative && isDbReady()) {
    try { await dbSavePending({ ...message, conversation_id: conversationId }); return; } catch {}
  }
  const key = `chat_pending_${conversationId}`;
  try {
    const existing = _readMessages(key);
    existing.push(message);
    _writeMessages(key, existing);
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

export async function getAllPendingMessages() {
  if (isNative && isDbReady()) {
    try { return await dbGetPending(); } catch {}
  }
  try {
    const keys = getAllKeys().filter(k => k.startsWith('chat_pending_'));
    const results = [];
    for (const key of keys) {
      try { results.push(..._readMessages(key)); } catch {}
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
