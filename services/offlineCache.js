import { Platform } from 'react-native';

const CACHE_PREFIX = 'omc_';
const MAX_EMAILS_PER_FOLDER = 100;
const MAX_CACHED_MESSAGES = 20;
const QUEUE_KEY = CACHE_PREFIX + 'offline_queue';

// --- Storage abstraction ---
let _asyncStorage = null;
async function getAS() {
  if (Platform.OS === 'web') return null;
  if (!_asyncStorage) {
    try { _asyncStorage = (await import('@react-native-async-storage/async-storage')).default; } catch {}
  }
  return _asyncStorage;
}

async function setItem(key, value) {
  const json = JSON.stringify(value);
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(key, json); } catch {}
  } else {
    const as = await getAS();
    if (as) await as.setItem(key, json);
  }
}

async function getItem(key) {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } else {
      const as = await getAS();
      if (!as) return null;
      const v = await as.getItem(key);
      return v ? JSON.parse(v) : null;
    }
  } catch { return null; }
}

// --- Email list cache ---

export async function saveEmailsToCache(folder, emails) {
  const key = CACHE_PREFIX + 'list_' + folder;
  const sliced = (emails || []).slice(0, MAX_EMAILS_PER_FOLDER);
  await setItem(key, { emails: sliced, ts: Date.now() });
}

export async function getEmailsFromCache(folder) {
  const key = CACHE_PREFIX + 'list_' + folder;
  const data = await getItem(key);
  return data?.emails || null;
}

// --- Message cache ---

export async function saveMessageToCache(uid, message) {
  const indexKey = CACHE_PREFIX + 'msg_index';
  const msgKey = CACHE_PREFIX + 'msg_' + uid;

  await setItem(msgKey, message);

  // Maintain LRU index
  let index = (await getItem(indexKey)) || [];
  index = [uid, ...index.filter(u => u !== uid)];
  if (index.length > MAX_CACHED_MESSAGES) {
    const removed = index.splice(MAX_CACHED_MESSAGES);
    for (const u of removed) {
      await setItem(CACHE_PREFIX + 'msg_' + u, null);
    }
  }
  await setItem(indexKey, index);
}

export async function getMessageFromCache(uid) {
  const msgKey = CACHE_PREFIX + 'msg_' + uid;
  return await getItem(msgKey);
}

// --- Offline action queue ---

export async function queueOfflineAction(action) {
  const queue = (await getItem(QUEUE_KEY)) || [];
  queue.push({ ...action, ts: Date.now() });
  await setItem(QUEUE_KEY, queue);
}

export async function getOfflineQueue() {
  return (await getItem(QUEUE_KEY)) || [];
}

export async function clearOfflineQueue() {
  await setItem(QUEUE_KEY, []);
}

export async function replayOfflineQueue(api) {
  const queue = await getOfflineQueue();
  if (!queue.length) return { replayed: 0 };

  let replayed = 0;
  for (const action of queue) {
    try {
      switch (action.type) {
        case 'delete':
          await api.deleteEmail(action.uid, action.folder);
          break;
        case 'move':
          await api.moveEmail(action.uid, action.toFolder, action.fromFolder);
          break;
        case 'markRead':
          await api.markRead(action.uid, action.folder);
          break;
        case 'markUnread':
          await api.markUnread(action.uid, action.folder);
          break;
        case 'star':
          await api.toggleStar(action.uid, action.folder);
          break;
        case 'archive':
          await api.moveEmail(action.uid, 'Archive', action.folder);
          break;
      }
      replayed++;
    } catch {}
  }

  await clearOfflineQueue();
  return { replayed };
}

// --- Online/offline status ---

export function isOnline() {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    return navigator.onLine !== false;
  }
  return true; // Assume online for mobile (NetInfo handles this separately)
}

export function onOnlineStatusChange(callback) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
