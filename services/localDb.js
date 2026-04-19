// Chatyy Local Database — instant offline data (like WhatsApp)
// Web: IndexedDB (fast, large storage, queryable)
// Native: expo-sqlite (iOS/Android)
// All public functions work on any platform

import { Platform } from 'react-native';

// ═══════════════════════════════════════════
// IndexedDB Layer (Web) — cache everything locally
// ═══════════════════════════════════════════
const IDB_NAME = 'chatyy_v2';
const IDB_VERSION = 3;
let _idb = null;

function getIDB() {
  if (_idb) return Promise.resolve(_idb);
  if (Platform.OS !== 'web' || typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('emails')) {
          const s = d.createObjectStore('emails', { keyPath: '_cid' });
          s.createIndex('folder', 'folder', { unique: false });
        }
        if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('messages')) {
          const s = d.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('cid', 'conversation_id', { unique: false });
        }
        if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', { keyPath: 'email' });
      };
      req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// Web cache: set/get with TTL
export async function webCacheSet(key, data, ttlSec = 300) {
  if (Platform.OS !== 'web') return;
  try {
    const d = await getIDB();
    if (!d) return;
    const tx = d.transaction('cache', 'readwrite');
    tx.objectStore('cache').put({ key, data, exp: Date.now() + ttlSec * 1000 });
  } catch {}
}

export async function webCacheGet(key) {
  if (Platform.OS !== 'web') return null;
  try {
    const d = await getIDB();
    if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('cache', 'readonly').objectStore('cache').get(key);
      req.onsuccess = () => {
        const e = req.result;
        r(e && e.exp > Date.now() ? e.data : null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// Web: save/get emails by folder
export async function webSaveEmails(folder, emails) {
  if (Platform.OS !== 'web') return;
  try {
    const d = await getIDB();
    if (!d) return;
    const tx = d.transaction('emails', 'readwrite');
    const s = tx.objectStore('emails');
    emails.forEach(e => s.put({ ...e, folder, _cid: folder + ':' + (e.uid || e.id), _ts: Date.now() }));
  } catch {}
}

export async function webGetEmails(folder) {
  if (Platform.OS !== 'web') return null;
  try {
    const d = await getIDB();
    if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('emails', 'readonly').objectStore('emails').index('folder').getAll(folder);
      req.onsuccess = () => {
        const emails = req.result;
        // Stale-while-revalidate: return cached emails always; caller pulls
        // the latest from IMAP and diffs.
        if (emails?.length > 0) r(emails);
        else r(null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// Web: save/get conversations
export async function webSaveConversations(convs) {
  if (Platform.OS !== 'web') return;
  try {
    const d = await getIDB();
    if (!d) return;
    const tx = d.transaction('conversations', 'readwrite');
    convs.forEach(c => tx.objectStore('conversations').put({ ...c, _ts: Date.now() }));
  } catch {}
}

export async function webGetConversations() {
  if (Platform.OS !== 'web') return null;
  try {
    const d = await getIDB();
    if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('conversations', 'readonly').objectStore('conversations').getAll();
      req.onsuccess = () => {
        const c = req.result;
        if (c?.length > 0) {
          // SWR pattern: always return cached rows even if >5min old. Stale
          // data beats a blank screen on reload; the caller fires a
          // background revalidate against the API anyway. The previous TTL
          // gate is what made the web feel "always loading".
          r(c.sort((a, b) => new Date(b.last_message_at || b.updated_at) - new Date(a.last_message_at || a.updated_at)));
        } else r(null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// Web: save/get messages for conversation
export async function webSaveMessages(convId, msgs) {
  if (Platform.OS !== 'web') return;
  try {
    const d = await getIDB();
    if (!d) return;
    const tx = d.transaction('messages', 'readwrite');
    msgs.forEach(m => tx.objectStore('messages').put({ ...m, conversation_id: convId, _ts: Date.now() }));
  } catch {}
}

export async function webGetMessages(convId) {
  if (Platform.OS !== 'web') return null;
  try {
    const d = await getIDB();
    if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('messages', 'readonly').objectStore('messages').index('cid').getAll(convId);
      req.onsuccess = () => {
        const m = req.result;
        // Return cached rows regardless of age — caller does a fresh fetch
        // to backfill anything new. Showing 2-day-old messages while we
        // revalidate is still better UX than a blank thread.
        //
        // Sort by created_at so temp (string id) and server (number id) rows
        // interleave correctly. `a.id - b.id` returned NaN for mixed types,
        // which left messages in insertion order and produced out-of-order
        // threads after an optimistic send was persisted.
        if (m?.length > 0) {
          r(m.sort((a, b) => {
            const ta = Date.parse(a.created_at || 0) || 0;
            const tb = Date.parse(b.created_at || 0) || 0;
            if (ta !== tb) return ta - tb;
            const na = Number(a.id), nb = Number(b.id);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a.id).localeCompare(String(b.id));
          }));
        } else r(null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// Web: clear all
export async function webClearAll() {
  if (Platform.OS !== 'web') return;
  try { indexedDB.deleteDatabase(IDB_NAME); _idb = null; } catch {}
}

// ═══════════════════════════════════════════
// SQLite Layer (Native) — original code below
// ═══════════════════════════════════════════

let db = null;
let _initPromise = null;
let _initialized = false;

// ---------------------------------------------------------------------------
// 1. Database Setup
// ---------------------------------------------------------------------------

export async function initLocalDb() {
  if (Platform.OS === 'web') return;
  if (_initialized && db) return;
  if (_initPromise) return _initPromise;

  _initPromise = _doInit();
  try {
    await _initPromise;
  } finally {
    _initPromise = null;
  }
}

async function _doInit() {
  try {
    if (Platform.OS === 'web') return;
    const SQLite = require('expo-sqlite');
    // Timeout: if SQLite doesn't open in 3s, give up (native module may not exist in this build)
    const dbPromise = SQLite.openDatabaseAsync('chatyy.db');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('SQLite timeout')), 3000));
    db = await Promise.race([dbPromise, timeoutPromise]);
    await _createTables();
    _initialized = true;
  } catch (e) {
    console.warn('[localDb] init failed (using AsyncStorage fallback):', e?.message || e);
    db = null;
  }
}

async function _ensureDb() {
  if (db) return;
  if (_initPromise) {
    await _initPromise;
    if (db) return;
  }
  // Attempt init if not yet started
  if (!_initialized) {
    await initLocalDb();
    if (db) return;
  }
  throw new Error('localDb not initialized');
}

// ---------------------------------------------------------------------------
// 2. Create Tables
// ---------------------------------------------------------------------------

async function _createTables() {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      name TEXT,
      type TEXT,
      last_message_content TEXT,
      last_message_at TEXT,
      unread_count INTEGER DEFAULT 0,
      avatar_url TEXT,
      members TEXT,
      updated_at TEXT,
      archived INTEGER DEFAULT 0,
      sync_seq INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      sender_email TEXT,
      content TEXT,
      type TEXT DEFAULT 'text',
      file_url TEXT,
      reply_to_id INTEGER,
      message_id TEXT,
      read_at TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      avatar_url TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS emails (
      uid INTEGER PRIMARY KEY,
      folder TEXT,
      subject TEXT,
      from_email TEXT,
      from_name TEXT,
      to_email TEXT,
      date TEXT,
      preview TEXT,
      seen INTEGER DEFAULT 0,
      flagged INTEGER DEFAULT 0,
      answered INTEGER DEFAULT 0,
      has_attachments INTEGER DEFAULT 0,
      labels TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_folder ON emails(folder);

    CREATE TABLE IF NOT EXISTS feed_posts (
      id INTEGER PRIMARY KEY,
      author_email TEXT,
      author_name TEXT,
      caption TEXT,
      media_type TEXT,
      media_urls TEXT,
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      liked INTEGER DEFAULT 0,
      bookmarked INTEGER DEFAULT 0,
      created_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- ═══ NEW WhatsApp-Level Cache Tables ═══

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY,
      title TEXT,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      description TEXT,
      calendar_id INTEGER,
      color TEXT,
      all_day INTEGER DEFAULT 0,
      recurrence TEXT,
      attendees TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_events(start_time);

    CREATE TABLE IF NOT EXISTS drive_files (
      id INTEGER PRIMARY KEY,
      name TEXT,
      mime_type TEXT,
      size INTEGER DEFAULT 0,
      folder_id INTEGER,
      parent_path TEXT,
      thumbnail_url TEXT,
      is_folder INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      trashed INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_drive_folder ON drive_files(folder_id);

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      title TEXT,
      type TEXT DEFAULT 'document',
      folder_id INTEGER,
      content_preview TEXT,
      shared_count INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY,
      title TEXT,
      content_preview TEXT,
      notebook_id INTEGER,
      pinned INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      type TEXT,
      title TEXT,
      body TEXT,
      data TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read);

    CREATE TABLE IF NOT EXISTS meeting_rooms (
      id TEXT PRIMARY KEY,
      title TEXT,
      scheduled_at TEXT,
      duration_minutes INTEGER,
      status TEXT DEFAULT 'scheduled',
      host_email TEXT,
      participant_count INTEGER DEFAULT 0,
      lobby_enabled INTEGER DEFAULT 0,
      created_at TEXT,
      sync_seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_meet_sched ON meeting_rooms(scheduled_at);

    CREATE TABLE IF NOT EXISTS user_profiles (
      email TEXT PRIMARY KEY,
      name TEXT,
      avatar_url TEXT,
      status TEXT,
      last_seen TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS offline_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retries INTEGER DEFAULT 0,
      last_error TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// 3. Conversations
// ---------------------------------------------------------------------------

export async function getConversations() {
  if (Platform.OS === 'web') return null; // caller falls back to cache
  try {
    await _ensureDb();
    return await db.getAllAsync(
      'SELECT * FROM conversations ORDER BY last_message_at DESC'
    );
  } catch (e) {
    console.warn('[localDb] getConversations:', e?.message);
    return null;
  }
}

export async function saveConversations(conversations) {
  if (Platform.OS === 'web' || !conversations?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const c of conversations) {
        await db.runAsync(
          `INSERT OR REPLACE INTO conversations
            (id, name, type, last_message_content, last_message_at, unread_count, avatar_url, members, updated_at, archived, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id,
          c.name || null,
          c.type || 'direct',
          c.last_message_content || c.last_message || null,
          c.last_message_at || c.updated_at || null,
          c.unread_count || 0,
          c.avatar_url || null,
          c.members ? (typeof c.members === 'string' ? c.members : JSON.stringify(c.members)) : null,
          c.updated_at || null,
          c.archived ? 1 : 0,
          c.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveConversations:', e?.message);
  }
}

export async function deleteConversation(id) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync('DELETE FROM conversations WHERE id = ?', id);
    await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', id);
  } catch (e) {
    console.warn('[localDb] deleteConversation:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Messages
// ---------------------------------------------------------------------------

export async function getMessages(conversationId, limit = 50, beforeId = null) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    if (beforeId) {
      return await db.getAllAsync(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND id < ?
         ORDER BY created_at DESC LIMIT ?`,
        conversationId, beforeId, limit
      );
    }
    const rows = await db.getAllAsync(
      `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      conversationId, limit
    );
    // Return in chronological order (oldest first)
    return rows.reverse();
  } catch (e) {
    console.warn('[localDb] getMessages:', e?.message);
    return null;
  }
}

export async function saveMessages(conversationId, messages) {
  if (Platform.OS === 'web' || !messages?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const m of messages) {
        if (!m.id || String(m.id).startsWith('tmp_')) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO messages
            (id, conversation_id, sender_email, content, type, file_url, reply_to_id, message_id, read_at, edited_at, deleted_at, created_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          conversationId || m.conversation_id,
          m.sender_email || m.sender || null,
          m.content || null,
          m.type || 'text',
          m.file_url || null,
          m.reply_to_id || null,
          m.message_id || null,
          m.read_at || null,
          m.edited_at || null,
          m.deleted_at || null,
          m.created_at || null,
          m.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveMessages:', e?.message);
  }
}

export async function saveMessage(msg) {
  if (Platform.OS === 'web' || !msg?.id || String(msg.id).startsWith('tmp_')) return;
  try {
    await _ensureDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO messages
        (id, conversation_id, sender_email, content, type, file_url, reply_to_id, message_id, read_at, edited_at, deleted_at, created_at, sync_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.conversation_id,
      msg.sender_email || msg.sender || null,
      msg.content || null,
      msg.type || 'text',
      msg.file_url || null,
      msg.reply_to_id || null,
      msg.message_id || null,
      msg.read_at || null,
      msg.edited_at || null,
      msg.deleted_at || null,
      msg.created_at || null,
      msg.sync_seq || 0
    );
  } catch (e) {
    console.warn('[localDb] saveMessage:', e?.message);
  }
}

export async function deleteMessage(id) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync(
      'UPDATE messages SET deleted_at = ? WHERE id = ?',
      new Date().toISOString(), id
    );
  } catch (e) {
    console.warn('[localDb] deleteMessage:', e?.message);
  }
}

export async function updateMessage(id, updates) {
  if (Platform.OS === 'web' || !id) return;
  try {
    await _ensureDb();
    const allowed = ['content', 'edited_at', 'read_at', 'deleted_at', 'type', 'file_url', 'sync_seq'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(updates[key]);
      }
    }
    if (!sets.length) return;
    vals.push(id);
    await db.runAsync(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  } catch (e) {
    console.warn('[localDb] updateMessage:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Contacts
// ---------------------------------------------------------------------------

export async function getContacts() {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync('SELECT * FROM contacts ORDER BY name ASC');
  } catch (e) {
    console.warn('[localDb] getContacts:', e?.message);
    return null;
  }
}

export async function saveContacts(contacts) {
  if (Platform.OS === 'web' || !contacts?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const c of contacts) {
        await db.runAsync(
          `INSERT OR REPLACE INTO contacts (id, name, email, phone, avatar_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          c.id || null,
          c.name || null,
          c.email,
          c.phone || null,
          c.avatar_url || null,
          c.updated_at || new Date().toISOString()
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveContacts:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 6. Emails
// ---------------------------------------------------------------------------

export async function getEmails(folder = 'INBOX', limit = 20) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync(
      'SELECT * FROM emails WHERE folder = ? ORDER BY date DESC LIMIT ?',
      folder, limit
    );
  } catch (e) {
    console.warn('[localDb] getEmails:', e?.message);
    return null;
  }
}

export async function saveEmails(folder, emails) {
  if (Platform.OS === 'web' || !emails?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const e of emails) {
        const uid = e.uid || e.id;
        if (!uid) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO emails
            (uid, folder, subject, from_email, from_name, to_email, date, preview, seen, flagged, answered, has_attachments, labels, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid,
          folder,
          e.subject || null,
          e.from_email || e.from?.email || null,
          e.from_name || e.from?.name || null,
          e.to_email || e.to || null,
          e.date || null,
          e.preview || e.snippet || null,
          e.seen ? 1 : 0,
          e.flagged ? 1 : 0,
          e.answered ? 1 : 0,
          e.has_attachments || e.hasAttachments ? 1 : 0,
          e.labels ? (typeof e.labels === 'string' ? e.labels : JSON.stringify(e.labels)) : null,
          e.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveEmails:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 7. Feed Posts
// ---------------------------------------------------------------------------

export async function getFeedPosts(limit = 20) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync(
      'SELECT * FROM feed_posts ORDER BY created_at DESC LIMIT ?',
      limit
    );
  } catch (e) {
    console.warn('[localDb] getFeedPosts:', e?.message);
    return null;
  }
}

export async function saveFeedPosts(posts) {
  if (Platform.OS === 'web' || !posts?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const p of posts) {
        if (!p.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO feed_posts
            (id, author_email, author_name, caption, media_type, media_urls, likes_count, comments_count, liked, bookmarked, created_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p.id,
          p.author_email || p.email || null,
          p.author_name || p.name || null,
          p.caption || null,
          p.media_type || null,
          p.media_urls ? (typeof p.media_urls === 'string' ? p.media_urls : JSON.stringify(p.media_urls)) : null,
          p.likes_count || 0,
          p.comments_count || 0,
          p.liked ? 1 : 0,
          p.bookmarked ? 1 : 0,
          p.created_at || null,
          p.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveFeedPosts:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 8. Sync State
// ---------------------------------------------------------------------------

export async function getLastSyncSeq() {
  if (Platform.OS === 'web') return 0;
  try {
    await _ensureDb();
    const row = await db.getFirstAsync(
      "SELECT value FROM sync_state WHERE key = 'last_sync_seq'"
    );
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function setLastSyncSeq(seq) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync(
      "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync_seq', ?)",
      String(seq)
    );
  } catch (e) {
    console.warn('[localDb] setLastSyncSeq:', e?.message);
  }
}

export async function getSyncState(key) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    const row = await db.getFirstAsync(
      'SELECT value FROM sync_state WHERE key = ?', key
    );
    return row ? row.value : null;
  } catch {
    return null;
  }
}

export async function setSyncState(key, value) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync(
      'INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)',
      key, String(value)
    );
  } catch (e) {
    console.warn('[localDb] setSyncState:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 9. Full Sync (first login / empty DB)
// ---------------------------------------------------------------------------

export async function fullSync(apiCall) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();

    // 1. Fetch conversations
    const convRes = await apiCall('chat_conversations');
    if (convRes?.conversations?.length) {
      await saveConversations(convRes.conversations);

      // 2. Fetch messages for the 20 most recent conversations
      const recent = convRes.conversations.slice(0, 20);
      for (const conv of recent) {
        try {
          const msgRes = await apiCall('chat_messages', { conversation_id: conv.id, limit: 50 });
          if (msgRes?.messages?.length) {
            await saveMessages(conv.id, msgRes.messages);
          }
        } catch {}
      }
    }

    // 3. Fetch contacts
    try {
      const contactRes = await apiCall('get_contacts');
      if (contactRes?.contacts?.length) {
        await saveContacts(contactRes.contacts);
      }
    } catch {}

    // 4. Save sync timestamp
    await setSyncState('last_full_sync', new Date().toISOString());

    console.log('[localDb] fullSync complete');
  } catch (e) {
    console.warn('[localDb] fullSync error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 10. Incremental Sync
// ---------------------------------------------------------------------------

export async function incrementalSync(apiCall, lastSeq) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();

    const res = await apiCall('app_sync', { since_seq: lastSeq });
    if (!res?.success) return;

    // Apply conversation updates
    if (res.conversations?.length) {
      await saveConversations(res.conversations);
    }

    // Apply new/edited messages
    if (res.messages?.length) {
      for (const m of res.messages) {
        if (m.deleted_at) {
          await deleteMessage(m.id);
        } else {
          await saveMessage(m);
        }
      }
    }

    // Update sync seq
    if (res.sync_seq) {
      await setLastSyncSeq(res.sync_seq);
    }

    console.log('[localDb] incrementalSync complete, seq:', res.sync_seq);
  } catch (e) {
    console.warn('[localDb] incrementalSync error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 11. Clear All (logout)
// ---------------------------------------------------------------------------

export async function clearLocalDb() {
  if (Platform.OS === 'web') return;
  try {
    if (!db) return;
    await db.execAsync(`
      DELETE FROM conversations;
      DELETE FROM messages;
      DELETE FROM contacts;
      DELETE FROM emails;
      DELETE FROM feed_posts;
      DELETE FROM sync_state;
      DELETE FROM calendar_events;
      DELETE FROM drive_files;
      DELETE FROM documents;
      DELETE FROM notes;
      DELETE FROM notifications;
      DELETE FROM meeting_rooms;
      DELETE FROM user_profiles;
      DELETE FROM offline_queue;
    `);
    console.log('[localDb] cleared all tables');
  } catch (e) {
    console.warn('[localDb] clearLocalDb:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 12. Utility: check if DB has data (for deciding full vs incremental sync)
// ---------------------------------------------------------------------------

export async function hasLocalData() {
  if (Platform.OS === 'web') return false;
  try {
    await _ensureDb();
    const row = await db.getFirstAsync('SELECT COUNT(*) as cnt FROM conversations');
    return row && row.cnt > 0;
  } catch {
    return false;
  }
}

export function isInitialized() {
  return _initialized && db !== null;
}

// ---------------------------------------------------------------------------
// 13. Calendar Events
// ---------------------------------------------------------------------------

export async function getCalendarEvents(startDate, endDate) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    if (startDate && endDate) {
      return await db.getAllAsync(
        'SELECT * FROM calendar_events WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC',
        startDate, endDate
      );
    }
    return await db.getAllAsync('SELECT * FROM calendar_events ORDER BY start_time ASC LIMIT 100');
  } catch (e) {
    console.warn('[localDb] getCalendarEvents:', e?.message);
    return null;
  }
}

export async function saveCalendarEvents(events) {
  if (Platform.OS === 'web' || !events?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const ev of events) {
        if (!ev.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO calendar_events
            (id, title, start_time, end_time, location, description, calendar_id, color, all_day, recurrence, attendees, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ev.id, ev.title || null, ev.start_time || ev.start || null, ev.end_time || ev.end || null,
          ev.location || null, ev.description || null, ev.calendar_id || null, ev.color || null,
          ev.all_day ? 1 : 0, ev.recurrence || null,
          ev.attendees ? (typeof ev.attendees === 'string' ? ev.attendees : JSON.stringify(ev.attendees)) : null,
          ev.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveCalendarEvents:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 14. Drive Files
// ---------------------------------------------------------------------------

export async function getDriveFiles(folderId = null) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    if (folderId) {
      return await db.getAllAsync(
        'SELECT * FROM drive_files WHERE folder_id = ? AND trashed = 0 ORDER BY is_folder DESC, name ASC',
        folderId
      );
    }
    return await db.getAllAsync(
      'SELECT * FROM drive_files WHERE folder_id IS NULL AND trashed = 0 ORDER BY is_folder DESC, name ASC'
    );
  } catch (e) {
    console.warn('[localDb] getDriveFiles:', e?.message);
    return null;
  }
}

export async function saveDriveFiles(files) {
  if (Platform.OS === 'web' || !files?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const f of files) {
        if (!f.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO drive_files
            (id, name, mime_type, size, folder_id, parent_path, thumbnail_url, is_folder, starred, trashed, created_at, updated_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          f.id, f.name || null, f.mime_type || null, f.size || 0,
          f.folder_id || null, f.parent_path || null, f.thumbnail_url || null,
          f.is_folder ? 1 : 0, f.starred ? 1 : 0, f.trashed ? 1 : 0,
          f.created_at || null, f.updated_at || null, f.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveDriveFiles:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 15. Documents
// ---------------------------------------------------------------------------

export async function getDocuments() {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync('SELECT * FROM documents ORDER BY updated_at DESC LIMIT 100');
  } catch (e) {
    console.warn('[localDb] getDocuments:', e?.message);
    return null;
  }
}

export async function saveDocuments(docs) {
  if (Platform.OS === 'web' || !docs?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const d of docs) {
        if (!d.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO documents
            (id, title, type, folder_id, content_preview, shared_count, created_at, updated_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          d.id, d.title || null, d.type || 'document', d.folder_id || null,
          d.content_preview || null, d.shared_count || 0,
          d.created_at || null, d.updated_at || null, d.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveDocuments:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 16. Notes
// ---------------------------------------------------------------------------

export async function getNotes() {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 100');
  } catch (e) {
    console.warn('[localDb] getNotes:', e?.message);
    return null;
  }
}

export async function saveNotes(notes) {
  if (Platform.OS === 'web' || !notes?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const n of notes) {
        if (!n.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO notes
            (id, title, content_preview, notebook_id, pinned, created_at, updated_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          n.id, n.title || null, n.content_preview || null, n.notebook_id || null,
          n.pinned ? 1 : 0, n.created_at || null, n.updated_at || null, n.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveNotes:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 17. Notifications
// ---------------------------------------------------------------------------

export async function getNotifications(limit = 50) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getAllAsync('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', limit);
  } catch (e) {
    console.warn('[localDb] getNotifications:', e?.message);
    return null;
  }
}

export async function saveNotifications(notifs) {
  if (Platform.OS === 'web' || !notifs?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const n of notifs) {
        if (!n.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO notifications
            (id, type, title, body, data, read, created_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          n.id, n.type || null, n.title || null, n.body || null,
          n.data ? (typeof n.data === 'string' ? n.data : JSON.stringify(n.data)) : null,
          n.read ? 1 : 0, n.created_at || null, n.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveNotifications:', e?.message);
  }
}

export async function markNotificationRead(id) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync('UPDATE notifications SET read = 1 WHERE id = ?', id);
  } catch (e) {
    console.warn('[localDb] markNotificationRead:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 18. Meeting Rooms
// ---------------------------------------------------------------------------

export async function getMeetingRooms(filter = 'upcoming') {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    const now = new Date().toISOString();
    if (filter === 'upcoming') {
      return await db.getAllAsync(
        "SELECT * FROM meeting_rooms WHERE scheduled_at >= ? AND status != 'ended' ORDER BY scheduled_at ASC",
        now
      );
    }
    return await db.getAllAsync('SELECT * FROM meeting_rooms ORDER BY scheduled_at DESC LIMIT 50');
  } catch (e) {
    console.warn('[localDb] getMeetingRooms:', e?.message);
    return null;
  }
}

export async function saveMeetingRooms(rooms) {
  if (Platform.OS === 'web' || !rooms?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const r of rooms) {
        if (!r.id) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO meeting_rooms
            (id, title, scheduled_at, duration_minutes, status, host_email, participant_count, lobby_enabled, created_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.id, r.title || null, r.scheduled_at || null, r.duration_minutes || 60,
          r.status || 'scheduled', r.host_email || null, r.participant_count || 0,
          r.lobby_enabled ? 1 : 0, r.created_at || null, r.sync_seq || 0
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveMeetingRooms:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 19. User Profiles (for avatars, names - cached locally)
// ---------------------------------------------------------------------------

export async function getUserProfile(email) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    return await db.getFirstAsync('SELECT * FROM user_profiles WHERE email = ?', email);
  } catch {
    return null;
  }
}

export async function saveUserProfiles(profiles) {
  if (Platform.OS === 'web' || !profiles?.length) return;
  try {
    await _ensureDb();
    await db.withTransactionAsync(async () => {
      for (const p of profiles) {
        if (!p.email) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO user_profiles
            (email, name, avatar_url, status, last_seen, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          p.email, p.name || null, p.avatar_url || null,
          p.status || null, p.last_seen || null,
          p.updated_at || new Date().toISOString()
        );
      }
    });
  } catch (e) {
    console.warn('[localDb] saveUserProfiles:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 20. Offline Queue (actions to replay when online)
// ---------------------------------------------------------------------------

export async function queueOfflineAction(action, payload) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync(
      'INSERT INTO offline_queue (action, payload, created_at) VALUES (?, ?, ?)',
      action,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      new Date().toISOString()
    );
  } catch (e) {
    console.warn('[localDb] queueOfflineAction:', e?.message);
  }
}

export async function getOfflineQueue() {
  if (Platform.OS === 'web') return [];
  try {
    await _ensureDb();
    return await db.getAllAsync('SELECT * FROM offline_queue ORDER BY created_at ASC LIMIT 100');
  } catch {
    return [];
  }
}

export async function removeOfflineAction(id) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync('DELETE FROM offline_queue WHERE id = ?', id);
  } catch (e) {
    console.warn('[localDb] removeOfflineAction:', e?.message);
  }
}

export async function replayOfflineQueue(apiCall) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    const queue = await getOfflineQueue();
    for (const item of queue) {
      try {
        const payload = JSON.parse(item.payload);
        const res = await apiCall(item.action, payload);
        if (res?.success) {
          await removeOfflineAction(item.id);
        } else {
          // Increment retry count
          await db.runAsync(
            'UPDATE offline_queue SET retries = retries + 1, last_error = ? WHERE id = ?',
            res?.message || 'Unknown error', item.id
          );
        }
      } catch (err) {
        await db.runAsync(
          'UPDATE offline_queue SET retries = retries + 1, last_error = ? WHERE id = ?',
          err?.message || 'Network error', item.id
        );
      }
    }
    // Delete items that failed too many times (> 10)
    await db.runAsync('DELETE FROM offline_queue WHERE retries > 10');
  } catch (e) {
    console.warn('[localDb] replayOfflineQueue:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 21. Enhanced Delta Sync (all entity types)
// ---------------------------------------------------------------------------

export async function fullDeltaSync(apiCall) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    const lastSeq = await getLastSyncSeq();

    const res = await apiCall('chat_sync', {
      since_seq: lastSeq,
      types: 'chat,email,feed,calendar,drive,docs,notes,meet,notifications',
      limit: 1000
    });

    if (!res?.success) return;

    // Apply all entity types
    if (res.conversations?.length) await saveConversations(res.conversations);
    if (res.messages?.length) {
      for (const m of res.messages) {
        if (m.deleted_at) await deleteMessage(m.id); else await saveMessage(m);
      }
    }
    if (res.contacts?.length) await saveContacts(res.contacts);
    if (res.emails?.length) await saveEmails('INBOX', res.emails);
    if (res.feed_posts?.length) await saveFeedPosts(res.feed_posts);
    if (res.calendar_events?.length) await saveCalendarEvents(res.calendar_events);
    if (res.drive_files?.length) await saveDriveFiles(res.drive_files);
    if (res.documents?.length) await saveDocuments(res.documents);
    if (res.notes?.length) await saveNotes(res.notes);
    if (res.notifications?.length) await saveNotifications(res.notifications);
    if (res.meeting_rooms?.length) await saveMeetingRooms(res.meeting_rooms);
    if (res.user_profiles?.length) await saveUserProfiles(res.user_profiles);

    if (res.sync_seq) await setLastSyncSeq(res.sync_seq);

    // Replay offline queue while we're at it
    await replayOfflineQueue(apiCall);

    console.log('[localDb] fullDeltaSync done, seq:', res.sync_seq);
  } catch (e) {
    console.warn('[localDb] fullDeltaSync:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 22. DB Stats (for debugging)
// ---------------------------------------------------------------------------

export async function getDbStats() {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    const tables = ['conversations', 'messages', 'contacts', 'emails', 'feed_posts',
      'calendar_events', 'drive_files', 'documents', 'notes', 'notifications',
      'meeting_rooms', 'user_profiles', 'offline_queue'];
    const stats = {};
    for (const t of tables) {
      const row = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM ${t}`);
      stats[t] = row?.cnt || 0;
    }
    const syncSeq = await getLastSyncSeq();
    stats.sync_seq = syncSeq;
    return stats;
  } catch {
    return null;
  }
}
