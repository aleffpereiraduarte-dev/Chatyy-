// Chatyy Local Database — instant offline data (like WhatsApp)
// Web: IndexedDB (fast, large storage, queryable)
// Native: expo-sqlite (iOS/Android)
// All public functions work on any platform

import { Platform } from 'react-native';

// ═══════════════════════════════════════════
// IndexedDB Layer (Web) — cache everything locally
// ═══════════════════════════════════════════
const IDB_NAME = 'chatyy_v2';
// v4 (2026-05-16): add `local_seq` + `client_temp_id` to the messages store so
// the SQLite-first chat migration (Stage 1) has parity with native. The
// messages object store gets two new indexes; existing rows survive — only the
// schema bumps. Older builds opening v4 just see the new fields as undefined.
const IDB_VERSION = 4;
let _idb = null;

function getIDB() {
  if (_idb) return Promise.resolve(_idb);
  if (Platform.OS !== 'web' || typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        const tx = e.target.transaction;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('emails')) {
          const s = d.createObjectStore('emails', { keyPath: '_cid' });
          s.createIndex('folder', 'folder', { unique: false });
        }
        if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
        let msgStore;
        if (!d.objectStoreNames.contains('messages')) {
          msgStore = d.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('cid', 'conversation_id', { unique: false });
        } else if (tx) {
          msgStore = tx.objectStore('messages');
        }
        // v3 → v4: add local_seq + client_temp_id indexes on messages.
        // local_seq is monotonic per conversation for optimistic ordering;
        // client_temp_id is the dedup key when a server new_message rolls in.
        if (msgStore && !msgStore.indexNames.contains('local_seq')) {
          try { msgStore.createIndex('local_seq', ['conversation_id', 'local_seq'], { unique: false }); } catch {}
        }
        if (msgStore && !msgStore.indexNames.contains('client_temp_id')) {
          try { msgStore.createIndex('client_temp_id', 'client_temp_id', { unique: false }); } catch {}
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

// ── Diagnostic: surface IDB cache footprint for settings/debug UI ──
// Roughly estimates the size of the chat-cache portion of IndexedDB so
// the user (or QA) can see "how persistent" the local copy is. WhatsApp
// Web shows nothing — but Chrome's storage quota is per-origin, so a
// runaway thread can hit 50MB-1GB and silently push the browser into
// LRU eviction. Surfacing the number lets us call evictOldestConversations()
// proactively before the browser does it for us.
//
// Native: returns nulls. The SQLite path has its own bookkeeping via
// PRAGMA page_count * page_size in db.js. We only count IDB so the
// number reflects the *web-specific* persistence problem.
export async function getCacheSize() {
  if (Platform.OS !== 'web') {
    return { conversations: 0, messages: 0, emails: 0, sizeBytes: 0, quotaBytes: 0, web: false };
  }
  const out = { conversations: 0, messages: 0, emails: 0, sizeBytes: 0, quotaBytes: 0, web: true };
  try {
    const d = await getIDB();
    if (!d) return out;
    // Count rows per store. `count()` is O(1) on IDB so this is cheap.
    out.conversations = await new Promise((r) => {
      try {
        const req = d.transaction('conversations', 'readonly').objectStore('conversations').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
    out.messages = await new Promise((r) => {
      try {
        const req = d.transaction('messages', 'readonly').objectStore('messages').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
    out.emails = await new Promise((r) => {
      try {
        const req = d.transaction('emails', 'readonly').objectStore('emails').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
  } catch {}
  // Browser storage estimate covers all origin storage (IDB + Cache API +
  // localStorage). Not exactly "chat cache size" but close enough for a
  // settings indicator; the alternative (serialize every row) would be
  // O(N) and slow.
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      out.sizeBytes = est?.usage || 0;
      out.quotaBytes = est?.quota || 0;
    }
  } catch {}
  return out;
}

// Pinned conversations should never be evicted (Whatsapp-style: a chat
// the user pinned is "important", and evicting it means a blank thread
// on next open). We treat `is_pinned`, `pinned`, or `pinned_at` as
// pin signals — backend has used all three at various points.
function _isPinnedConv(c) {
  if (!c) return false;
  return Boolean(c.is_pinned || c.pinned || c.pinned_at);
}

// LRU eviction: drop oldest non-pinned conversations (and their messages)
// when total origin storage exceeds `maxBytes`. Default 100 MB. Returns
// the number of conversations evicted.
//
// The estimate is coarse — `navigator.storage.estimate()` reports the
// whole origin, not just IDB — but the chat cache is by far the
// dominant consumer in practice (avatars + media are on the CDN, not in
// IDB). The 100 MB cap is comfortably under the smallest browser quota
// we've seen in the wild (~200 MB on Safari private mode) so we evict
// well before the browser does its own surprise eviction.
export async function evictOldestConversations(maxBytes = 100 * 1024 * 1024, targetBytes = 80 * 1024 * 1024) {
  if (Platform.OS !== 'web') return 0;
  try {
    const sz = await getCacheSize();
    if (!sz.sizeBytes || sz.sizeBytes <= maxBytes) return 0;
    const d = await getIDB();
    if (!d) return 0;
    // Pull every conversation, sort oldest-activity first, drop until
    // we're under `targetBytes` or we run out of non-pinned rows.
    const convs = await new Promise((r) => {
      try {
        const req = d.transaction('conversations', 'readonly').objectStore('conversations').getAll();
        req.onsuccess = () => r(req.result || []);
        req.onerror = () => r([]);
      } catch { r([]); }
    });
    convs.sort((a, b) => {
      const ta = Date.parse(a.last_message_at || a.updated_at || 0) || 0;
      const tb = Date.parse(b.last_message_at || b.updated_at || 0) || 0;
      return ta - tb; // oldest first
    });
    let evicted = 0;
    for (const c of convs) {
      if (_isPinnedConv(c)) continue;
      // Delete conversation row + all messages indexed by `cid`.
      try {
        const tx = d.transaction(['conversations', 'messages'], 'readwrite');
        tx.objectStore('conversations').delete(c.id);
        const msgStore = tx.objectStore('messages');
        const cursorReq = msgStore.index('cid').openCursor(IDBKeyRange.only(c.id));
        await new Promise((r) => {
          cursorReq.onsuccess = (e) => {
            const cur = e.target.result;
            if (cur) { try { cur.delete(); } catch {} cur.continue(); }
            else r();
          };
          cursorReq.onerror = () => r();
        });
      } catch {}
      evicted++;
      // Re-check size every 10 conversations — bailing early avoids
      // gratuitous deletion if a few large threads were the culprit.
      if (evicted % 10 === 0) {
        try {
          const newSz = await getCacheSize();
          if (newSz.sizeBytes && newSz.sizeBytes <= targetBytes) break;
        } catch {}
      }
    }
    return evicted;
  } catch {
    return 0;
  }
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
  // Schema unification (2026-05-19): db.js is the SINGLE owner of
  // `conversations` + `messages`. Removing the CREATE TABLE blocks here
  // closes a race where whichever module's init won determined the
  // column shape — the loser's INSERTs then failed silently and ~50%
  // of messages went missing on the device. db.js's init runs on import
  // (see end of db.js), so by the time anything in this file calls
  // saveMessage/saveMessages those tables already exist with the
  // unified superset schema. We keep this file's `offline_queue` and
  // `sync_state` creations because those are localDb-exclusive.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

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

    -- localDb key-value sync table. Renamed from sync_state (which
    -- db.js also owns with a different schema: table_name, last_sync,
    -- last_id, version) to avoid the same CREATE-IF-NOT-EXISTS race that
    -- bled messages. Both modules can now coexist without stepping on
    -- each other. All localDb sync_state helpers below target this
    -- table; db.js dbGetSyncState/dbSetSyncState target the other one.
    CREATE TABLE IF NOT EXISTS sync_state_kv (
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

  // Run additive schema migrations for THIS module's tables (sync_state,
  // offline_queue, etc.). The `messages` table is now owned by db.js — its
  // migrations + FTS5 + indices are wired there. Don't recreate triggers
  // here or they'll collide with db.js's `messages_fts_*` triggers.
  await _runMigrations();
}

// ---------------------------------------------------------------------------
// 2.5 Schema Migrations (additive ALTERs, indexed by PRAGMA user_version)
// ---------------------------------------------------------------------------
//
// Bump CURRENT_DB_VERSION whenever a new migration step is added. Every step
// is idempotent — ALTER TABLE wrapped in try/catch so re-running on a partially
// migrated DB is safe (SQLite throws "duplicate column" but we ignore it).
//
//   v1 (2026-05-16) — SQLite-first chat migration Stage 1:
//                     add `local_seq`, `client_temp_id`, `pending_state` to
//                     messages so optimistic ordering + dedup + outbox state
//                     all live in one row. See native_call_full_rewrite_plan.
//
const CURRENT_DB_VERSION = 1;

async function _runMigrations() {
  if (!db) return;
  let from = 0;
  try {
    const row = await db.getFirstAsync('PRAGMA user_version');
    // expo-sqlite returns { user_version: N } as the first column
    from = (row && (row.user_version ?? row['user_version'])) | 0;
  } catch {}
  if (from >= CURRENT_DB_VERSION) return;

  // --- v0 → v1 ---
  // 2026-05-19: db.js now owns the `messages` table and its column shape,
  // so these ALTERs are best-effort no-ops on a healthy install (db.js's
  // CREATE TABLE already includes the columns). We keep them here for the
  // narrow case where an older build's `messages` table somehow predates
  // db.js's unified shape — the ADD COLUMN backfills the rest.
  if (from < 1) {
    const alters = [
      "ALTER TABLE messages ADD COLUMN local_seq INTEGER DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN client_temp_id TEXT",
      "ALTER TABLE messages ADD COLUMN pending_state TEXT", // null | 'pending' | 'failed' | 'sent'
    ];
    for (const sql of alters) {
      try { await db.execAsync(sql); }
      catch (e) {
        const msg = String(e?.message || '');
        if (!/duplicate column/i.test(msg) && !/no such table/i.test(msg)) {
          console.warn('[localDb] migration v1 ALTER failed:', msg);
        }
      }
    }
  }

  try { await db.execAsync(`PRAGMA user_version = ${CURRENT_DB_VERSION}`); } catch {}
  console.log('[localDb] migrated', from, '→', CURRENT_DB_VERSION);
}

// ---------------------------------------------------------------------------
// 2.6 Optimistic ordering — per-conversation monotonic local sequence
// ---------------------------------------------------------------------------

// Returns max(local_seq)+1 for the given conversation. Used by every send
// path to assign a stable order to optimistic rows BEFORE the server has
// a chance to issue a real id/sync_seq. Web returns 0 (web uses IndexedDB
// timestamps instead — see webSaveMessages).
export async function getNextLocalSeq(conversationId) {
  if (Platform.OS === 'web') return 0;
  if (!conversationId && conversationId !== 0) return 0;
  try {
    await _ensureDb();
    const row = await db.getFirstAsync(
      'SELECT MAX(local_seq) AS max_seq FROM messages WHERE conversation_id = ?',
      conversationId
    );
    const cur = (row && (row.max_seq ?? row['max_seq'])) | 0;
    return cur + 1;
  } catch (e) {
    console.warn('[localDb] getNextLocalSeq:', e?.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 3. Conversations
// ---------------------------------------------------------------------------

export async function getConversations() {
  if (Platform.OS === 'web') return null; // caller falls back to cache
  try {
    await _ensureDb();
    // Delegate to db.js — it owns the conversations table. dbGetConversations
    // parses raw_json so callers get the full object instead of just the
    // column subset this module used to project.
    const dbMod = require('./db');
    if (dbMod && typeof dbMod.dbGetConversations === 'function') {
      return await dbMod.dbGetConversations(true);
    }
    // Last-resort fallback: raw SELECT (covers misconfigured envs where
    // db.js isn't loaded — shouldn't happen on device).
    return await db.getAllAsync(
      'SELECT * FROM conversations ORDER BY last_message_time DESC'
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
    // Delegate to db.js (single owner of the conversations table). db.js's
    // schema uses last_message_time / last_message instead of this module's
    // historical last_message_at / last_message_content — dbSaveConversations
    // already normalizes via raw_json so the original payload is preserved.
    const dbMod = require('./db');
    if (dbMod && typeof dbMod.dbSaveConversations === 'function') {
      await dbMod.dbSaveConversations(conversations);
    }
  } catch (e) {
    console.warn('[localDb] saveConversations:', e?.message);
  }
}

// Stage 1 invariant: deleting messages from local SQLite is only allowed when
//   (a) the conversation itself is being deleted, OR
//   (b) the user explicitly long-pressed → Delete a message, OR
//   (c) a disappearing-timer expired for that row.
// This call falls under (a). Do NOT add a "trim server-out-of-sync rows" or
// similar pruning here — local is the source of truth, server is a sync
// target. If you need to clear stale rows, use `clearLocalDb()` at logout.
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

// WhatsApp-style "Clear chat history": wipes only the messages for a
// conversation while keeping the conversation row + pin/mute/folder
// settings intact. Backend sets cleared_at server-side; this kills the
// local cache so the chat doesn't repopulate from device storage on
// next open.
export async function clearConversationMessages(id) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', id);
  } catch (e) {
    console.warn('[localDb] clearConversationMessages:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Messages
// ---------------------------------------------------------------------------

/**
 * Search all locally-cached messages (FTS5 when available, LIKE fallback).
 * Returns rows sorted by recency. Query supports phrase quoting ("hello world")
 * and prefix search (hello*) natively via FTS5.
 */
export async function searchMessagesFTS(query, limit = 50, conversationId = null) {
  if (Platform.OS === 'web' || !query || !query.trim()) return [];
  try {
    await _ensureDb();
    const q = query.trim();
    try {
      const sql = conversationId
        ? `SELECT m.* FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ? AND m.conversation_id = ? AND m.deleted_at IS NULL
           ORDER BY m.id DESC LIMIT ?`
        : `SELECT m.* FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
           ORDER BY m.id DESC LIMIT ?`;
      const args = conversationId
        ? [q, conversationId, limit]
        : [q, limit];
      return await db.getAllAsync(sql, ...args);
    } catch {
      const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
      const sql = conversationId
        ? `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' AND conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`
        : `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`;
      const args = conversationId ? [like, conversationId, limit] : [like, limit];
      return await db.getAllAsync(sql, ...args);
    }
  } catch (e) {
    console.warn('[localDb] searchMessagesFTS:', e?.message);
    return [];
  }
}

export async function getMessages(conversationId, limit = 50, beforeId = null) {
  if (Platform.OS === 'web') return null;
  try {
    await _ensureDb();
    // Delegate to db.js — single owner of messages table. dbGetMessages
    // already parses raw_json and orders chronologically.
    const dbMod = require('./db');
    if (dbMod && typeof dbMod.dbGetMessages === 'function') {
      return await dbMod.dbGetMessages(conversationId, limit, beforeId);
    }
    // Fallback — shouldn't be hit on device.
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
    // Delegate to db.js — single owner of messages table. dbSaveMessages
    // persists the full superset (raw_json + columns) atomically.
    const dbMod = require('./db');
    if (dbMod && typeof dbMod.dbSaveMessages === 'function') {
      await dbMod.dbSaveMessages(conversationId, messages);
    }
  } catch (e) {
    console.error('[localDb] saveMessages:', e?.message);
    try { require('./crashReporter').reportCrash?.({ type: 'persistence_error', context: 'localDb_saveMessages', message: `conv=${conversationId} n=${messages?.length} ${e?.message}`, stack: e?.stack }); } catch {}
  }
}

export async function saveMessage(msg) {
  if (Platform.OS === 'web' || !msg?.id || String(msg.id).startsWith('tmp_')) return;
  try {
    await _ensureDb();
    // Dedup step (still local to this module since it's a write-side concern):
    // if this server row carries a client_temp_id and an optimistic row with
    // that temp id is already in SQLite (from a previous build / cache), we
    // delete it BEFORE the upsert so the thread doesn't show duplicates.
    // local_seq carries over so ordering is stable across the swap.
    const ctid = msg.client_temp_id || msg.client_message_id || null;
    let localSeq = msg.local_seq != null ? msg.local_seq : null;
    if (ctid) {
      try {
        const existing = await db.getFirstAsync(
          'SELECT id, local_seq FROM messages WHERE client_temp_id = ? LIMIT 1',
          ctid
        );
        if (existing && String(existing.id) !== String(msg.id)) {
          if (localSeq == null) localSeq = existing.local_seq;
          await db.runAsync('DELETE FROM messages WHERE id = ?', existing.id);
        } else if (existing && localSeq == null) {
          localSeq = existing.local_seq;
        }
      } catch {}
    }
    // Delegate the actual upsert to db.js — same table, same connection
    // (shared `chatyy.db` file), but db.js's `dbSaveMessages` writes the
    // FULL superset of columns (including raw_json which dbGetMessages
    // depends on). Writing through dbSaveMessages keeps optimistic-send
    // rows discoverable by every reader path in the app.
    const dbMod = require('./db');
    if (dbMod && typeof dbMod.dbSaveMessages === 'function') {
      const enriched = {
        ...msg,
        sync_seq: msg.sync_seq || 0,
        local_seq: localSeq != null ? localSeq : 0,
        client_temp_id: ctid,
        pending_state: 'sent',
      };
      await dbMod.dbSaveMessages(msg.conversation_id, [enriched]);
    }
  } catch (e) {
    console.error('[localDb] saveMessage:', e?.message);
    try { require('./crashReporter').reportCrash?.({ type: 'persistence_error', context: 'localDb_saveMessage', message: `id=${msg?.id} ctid=${msg?.client_temp_id || msg?.client_message_id} ${e?.message}`, stack: e?.stack }); } catch {}
  }
}

// Persist an optimistic chat-send intent to SQLite BEFORE the network call.
// Stage 1 invariant: local SQLite is the source of truth, server is delivery.
//
// Why offline_queue instead of `messages`? The messages.id column is INTEGER
// PRIMARY KEY (= rowid alias), so a tmp_… string would coerce to 0 and every
// optimistic row would collide. The queue captures the durable intent +
// payload; when the server acks, saveMessage() inserts the confirmed row in
// `messages` keyed by the server id, with client_temp_id carrying the dedup
// link back to the queue entry.
//
//   msg.id              — caller-generated temp id (e.g. 'tmp_…'). Required.
//   msg.client_temp_id  — dedup key the server echoes back. Defaults to id.
//   msg.conversation_id — required.
//   pendingState        — 'pending' (in-flight) | 'failed' (will retry).
//
// Returns { id, local_seq, client_temp_id, queue_id } so the caller can hand
// the assigned local_seq to the UI for stable ordering.
export async function saveLocalMessage(msg, pendingState = 'pending') {
  if (Platform.OS === 'web' || !msg?.id || !msg.conversation_id) return null;
  try {
    await _ensureDb();
    const localSeq = msg.local_seq != null
      ? msg.local_seq
      : await getNextLocalSeq(msg.conversation_id);
    const ctid = msg.client_temp_id || String(msg.id);
    const payload = {
      temp_id: msg.id,
      conversation_id: msg.conversation_id,
      sender_email: msg.sender_email || msg.sender || null,
      content: msg.content || null,
      type: msg.type || 'text',
      file_url: msg.file_url || null,
      reply_to_id: msg.reply_to_id || null,
      client_temp_id: ctid,
      client_message_id: ctid,
      local_seq: localSeq,
      pending_state: pendingState,
      created_at: msg.created_at || new Date().toISOString(),
    };
    const res = await db.runAsync(
      'INSERT INTO offline_queue (action, payload, created_at) VALUES (?, ?, ?)',
      'chat_send',
      JSON.stringify(payload),
      payload.created_at
    );
    return {
      id: msg.id,
      local_seq: localSeq,
      client_temp_id: ctid,
      queue_id: res?.lastInsertRowId || null,
    };
  } catch (e) {
    console.error('[localDb] saveLocalMessage:', e?.message);
    try { require('./crashReporter').reportCrash?.({ type: 'persistence_error', context: 'localDb_saveLocalMessage', message: `id=${msg?.id} ${e?.message}`, stack: e?.stack }); } catch {}
    return null;
  }
}

// Mark a previously optimistic queue entry as failed (server rejected / net
// down) so the outbox drainer + UI know to retry. Does NOT delete — Stage 1
// rule: pending intent survives until user explicitly retries or deletes.
export async function markMessageFailed(tempId, errorMsg = null) {
  if (Platform.OS === 'web' || !tempId) return;
  try {
    await _ensureDb();
    await db.runAsync(
      `UPDATE offline_queue
         SET retries = retries + 1,
             last_error = ?
       WHERE action = 'chat_send'
         AND payload LIKE ?`,
      errorMsg ? String(errorMsg).slice(0, 500) : 'unknown',
      '%"temp_id":"' + String(tempId).replace(/"/g, '') + '"%'
    );
  } catch (e) {
    console.warn('[localDb] markMessageFailed:', e?.message);
  }
}

// Called after the server acks an optimistic send — removes the matching
// queue row(s) so we don't keep retrying a message that already landed.
// Match on temp_id OR client_temp_id in the JSON payload (both stored).
export async function clearPendingSend(tempIdOrCtid) {
  if (Platform.OS === 'web' || !tempIdOrCtid) return;
  try {
    await _ensureDb();
    const needle = String(tempIdOrCtid).replace(/"/g, '');
    await db.runAsync(
      `DELETE FROM offline_queue
        WHERE action = 'chat_send'
          AND (payload LIKE ? OR payload LIKE ?)`,
      '%"temp_id":"' + needle + '"%',
      '%"client_temp_id":"' + needle + '"%'
    );
  } catch (e) {
    console.warn('[localDb] clearPendingSend:', e?.message);
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
    const allowed = ['content', 'edited_at', 'read_at', 'deleted_at', 'type', 'file_url', 'sync_seq', 'local_seq', 'client_temp_id', 'pending_state'];
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
      "SELECT value FROM sync_state_kv WHERE key = 'last_sync_seq'"
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
      "INSERT OR REPLACE INTO sync_state_kv (key, value) VALUES ('last_sync_seq', ?)",
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
      'SELECT value FROM sync_state_kv WHERE key = ?', key
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
      'INSERT OR REPLACE INTO sync_state_kv (key, value) VALUES (?, ?)',
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
      DELETE FROM sync_state_kv;
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

// WhatsApp-invisible-sync (2026-05-18): chat is now push-only (WS events
// + envelope pull + per-conv pts on open) so it's excluded from this
// catch-up. Email/calendar/contacts still benefit from a delta pull on
// foreground / reconnect because IMAP+CalDAV don't push to the client
// directly. Other surfaces (feed/drive/docs/notes/meet/notifications)
// are lazy — they load when the user navigates there, so we skip them
// here unless explicitly requested.
const DEFAULT_SURFACES = 'email,calendar,contacts';

export async function fullDeltaSync(apiCall, opts = {}) {
  if (Platform.OS === 'web') return;
  try {
    await _ensureDb();
    const lastSeq = await getLastSyncSeq();
    // `surfaces` overrides the default if a caller explicitly opts in
    // (e.g. a "full refresh" gesture in settings).
    const types = (opts && typeof opts.surfaces === 'string' && opts.surfaces.length)
      ? opts.surfaces
      : DEFAULT_SURFACES;

    // ⚠️ NON-FUNCTIONAL (2026-06-28): this multi-surface delta sync was wired to
    // a unified `app_sync`/`chat_sync` endpoint that takes {since_seq, types} and
    // returns {emails, contacts, calendar_events, ..., sync_seq}. That backend
    // endpoint was NEVER implemented. The live `chat_sync` handler (chat.php
    // case 'chat_sync', ~21970) is the Telegram-style PER-CONVERSATION pts sync:
    // it reads `$input['conversations'] = [{id, since_pts, limit}]` and returns
    // ONLY {conversations:[{events, messages, latest_pts, has_more}]}. Calling it
    // with {since_seq, types, limit} makes the server see an EMPTY conversations
    // array → it returns nothing → res.emails / res.contacts / res.calendar_events
    // are always undefined → email/calendar/contacts delta has been a SILENT
    // no-op. `app_sync` is not routed anywhere in api/*.php (only named in a
    // sync.php doc comment), so there is no correct endpoint to point at yet —
    // the unified delta endpoint must be built server-side first. Bail out here
    // so we stop firing a contract-wrong request on every foreground/reconnect.
    // Email, calendar and contacts still hydrate via each screen's own fetch.
    // NOTE: keep `incrementalSync` (app_sync) in mind — it shares the same gap.
    return;

    // eslint-disable-next-line no-unreachable
    const res = await apiCall('chat_sync', {
      since_seq: lastSeq,
      types,
      limit: 1000
    });

    if (!res?.success) return;

    // Chat (conversations + messages) — only applied if the caller
    // explicitly requested 'chat' in `surfaces`. Default path skips it
    // because the WS handler already saves messages via applyRealtimeEvent
    // and per-conv pts catch-up runs on open / reconnect.
    if (types.indexOf('chat') >= 0) {
      if (res.conversations?.length) await saveConversations(res.conversations);
      if (res.messages?.length) {
        for (const m of res.messages) {
          if (m.deleted_at) await deleteMessage(m.id); else await saveMessage(m);
        }
      }
    }
    if (res.contacts?.length) await saveContacts(res.contacts);
    if (res.emails?.length) await saveEmails('INBOX', res.emails);
    if (types.indexOf('feed') >= 0 && res.feed_posts?.length) await saveFeedPosts(res.feed_posts);
    if (res.calendar_events?.length) await saveCalendarEvents(res.calendar_events);
    if (types.indexOf('drive') >= 0 && res.drive_files?.length) await saveDriveFiles(res.drive_files);
    if (types.indexOf('docs') >= 0 && res.documents?.length) await saveDocuments(res.documents);
    if (types.indexOf('notes') >= 0 && res.notes?.length) await saveNotes(res.notes);
    if (types.indexOf('notifications') >= 0 && res.notifications?.length) await saveNotifications(res.notifications);
    if (types.indexOf('meet') >= 0 && res.meeting_rooms?.length) await saveMeetingRooms(res.meeting_rooms);
    if (res.user_profiles?.length) await saveUserProfiles(res.user_profiles);

    if (res.sync_seq) await setLastSyncSeq(res.sync_seq);

    // Replay offline queue while we're at it
    await replayOfflineQueue(apiCall);

    console.log('[localDb] fullDeltaSync done, seq:', res.sync_seq, 'surfaces:', types);
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
