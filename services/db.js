/**
 * Chatyy Local Database — SQLite (expo-sqlite)
 * Single source of truth for ALL local data
 *
 * Tables:
 *   conversations  — chat list (id, name, type, last_message, unread_count, ...)
 *   messages       — chat messages (id, conversation_id, sender, content, type, ...)
 *   contacts       — address book (email, name, phone, avatar, ...)
 *   emails         — inbox cache (uid, folder, from, subject, snippet, ...)
 *   calendar       — events (id, title, start, end, location, ...)
 *   files          — drive/cloud (id, name, path, size, type, ...)
 *   settings       — key-value store for app settings
 *   sync_state     — tracks last sync per table
 *
 * Why SQLite > MMKV:
 *   - Query by index (WHERE conversation_id = ? ORDER BY created_at)
 *   - Handle 100k+ messages without loading all into RAM
 *   - Transactions for consistency
 *   - Full-text search on messages/emails
 */
import { Platform } from 'react-native';

// Only import SQLite on native — web doesn't support it
let SQLite = null;
if (Platform.OS !== 'web') {
  try { SQLite = require('expo-sqlite'); } catch {}
}

let _db = null;
let _ready = false;
let _readyResolve;
const _readyPromise = new Promise(r => { _readyResolve = r; });

// Web fallback — use MMKV/localStorage (SQLite not available on web)
const isWeb = Platform.OS === 'web';

export function getDb() { return _db; }
export function isDbReady() { return _ready; }
export function waitForDb() { return _readyPromise; }

// ── Initialize database ──
export async function initDatabase() {
  if (isWeb || _ready) return;
  try {
    _db = await SQLite.openDatabaseAsync('chatyy.db');

    // Enable WAL mode for better concurrent read/write performance
    await _db.execAsync('PRAGMA journal_mode = WAL;');
    await _db.execAsync('PRAGMA foreign_keys = ON;');
    await _db.execAsync('PRAGMA cache_size = -8000;'); // 8MB cache

    // Create all tables
    await _db.execAsync(`
      -- Conversations
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'direct',
        last_message TEXT,
        last_message_time TEXT,
        last_message_sender TEXT,
        unread_count INTEGER DEFAULT 0,
        avatar_url TEXT,
        pinned INTEGER DEFAULT 0,
        muted INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        is_group INTEGER DEFAULT 0,
        member_count INTEGER DEFAULT 0,
        description TEXT,
        updated_at TEXT,
        raw_json TEXT
      );

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        sender_email TEXT,
        sender_name TEXT,
        content TEXT,
        type TEXT DEFAULT 'text',
        file_url TEXT,
        file_name TEXT,
        file_size INTEGER,
        reply_to_id INTEGER,
        edited_at TEXT,
        deleted INTEGER DEFAULT 0,
        reactions TEXT,
        read_by TEXT,
        created_at TEXT,
        raw_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);

      -- Contacts
      CREATE TABLE IF NOT EXISTS contacts (
        email TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        avatar_url TEXT,
        is_chatyy_user INTEGER DEFAULT 0,
        last_seen TEXT,
        about TEXT,
        raw_json TEXT
      );

      -- Emails (inbox cache)
      CREATE TABLE IF NOT EXISTS emails (
        uid INTEGER,
        folder TEXT DEFAULT 'INBOX',
        from_email TEXT,
        from_name TEXT,
        subject TEXT,
        snippet TEXT,
        date TEXT,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        is_flagged INTEGER DEFAULT 0,
        has_attachments INTEGER DEFAULT 0,
        labels TEXT,
        raw_json TEXT,
        PRIMARY KEY (uid, folder)
      );
      CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder, date DESC);

      -- Calendar events
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        start_time TEXT,
        end_time TEXT,
        location TEXT,
        all_day INTEGER DEFAULT 0,
        color TEXT,
        recurrence TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);

      -- Files (Cloud/Drive)
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        name TEXT,
        path TEXT,
        parent_id INTEGER,
        size INTEGER DEFAULT 0,
        mime_type TEXT,
        is_folder INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        is_trashed INTEGER DEFAULT 0,
        thumbnail_url TEXT,
        cdn_url TEXT,
        created_at TEXT,
        updated_at TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);

      -- Key-value settings
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Sync state tracking
      CREATE TABLE IF NOT EXISTS sync_state (
        table_name TEXT PRIMARY KEY,
        last_sync TEXT,
        last_id INTEGER DEFAULT 0,
        version INTEGER DEFAULT 0
      );

      -- Pending messages (unsent, queued for retry)
      CREATE TABLE IF NOT EXISTS pending_messages (
        temp_id TEXT PRIMARY KEY,
        conversation_id INTEGER,
        content TEXT,
        type TEXT DEFAULT 'text',
        file_url TEXT,
        file_name TEXT,
        created_at TEXT,
        retries INTEGER DEFAULT 0,
        raw_json TEXT
      );
    `);

    _ready = true;
    _readyResolve();
  } catch (err) {
    console.warn('[DB] Init failed:', err.message);
    _ready = true;
    _readyResolve();
  }
}

// ══════════════════════════════════════
// CONVERSATIONS
// ══════════════════════════════════════

export async function dbSaveConversations(conversations) {
  if (isWeb || !_db || !conversations?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO conversations (id, name, type, last_message, last_message_time, last_message_sender, unread_count, avatar_url, pinned, muted, archived, is_group, member_count, description, updated_at, raw_json)
     VALUES ($id, $name, $type, $lastMsg, $lastTime, $lastSender, $unread, $avatar, $pinned, $muted, $archived, $isGroup, $members, $desc, $updated, $raw)`
  );
  try {
    for (const c of conversations) {
      await stmt.executeAsync({
        $id: c.id,
        $name: c.name || c.display_name || '',
        $type: c.type || 'direct',
        $lastMsg: c.last_message || '',
        $lastTime: c.last_message_time || c.updated_at || '',
        $lastSender: c.last_message_sender || '',
        $unread: c.unread_count || 0,
        $avatar: c.avatar_url || '',
        $pinned: c.pinned ? 1 : 0,
        $muted: c.muted ? 1 : 0,
        $archived: c.archived ? 1 : 0,
        $isGroup: c.type === 'group' ? 1 : 0,
        $members: c.member_count || 0,
        $desc: c.description || '',
        $updated: c.updated_at || '',
        $raw: JSON.stringify(c),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetConversations(includeArchived = false) {
  if (isWeb || !_db) return [];
  const where = includeArchived ? '' : 'WHERE archived = 0';
  const rows = await _db.getAllAsync(
    `SELECT raw_json FROM conversations ${where} ORDER BY pinned DESC, last_message_time DESC LIMIT 200`
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════

export async function dbSaveMessages(conversationId, messages) {
  if (isWeb || !_db || !messages?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, sender_name, content, type, file_url, file_name, file_size, reply_to_id, edited_at, deleted, reactions, read_by, created_at, raw_json)
     VALUES ($id, $convId, $sender, $senderName, $content, $type, $fileUrl, $fileName, $fileSize, $replyTo, $edited, $deleted, $reactions, $readBy, $created, $raw)`
  );
  try {
    for (const m of messages) {
      if (!m.id || String(m.id).startsWith('tmp_')) continue;
      await stmt.executeAsync({
        $id: m.id,
        $convId: conversationId,
        $sender: m.sender_email || '',
        $senderName: m.sender_name || '',
        $content: m.content || '',
        $type: m.type || 'text',
        $fileUrl: m.file_url || '',
        $fileName: m.file_name || '',
        $fileSize: m.file_size || 0,
        $replyTo: m.reply_to_id || null,
        $edited: m.edited_at || null,
        $deleted: m.deleted ? 1 : 0,
        $reactions: m.reactions ? JSON.stringify(m.reactions) : null,
        $readBy: m.read_by ? JSON.stringify(m.read_by) : null,
        $created: m.created_at || '',
        $raw: JSON.stringify(m),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetMessages(conversationId, limit = 50, beforeId = null) {
  if (isWeb || !_db) return [];
  let query = 'SELECT raw_json FROM messages WHERE conversation_id = ?';
  const params = [conversationId];
  if (beforeId) {
    query += ' AND id < ?';
    params.push(beforeId);
  }
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  const rows = await _db.getAllAsync(query, params);
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean).reverse();
}

export async function dbGetLastMessageId(conversationId) {
  if (isWeb || !_db) return 0;
  const row = await _db.getFirstAsync(
    'SELECT MAX(id) as max_id FROM messages WHERE conversation_id = ?', [conversationId]
  );
  return row?.max_id || 0;
}

export async function dbDeleteMessage(conversationId, messageId) {
  if (isWeb || !_db) return;
  await _db.runAsync('DELETE FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId]);
}

export async function dbUpdateMessage(messageId, updates) {
  if (isWeb || !_db) return;
  // Update raw_json with merged data
  const row = await _db.getFirstAsync('SELECT raw_json FROM messages WHERE id = ?', [messageId]);
  if (!row) return;
  try {
    const existing = JSON.parse(row.raw_json);
    const merged = { ...existing, ...updates };
    await _db.runAsync('UPDATE messages SET raw_json = ?, content = ?, edited_at = ? WHERE id = ?', [
      JSON.stringify(merged), merged.content || '', merged.edited_at || null, messageId
    ]);
  } catch {}
}

// ══════════════════════════════════════
// CONTACTS
// ══════════════════════════════════════

export async function dbSaveContacts(contacts) {
  if (isWeb || !_db || !contacts?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO contacts (email, name, phone, avatar_url, is_chatyy_user, about, raw_json)
     VALUES ($email, $name, $phone, $avatar, $isChatyy, $about, $raw)`
  );
  try {
    for (const c of contacts) {
      await stmt.executeAsync({
        $email: c.email || '',
        $name: c.name || c.display_name || '',
        $phone: c.phone || '',
        $avatar: c.avatar_url || '',
        $isChatyy: c.is_chatyy_user ? 1 : 0,
        $about: c.about || '',
        $raw: JSON.stringify(c),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetContacts() {
  if (isWeb || !_db) return [];
  const rows = await _db.getAllAsync('SELECT raw_json FROM contacts ORDER BY name ASC LIMIT 1000');
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

export async function dbSearchContacts(query) {
  if (isWeb || !_db || !query) return [];
  const q = `%${query}%`;
  const rows = await _db.getAllAsync(
    'SELECT raw_json FROM contacts WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 50', [q, q, q]
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// EMAILS
// ══════════════════════════════════════

export async function dbSaveEmails(folder, emails) {
  if (isWeb || !_db || !emails?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO emails (uid, folder, from_email, from_name, subject, snippet, date, is_read, is_starred, is_flagged, has_attachments, labels, raw_json)
     VALUES ($uid, $folder, $fromEmail, $fromName, $subject, $snippet, $date, $read, $starred, $flagged, $attach, $labels, $raw)`
  );
  try {
    for (const e of emails) {
      await stmt.executeAsync({
        $uid: e.uid || e.id,
        $folder: folder,
        $fromEmail: e.from?.email || e.from_email || '',
        $fromName: e.from?.name || e.from_name || '',
        $subject: e.subject || '',
        $snippet: e.snippet || e.preview || '',
        $date: e.date || '',
        $read: e.seen || e.is_read ? 1 : 0,
        $starred: e.flagged || e.is_starred ? 1 : 0,
        $flagged: e.flagged ? 1 : 0,
        $attach: e.hasAttachments || e.has_attachments ? 1 : 0,
        $labels: e.labels ? JSON.stringify(e.labels) : null,
        $raw: JSON.stringify(e),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetEmails(folder = 'INBOX', limit = 50, offset = 0) {
  if (isWeb || !_db) return [];
  const rows = await _db.getAllAsync(
    'SELECT raw_json FROM emails WHERE folder = ? ORDER BY date DESC LIMIT ? OFFSET ?', [folder, limit, offset]
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════

export async function dbSaveEvents(events) {
  if (isWeb || !_db || !events?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO calendar_events (id, title, description, start_time, end_time, location, all_day, color, raw_json)
     VALUES ($id, $title, $desc, $start, $end, $loc, $allDay, $color, $raw)`
  );
  try {
    for (const e of events) {
      await stmt.executeAsync({
        $id: String(e.id),
        $title: e.title || '',
        $desc: e.description || '',
        $start: e.start || e.start_time || '',
        $end: e.end || e.end_time || '',
        $loc: e.location || '',
        $allDay: e.all_day ? 1 : 0,
        $color: e.color || '',
        $raw: JSON.stringify(e),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetEvents(startDate, endDate) {
  if (isWeb || !_db) return [];
  const rows = await _db.getAllAsync(
    'SELECT raw_json FROM calendar_events WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC', [startDate, endDate]
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// FILES (Cloud/Drive)
// ══════════════════════════════════════

export async function dbSaveFiles(files) {
  if (isWeb || !_db || !files?.length) return;
  const stmt = await _db.prepareAsync(
    `INSERT OR REPLACE INTO files (id, name, path, parent_id, size, mime_type, is_folder, is_starred, is_trashed, thumbnail_url, cdn_url, created_at, updated_at, raw_json)
     VALUES ($id, $name, $path, $parent, $size, $mime, $isFolder, $starred, $trashed, $thumb, $cdn, $created, $updated, $raw)`
  );
  try {
    for (const f of files) {
      await stmt.executeAsync({
        $id: f.id,
        $name: f.name || f.original_name || '',
        $path: f.path || '',
        $parent: f.parent_id || f.folder_id || 0,
        $size: f.size || 0,
        $mime: f.mime_type || '',
        $isFolder: f.is_folder ? 1 : 0,
        $starred: f.is_starred ? 1 : 0,
        $trashed: f.is_trashed ? 1 : 0,
        $thumb: f.thumbnail_url || '',
        $cdn: f.cdn_url || '',
        $created: f.created_at || '',
        $updated: f.updated_at || '',
        $raw: JSON.stringify(f),
      });
    }
  } finally { await stmt.finalizeAsync(); }
}

export async function dbGetFiles(parentId = 0) {
  if (isWeb || !_db) return [];
  const rows = await _db.getAllAsync(
    'SELECT raw_json FROM files WHERE parent_id = ? AND is_trashed = 0 ORDER BY is_folder DESC, name ASC', [parentId]
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// SETTINGS (key-value)
// ══════════════════════════════════════

export async function dbSet(key, value) {
  if (isWeb || !_db) return;
  await _db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, typeof value === 'string' ? value : JSON.stringify(value)]);
}

export async function dbGet(key) {
  if (isWeb || !_db) return null;
  const row = await _db.getFirstAsync('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value || null;
}

export async function dbGetJSON(key) {
  const v = await dbGet(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}

// ══════════════════════════════════════
// SYNC STATE
// ══════════════════════════════════════

export async function dbGetSyncState(tableName) {
  if (isWeb || !_db) return { last_sync: null, last_id: 0, version: 0 };
  const row = await _db.getFirstAsync('SELECT * FROM sync_state WHERE table_name = ?', [tableName]);
  return row || { last_sync: null, last_id: 0, version: 0 };
}

export async function dbSetSyncState(tableName, lastId, version = 1) {
  if (isWeb || !_db) return;
  await _db.runAsync(
    'INSERT OR REPLACE INTO sync_state (table_name, last_sync, last_id, version) VALUES (?, ?, ?, ?)',
    [tableName, new Date().toISOString(), lastId, version]
  );
}

// ══════════════════════════════════════
// PENDING MESSAGES
// ══════════════════════════════════════

export async function dbSavePending(msg) {
  if (isWeb || !_db) return;
  await _db.runAsync(
    'INSERT OR REPLACE INTO pending_messages (temp_id, conversation_id, content, type, file_url, file_name, created_at, retries, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [msg.temp_id, msg.conversation_id, msg.content || '', msg.type || 'text', msg.file_url || '', msg.file_name || '', msg.created_at || new Date().toISOString(), msg.retries || 0, JSON.stringify(msg)]
  );
}

export async function dbGetPending(conversationId) {
  if (isWeb || !_db) return [];
  const rows = conversationId
    ? await _db.getAllAsync('SELECT raw_json FROM pending_messages WHERE conversation_id = ? ORDER BY created_at', [conversationId])
    : await _db.getAllAsync('SELECT raw_json FROM pending_messages ORDER BY created_at');
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

export async function dbRemovePending(tempId) {
  if (isWeb || !_db) return;
  await _db.runAsync('DELETE FROM pending_messages WHERE temp_id = ?', [tempId]);
}

// ══════════════════════════════════════
// SEARCH (full-text across messages)
// ══════════════════════════════════════

export async function dbSearchMessages(query, limit = 50) {
  if (isWeb || !_db || !query) return [];
  const q = `%${query}%`;
  const rows = await _db.getAllAsync(
    'SELECT raw_json FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?', [q, limit]
  );
  return rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
}

// ══════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════

export async function dbClearAll() {
  if (isWeb || !_db) return;
  await _db.execAsync(`
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM contacts;
    DELETE FROM emails;
    DELETE FROM calendar_events;
    DELETE FROM files;
    DELETE FROM settings;
    DELETE FROM sync_state;
    DELETE FROM pending_messages;
  `);
}

export async function dbGetStats() {
  if (isWeb || !_db) return {};
  const [msgs, convs, contacts, emails, events, files] = await Promise.all([
    _db.getFirstAsync('SELECT COUNT(*) as c FROM messages'),
    _db.getFirstAsync('SELECT COUNT(*) as c FROM conversations'),
    _db.getFirstAsync('SELECT COUNT(*) as c FROM contacts'),
    _db.getFirstAsync('SELECT COUNT(*) as c FROM emails'),
    _db.getFirstAsync('SELECT COUNT(*) as c FROM calendar_events'),
    _db.getFirstAsync('SELECT COUNT(*) as c FROM files'),
  ]);
  return {
    messages: msgs?.c || 0,
    conversations: convs?.c || 0,
    contacts: contacts?.c || 0,
    emails: emails?.c || 0,
    events: events?.c || 0,
    files: files?.c || 0,
  };
}

// Auto-init on import
initDatabase();
