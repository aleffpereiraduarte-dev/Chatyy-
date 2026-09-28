// Chatyy SQLite Store — SYNCHRONOUS companion over the existing `chatyy.db`.
//
// WHY THIS EXISTS (read before changing):
//   The durable, full-history chat store is ALREADY `services/db.js` — it opens
//   `chatyy.db` with expo-sqlite's *async* handle (openDatabaseAsync) and owns
//   the `messages` schema, migrations, FTS5 and media columns. `chatCache.js`
//   write-through and `smartChatCache.js` (in-memory/MMKV instant paint) sit on
//   top of it. So SQLite is already the durable layer behind SmartCache.
//
//   The one thing db.js CANNOT do is a *synchronous* read: openDatabaseAsync
//   only exposes getAllAsync/getFirstAsync. That means when a conversation is
//   opened cold — beyond SmartCache's in-memory window (older history, or before
//   MMKV has warmed at splash) — the full history has to be fetched through an
//   `await getCachedMessages(...)` inside a useEffect, which paints one frame
//   late (a visible skeleton flash, "demora abrir").
//
//   expo-sqlite 55 exposes a *synchronous* handle (openDatabaseSync +
//   getAllSync/getFirstSync/runSync). This module opens the SAME `chatyy.db`
//   file with that sync handle and exposes `getMessagesSync()` so the chat
//   screen can paint the FULL local history from frame 1 — Telegram/WhatsApp
//   style, zero async gap, works fully offline.
//
// DESIGN RULES:
//   - Same DB file (`chatyy.db`) + same `messages` table as db.js. We do NOT
//     create a second database (that would double storage + drift schema).
//   - db.js OWNS the schema/migrations. This module NEVER migrates. Reads only
//     touch base columns that have existed since the first CREATE TABLE
//     (id, conversation_id, created_at, local_path, type, raw_json), so they
//     are safe regardless of migration state. If the table isn't there yet
//     (very first launch, pre-init), reads return [] gracefully.
//   - WAL mode (set by db.js) allows many concurrent readers + one writer, so a
//     second read connection is safe. We also set busy_timeout so the rare
//     write never throws SQLITE_BUSY — it just waits.
//   - Native only. On web (IndexedDB via localDb.js) every function is a no-op
//     returning empty/false so callers need no Platform guards.
//
// PUBLIC API:
//   getMessagesSync(convId, limit?, beforeId?)  → Message[] oldest→newest (parsed)
//   getLastMessageIdSync(convId)                → number
//   getSyncStatsSync()                          → { msgsTotal, mediaTotal, ... } | null
//   upsertMessagesSync(convId, messages)        → count written (best-effort)
//   setMediaLocalPathSync(msgId, localPath, d?) → boolean
//   isReady() / reset()

import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
const DB_NAME = 'chatyy.db'; // MUST match services/db.js

let SQLite = null;
if (!isWeb) {
  try { SQLite = require('expo-sqlite'); } catch { SQLite = null; }
}

let _db = null;        // sync handle
let _openTried = false; // don't retry a hard failure every call
let _tableOk = false;   // messages table confirmed present

// Media-bearing message types (mirrors db.js getSyncStats / getMissingMedia).
const MEDIA_TYPES = "'image','video','audio','voice','short_video','gif','sticker','file','document'";

// ─── Account-switch scope lock ──────────────────────────────────────────────
// Mirror smartChatCache: during an account switch chatCache raises a scope lock
// so no screen paints the previous user's rows. Return empty while locked.
let _scopeCheck = null;
function _isLocked() {
  try {
    if (!_scopeCheck) {
      const mod = require('./chatCache');
      _scopeCheck = (typeof mod?.isCacheScopeLocked === 'function') ? mod.isCacheScopeLocked : (() => false);
    }
    return _scopeCheck();
  } catch { return false; }
}

// ─── Lazy open ──────────────────────────────────────────────────────────────
function _getDb() {
  if (_db) return _db;
  if (isWeb || !SQLite || _openTried) return _db; // _db still null on prior failure
  _openTried = true;
  try {
    // openDatabaseSync opens the SAME file db.js opened async. Under WAL this is
    // a fully independent connection safe for concurrent reads.
    _db = SQLite.openDatabaseSync(DB_NAME);
    try {
      // Match db.js pragmas. WAL is a DB-level setting (already on from db.js);
      // re-asserting is harmless. busy_timeout is per-connection — set it so our
      // rare writes wait instead of throwing while db.js holds the write lock.
      _db.execSync('PRAGMA journal_mode = WAL;');
      _db.execSync('PRAGMA busy_timeout = 5000;');
      _db.execSync('PRAGMA foreign_keys = OFF;');
    } catch {}
    // Confirm the messages table exists (db.js may not have finished init on a
    // very first cold launch). If not, reads no-op until it does.
    try {
      const row = _db.getFirstSync(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
      );
      _tableOk = !!row;
    } catch { _tableOk = false; }
  } catch (e) {
    _db = null;
    if (__DEV__) console.warn('[sqliteStore] openDatabaseSync failed:', e?.message);
  }
  return _db;
}

// Re-check table presence cheaply if the first open lost the race with db.js
// init. Called on the read path so the first successful read "unlocks" writes.
function _ensureTable(db) {
  if (_tableOk) return true;
  try {
    const row = db.getFirstSync(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
    );
    _tableOk = !!row;
  } catch { _tableOk = false; }
  return _tableOk;
}

// ─── Reads (the reason this module exists) ──────────────────────────────────

/**
 * Synchronous full-history read for a conversation. Mirrors db.js dbGetMessages
 * exactly (same query, same raw_json parse, same oldest→newest ordering) but
 * WITHOUT the await — safe to call inside a `useState(() => ...)` initializer so
 * the thread paints from frame 1.
 *
 * @param {number|string} convId
 * @param {number} limit     newest N (default 50)
 * @param {number|null} beforeId  paginate: only rows with id < beforeId
 * @returns {object[]} parsed messages, oldest→newest. [] on any failure.
 */
export function getMessagesSync(convId, limit = 50, beforeId = null) {
  if (isWeb || convId == null) return [];
  if (_isLocked()) return []; // account switch in progress
  const db = _getDb();
  if (!db || !_ensureTable(db)) return [];
  let query = 'SELECT raw_json FROM messages WHERE conversation_id = ?';
  const params = [convId];
  if (beforeId) { query += ' AND id < ?'; params.push(beforeId); }
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  let rows;
  try {
    rows = db.getAllSync(query, params);
  } catch (e) {
    if (__DEV__) console.warn('[sqliteStore] getMessagesSync failed:', e?.message);
    return [];
  }
  const out = [];
  for (const r of rows) {
    if (!r || !r.raw_json) continue;
    try { out.push(JSON.parse(r.raw_json)); } catch {}
  }
  out.reverse(); // DESC → oldest-first for the list
  return out;
}

/** Highest server-confirmed message id we have locally (0 if none). */
export function getLastMessageIdSync(convId) {
  if (isWeb || convId == null) return 0;
  const db = _getDb();
  if (!db || !_ensureTable(db)) return 0;
  try {
    const row = db.getFirstSync(
      'SELECT MAX(id) AS max_id FROM messages WHERE conversation_id = ?', [convId]
    );
    return Number(row?.max_id || 0);
  } catch { return 0; }
}

/**
 * Cheap offline-backup progress counters (sync variant of db.js getSyncStats).
 * Suitable for a Settings tile / SyncBar without an await.
 */
export function getSyncStatsSync() {
  if (isWeb) return null;
  const db = _getDb();
  if (!db || !_ensureTable(db)) return null;
  try {
    const mTotal = db.getFirstSync('SELECT COUNT(*) AS n FROM messages');
    const mMedia = db.getFirstSync(
      `SELECT COUNT(*) AS n FROM messages WHERE type IN (${MEDIA_TYPES})`
    );
    const mDisk = db.getFirstSync(
      `SELECT COUNT(*) AS n FROM messages WHERE type IN (${MEDIA_TYPES}) AND local_path IS NOT NULL AND local_path <> ''`
    );
    const msgsTotal = Number(mTotal?.n || 0);
    const mediaTotal = Number(mMedia?.n || 0);
    const mediaOnDisk = Number(mDisk?.n || 0);
    return {
      msgsTotal,
      mediaTotal,
      mediaOnDisk,
      mediaPending: Math.max(0, mediaTotal - mediaOnDisk),
      mediaPercent: mediaTotal === 0 ? 100 : Math.floor((mediaOnDisk / mediaTotal) * 100),
    };
  } catch { return null; }
}

// ─── Writes (optional / best-effort) ────────────────────────────────────────
// The PRIMARY writer stays db.js (async, via chatCache write-through). These
// sync writers exist for callers that already run synchronously (e.g. an
// optimistic media-path stamp) and want the row durable immediately. They
// mirror db.js dbSaveMessages column-for-column so a later async INSERT OR
// REPLACE from fullHistorySync doesn't blank anything.

/**
 * Synchronous upsert of confirmed messages. Skips tmp_/optimistic ids (matches
 * db.js — those live only in SmartCache until the server confirms).
 * @returns {number} rows written
 */
export function upsertMessagesSync(convId, messages) {
  if (isWeb || !Array.isArray(messages) || messages.length === 0) return 0;
  const db = _getDb();
  if (!db || !_ensureTable(db)) return 0;
  let written = 0;
  try {
    db.execSync('BEGIN');
    const stmt = db.prepareSync(
      `INSERT OR REPLACE INTO messages
         (id, conversation_id, sender_email, sender_name, content, type,
          file_url, file_name, file_size, reply_to_id, message_id,
          read_at, edited_at, deleted, deleted_at, reactions, read_by,
          created_at, sync_seq, local_seq, client_temp_id, pending_state,
          local_path, media_width, media_height, media_duration, raw_json)
       VALUES
         ($id, $convId, $sender, $senderName, $content, $type,
          $fileUrl, $fileName, $fileSize, $replyTo, $messageId,
          $readAt, $edited, $deleted, $deletedAt, $reactions, $readBy,
          $created, $syncSeq, $localSeq, $clientTempId, $pendingState,
          $localPath, $mediaW, $mediaH, $mediaDur, $raw)`
    );
    try {
      for (const m of messages) {
        if (!m || m.id == null || String(m.id).startsWith('tmp_')) continue;
        stmt.executeSync({
          $id: m.id,
          $convId: convId || m.conversation_id,
          $sender: m.sender_email || m.sender || '',
          $senderName: m.sender_name || '',
          $content: m.content || '',
          $type: m.type || 'text',
          $fileUrl: m.file_url || '',
          $fileName: m.file_name || '',
          $fileSize: m.file_size || 0,
          $replyTo: m.reply_to_id || null,
          $messageId: m.message_id || null,
          $readAt: m.read_at || null,
          $edited: m.edited_at || null,
          $deleted: m.deleted ? 1 : 0,
          $deletedAt: m.deleted_at || null,
          $reactions: m.reactions ? JSON.stringify(m.reactions) : null,
          $readBy: m.read_by ? JSON.stringify(m.read_by) : null,
          $created: m.created_at || '',
          $syncSeq: m.sync_seq || 0,
          $localSeq: m.local_seq != null ? m.local_seq : 0,
          $clientTempId: m.client_temp_id || m.client_message_id || null,
          $pendingState: m.pending_state || 'sent',
          $localPath: m.local_path || m._localUri || null,
          $mediaW: m.media_width || (m.media && m.media.width) || null,
          $mediaH: m.media_height || (m.media && m.media.height) || null,
          $mediaDur: m.media_duration || (m.media && m.media.duration) || null,
          $raw: JSON.stringify(m),
        });
        written++;
      }
    } finally { stmt.finalizeSync(); }
    db.execSync('COMMIT');
  } catch (e) {
    try { db.execSync('ROLLBACK'); } catch {}
    if (__DEV__) console.warn('[sqliteStore] upsertMessagesSync failed:', e?.message);
    return 0;
  }
  return written;
}

/**
 * Stamp a media message's on-disk path (and optional dims) synchronously. Keeps
 * both the indexed `local_path` column AND the row's raw_json in sync so the
 * next getMessagesSync paints file:// offline. No-op if the row is missing.
 * @returns {boolean} true if a row was updated
 */
export function setMediaLocalPathSync(msgId, localPath, dims = null) {
  if (isWeb || msgId == null || !localPath) return false;
  const db = _getDb();
  if (!db || !_ensureTable(db)) return false;
  try {
    const row = db.getFirstSync('SELECT raw_json FROM messages WHERE id = ?', [msgId]);
    if (!row) return false;
    let merged = {};
    try { merged = JSON.parse(row.raw_json) || {}; } catch { merged = {}; }
    merged.local_path = localPath;
    if (dims) {
      if (dims.width != null) merged.media_width = dims.width;
      if (dims.height != null) merged.media_height = dims.height;
      if (dims.duration != null) merged.media_duration = dims.duration;
    }
    db.runSync(
      'UPDATE messages SET local_path = ?, media_width = COALESCE(?, media_width), media_height = COALESCE(?, media_height), media_duration = COALESCE(?, media_duration), raw_json = ? WHERE id = ?',
      [
        localPath,
        dims?.width ?? null,
        dims?.height ?? null,
        dims?.duration ?? null,
        JSON.stringify(merged),
        msgId,
      ]
    );
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[sqliteStore] setMediaLocalPathSync failed:', e?.message);
    return false;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
export function isReady() {
  if (isWeb) return false;
  const db = _getDb();
  return !!(db && _ensureTable(db));
}

/** Drop the cached handle (e.g. after a hard DB reset). Reopens lazily. */
export function reset() {
  try { _db?.closeSync?.(); } catch {}
  _db = null;
  _openTried = false;
  _tableOk = false;
}

export default {
  getMessagesSync,
  getLastMessageIdSync,
  getSyncStatsSync,
  upsertMessagesSync,
  setMediaLocalPathSync,
  isReady,
  reset,
};
