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
import { CREATE_CURSORS_SQL, CREATE_CHATSTORE_META_SQL, normAccount, acctClause } from './chatStore/schema';

const isWeb = Platform.OS === 'web';
const DB_NAME = 'chatyy.db'; // MUST match services/db.js

let SQLite = null;
if (!isWeb) {
  try { SQLite = require('expo-sqlite'); } catch { SQLite = null; }
}

let _db = null;        // sync handle
let _openTried = false; // don't retry a hard failure every call
let _tableOk = false;   // messages table confirmed present
let _cursorsOk = false; // cursors table ensured present
let _hasAccountColCache = null; // null=unknown, true/false once probed

// ── Multi-account isolation ──────────────────────────────────────────────────
// Active account email. When set (via the facade's setActiveAccount, wired from
// AuthContext), every sync read filters by `account_email = ?` and every sync
// write stamps it. Defaults '' → no filtering / no stamping → identical to the
// pre-isolation behaviour until AuthContext wires it.
let _activeAccount = '';
export function setActiveAccount(email) { _activeAccount = normAccount(email); }
export function getActiveAccount() { return _activeAccount; }
// [2026-10-07 bgsync] Device legacy owner — also sees account_email IS NULL rows
// (see chatStore/schema.js acctClause).
let _legacyOwner = '';
export function setLegacyOwner(email) { _legacyOwner = normAccount(email); }
export function getLegacyOwner() { return _legacyOwner; }

// Probe (once) whether the shared messages table already carries the
// account_email column db.js adds at init. Reads/writes only reference the
// column when it truly exists, so a sync call that races db.js's ALTER never
// throws — it just runs unscoped for that one frame.
function _hasAccountCol(db) {
  if (_hasAccountColCache != null) return _hasAccountColCache;
  try {
    const cols = db.getAllSync('PRAGMA table_info(messages)') || [];
    _hasAccountColCache = cols.some(c => c && c.name === 'account_email');
  } catch { _hasAccountColCache = false; }
  return _hasAccountColCache;
}
function _acctFilter(db) {
  // Returns { sql, params } fragment to AND into a messages query, or empty.
  if (_activeAccount && _hasAccountCol(db)) return acctClause(_activeAccount, _legacyOwner);
  return { sql: '', params: [] };
}

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
  const af = _acctFilter(db);
  if (af.sql) { query += af.sql; params.push(...af.params); }
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
    const af = _acctFilter(db);
    const row = db.getFirstSync(
      `SELECT MAX(id) AS max_id FROM messages WHERE conversation_id = ?${af.sql}`,
      [convId, ...af.params]
    );
    return Number(row?.max_id || 0);
  } catch { return 0; }
}

/**
 * Synchronous conversation-list read (mirrors db.js dbGetConversations). Reads
 * the shared `conversations` table ordered by last-message time DESC and
 * returns parsed rows. Honors the account scope + cache-scope lock and returns
 * [] on any failure / while locked so a cold ChatList paints from frame 1
 * without ever surfacing another account's rows.
 * @returns {object[]} parsed conversations (pinned first, newest first)
 */
export function getConversationsSync() {
  if (isWeb) return [];
  if (_isLocked()) return []; // account switch in progress
  const db = _getDb();
  if (!db) return [];
  // Confirm the conversations table is present (db.js may not have finished
  // init on a very first cold launch).
  try {
    const t = db.getFirstSync(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
    );
    if (!t) return [];
  } catch { return []; }
  let where = 'WHERE archived = 0';
  const params = [];
  if (_activeAccount && _hasAccountColConv(db)) {
    const ac = acctClause(_activeAccount, _legacyOwner);
    where += ac.sql; params.push(...ac.params);
  }
  let rows;
  try {
    rows = db.getAllSync(
      `SELECT raw_json FROM conversations ${where} ORDER BY pinned DESC, last_message_time DESC LIMIT 200`,
      params
    );
  } catch (e) {
    if (__DEV__) console.warn('[sqliteStore] getConversationsSync failed:', e?.message);
    return [];
  }
  const out = [];
  for (const r of rows) {
    if (!r || !r.raw_json) continue;
    try { out.push(JSON.parse(r.raw_json)); } catch {}
  }
  return out;
}

// conversations has its own account_email column (added by db.js). Probe once.
let _hasAccountColConvCache = null;
function _hasAccountColConv(db) {
  if (_hasAccountColConvCache != null) return _hasAccountColConvCache;
  try {
    const cols = db.getAllSync('PRAGMA table_info(conversations)') || [];
    _hasAccountColConvCache = cols.some(c => c && c.name === 'account_email');
  } catch { _hasAccountColConvCache = false; }
  return _hasAccountColConvCache;
}

// ── Delta-sync cursor (native, synchronous) ──────────────────────────────────
// Ensure the cursors table exists. db.js also creates it during init; we
// idempotently CREATE TABLE IF NOT EXISTS here so a sync setCursor in the
// pre-init window still works. Never drops/alters anything.
function _ensureCursors(db) {
  if (_cursorsOk) return true;
  try { db.execSync(CREATE_CURSORS_SQL); _cursorsOk = true; }
  catch (e) { if (__DEV__) console.warn('[sqliteStore] ensure cursors failed:', e?.message); _cursorsOk = false; }
  return _cursorsOk;
}

/**
 * Read a delta-sync cursor by scope. The facade namespaces `scope` with the
 * active account so accounts never collide. Always returns an object; zeros
 * when unset.
 * @returns {{scope:string,last_pts:number,last_msg_id:number,updated_at:?string}}
 */
export function getCursorSync(scope) {
  const empty = { scope: scope != null ? String(scope) : '', last_pts: 0, last_msg_id: 0, updated_at: null };
  if (isWeb || scope == null) return empty;
  const db = _getDb();
  if (!db || !_ensureCursors(db)) return empty;
  try {
    const row = db.getFirstSync(
      'SELECT scope, last_pts, last_msg_id, updated_at FROM cursors WHERE scope = ?', [String(scope)]
    );
    if (!row) return empty;
    return {
      scope: row.scope,
      last_pts: Number(row.last_pts || 0),
      last_msg_id: Number(row.last_msg_id || 0),
      updated_at: row.updated_at || null,
    };
  } catch (e) {
    if (__DEV__) console.warn('[sqliteStore] getCursorSync failed:', e?.message);
    return empty;
  }
}

/**
 * Upsert a delta-sync cursor. MONOTONIC — a watermark never moves backward, so
 * an out-of-order/stale write can't drag last_pts / last_msg_id down.
 * @returns {boolean} true on success
 */
export function setCursor(scope, cursor = {}) {
  if (isWeb || scope == null) return false;
  const db = _getDb();
  if (!db || !_ensureCursors(db)) return false;
  const lastPts = Number(cursor.last_pts || 0) || 0;
  const lastMsgId = Number(cursor.last_msg_id || 0) || 0;
  try {
    db.runSync(
      `INSERT INTO cursors (scope, last_pts, last_msg_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         last_pts = MAX(cursors.last_pts, excluded.last_pts),
         last_msg_id = MAX(cursors.last_msg_id, excluded.last_msg_id),
         updated_at = excluded.updated_at`,
      [String(scope), lastPts, lastMsgId, new Date().toISOString()]
    );
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[sqliteStore] setCursor failed:', e?.message);
    return false;
  }
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
  // Only reference account_email when the column truly exists (db.js adds it at
  // init). Keeps sync writes safe on a DB that hasn't finished migrating yet.
  const withAcct = _hasAccountCol(db);
  try {
    db.execSync('BEGIN');
    const stmt = db.prepareSync(
      `INSERT OR REPLACE INTO messages
         (id, conversation_id, sender_email, sender_name, content, type,
          file_url, file_name, file_size, reply_to_id, message_id,
          read_at, edited_at, deleted, deleted_at, reactions, read_by,
          created_at, sync_seq, local_seq, client_temp_id, pending_state,
          local_path, media_width, media_height, media_duration, raw_json${withAcct ? ', account_email' : ''})
       VALUES
         ($id, $convId, $sender, $senderName, $content, $type,
          $fileUrl, $fileName, $fileSize, $replyTo, $messageId,
          $readAt, $edited, $deleted, $deletedAt, $reactions, $readBy,
          $created, $syncSeq, $localSeq, $clientTempId, $pendingState,
          $localPath, $mediaW, $mediaH, $mediaDur, $raw${withAcct ? ', $account' : ''})`
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
          ...(withAcct ? { $account: m.account_email || _activeAccount || null } : {}),
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

// ─── [2026-10-07 bgsync] Legacy-owner resolution + raw handle ──────────────

function _metaGet(db, k) {
  try { db.execSync(CREATE_CHATSTORE_META_SQL); } catch { return null; }
  try { const r = db.getFirstSync('SELECT v FROM chatstore_meta WHERE k = ?', [k]); return r ? (r.v ?? null) : null; }
  catch { return null; }
}
function _metaSet(db, k, v) {
  try { db.runSync('INSERT OR REPLACE INTO chatstore_meta (k, v) VALUES (?, ?)', [k, String(v)]); return true; }
  catch { return false; }
}

/**
 * Decide (once per device) which account owns the pre-isolation rows
 * (account_email IS NULL). Recorded only when the device is known to have a
 * SINGLE signed-in account (deviceAccounts <= 1) and NULL conversation rows
 * exist — otherwise nobody adopts them (multi-account device → hidden, the
 * normal sync refills each account; privacy over convenience). Cheap: one
 * LIMIT 1 probe on the small `conversations` table, then a cached meta row.
 * @returns {string} the legacy owner ('' = none)
 */
export function resolveLegacyOwnerSync(email, deviceAccounts) {
  if (isWeb) return '';
  const acct = normAccount(email);
  const db = _getDb();
  if (!db || !acct) return '';
  const known = _metaGet(db, 'legacy_owner');
  if (known != null) return known === '-' ? '' : normAccount(known);
  if (!(Number.isFinite(deviceAccounts) && deviceAccounts <= 1)) return '';
  try {
    if (!_hasAccountColConv(db)) return '';
    const t = db.getFirstSync("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'");
    if (!t) return '';
    const r = db.getFirstSync('SELECT 1 AS x FROM conversations WHERE account_email IS NULL LIMIT 1');
    if (!r) { _metaSet(db, 'legacy_owner', '-'); return ''; }
  } catch { return ''; }
  _metaSet(db, 'legacy_owner', acct);
  return acct;
}

/** Raw sync handle (messages table present) for services/bgJournal.js. */
export function getSyncDb() {
  if (isWeb) return null;
  const db = _getDb();
  return db && _ensureTable(db) ? db : null;
}

/** Whether the shared tables carry account_email (probed once). */
export function hasAccountColumnsSync() {
  const db = _getDb();
  if (!db) return { messages: false, conversations: false };
  return { messages: _hasAccountCol(db), conversations: _hasAccountColConv(db) };
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
  _cursorsOk = false;
  _hasAccountColCache = null;
  _hasAccountColConvCache = null;
}

export default {
  getMessagesSync,
  getConversationsSync,
  getLastMessageIdSync,
  getSyncStatsSync,
  getCursorSync,
  setCursor,
  upsertMessagesSync,
  setMediaLocalPathSync,
  setActiveAccount,
  getActiveAccount,
  setLegacyOwner,
  getLegacyOwner,
  resolveLegacyOwnerSync,
  getSyncDb,
  hasAccountColumnsSync,
  isReady,
  reset,
};
