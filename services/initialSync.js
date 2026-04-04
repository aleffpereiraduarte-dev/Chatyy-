/**
 * Initial Sync — WhatsApp-style full download on first login
 * Downloads ALL conversations + recent messages to local cache
 * Shows progress bar via WebSocket events
 * After initial sync, only delta-syncs new messages
 */
import { Platform } from 'react-native';
import { getString, setString, getJSON, setJSON } from './mmkv';
import { cacheMessages, cacheConversations, cacheSingleMessage, getLastSyncId } from './chatCache';
import mailWs from './websocket';

const SYNC_KEY = 'initial_sync_done';
const SYNC_VERSION_KEY = 'sync_version';
const CURRENT_SYNC_VERSION = 2; // Bump to force re-sync

// Check if initial sync has been completed
export function isSyncComplete() {
  const done = getString(SYNC_KEY);
  const version = getString(SYNC_VERSION_KEY);
  return done === 'true' && version === String(CURRENT_SYNC_VERSION);
}

// Mark sync as complete
function markSyncComplete() {
  setString(SYNC_KEY, 'true');
  setString(SYNC_VERSION_KEY, String(CURRENT_SYNC_VERSION));
  setString('last_full_sync', new Date().toISOString());
}

// Emit sync progress to SyncBar component
function emitProgress(phase, progress = 0) {
  mailWs._emit('sync_progress', { phase, progress });
}

/**
 * Run initial sync — downloads all conversations + messages
 * @param {object} api - API module with chatConversations, chatMessages etc.
 * @param {object} options - { force: boolean }
 */
export async function runInitialSync(api, options = {}) {
  if (!options.force && isSyncComplete()) {
    return { skipped: true };
  }

  try {
    emitProgress('start', 0);

    // Step 1: Download all conversations (10%)
    emitProgress('progress', 5);
    const convResult = await api.chatConversations('', true);
    if (!convResult.success) {
      emitProgress('done', 100);
      return { error: 'Failed to fetch conversations' };
    }

    const allConvs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
    await cacheConversations(allConvs);
    emitProgress('progress', 15);

    // Step 2: Download messages for each conversation (15% → 90%)
    const total = allConvs.length;
    let done = 0;

    // Download in batches of 5 to not overload
    const BATCH_SIZE = 5;
    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = allConvs.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (conv) => {
          try {
            const lastId = await getLastSyncId(conv.id);
            const msgResult = await api.chatMessages(conv.id, 50, lastId);
            if (msgResult.success) {
              const msgs = Array.isArray(msgResult.data) ? msgResult.data : (msgResult.data?.messages || []);
              if (msgs.length > 0) {
                await cacheMessages(conv.id, msgs);
              }
            }
          } catch {}
          done++;
          const pct = 15 + Math.round((done / total) * 75);
          emitProgress('progress', Math.min(pct, 90));
        })
      );
    }

    // Step 3: Cache user profile + contacts (90% → 95%)
    emitProgress('progress', 92);
    try {
      const profileResult = await api.getProfile();
      if (profileResult.success) {
        setJSON('cached_profile', profileResult.data);
      }
    } catch {}

    try {
      const contactsResult = await api.getContacts();
      if (contactsResult.success) {
        const contacts = Array.isArray(contactsResult.data) ? contactsResult.data : (contactsResult.data?.contacts || []);
        setJSON('cached_contacts', contacts);
      }
    } catch {}

    // Done!
    emitProgress('progress', 100);
    markSyncComplete();

    // Small delay so user sees 100%
    await new Promise(r => setTimeout(r, 500));
    emitProgress('done', 100);

    return { success: true, conversations: total, messages: done };

  } catch (err) {
    emitProgress('done', 100);
    return { error: err.message };
  }
}

/**
 * Delta sync — only fetch new messages since last sync
 * Called on app resume / reconnect
 */
export async function runDeltaSync(api) {
  try {
    // Fetch conversations to update list
    const convResult = await api.chatConversations('', false);
    if (!convResult.success) return;

    const convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
    await cacheConversations(convs);

    // For conversations with unread messages, fetch new messages
    const unread = convs.filter(c => c.unread_count > 0);
    await Promise.all(
      unread.slice(0, 10).map(async (conv) => {
        try {
          const lastId = await getLastSyncId(conv.id);
          if (lastId > 0) {
            const msgResult = await api.chatMessages(conv.id, 50, lastId);
            if (msgResult.success) {
              const msgs = Array.isArray(msgResult.data) ? msgResult.data : (msgResult.data?.messages || []);
              if (msgs.length > 0) {
                await cacheMessages(conv.id, msgs);
              }
            }
          }
        } catch {}
      })
    );
  } catch {}
}

/**
 * Reset sync state — forces full re-sync on next open
 */
export function resetSync() {
  setString(SYNC_KEY, 'false');
  setString(SYNC_VERSION_KEY, '0');
}
