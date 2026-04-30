/**
 * Chatyy Local Sync — Ponte WebSocket ↔ SQLite
 *
 * Celular: TUDO do SQLite local (instantaneo)
 * WebSocket sincroniza bidirecional com servidor
 *
 * - Servidor muda → WS empurra → salva no SQLite
 * - Celular muda → salva no SQLite → WS envia pro servidor
 * - App fechado → background fetch sync a cada 15 min
 * - App abre → delta sync (so o que mudou)
 */

import { Platform } from 'react-native';

let _db = null;
let _ready = false;
let _initPromise = null;

// ─── Database Init (dynamic import, never crashes) ──────────

async function getDb() {
  if (_ready && _db) return _db;
  if (_initPromise) return _initPromise;
  if (Platform.OS === 'web') return null;

  _initPromise = (async () => {
    try {
      const SQLite = require('expo-sqlite');
      _db = await Promise.race([
        SQLite.openDatabaseAsync('chatyy_sync.db'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);

      await _db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY,
          name TEXT,
          type TEXT DEFAULT 'direct',
          last_message TEXT,
          last_message_at TEXT,
          unread_count INTEGER DEFAULT 0,
          avatar_url TEXT,
          members TEXT,
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL,
          sender_email TEXT,
          sender_name TEXT,
          content TEXT,
          type TEXT DEFAULT 'text',
          file_url TEXT,
          reply_to_id INTEGER,
          read_at TEXT,
          edited_at TEXT,
          deleted_at TEXT,
          created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id DESC);

        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          name TEXT,
          phone TEXT,
          avatar_url TEXT,
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS pending_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);

      _ready = true;
      return _db;
    } catch (e) {
      console.warn('[localSync] init failed:', e?.message);
      _db = null;
      return null;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

// ─── Conversations ──────────────────────────────────────────

export async function getConversations() {
  const db = await getDb();
  if (!db) return null;
  try {
    return await db.getAllAsync('SELECT * FROM conversations ORDER BY last_message_at DESC');
  } catch { return null; }
}

export async function saveConversations(convs) {
  const db = await getDb();
  if (!db || !convs?.length) return;
  try {
    for (const c of convs) {
      await db.runAsync(
        `INSERT OR REPLACE INTO conversations (id, name, type, last_message, last_message_at, unread_count, avatar_url, members, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, c.name || null, c.type || 'direct',
        c.last_message_content || c.last_message || null,
        c.last_message_at || c.updated_at || null,
        c.unread_count || 0, c.avatar_url || null,
        typeof c.members === 'string' ? c.members : JSON.stringify(c.members || []),
        c.updated_at || null
      );
    }
  } catch (e) { console.warn('[localSync] saveConversations:', e?.message); }
}

// ─── Messages (per row, indexed — fast!) ────────────────────

export async function getMessages(conversationId, limit = 50) {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db.getAllAsync(
      'SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?',
      conversationId, limit
    );
    return rows?.reverse() || null;
  } catch { return null; }
}

export async function saveMessages(conversationId, messages) {
  const db = await getDb();
  if (!db || !messages?.length) return;
  try {
    for (const m of messages) {
      if (!m.id || String(m.id).startsWith('tmp_')) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, sender_name, content, type, file_url, reply_to_id, read_at, edited_at, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id, conversationId || m.conversation_id, m.sender_email || m.sender || null,
        m.sender_name || null, m.content || null, m.type || 'text',
        m.file_url || null, m.reply_to_id || null,
        m.read_at || null, m.edited_at || null, m.deleted_at || null,
        m.created_at || null
      );
    }
  } catch (e) { console.warn('[localSync] saveMessages:', e?.message); }
}

export async function saveOneMessage(msg) {
  if (!msg?.id || String(msg.id).startsWith('tmp_')) return;
  const conversationId = msg.conversation_id || msg.conversationId;
  if (!conversationId) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, sender_name, content, type, file_url, reply_to_id, read_at, edited_at, deleted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id, conversationId, msg.sender_email || msg.sender || null,
      msg.sender_name || null, msg.content || null, msg.type || 'text',
      msg.file_url || null, msg.reply_to_id || null,
      msg.read_at || null, msg.edited_at || null, msg.deleted_at || null,
      msg.created_at || null
    );
  } catch {}
}

export async function deleteMessage(messageId) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('UPDATE messages SET deleted_at = datetime('now') WHERE id = ?', messageId);
  } catch {}
}

// ─── Contacts ───────────────────────────────────────────────

export async function getContacts() {
  const db = await getDb();
  if (!db) return null;
  try {
    return await db.getAllAsync('SELECT * FROM contacts ORDER BY name ASC');
  } catch { return null; }
}

export async function saveContacts(contacts) {
  const db = await getDb();
  if (!db || !contacts?.length) return;
  try {
    for (const c of contacts) {
      await db.runAsync(
        'INSERT OR REPLACE INTO contacts (email, name, phone, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?)',
        c.email, c.name || null, c.phone || null, c.avatar_url || null, c.updated_at || null
      );
    }
  } catch {}
}

// ─── Sync Meta ──────────────────────────────────────────────

export async function getLastSync(key) {
  const db = await getDb();
  if (!db) return 0;
  try {
    const row = await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', key);
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch { return 0; }
}

export async function setLastSync(key, value) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', key, String(value));
  } catch {}
}

// ─── Pending Actions (offline queue) ────────────────────────

export async function queueAction(action, data) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('INSERT INTO pending_actions (action, data) VALUES (?, ?)', action, JSON.stringify(data));
  } catch {}
}

export async function getPendingActions() {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.getAllAsync('SELECT * FROM pending_actions ORDER BY id ASC');
  } catch { return []; }
}

export async function removePendingAction(id) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('DELETE FROM pending_actions WHERE id = ?', id);
  } catch {}
}

// ─── WebSocket Event Handler ────────────────────────────────
// Call this from the WebSocket message handler to sync in real-time

export async function handleSyncEvent(event) {
  if (Platform.OS === 'web') return; // Web uses API, not local sync
  if (!event?.type) return;

  try {
    switch (event.type) {
      case 'new_message':
      case 'chat_message':
        if (event.data) await saveOneMessage(event.data);
        break;

      case 'message_edited':
        if (event.data?.id) await saveOneMessage(event.data);
        break;

      case 'message_deleted':
        if (event.data?.id || event.data?.message_id) {
          await deleteMessage(event.data.id || event.data.message_id);
        }
        break;

      case 'conversation_updated':
        if (event.data) await saveConversations([event.data]);
        break;

      case 'message_read':
        // Mark messages as read locally
        if (event.data?.conversation_id && event.data?.message_id) {
          const db = await getDb();
          if (db) {
            await db.runAsync(
              'UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND id <= ? AND read_at IS NULL',
              event.data.conversation_id, event.data.message_id
            ).catch(() => {});
          }
        }
        break;
    }
  } catch (e) { console.warn('[localSync] handleSyncEvent:', e?.message); }
}

// ─── Full Sync (on app open) ────────────────────────────────

export async function isReady() {
  const db = await getDb();
  return db !== null;
}

export async function getMessageCount() {
  const db = await getDb();
  if (!db) return 0;
  try {
    const row = await db.getFirstAsync('SELECT COUNT(*) as cnt FROM messages');
    return row?.cnt || 0;
  } catch { return 0; }
}

// ─── Clear (logout) ─────────────────────────────────────────

export async function clearAll() {
  const db = await getDb();
  if (!db) return;
  try {
    await db.execAsync('DELETE FROM conversations; DELETE FROM messages; DELETE FROM contacts; DELETE FROM sync_meta; DELETE FROM pending_actions;');
  } catch {}
}
