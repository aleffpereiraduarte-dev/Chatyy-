import { Platform } from 'react-native';

// Chat cache using localStorage (web) and AsyncStorage (native)
// SQLite can be added later with a native build for better performance

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

// Save messages to local cache
export async function cacheMessages(conversationId, messages) {
  if (!messages?.length) return;
  const key = `chat_msgs_${conversationId}`;
  const filtered = messages.filter(m => m.id && !String(m.id).startsWith('tmp_'));
  if (!filtered.length) return;

  if (Platform.OS === 'web') {
    try {
      const existing = JSON.parse(webGet(key) || '[]');
      const merged = mergeMessages(existing, filtered);
      webSet(key, JSON.stringify(merged.slice(-200)));
    } catch {}
    return;
  }
  const as = await getAS();
  if (!as) return;
  try {
    const existing = JSON.parse(await as.getItem(key) || '[]');
    const merged = mergeMessages(existing, filtered);
    await as.setItem(key, JSON.stringify(merged.slice(-200)));
  } catch {}
}

// Get cached messages for a conversation
export async function getCachedMessages(conversationId, limit = 50) {
  const key = `chat_msgs_${conversationId}`;
  if (Platform.OS === 'web') {
    try {
      return JSON.parse(webGet(key) || '[]').slice(-limit);
    } catch { return []; }
  }
  const as = await getAS();
  if (!as) return [];
  try {
    const msgs = JSON.parse(await as.getItem(key) || '[]');
    return msgs.slice(-limit);
  } catch { return []; }
}

// Get last synced message ID for a conversation
export async function getLastSyncId(conversationId) {
  const msgs = await getCachedMessages(conversationId, 1000);
  if (!msgs.length) return 0;
  return Math.max(...msgs.filter(m => typeof m.id === 'number').map(m => m.id), 0);
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
  if (Platform.OS === 'web') {
    try {
      const msgs = JSON.parse(webGet(key) || '[]');
      webSet(key, JSON.stringify(msgs.filter(m => m.id !== messageId)));
    } catch {}
    return;
  }
  const as = await getAS();
  if (!as) return;
  try {
    const msgs = JSON.parse(await as.getItem(key) || '[]');
    await as.setItem(key, JSON.stringify(msgs.filter(m => m.id !== messageId)));
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
  for (const m of incoming) if (m.id) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return ta - tb;
  });
}
