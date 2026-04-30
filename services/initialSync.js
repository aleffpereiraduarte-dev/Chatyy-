/**
 * Full Sync — WhatsApp-level: download EVERYTHING to device
 *
 * Phase 1 (0-15%):   Conversations list
 * Phase 2 (15-55%):  Messages for ALL conversations (last 100 each)
 * Phase 3 (55-65%):  Contacts + address book
 * Phase 4 (65-75%):  Emails (last 100 per folder)
 * Phase 5 (75-85%):  Calendar events (next 3 months)
 * Phase 6 (85-92%):  Files/Cloud listing
 * Phase 7 (92-97%):  Profile + settings
 * Phase 8 (97-100%): Media thumbnails pre-cache
 */
import { Platform } from 'react-native';
import { getString, setString, setJSON } from './mmkv';
import { cacheMessages, cacheConversations, getLastSyncId } from './chatCache';
import {
  dbSaveContacts, dbSaveEmails, dbSaveEvents, dbSaveFiles,
  dbSet, dbSetSyncState, isDbReady,
} from './db';
let mailWs = null;
try { mailWs = require('./websocket').default; } catch {}

const SYNC_KEY = 'initial_sync_done';
const SYNC_VERSION_KEY = 'sync_version';
const CURRENT_SYNC_VERSION = 3; // Bump to force re-sync

export function isSyncComplete() {
  const done = getString(SYNC_KEY);
  const version = getString(SYNC_VERSION_KEY);
  return done === 'true' && version === String(CURRENT_SYNC_VERSION);
}

function markSyncComplete() {
  setString(SYNC_KEY, 'true');
  setString(SYNC_VERSION_KEY, String(CURRENT_SYNC_VERSION));
  setString('last_full_sync', new Date().toISOString());
}

function emit(phase, progress = 0) {
  mailWs?._emit?.('sync_progress', { phase, progress });
}

/**
 * Full initial sync — downloads EVERYTHING
 */
export async function runInitialSync(api, options = {}) {
  if (!options.force && isSyncComplete()) {
    return { skipped: true };
  }

  const isNative = Platform.OS !== 'web';
  const stats = { conversations: 0, messages: 0, contacts: 0, emails: 0, events: 0, files: 0 };

  try {
    emit('start', 0);

    // ══════ Phase 1: Conversations (0-15%) ══════
    emit('progress', 2);
    const convResult = await api.chatConversations('', true);
    const allConvs = convResult.success
      ? (Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []))
      : [];
    if (allConvs.length > 0) {
      await cacheConversations(allConvs);
      stats.conversations = allConvs.length;
    }
    emit('progress', 15);

    // ══════ Phase 2: Skip bulk message download (Telegram-style) ══════
    // Messages load on-demand when user opens a conversation.
    // This avoids downloading 100 msgs x N conversations on app start.
    emit('progress', 55);

    // ══════ Phase 3: Contacts (55-65%) ══════
    emit('progress', 56);
    try {
      const contactsResult = await api.getContacts();
      if (contactsResult.success) {
        const contacts = Array.isArray(contactsResult.data)
          ? contactsResult.data
          : (contactsResult.data?.contacts || []);
        setJSON('cached_contacts', contacts);
        if (isNative && isDbReady()) {
          await dbSaveContacts(contacts);
        }
        stats.contacts = contacts.length;
      }
    } catch {}
    emit('progress', 65);

    // ══════ Phase 4: Emails — last 100 per main folder (65-75%) ══════
    emit('progress', 66);
    const folders = ['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash'];
    let foldersDone = 0;
    for (const folder of folders) {
      try {
        const r = await api.getEmails(folder, 1, 200);
        if (r.success) {
          const emails = r.data?.emails || r.data || [];
          if (emails.length > 0 && isNative && isDbReady()) {
            await dbSaveEmails(folder, emails);
            stats.emails += emails.length;
          }
        }
      } catch {}
      foldersDone++;
      emit('progress', 66 + Math.round((foldersDone / folders.length) * 9));
    }
    emit('progress', 75);

    // ══════ Phase 5: Calendar events — next 3 months (75-85%) ══════
    emit('progress', 76);
    try {
      const now = new Date();
      const threeMonths = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const r = await api.getEvents(now.toISOString().slice(0, 10), threeMonths.toISOString().slice(0, 10));
      if (r.success) {
        const events = r.data?.events || r.data || [];
        if (events.length > 0 && isNative && isDbReady()) {
          await dbSaveEvents(events);
          stats.events = events.length;
        }
      }
    } catch {}
    emit('progress', 85);

    // ══════ Phase 6: Files/Cloud listing (85-92%) ══════
    emit('progress', 86);
    try {
      const r = await api.driveList(0, 'date', 'desc', 200);
      if (r.success) {
        const files = r.data?.files || r.data || [];
        if (files.length > 0 && isNative && isDbReady()) {
          await dbSaveFiles(files);
          stats.files = files.length;
        }
      }
    } catch {}
    emit('progress', 92);

    // ══════ Phase 7: Profile + settings (92-97%) ══════
    emit('progress', 93);
    try {
      const profileResult = await api.getProfile();
      if (profileResult.success) {
        setJSON('cached_profile', profileResult.data);
        if (isNative && isDbReady()) {
          await dbSet('user_profile', JSON.stringify(profileResult.data));
        }
      }
    } catch {}

    try {
      const settingsResult = await api.getSettings();
      if (settingsResult.success) {
        setJSON('cached_settings', settingsResult.data);
        if (isNative && isDbReady()) {
          await dbSet('user_settings', JSON.stringify(settingsResult.data));
        }
      }
    } catch {}
    emit('progress', 97);

    // ══════ Phase 7b: Notes (97%) ══════
    try {
      const notesResult = await api.apiCall('notes_list');
      if (notesResult.success) {
        const { saveNotesToCache } = require('./offlineCache');
        await saveNotesToCache(notesResult.data?.notes || notesResult.data || []);
      }
    } catch {}

    // Also save settings to new offline cache
    try {
      const { saveSettingsToCache } = require('./offlineCache');
      const s = await api.getSettings();
      if (s.success) await saveSettingsToCache(s.data);
    } catch {}

    // ══════ Phase 8: Pre-cache media thumbnails (97-100%) ══════
    emit('progress', 98);
    if (isNative) {
      try {
        // Pre-cache avatar URLs for recent conversations
        const { Image } = require('react-native');
        const avatarUrls = allConvs
          .filter(c => c.avatar_url)
          .map(c => c.avatar_url)
          .slice(0, 30);
        avatarUrls.forEach(url => {
          try { Image.prefetch(url); } catch {}
        });
      } catch {}
    }
    emit('progress', 100);

    // Mark sync complete
    markSyncComplete();
    if (isNative && isDbReady()) {
      await dbSetSyncState('full_sync', 0, CURRENT_SYNC_VERSION);
    }

    await new Promise(r => setTimeout(r, 400));
    emit('done', 100);

    console.log('[Sync] Complete:', stats);
    return { success: true, ...stats };

  } catch (err) {
    // emit 'error' so UI pode diferenciar sucesso/falha. Antes emitia
    // 'done' mesmo em erro, mascarando falhas no fluxo de splash/loader.
    emit('error', 0);
    return { error: err.message };
  }
}

/**
 * Delta sync — only new data since last sync
 * Called on: app resume, reconnect, periodic (every 60s)
 */
export async function runDeltaSync(api) {
  const isNative = Platform.OS !== 'web';
  try {
    // 1. Conversations
    const convResult = await api.chatConversations('', false);
    if (convResult.success) {
      const convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
      await cacheConversations(convs);

      // 2. Messages for conversations with unread
      const unread = convs.filter(c => c.unread_count > 0);
      await Promise.all(
        unread.slice(0, 15).map(async (conv) => {
          try {
            const lastId = await getLastSyncId(conv.id);
            if (lastId > 0) {
              const r = await api.chatMessages(conv.id, 50, null, lastId);
              if (r.success) {
                const msgs = Array.isArray(r.data) ? r.data : (r.data?.messages || []);
                if (msgs.length > 0) await cacheMessages(conv.id, msgs);
              }
            }
          } catch {}
        })
      );
    }

    // 3. Contacts refresh (light)
    try {
      const r = await api.getContacts();
      if (r.success) {
        const contacts = Array.isArray(r.data) ? r.data : (r.data?.contacts || []);
        setJSON('cached_contacts', contacts);
        if (isNative && isDbReady()) await dbSaveContacts(contacts);
      }
    } catch {}

  } catch {}
}

/**
 * Reset sync — force re-download
 */
export function resetSync() {
  setString(SYNC_KEY, 'false');
  setString(SYNC_VERSION_KEY, '0');
}
