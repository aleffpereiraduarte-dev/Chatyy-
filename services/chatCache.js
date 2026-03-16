import { Platform } from 'react-native';

// Chat cache using localStorage (web) and AsyncStorage (native)
// Provides local-first messaging: show cached messages instantly, sync only new ones from server

const MAX_CACHED_MESSAGES = 500; // Keep last 500 messages per conversation

let AsyncStorage = null;

async function getAS() {
  if (Platform.OS === 'web') return null;
  if (AsyncStorage) return AsyncStorage;
  try {
    const m = await import('@react-native-async-storage/async-storage');
    AsyncStorage = m.default;
    return AsyncStorage;
  } catch { return null; }
}

function webGet(key) {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function webSet(key, val) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
}

// --- Internal helpers ---

async function _readMessages(key) {
  if (Platform.OS === 'web') {
    try { return JSON.parse(webGet(key) || '[]'); } catch { return []; }
  }
  const as = await getAS();
  if (!as) return [];
  try { return JSON.parse(await as.getItem(key) || '[]'); } catch { return []; }
}

async function _writeMessages(key, msgs) {
  const data = JSON.stringify(msgs.slice(-MAX_CACHED_MESSAGES));
  if (Platform.OS === 'web') {
    webSet(key, data);
    return;
  }
  const as = await getAS();
  if (!as) return;
  try { await as.setItem(key, data); } catch {}
}

// --- Public API ---

// Save/merge messages to local cache (used after fetching from server)
export async function cacheMessages(conversationId, messages) {
  if (!messages?.length) return;
  const key = `chat_msgs_${conversationId}`;
  const filtered = messages.filter(m => m.id && !String(m.id).startsWith('tmp_'));
  if (!filtered.length) return;

  try {
    const existing = await _readMessages(key);
    const merged = mergeMessages(existing, filtered);
    await _writeMessages(key, merged);
  } catch {}
}

// Save a single message to cache (used for WebSocket real-time messages & sent messages)
export async function cacheSingleMessage(conversationId, msg) {
  if (!msg?.id || String(msg.id).startsWith('tmp_')) return;
  const key = `chat_msgs_${conversationId}`;
  try {
    const existing = await _readMessages(key);
    // Check if already cached (avoid duplicates)
    const idx = existing.findIndex(m => m.id === msg.id);
    if (idx !== -1) {
      // Update existing entry (e.g., edited message)
      existing[idx] = msg;
      await _writeMessages(key, existing);
    } else {
      // Append new message
      existing.push(msg);
      await _writeMessages(key, existing);
    }
  } catch {}
}

// Get cached messages for a conversation (INSTANT, no network)
export async function getCachedMessages(conversationId, limit = 50) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = await _readMessages(key);
    return msgs.slice(-limit);
  } catch { return []; }
}

// Get last synced message ID for a conversation
export async function getLastSyncId(conversationId) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = await _readMessages(key);
    if (!msgs.length) return 0;
    return Math.max(...msgs.filter(m => typeof m.id === 'number').map(m => m.id), 0);
  } catch { return 0; }
}

// Cache conversation list
export async function cacheConversations(conversations) {
  if (!conversations?.length) return;
  const data = JSON.stringify(conversations.slice(0, 100));
  if (Platform.OS === 'web') {
    webSet('chat_conversations', data);
    return;
  }
  const as = await getAS();
  if (!as) return;
  try { await as.setItem('chat_conversations', data); } catch {}
}

// Get cached conversations
export async function getCachedConversations() {
  if (Platform.OS === 'web') {
    try { return JSON.parse(webGet('chat_conversations') || '[]'); } catch { return []; }
  }
  const as = await getAS();
  if (!as) return [];
  try { return JSON.parse(await as.getItem('chat_conversations') || '[]'); } catch { return []; }
}

// Delete a single message from cache
export async function deleteCachedMessage(conversationId, messageId) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = await _readMessages(key);
    await _writeMessages(key, msgs.filter(m => m.id !== messageId));
  } catch {}
}

// Update a message in cache (for edits, reactions, etc.)
export async function updateCachedMessage(conversationId, messageId, updates) {
  const key = `chat_msgs_${conversationId}`;
  try {
    const msgs = await _readMessages(key);
    const idx = msgs.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], ...updates };
      await _writeMessages(key, msgs);
    }
  } catch {}
}

// Clear all cache
export async function clearChatCache() {
  if (Platform.OS === 'web') {
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('chat_'));
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
    return;
  }
  const as = await getAS();
  if (!as) return;
  try {
    const allKeys = await as.getAllKeys();
    const chatKeys = allKeys.filter(k => k.startsWith('chat_'));
    if (chatKeys.length) await as.multiRemove(chatKeys);
  } catch {}
}

// Helper: merge two arrays of messages by ID, sorted by created_at
function mergeMessages(existing, incoming) {
  const map = new Map();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) if (m.id) map.set(m.id, m); // incoming overwrites existing (fresher data)
  return Array.from(map.values()).sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return ta - tb;
  });
}
