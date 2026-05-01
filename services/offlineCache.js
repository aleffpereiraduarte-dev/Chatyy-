import { Platform } from 'react-native';
import { getString, setString, remove, getAllKeys, getJSON, setJSON } from './mmkv';
import { isConnected as networkIsConnected } from './networkInfo';

// Offline Cache v2 — powered by MMKV (<1ms sync reads)
// Caches: emails, messages, calendar, contacts, files, offline action queue
// Everything persists on device — app works without internet after first sync

const CACHE_PREFIX = 'omc_';
const MAX_EMAILS_PER_FOLDER = 200;
const MAX_CACHED_MESSAGES = 200; // Email messages (not chat — chat uses chatCache.js)
const QUEUE_KEY = CACHE_PREFIX + 'offline_queue';

// ─── Email List Cache ───

export async function saveEmailsToCache(folder, emails) {
  const key = CACHE_PREFIX + 'list_' + folder;
  const sliced = (emails || []).slice(0, MAX_EMAILS_PER_FOLDER);
  setJSON(key, { emails: sliced, ts: Date.now() });
  // Web: also save to IndexedDB for faster access — await pra que rejeições
  // sejam capturadas pelo try/catch externo em vez de virar UnhandledRejection.
  if (Platform.OS === 'web') {
    try {
      const { webSaveEmails } = require('./localDb');
      await webSaveEmails(folder, sliced);
    } catch {}
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
  // Padroniza pra { data, ts } igual aos outros caches do arquivo —
  // antes salvava { contacts, ts } e os leitores viam undefined.
  setJSON(CACHE_PREFIX + 'contacts', { data: (contacts || []).slice(0, 1000), ts: Date.now() });
}

export async function getCachedContacts() {
  const data = getJSON(CACHE_PREFIX + 'contacts');
  return data?.data || data?.contacts || null;
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

// ─── Notes Cache (individual notes for offline editing) ───

export async function saveNoteToCache(note) {
  if (!note?.id) return;
  const key = CACHE_PREFIX + 'note_' + note.id;
  setJSON(key, { ...note, _cachedAt: Date.now() });
  // Also update the notes list
  const listData = getJSON(CACHE_PREFIX + 'notes');
  if (listData?.data) {
    const idx = listData.data.findIndex(n => n.id === note.id);
    if (idx >= 0) listData.data[idx] = note;
    else listData.data.unshift(note);
    setJSON(CACHE_PREFIX + 'notes', listData);
  }
}

export async function getNoteFromCache(noteId) {
  return getJSON(CACHE_PREFIX + 'note_' + noteId);
}

export async function deleteNoteFromCache(noteId) {
  remove(CACHE_PREFIX + 'note_' + noteId);
  const listData = getJSON(CACHE_PREFIX + 'notes');
  if (listData?.data) {
    listData.data = listData.data.filter(n => n.id !== noteId);
    setJSON(CACHE_PREFIX + 'notes', listData);
  }
}

// ─── Settings Cache (offline changes) ───

export async function saveSettingsToCache(settings) {
  setJSON(CACHE_PREFIX + 'user_settings', { data: settings, ts: Date.now() });
}

export async function getSettingsFromCache() {
  const d = getJSON(CACHE_PREFIX + 'user_settings');
  return d?.data || null;
}

// ─── Drive: Mark files for offline access ───

export async function markFileOffline(fileId, fileData) {
  const key = CACHE_PREFIX + 'offline_file_' + fileId;
  setJSON(key, { ...fileData, _offlineAt: Date.now() });
  // Track offline files list
  const listKey = CACHE_PREFIX + 'offline_files_list';
  const list = getJSON(listKey) || [];
  if (!list.includes(fileId)) list.push(fileId);
  setJSON(listKey, list);
}

export async function getOfflineFile(fileId) {
  return getJSON(CACHE_PREFIX + 'offline_file_' + fileId);
}

export async function getOfflineFilesList() {
  return getJSON(CACHE_PREFIX + 'offline_files_list') || [];
}

export async function removeOfflineFile(fileId) {
  remove(CACHE_PREFIX + 'offline_file_' + fileId);
  const listKey = CACHE_PREFIX + 'offline_files_list';
  const list = getJSON(listKey) || [];
  setJSON(listKey, list.filter(id => id !== fileId));
}

// ─── User Profile Cache ───

export async function saveProfile(profile) {
  // Mesmo wrapper { data, ts } usado por saveProfileToCache no web —
  // antes esta função sobrescrevia o wrapper com objeto cru, dessincronizando.
  setJSON(CACHE_PREFIX + 'profile', { data: profile, ts: Date.now() });
}

export async function getCachedProfile() {
  const d = getJSON(CACHE_PREFIX + 'profile');
  return d?.data ?? d ?? null;
}

// ─── Offline Action Queue ───
// Actions performed while offline are queued and replayed when back online

export async function queueOfflineAction(action) {
  const queue = getJSON(QUEUE_KEY) || [];
  queue.push({ ...action, ts: Date.now(), id: Date.now() + '_' + Math.random().toString(36).slice(2, 8) });
  setJSON(QUEUE_KEY, queue);
}

export async function getOfflineQueue() {
  const queue = getJSON(QUEUE_KEY) || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fresh = queue.filter(a => !a?.ts || a.ts >= cutoff);
  if (fresh.length !== queue.length) setJSON(QUEUE_KEY, fresh);
  return fresh;
}

export async function clearOfflineQueue() {
  setJSON(QUEUE_KEY, []);
}

export async function removeFromQueue(actionId) {
  const queue = getJSON(QUEUE_KEY) || [];
  setJSON(QUEUE_KEY, queue.filter(a => a.id !== actionId));
}

// Cancel a queued chat_send by client_message_id — used when the original
// in-flight request eventually succeeds (late) after we already queued an
// offline retry. Without this the retry replays on the next mount and the
// server sees the same message twice (safe now that we have a UNIQUE index,
// but still wasteful and can flicker the UI).
export async function removeChatSendFromQueueByClientMsgId(clientMsgId) {
  if (!clientMsgId) return;
  const queue = getJSON(QUEUE_KEY) || [];
  const filtered = queue.filter(a =>
    !(a?.type === 'chat_send' && a?.client_message_id === clientMsgId)
  );
  if (filtered.length !== queue.length) setJSON(QUEUE_KEY, filtered);
}

// Global mutex: 3 trigger points (OfflineNotice, conversation mount, send-catch
// handler) all call replayOfflineQueue. Without this lock, two replays can
// read the same queue snapshot and both try to send the same actions —
// server dedup saves us via the UNIQUE client_message_id index, but the
// frontend flickers (success state set twice) and burns network. The mutex
// makes subsequent calls return early until the first one finishes.
let _replayInFlight = null;

export async function replayOfflineQueue(api) {
  if (_replayInFlight) return _replayInFlight;
  _replayInFlight = (async () => {
  const queue = await getOfflineQueue();
  if (!queue.length) return { replayed: 0, failed: 0 };

  // Skip entries whose backoff hasn't elapsed yet. They stay in the queue
  // for the next replay tick (OfflineNotice / mount) so a transient server
  // outage doesn't burn all retries in a 5-second window.
  const now = Date.now();
  const due = queue.filter(a => !a.next_retry_at || a.next_retry_at <= now);
  const notDue = queue.filter(a => a.next_retry_at && a.next_retry_at > now);

  // Replay in chronological order so chat_sends from the same conversation
  // land in the same order the user typed them. Without this a queue that
  // was mutated by partial retries could flip [A,B,C] into [B,C,A] on the
  // server side, confusing the recipient.
  due.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // Put skipped-due-to-backoff entries back in the queue up front so we
  // persist them even if zero actions replay this pass.
  const failedFromBackoff = notDue;

  let replayed = 0;
  let failed = 0;
  const failedActions = [];
  // Once a chat_send fails for a given conversation we skip every later
  // chat_send for that SAME conversation — holding them in failedActions so
  // the next replay pass tries them in order. Prevents message #3 from
  // overtaking message #2 when #2 hits a transient error.
  const blockedConvIds = new Set();

  for (const action of due) {
    if (action.type === 'chat_send' && blockedConvIds.has(action.conversation_id)) {
      failedActions.push(action);
      continue;
    }
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
        case 'chat_audio_upload': {
          // Áudio gravado offline ou com net ruim — tenta subir novamente
          // quando conexão voltar. Só funciona no native (precisa do uri
          // do file system local; web perdeu o blob no reload).
          if (!action.audio_uri) break;
          const filePayload = {
            uri: action.audio_uri,
            name: action.audio_name || 'audio.m4a',
            type: action.audio_type || 'audio/mp4',
          };
          const r = await api.chatUploadFile(
            action.conversation_id,
            filePayload,
            `Audio (${action.duration || 0}s)`,
            false,
            null, // no progress callback in replay
            'audio',
          );
          if (r?.success && r.data) {
            const serverMsg = r.data.message || r.data;
            try {
              const { removePendingMessage, cacheSingleMessage } = require('./chatCache');
              await removePendingMessage(action.conversation_id, action.temp_id).catch(() => {});
              await cacheSingleMessage(action.conversation_id, serverMsg).catch(() => {});
            } catch {}
            try {
              const ws = require('./websocket').default;
              ws?.emit?.('chat_message', {
                conversation_id: action.conversation_id,
                message: serverMsg,
              });
              ws?.relayChatMessage?.(action.conversation_id, serverMsg, action.temp_id, []);
            } catch {}
          } else {
            throw new Error('audio_upload_failed');
          }
          break;
        }
        case 'chat_send': {
          const r = await api.chatSend(
            action.conversation_id,
            action.content,
            action.msgType || 'text',
            action.reply_to_id,
            action.mentions || null,
            null,
            action.temp_id,
            action.client_message_id,
          );
          // Throw em falha pra que a fila mantenha a action para retry —
          // antes ações com r.success=false (sem exception) eram consideradas
          // replayed e sumiam silenciosamente.
          if (!r?.success || !r?.data?.id) throw new Error('chat_send_failed');
          if (r?.success && r.data?.id) {
            const serverMsg = { ...r.data, client_message_id: action.client_message_id };
            // 1. Drop the persisted "pending" entry — without this, the
            //    chat screen restores it on next mount and the user sees
            //    the same message twice (one wandering, one fresh).
            try {
              const { removePendingMessage, cacheSingleMessage } = require('./chatCache');
              await removePendingMessage(action.conversation_id, action.temp_id).catch(() => {});
              await cacheSingleMessage(action.conversation_id, serverMsg).catch(() => {});
            } catch {}
            // 2. Tell any open chat screen to swap its optimistic temp
            //    message for the real one. We piggy-back on the existing
            //    'chat_message' WS listener so we don't have to add a new
            //    code path in chat-conversation.
            try {
              const ws = require('./websocket').default;
              ws?.emit?.('chat_message', {
                conversation_id: action.conversation_id,
                message: serverMsg,
              });
            } catch {}
            // 3. Server-side broadcastChatMessage already fires when
            //    chat_send inserts the row, so we DO NOT relay again here —
            //    a second relay from the sender produced a duplicate bubble
            //    on every recipient (matched by id, but the dedup race
            //    against the canonical broadcast was the original Phase-1
            //    duplication bug). Trust the server fan-out.
          }
          break;
        }
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
        case 'note_create':
          await api.apiCall('notes_create', action.payload, 'POST');
          break;
        case 'note_update':
          await api.apiCall('notes_update', { id: action.noteId, ...action.payload }, 'POST');
          break;
        case 'note_delete':
          await api.apiCall('notes_delete', { id: action.noteId }, 'POST');
          break;
        case 'settings_update':
          await api.apiCall('update_settings', action.payload, 'POST');
          break;
        default:
          break;
      }
      replayed++;
    } catch (err) {
      failed++;
      // Keep failed actions for retry with exponential backoff: retry 1
      // runs immediately, retry 2 needs ≥30s since last attempt, retry 3
      // ≥2min, retry 4 ≥10min, retry 5 ≥45min, then give up after 6. The
      // previous "cap at 3 retries, no delay" burned all retries in the
      // same replay pass whenever the server was briefly down.
      const attempts = (action.retries || 0) + 1;
      if (attempts < 6) {
        const delaysMs = [0, 30000, 120000, 600000, 2700000, 14400000];
        failedActions.push({
          ...action,
          retries: attempts,
          next_retry_at: Date.now() + (delaysMs[attempts] || 0),
        });
      }
      if (action.type === 'chat_send' && action.conversation_id) {
        blockedConvIds.add(action.conversation_id);
      }
    }
  }

  // Save only failed actions + still-backing-off entries back to queue
  setJSON(QUEUE_KEY, [...failedFromBackoff, ...failedActions]);
  return { replayed, failed };
  })().finally(() => { _replayInFlight = null; });
  return _replayInFlight;
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
