import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys, getJSON, setJSON } from './mmkv';
import { isConnected as networkIsConnected } from './networkInfo';

// Offline Cache v2 — powered by MMKV (<1ms sync reads)
// Caches: emails, messages, calendar, contacts, files, offline action queue
// Everything persists on device — app works without internet after first sync

const CACHE_PREFIX = 'omc_';
const MAX_EMAILS_PER_FOLDER = 100;
const MAX_CACHED_MESSAGES = 50; // Email messages (not chat — chat uses chatCache.js)
const QUEUE_KEY = CACHE_PREFIX + 'offline_queue';

// ─── Email List Cache ───

export async function saveEmailsToCache(folder, emails) {
  const key = CACHE_PREFIX + 'list_' + folder;
  const sliced = (emails || []).slice(0, MAX_EMAILS_PER_FOLDER);
  setJSON(key, { emails: sliced, ts: Date.now() });
  // Web: also save to IndexedDB for faster access
  if (Platform.OS === 'web') {
    try { const { webSaveEmails } = require('./localDb'); webSaveEmails(folder, sliced); } catch {}
  }
}

export async function getEmailsFromCache(folder) {
  // Web: try IndexedDB first (faster than MMKV shim)
  if (Platform.OS === 'web') {
    try {
      const { webGetEmails } = require('./localDb');
      const idbEmails = await webGetEmails(folder);
      if (idbEmails && idbEmails.length > 0) return idbEmails;
    } catch {}
  }
  const key = CACHE_PREFIX + 'list_' + folder;
  const data = getJSON(key);
  return data?.emails || null;
}

// ─── Profile + Settings Cache (web IndexedDB) ───

export async function saveProfileToCache(profile) {
  if (Platform.OS === 'web') {
    try { const { webCacheSet } = require('./localDb'); await webCacheSet('profile', profile, 86400); } catch {}
  }
  setJSON(CACHE_PREFIX + 'profile', { data: profile, ts: Date.now() });
}

export async function getProfileFromCache() {
  if (Platform.OS === 'web') {
    try { const { webCacheGet } = require('./localDb'); const d = await webCacheGet('profile'); if (d) return d; } catch {}
  }
  const d = getJSON(CACHE_PREFIX + 'profile');
  return d?.data || null;
}

export async function saveContactsToCache(contacts) {
  if (Platform.OS === 'web') {
    try { const { webCacheSet } = require('./localDb'); await webCacheSet('contacts', contacts, 86400); } catch {}
  }
  setJSON(CACHE_PREFIX + 'contacts', { data: (contacts || []).slice(0, 500), ts: Date.now() });
}

export async function getContactsFromCache() {
  if (Platform.OS === 'web') {
    try { const { webCacheGet } = require('./localDb'); const d = await webCacheGet('contacts'); if (d) return d; } catch {}
  }
  const d = getJSON(CACHE_PREFIX + 'contacts');
  return d?.data || null;
}

export async function saveCalendarToCache(events) {
  if (Platform.OS === 'web') {
    try { const { webCacheSet } = require('./localDb'); await webCacheSet('calendar', events, 3600); } catch {}
  }
  setJSON(CACHE_PREFIX + 'calendar', { data: events, ts: Date.now() });
}

export async function getCalendarFromCache() {
  if (Platform.OS === 'web') {
    try { const { webCacheGet } = require('./localDb'); const d = await webCacheGet('calendar'); if (d) return d; } catch {}
  }
  const d = getJSON(CACHE_PREFIX + 'calendar');
  return d?.data || null;
}

export async function saveDriveToCache(files) {
  if (Platform.OS === 'web') {
    try { const { webCacheSet } = require('./localDb'); await webCacheSet('drive', files, 3600); } catch {}
  }
  setJSON(CACHE_PREFIX + 'drive', { data: files, ts: Date.now() });
}

export async function getDriveFromCache() {
  if (Platform.OS === 'web') {
    try { const { webCacheGet } = require('./localDb'); const d = await webCacheGet('drive'); if (d) return d; } catch {}
  }
  const d = getJSON(CACHE_PREFIX + 'drive');
  return d?.data || null;
}

export async function saveNotesToCache(notes) {
  if (Platform.OS === 'web') {
    try { const { webCacheSet } = require('./localDb'); await webCacheSet('notes', notes, 3600); } catch {}
  }
  setJSON(CACHE_PREFIX + 'notes', { data: notes, ts: Date.now() });
}

export async function getNotesFromCache() {
  if (Platform.OS === 'web') {
    try { const { webCacheGet } = require('./localDb'); const d = await webCacheGet('notes'); if (d) return d; } catch {}
  }
  const d = getJSON(CACHE_PREFIX + 'notes');
  return d?.data || null;
}

// ─── Email Message Cache (individual read emails) ───

export async function saveMessageToCache(uid, message) {
  const indexKey = CACHE_PREFIX + 'msg_index';
  const msgKey = CACHE_PREFIX + 'msg_' + uid;
  setJSON(msgKey, message);

  // Maintain LRU index
  let index = getJSON(indexKey) || [];
  index = [uid, ...index.filter(u => u !== uid)];
  if (index.length > MAX_CACHED_MESSAGES) {
    const removed = index.splice(MAX_CACHED_MESSAGES);
    for (const u of removed) remove(CACHE_PREFIX + 'msg_' + u);
  }
  setJSON(indexKey, index);
}

export async function getMessageFromCache(uid) {
  return getJSON(CACHE_PREFIX + 'msg_' + uid);
}

// ─── Calendar Cache ───

export async function saveCalendarEvents(events) {
  setJSON(CACHE_PREFIX + 'calendar_events', { events: (events || []).slice(0, 500), ts: Date.now() });
}

export async function getCachedCalendarEvents() {
  const data = getJSON(CACHE_PREFIX + 'calendar_events');
  return data?.events || null;
}

export async function saveCalendarEvent(event) {
  if (!event?.id) return;
  const data = getJSON(CACHE_PREFIX + 'calendar_events') || { events: [], ts: Date.now() };
  const idx = data.events.findIndex(e => e.id === event.id);
  if (idx >= 0) data.events[idx] = event;
  else data.events.push(event);
  data.ts = Date.now();
  setJSON(CACHE_PREFIX + 'calendar_events', data);
}

export async function deleteCachedCalendarEvent(eventId) {
  const data = getJSON(CACHE_PREFIX + 'calendar_events');
  if (!data?.events) return;
  data.events = data.events.filter(e => e.id !== eventId);
  data.ts = Date.now();
  setJSON(CACHE_PREFIX + 'calendar_events', data);
}

// ─── Contacts Cache ───

export async function saveContacts(contacts) {
  setJSON(CACHE_PREFIX + 'contacts', { contacts: (contacts || []).slice(0, 1000), ts: Date.now() });
}

export async function getCachedContacts() {
  const data = getJSON(CACHE_PREFIX + 'contacts');
  return data?.contacts || null;
}

// ─── Files/Drive Cache ───

export async function saveFiles(folderId, files) {
  const key = CACHE_PREFIX + 'files_' + (folderId || 'root');
  setJSON(key, { files: (files || []).slice(0, 200), ts: Date.now() });
}

export async function getCachedFiles(folderId) {
  const key = CACHE_PREFIX + 'files_' + (folderId || 'root');
  const data = getJSON(key);
  return data?.files || null;
}

// ─── Folders/Labels Cache ───

export async function saveFolders(folders) {
  setJSON(CACHE_PREFIX + 'folders', folders);
}

export async function getCachedFolders() {
  return getJSON(CACHE_PREFIX + 'folders') || null;
}

export async function saveLabels(labels) {
  setJSON(CACHE_PREFIX + 'labels', labels);
}

export async function getCachedLabels() {
  return getJSON(CACHE_PREFIX + 'labels') || null;
}

// ─── User Profile Cache ───

export async function saveProfile(profile) {
  setJSON(CACHE_PREFIX + 'profile', profile);
}

export async function getCachedProfile() {
  return getJSON(CACHE_PREFIX + 'profile') || null;
}

// ─── Offline Action Queue ───
// Actions performed while offline are queued and replayed when back online

export async function queueOfflineAction(action) {
  const queue = getJSON(QUEUE_KEY) || [];
  queue.push({ ...action, ts: Date.now(), id: Date.now() + '_' + Math.random().toString(36).slice(2, 8) });
  setJSON(QUEUE_KEY, queue);
}

export async function getOfflineQueue() {
  return getJSON(QUEUE_KEY) || [];
}

export async function clearOfflineQueue() {
  setJSON(QUEUE_KEY, []);
}

export async function removeFromQueue(actionId) {
  const queue = getJSON(QUEUE_KEY) || [];
  setJSON(QUEUE_KEY, queue.filter(a => a.id !== actionId));
}

export async function replayOfflineQueue(api) {
  const queue = await getOfflineQueue();
  if (!queue.length) return { replayed: 0, failed: 0 };

  let replayed = 0;
  let failed = 0;
  const failedActions = [];

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
        case 'send_email':
          await api.sendEmail(action.payload);
          break;
        case 'chat_send':
          await api.chatSend(action.conversation_id, action.content, action.msgType || 'text', action.reply_to_id);
          break;
        case 'calendar_create':
          await api.calendarCreateEvent(action.payload);
          break;
        case 'calendar_update':
          await api.calendarUpdateEvent(action.eventId, action.payload);
          break;
        case 'calendar_delete':
          await api.calendarDeleteEvent(action.eventId);
          break;
        case 'contact_create':
          await api.createContact(action.payload);
          break;
        case 'contact_update':
          await api.updateContact(action.contactId, action.payload);
          break;
        default:
          console.warn('[Offline] Unknown action type:', action.type);
      }
      replayed++;
    } catch (err) {
      failed++;
      // Keep failed actions for retry (max 3 retries)
      if ((action.retries || 0) < 3) {
        failedActions.push({ ...action, retries: (action.retries || 0) + 1 });
      }
    }
  }

  // Save only failed actions back to queue
  setJSON(QUEUE_KEY, failedActions);
  return { replayed, failed };
}

// ─── Online/Offline Status ───

export function isOnline() {
  if (Platform.OS === 'web') {
    return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  }
  return networkIsConnected();
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

// ─── Cache Stats (for debugging) ───

export function getCacheStats() {
  const keys = getAllKeys();
  const omcKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
  const chatKeys = keys.filter(k => k.startsWith('chat_'));
  return {
    total: keys.length,
    email: omcKeys.filter(k => k.includes('list_') || k.includes('msg_')).length,
    calendar: omcKeys.filter(k => k.includes('calendar')).length,
    contacts: omcKeys.filter(k => k.includes('contacts')).length,
    files: omcKeys.filter(k => k.includes('files')).length,
    chat: chatKeys.length,
    queue: (getJSON(QUEUE_KEY) || []).length,
  };
}
