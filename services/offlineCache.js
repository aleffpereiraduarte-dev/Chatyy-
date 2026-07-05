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

// [2026-06-14] FIX "(sem conteúdo)" PERSISTENTE no iOS — causa raiz achada por
// 4 agentes: builds VELHOS (<10/06, antes do fallback Rust-vazio→PHP) gravavam
// CORPO VAZIO no cache de mensagem. Depois, mesmo com o app novo, o leitor caía
// nesse cache envenenado e mostrava "(sem conteúdo)" pra SEMPRE (MMKV sobrevive
// a updates, TTL longo, sem invalidação). Web não tinha o bug (não usa esse cache).
//
// Defesa em 3 camadas (tudo JS → entrega por OTA + embutido no build):
//  1. NUNCA servir uma entrada de cache sem corpo (vira cache-miss → rebusca).
//  2. NUNCA gravar uma entrada sem corpo (não re-envenena).
//  3. Purga ÚNICA de todo o cache de mensagem no 1º boot do bundle novo, pra
//     limpar entradas já envenenadas de imediato (não esperar lazy).
function _msgHasBody(m) {
  if (!m || typeof m !== 'object') return false;
  const d = m.data && typeof m.data === 'object' ? m.data : m; // tolera {data:{}} ou shape plano
  const html = String(d.body_html || d.html || '').trim();
  const text = String(d.body_text || d.body_plain || d.body || d.text || '').trim();
  const att = Array.isArray(d.attachments) && d.attachments.length > 0;
  return !!(html || text || att);
}

// Purga única — roda no load do módulo. Limpa TODAS as entradas msg_* (inclui
// msg_index) quando a versão do cache muda, eliminando o envenenamento legado.
(function _purgePoisonedMsgCacheOnce() {
  try {
    const VER_KEY = CACHE_PREFIX + 'msgcache_ver';
    const CUR = '2'; // bump aqui sempre que precisar forçar nova limpeza
    if (getString(VER_KEY) === CUR) return;
    const keys = getAllKeys() || [];
    for (const k of keys) {
      if (typeof k === 'string' && k.indexOf(CACHE_PREFIX + 'msg_') === 0) remove(k);
    }
    setString(VER_KEY, CUR);
  } catch {}
})();

// ─── Account namespacing ───
// Email caches (list + message bodies) MUST be scoped to the active account.
// Without this, account A's inbox rows / message bodies paint under account B
// after a switch (both accounts wrote to the same `list_INBOX` / `msg_<uid>`
// keys). We derive the namespace lazily from api.getActiveAccountEmail() —
// lazy require avoids a circular import at module load (api.js does not import
// this file at top level). Falls back to `_noacct` when no account is active
// so a logged-out read never collides with a signed-in one.
function _acctNS() {
  try {
    const { getActiveAccountEmail } = require('./api');
    const e = getActiveAccountEmail && getActiveAccountEmail();
    return e ? String(e).toLowerCase() : '_noacct';
  } catch { return '_noacct'; }
}
function _listKey(folder) { return CACHE_PREFIX + 'list_' + _acctNS() + '_' + folder; }
function _msgKey(uid) { return CACHE_PREFIX + 'msg_' + _acctNS() + '_' + uid; }
function _msgIndexKey() { return CACHE_PREFIX + 'msg_index_' + _acctNS(); }
// Web IDB folder scoping: prefix the folder name so account A's INBOX blob in
// IndexedDB can't be served to account B.
function _webFolder(folder) { return _acctNS() + '::' + folder; }

// Purge ALL email caches (list + message bodies + index) for EVERY account.
// Called on logout / account switch so the outgoing identity's inbox and
// bodies can't leak into the next account on this device.
export function purgeEmailCaches() {
  try {
    const keys = getAllKeys() || [];
    for (const k of keys) {
      if (typeof k !== 'string') continue;
      if (k.indexOf(CACHE_PREFIX + 'list_') === 0 ||
          k.indexOf(CACHE_PREFIX + 'msg_') === 0) {
        remove(k);
      }
    }
  } catch {}
  if (Platform.OS === 'web') {
    try { require('./localDb').webClearAll?.(); } catch {}
  }
}

// ─── Email List Cache ───

export async function saveEmailsToCache(folder, emails) {
  const key = _listKey(folder);
  const sliced = (emails || []).slice(0, MAX_EMAILS_PER_FOLDER);
  setJSON(key, { emails: sliced, ts: Date.now() });
  // Web: also save to IndexedDB for faster access — await pra que rejeições
  // sejam capturadas pelo try/catch externo em vez de virar UnhandledRejection.
  if (Platform.OS === 'web') {
    try {
      const { webSaveEmails } = require('./localDb');
      await webSaveEmails(_webFolder(folder), sliced);
    } catch {}
  }
}

export async function getEmailsFromCache(folder) {
  // Web: try IndexedDB first (faster than MMKV shim)
  if (Platform.OS === 'web') {
    try {
      const { webGetEmails } = require('./localDb');
      const idbEmails = await webGetEmails(_webFolder(folder));
      if (idbEmails && idbEmails.length > 0) return idbEmails;
    } catch {}
  }
  const key = _listKey(folder);
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
  const indexKey = _msgIndexKey();
  const msgKey = _msgKey(uid);
  // NÃO cachear corpo vazio — senão envenena e mostra "(sem conteúdo)" pra sempre.
  // Se já existir uma entrada (possivelmente envenenada), remove.
  if (!_msgHasBody(message)) {
    remove(msgKey);
    let idx = getJSON(indexKey) || [];
    const filtered = idx.filter(u => u !== uid);
    if (filtered.length !== idx.length) setJSON(indexKey, filtered);
    return;
  }
  setJSON(msgKey, message);

  // Maintain LRU index (per-account)
  let index = getJSON(indexKey) || [];
  index = [uid, ...index.filter(u => u !== uid)];
  if (index.length > MAX_CACHED_MESSAGES) {
    const removed = index.splice(MAX_CACHED_MESSAGES);
    for (const u of removed) remove(_msgKey(u));
  }
  setJSON(indexKey, index);
}

export async function getMessageFromCache(uid) {
  const key = _msgKey(uid);
  const m = getJSON(key);
  // Entrada SEM corpo é lixo (envenenamento legado) → trata como cache-miss e
  // remove, pra forçar rebusca do servidor (que sempre traz o corpo via PHP).
  if (!_msgHasBody(m)) {
    if (m) remove(key);
    return null;
  }
  return m;
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

// 7d TTL — WhatsApp keeps unsent indefinitely, but at some point a stuck
// action (server schema changed, recipient deleted, etc.) is dead weight.
// 7 days matches WhatsApp's media-resend window and the user's mental model
// for "I sent that last week and it never went". Anything older is dropped
// silently — the optimistic bubble already flipped to ❗ at attempt 5.
const OFFLINE_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getOfflineQueue() {
  const queue = getJSON(QUEUE_KEY) || [];
  const cutoff = Date.now() - OFFLINE_QUEUE_TTL_MS;
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
        case 'chat_voice_upload': {
          // WhatsApp-grade voice note offline send. User recorded while
          // offline (or while WS was reconnecting). The audio file lives
          // in documentDirectory/outbox/voice/ so it survived a kill.
          // Once uploaded successfully we delete the outbox copy and
          // persist the server's canonical message into chatCache so the
          // bubble flips from optimistic to delivered.
          if (!action.audio_uri) {
            const e = new Error('voice_uri_missing');
            e.isHardError = true;
            throw e;
          }
          const filePayload = {
            uri: action.audio_uri,
            name: action.audio_name || 'voice.m4a',
            type: action.audio_type || 'audio/mp4',
          };
          let r;
          try {
            r = await api.chatUploadFile(
              action.conversation_id,
              filePayload,
              `Voice (${action.duration || 0}s)`,
              false, // view_once disabled for voice
              null,
              'voice',
            );
          } catch (uploadErr) {
            const m = String(uploadErr?.message || '');
            // 404/410 — outbox file gone (user cleared cache between
            // record and net-up). Hard fail; user will see red ❗.
            if (/\b40[49]\b|\b410\b|gone|not.?found/i.test(m)) {
              uploadErr.isHardError = true;
            }
            throw uploadErr;
          }
          if (r?.success && r.data) {
            const serverMsg = r.data.message || r.data;
            try {
              const { removePendingMessage, cacheSingleMessage } = require('./chatCache');
              await removePendingMessage(action.conversation_id, action.temp_id).catch(() => {});
              await cacheSingleMessage(action.conversation_id, serverMsg).catch(() => {});
            } catch {}
            // Persist server-side waveform peaks alongside the cached
            // audio so future renders paint instantly. The server may
            // have recomputed peaks from the file even if we passed
            // an inline waveform via chat_voice_session_finalize.
            try {
              const { setVoiceWaveform, cacheVoiceMessage, removeOutboxVoice } = require('./audioCache');
              const peaks = serverMsg.wave_peaks || serverMsg.waveform || action.waveform;
              if (Array.isArray(peaks)) setVoiceWaveform(serverMsg.file_url, peaks, serverMsg.id);
              // Adopt the just-uploaded local file as the canonical
              // cache for the new remote URL so we don't waste bytes
              // re-downloading what we already have on disk.
              if (serverMsg.file_url) {
                const mc = require('./mediaCache');
                if (typeof mc.adoptLocalFileAsCache === 'function') {
                  mc.adoptLocalFileAsCache(serverMsg.file_url, action.audio_uri).catch(() => {});
                }
                // Also fire the official prefetch so the syncIndex
                // entry is registered for both list + bubble consumers.
                cacheVoiceMessage(serverMsg.file_url, serverMsg.id, peaks).catch(() => {});
              }
              // Cleanup outbox file — successfully uploaded, no longer
              // needed. Free the bytes from documentDirectory.
              await removeOutboxVoice(action.audio_uri).catch(() => {});
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
            const m = String(r?.message || r?.error || '');
            const isHard = /too large|size|mime|rejected|blocked|forbidden|\b413\b|\b415\b|\b403\b/i.test(m);
            const err = new Error(m || 'voice_upload_failed');
            if (isHard) err.isHardError = true;
            throw err;
          }
          break;
        }
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
            !!action.view_once,
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
            // Classify hard failures (too large / bad mime / 4xx) so the replay
            // queue DROPS them instead of retrying forever (parity with the
            // chat_voice_upload + chat_file_upload cases).
            const m = String(r?.message || r?.error || '');
            const isHard = /too large|size|mime|rejected|blocked|forbidden|\b413\b|\b415\b|\b403\b/i.test(m);
            const err = new Error(m || 'audio_upload_failed');
            if (isHard) err.isHardError = true;
            throw err;
          }
          break;
        }
        case 'chat_file_upload': {
          // Foto/vídeo/file que falhou no upload original — replay quando
          // rede voltar. Mesmo pattern do chat_audio_upload. Antes media
          // ficava como _failed e era perdida se o user fechasse o app
          // antes de tocar no balão vermelho. Só funciona no native: o
          // uri local (file://...) sobrevive a reload, mas no web o blob
          // URL morre quando a aba fecha — nesse caso o action vai falhar
          // permanentemente e o usuário tem que re-anexar o arquivo.
          if (!action.uri) {
            // Sem uri salvável (ex: blob revoke pós-reload) é hard error —
            // não adianta retry. Marca pra ser dropado do queue.
            const e = new Error('file_uri_missing');
            e.isHardError = true;
            throw e;
          }
          const filePayload = {
            uri: action.uri,
            name: action.name || 'file',
            type: action.file_type || '',
          };
          let r;
          try {
            r = await api.chatUploadFile(
              action.conversation_id,
              filePayload,
              action.caption || '',
              !!action.view_once,
              null, // no progress callback in replay
              action.msg_type || undefined,
            );
          } catch (uploadErr) {
            // 404/410 = arquivo sumiu do device (user limpou cache, ou web
            // perdeu o blob no reload). Nada que retry resolva — marca
            // hard error pra removeFromQueue logo abaixo.
            const m = String(uploadErr?.message || '');
            if (/\b40[49]\b|\b410\b|gone|not.?found/i.test(m)) {
              uploadErr.isHardError = true;
            }
            throw uploadErr;
          }
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
            // Server respondeu mas sem success — pode ser permanente
            // (413 size too large, 415 mime rejected) ou transitório.
            const m = String(r?.message || r?.error || '');
            const isHard = /too large|size|mime|rejected|blocked|forbidden|\b413\b|\b415\b|\b403\b/i.test(m);
            const err = new Error(m || 'file_upload_failed');
            if (isHard) err.isHardError = true;
            throw err;
          }
          break;
        }
        case 'chat_send': {
          // Network-down hardening: on a dead/captive network api.chatSend()
          // can hang indefinitely (no fetch timeout) — the optimistic bubble
          // then stays stuck on "Enviando..." forever with no red tap-to-retry,
          // because neither the success path nor markFailed ever fires. Race
          // the call against a 5s timeout so a hang is treated identically to
          // a thrown error: it falls into the catch below (which schedules a
          // backoff retry) AND, critically, flips the messageOutbox state to
          // 'failed' so SendStatusText shows the tap-to-retry affordance.
          let r;
          try {
            r = await Promise.race([
              api.chatSend(
                action.conversation_id,
                action.content,
                action.msgType || 'text',
                action.reply_to_id,
                action.mentions || null,
                null,
                action.temp_id,
                action.client_message_id,
              ),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('chat_send_timeout')), 5000)
              ),
            ]);
          } catch (sendErr) {
            // Surface the failure to the SQLite outbox state machine so the
            // bubble can flip from "Enviando..." to the red retry state — the
            // catch handler below only re-queues for backoff, it doesn't touch
            // messageOutbox. markFailed is idempotent (no-op if no such row).
            if (action.client_message_id) {
              try {
                const outbox = require('./messageOutbox');
                outbox.markFailed?.(action.client_message_id, sendErr);
              } catch {}
            }
            throw sendErr;
          }
          // Throw em falha pra que a fila mantenha a action para retry —
          // antes ações com r.success=false (sem exception) eram consideradas
          // replayed e sumiam silenciosamente.
          if (!r?.success || !r?.data?.id) {
            if (action.client_message_id) {
              try {
                const outbox = require('./messageOutbox');
                outbox.markFailed?.(action.client_message_id, new Error('chat_send_failed'));
              } catch {}
            }
            throw new Error('chat_send_failed');
          }
          if (r?.success && r.data?.id) {
            const serverMsg = { ...r.data, client_message_id: action.client_message_id };
            // 0. Flip the SQLite outbox row to 'sent' (✓). The replay path
            //    delivered the message but never told messageOutbox, so the
            //    optimistic "Enviando..." bubble stayed a zombie forever AND
            //    the sendWorker could re-send the same row. markSent is
            //    idempotent — a no-op when there's no matching outbox row
            //    (e.g. the send originated purely from the MMKV queue).
            if (action.client_message_id) {
              try {
                const outbox = require('./messageOutbox');
                await outbox.markSent?.(action.client_message_id, serverMsg.id);
              } catch {}
            }
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
        case 'chat_read': {
          // Read receipt — mark conversation as read on server. WhatsApp blue
          // double check. Hard errors (conv not found / no permission) just
          // drop the action; transient errors throw to trigger retry.
          if (!action.conversation_id) break;
          try {
            // [read-id fix] When the offline fallback carried the specific
            // message_id (markReadUpTo), replay with chatRead(conv, id) so the
            // server's last_read_message_id advances to that exact row — the
            // conversation-wide chatReadAck loses the watermark and can let the
            // peer's blue ticks regress. Fall back to chatReadAck when no id.
            const r = action.message_id
              ? await api.chatRead(action.conversation_id, action.message_id)
              : await api.chatReadAck(action.conversation_id);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|permission|invalid|forbidden/i.test(msg);
              if (/not_found/i.test(msg)) {
                // Conversation was deleted (other device / server purge). Drop
                // it from the chat-list cache too so the stale unread badge
                // clears instead of lingering forever pointing at a dead conv.
                try { require('./chatCache').removeConversationFromCache?.(action.conversation_id); } catch {}
              }
              if (!isHardError) throw new Error('chat_read_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|permission|forbidden/i.test(msg);
            if (/not_found/i.test(msg)) {
              try { require('./chatCache').removeConversationFromCache?.(action.conversation_id); } catch {}
            }
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_react': {
          // Emoji / sticker reaction replay. message_id required; emoji OR
          // sticker_url determines payload shape.
          if (!action.message_id) break;
          try {
            const r = await api.chatReact(
              action.message_id,
              action.emoji || null,
              action.sticker_url || null,
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              // "already exists" / "duplicate" = the reaction already landed
              // (e.g. the original request actually succeeded before we queued
              // the offline retry). Retrying forever is pointless — treat it
              // as a hard error and drop the action.
              const isHardError = /not_found|invalid|permission|forbidden|too_long|already.?exists|duplicate/i.test(msg);
              if (!isHardError) throw new Error('chat_react_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            if (/already.?exists|duplicate/i.test(msg)) {
              // Mark as hard so the outer catch drops it from the queue rather
              // than scheduling another doomed retry.
              e.isHardError = true;
            }
            const isHardError = /not_found|invalid|permission|forbidden|too_long|already.?exists|duplicate/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_delete': {
          // Delete-for-everyone / delete-for-me replay. message_id + mode
          // required. Mirrors chat_react: hard errors drop the action,
          // transient errors throw to trigger retry. Server dedups a repeat
          // delete (already-deleted row is a no-op), so replay is safe.
          if (!action.message_id) break;
          try {
            const r = await api.chatDelete(
              action.message_id,
              action.mode || 'for_all',
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
              if (!isHardError) throw new Error('chat_delete_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_edit': {
          // Edit-message replay. message_id + content required (content is the
          // already-encrypted envelope when E2E is on). Mirrors chat_react.
          if (!action.message_id || action.content == null) break;
          try {
            const r = await api.chatEdit(action.message_id, action.content);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
              if (!isHardError) throw new Error('chat_edit_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_forward_multi': {
          // WhatsApp-style multi-target forward replay. message_id +
          // conversation_ids required. Mirrors chat_react: hard errors drop the
          // action, transient errors throw to trigger retry. Server clones
          // idempotently per (origin, target) so replay is safe.
          const convIds = Array.isArray(action.conversation_ids) ? action.conversation_ids : [];
          if (!action.message_id || convIds.length === 0) break;
          try {
            const r = await api.chatForwardMulti(
              action.message_id,
              convIds,
              { hideOrigin: !!action.hide_origin },
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
              if (!isHardError) throw new Error('chat_forward_multi_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_forward': {
          // Single-target forward replay. message_id + conversation_id required.
          if (!action.message_id || !action.conversation_id) break;
          try {
            const r = await api.chatForward(
              action.message_id,
              action.conversation_id,
              { hideOrigin: !!action.hide_origin },
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
              if (!isHardError) throw new Error('chat_forward_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired|window/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_star_message': {
          // Favorite/unfavorite a single message. Star intent persists across
          // crashes via the queue.
          if (!action.message_id) break;
          try {
            const r = await api.chatStarMessage(
              action.message_id,
              action.star ? true : false,
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|permission|forbidden|invalid/i.test(msg);
              if (!isHardError) throw new Error('chat_star_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|permission|forbidden|invalid/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_pin': {
          // Pin a conversation (chat-list pin, not the message-pin variant).
          if (!action.conversation_id) break;
          try {
            const r = await api.chatPin(
              action.conversation_id,
              action.message_id || null,
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|permission|forbidden|invalid|limit/i.test(msg);
              if (!isHardError) throw new Error('chat_pin_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|permission|forbidden|invalid|limit/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'chat_pin_message': {
          // Pin a specific message in a conversation (WhatsApp-style, 24h/7d/30d).
          if (!action.message_id) break;
          try {
            const r = await api.chatPinMessage(
              action.message_id,
              action.duration_seconds || null,
            );
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|permission|forbidden|invalid|limit/i.test(msg);
              if (!isHardError) throw new Error('chat_pin_message_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|permission|forbidden|invalid|limit/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'status_react': {
          // Private emoji reaction on a story. Hard errors (not_found = story
          // expired / deleted, invalid emoji) drop silently; transient errors
          // retry with backoff. Author only sees who reacted, viewer already
          // got optimistic feedback so a silent drop is acceptable here.
          const p = action.params || {};
          if (!p.status_id || !p.emoji) break;
          try {
            const r = await api.statusReact(p.status_id, p.emoji);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired/i.test(msg);
              if (!isHardError) throw new Error('status_react_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'status_reply_dm': {
          // Instagram-style DM reply to a story. Backend opens/reuses direct
          // conversation, drops a status_reply card. Hard errors = story gone;
          // transient = retry. We don't try to reconstruct the chatSend
          // fallback path here (UI already did optimistic snackbar).
          const p = action.params || {};
          if (!p.status_id || !p.content) break;
          try {
            const r = await api.statusReplyDM(p.status_id, p.content);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|invalid|permission|forbidden|expired/i.test(msg);
              if (!isHardError) throw new Error('status_reply_dm_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|invalid|permission|forbidden|expired/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'status_view': {
          // View receipt — idempotent on the server (UNIQUE on
          // (status_id, viewer_email)). If already viewed the row insert is a
          // no-op; transient errors retry, hard errors drop silently.
          const p = action.params || {};
          if (!p.status_id) break;
          try {
            const r = await api.statusView(p.status_id);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|already|duplicate|invalid|permission|forbidden|expired/i.test(msg);
              if (!isHardError) throw new Error('status_view_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|already|duplicate|invalid|permission|forbidden|expired/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'feed_like': {
          // Toggle like on a feed post or reel (same endpoint). Server is
          // idempotent-ish: each call flips the like state, so we coalesce
          // by ID at queue insertion time on the caller side. Here we just
          // replay once. Hard errors = post deleted; transient = retry.
          const p = action.params || {};
          if (!p.id) break;
          try {
            const r = await api.feedLike(p.id);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|deleted|invalid|permission|forbidden/i.test(msg);
              if (!isHardError) throw new Error('feed_like_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|deleted|invalid|permission|forbidden/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'feed_comment': {
          // Comment on a feed post / reel. Content + optional reply_to_id +
          // optional media (sticker/gif). Hard errors (post gone, banned,
          // content too long) drop silently — the optimistic comment row
          // in the UI is not rolled back here since FeedComments already
          // catches and removes it.
          const p = action.params || {};
          if (!p.post_id) break;
          try {
            const r = await api.feedComment(p.post_id, p.content || '', p.reply_to_id, {
              mediaUrl: p.media_url || p.attachment_url,
              mediaType: p.media_type,
            });
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|deleted|invalid|permission|forbidden|too_long|banned/i.test(msg);
              if (!isHardError) throw new Error('feed_comment_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|deleted|invalid|permission|forbidden|too_long|banned/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'feed_bookmark': {
          // Toggle bookmark on a reel/post. Server flips state per call —
          // same idempotency caveat as feed_like (caller should de-dup at
          // queue time). Hard errors = post gone.
          const p = action.params || {};
          if (!p.id) break;
          try {
            const r = await api.feedBookmark(p.id);
            if (r && r.success === false) {
              const msg = String(r.message || r.error || '');
              const isHardError = /not_found|deleted|invalid|permission|forbidden/i.test(msg);
              if (!isHardError) throw new Error('feed_bookmark_failed:' + msg);
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isHardError = /not_found|deleted|invalid|permission|forbidden/i.test(msg);
            if (!isHardError) throw e;
          }
          break;
        }
        case 'notification_action': {
          // User tapped a lockscreen / notification-shade action (archive,
          // mark-read, delete, chat_read) while offline. The system UI
          // already dismissed the notification — without this retry the
          // server-side state stays stale forever.
          const params = action.params || {};
          const at = action.action_type;
          if (!at) break;
          try {
            switch (at) {
              case 'archive':
                await api.moveEmail(params.uid, 'Archive', params.folder || 'INBOX');
                break;
              case 'move':
                await api.moveEmail(params.uid, params.destination || 'Archive', params.folder || 'INBOX');
                break;
              case 'mark_read':
                await api.markRead(params.uid, params.folder || 'INBOX');
                break;
              case 'delete':
                await api.deleteEmail(params.uid, params.folder || 'INBOX');
                break;
              case 'chat_read': {
                if (!params.conversation_id) break;
                const r = await api.chatReadAck(params.conversation_id);
                if (r && r.success === false) {
                  const msg = String(r.message || r.error || '');
                  const isHardError = /not_found|permission|forbidden|invalid/i.test(msg);
                  if (!isHardError) throw new Error('notif_chat_read_failed:' + msg);
                }
                break;
              }
              default:
                // Unknown notification action_type — drop silently. A
                // future client version may have queued something this
                // build doesn't recognize.
                break;
            }
          } catch (e) {
            const msg = String(e?.message || e || '');
            // 404 = email/conversation gone (user deleted on another
            // device, or the uid was stale). Don't burn retries.
            const isHardError = /\b40[34]\b|not_found|permission|forbidden|invalid|gone/i.test(msg);
            if (isHardError) {
              e.isHardError = true;
              throw e;
            }
            throw e;
          }
          break;
        }
        default:
          break;
      }
      replayed++;
    } catch (err) {
      failed++;
      // Hard error sinal vindo do case (ex: chat_file_upload 404/410,
      // 413 too large, 415 mime rejected). Não tem retry que resolva —
      // dropa da fila silenciosamente em vez de bater no servidor pra
      // sempre. Ainda chama emitSendFail pro balão refletir o estado.
      if (err && err.isHardError) {
        if (action.type === 'chat_file_upload' && action.temp_id) {
          try {
            const evt = require('./sendFailEvents');
            evt.emitSendFail?.(action.conversation_id, action.temp_id, action.client_message_id);
          } catch {}
        }
        continue;
      }
      // WhatsApp-style retry: keep retrying indefinitely with exponential
      // backoff capped at 1h. After 5 attempts the bubble flips to red ❗
      // (so the user can see it failed and tap to retry immediately) but
      // the action STAYS in the queue so subsequent reconnects/foreground
      // events still replay it. The previous code dropped after 6 attempts,
      // silently losing the message. WhatsApp never gives up on its own —
      // only the user's "delete" action removes a failed message.
      const attempts = (action.retries || 0) + 1;
      // 429 special-case: server rate-limit (60 sends/min). Don't burn retry
      // attempts on something that ONLY needs us to slow down. Wait at least
      // 60s then resume the normal cadence. Detect via err message containing
      // 429 or "Sending too fast" (text from chat.php rate limiter).
      const errMsg = String(err?.message || err || '');
      const isRateLimit = /\b429\b|too fast|rate.?limit/i.test(errMsg);
      // Backoff: 0s, 30s, 2min, 10min, 30min, 1h, 1h, 1h... — never drop
      const delaysMs = [0, 30000, 120000, 600000, 1800000, 3600000];
      const delay = isRateLimit
        ? Math.max(60000, delaysMs[Math.min(attempts, delaysMs.length - 1)])
        : delaysMs[Math.min(attempts, delaysMs.length - 1)];
      failedActions.push({
        ...action,
        retries: attempts,
        next_retry_at: Date.now() + delay,
        // Mark as "permanently failing" once we hit attempt 5 so the UI
        // can show ❗ + tap-to-retry. Doesn't remove from queue.
        permanent_fail: attempts >= 5,
      });
      // Surface to chat-conversation listeners so the bubble flips visual.
      if (attempts >= 5 && action.type === 'chat_send' && action.temp_id) {
        try {
          const evt = require('../services/sendFailEvents');
          evt.emitSendFail?.(action.conversation_id, action.temp_id, action.client_message_id);
        } catch {}
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
