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

    // Enable WAL mode for better concurrent read/write performance.
    //
    // foreign_keys stays OFF on purpose. Earlier builds had a FK on
    // messages.conversation_id → conversations(id) but chat-list and
    // messages arrive on the WS in parallel: a message can land before
    // the chat row is materialized (envelope pull races chat_sync), and
    // the FK was silently rejecting those rows. Schema unification
    // (2026-05-19) drops the FK from the table definition AND keeps the
    // PRAGMA off so old DBs from previous installs don't re-enable it.
    await _db.execAsync('PRAGMA journal_mode = WAL;');
    // [#1218 2026-05-20] WhatsApp-grade PRAGMA bundle. WAL alone runs every
    // commit through fsync — bulk dbSaveMessages (200 rows) was paying 200
    // syncs (~8s). NORMAL is safe with WAL (no torn-write risk) and matches
    // WhatsApp's msgstore.db config. busy_timeout removes SQLITE_BUSY throws
    // when WS+REST hydrate in parallel. mmap_size 256MB lets reads skip
    // syscalls for hot pages. temp_store MEMORY keeps sort/group OOM-free.
    await _db.execAsync('PRAGMA synchronous = NORMAL;');
    await _db.execAsync('PRAGMA busy_timeout = 5000;');
    await _db.execAsync('PRAGMA temp_store = MEMORY;');
    try { await _db.execAsync('PRAGMA mmap_size = 268435456;'); } catch {}
    await _db.execAsync('PRAGMA cache_size = -20000;'); // 20MB cache (up from 8MB)

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
      -- Unified schema (2026-05-19): db.js is the SINGLE owner of this table.
      -- localDb.js used to CREATE TABLE IF NOT EXISTS with a partially
      -- overlapping column set, so whichever module won the init race
      -- dictated which columns existed and the loser's INSERTs failed
      -- silently. The columns below are the SUPERSET of both — db.js's
      -- original (sender_name, file_name, file_size, deleted, reactions,
      -- read_by, raw_json) PLUS localDb.js's (message_id, read_at,
      -- deleted_at, sync_seq, local_seq, client_temp_id, pending_state).
      -- NO FOREIGN KEY — see init() comment about WS race conditions.
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
        message_id TEXT,
        read_at TEXT,
        edited_at TEXT,
        deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        reactions TEXT,
        read_by TEXT,
        created_at TEXT,
        sync_seq INTEGER DEFAULT 0,
        local_seq INTEGER DEFAULT 0,
        client_temp_id TEXT,
        pending_state TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_messages_local_seq ON messages(conversation_id, local_seq);
      CREATE INDEX IF NOT EXISTS idx_messages_client_temp ON messages(client_temp_id);

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

    // FTS5 index on messages.content for offline full-text search. Triggers
    // keep it synced with the base table. Created in a separate execAsync so
    // FTS5 unavailability (rare — most builds include it) doesn't take down
    // the rest of init.
    try {
      await _db.execAsync(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          sender_email UNINDEXED,
          conversation_id UNINDEXED,
          content_rowid = id,
          tokenize = "unicode61 remove_diacritics 2"
        );
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content, sender_email, conversation_id)
          VALUES (new.id, new.content, new.sender_email, new.conversation_id);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
          INSERT INTO messages_fts(rowid, content, sender_email, conversation_id)
          VALUES (new.id, new.content, new.sender_email, new.conversation_id);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
        END;
      `);
      // [#1223 2026-05-20 Wave 6] Migration: rebuild FTS5 if it was created
      // without the unicode61+remove_diacritics tokenizer. Existing installs
      // (pre-tokenizer) silently miss matches like "café" ↔ "cafe". The
      // tokenizer is a CREATE-time setting — SQLite doesn't expose ALTER for
      // it, so we DROP and recreate, then re-populate from messages. Done
      // once via user_version gate to avoid re-indexing on every cold start.
      try {
        const ver = await _db.getFirstAsync('PRAGMA user_version');
        const userVersion = ver?.user_version ?? 0;
        if (userVersion < 6) {
          // Check if FTS5 was created with old tokenizer by reading the
          // schema. unicode61 with remove_diacritics shows in sqlite_master.
          const ftsSchema = await _db.getFirstAsync(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'"
          );
          const hasNewTokenizer = String(ftsSchema?.sql || '').includes('remove_diacritics');
          if (!hasNewTokenizer) {
            console.warn('[DB] FTS5 migration: rebuilding with remove_diacritics');
            await _db.execAsync(`
              DROP TABLE IF EXISTS messages_fts;
              CREATE VIRTUAL TABLE messages_fts USING fts5(
                content,
                sender_email UNINDEXED,
                conversation_id UNINDEXED,
                content_rowid = id,
                tokenize = "unicode61 remove_diacritics 2"
              );
              INSERT INTO messages_fts(rowid, content, sender_email, conversation_id)
                SELECT id, content, sender_email, conversation_id FROM messages WHERE content IS NOT NULL AND content != '';
            `);
          }
          await _db.execAsync('PRAGMA user_version = 6');
        }
      } catch (e) {
        console.warn('[DB] FTS5 tokenizer migration skipped:', e?.message);
      }
    } catch (err) {
      console.warn('[DB] FTS5 setup skipped:', err?.message);
    }

    // ── Additive schema migrations (idempotent ALTERs) ──
    //
    // Pre-existing installs may have a `messages` table created by an older
    // db.js OR by the now-retired localDb.js CREATE TABLE block. Either way
    // we backfill any missing columns so the unified schema is the same
    // shape on every device. ALTER TABLE ADD COLUMN throws "duplicate
    // column name" when the column is already there — we swallow that one
    // case and log anything else.
    const ADDITIVE_COLUMNS = [
      // localDb.js originals
      "ALTER TABLE messages ADD COLUMN message_id TEXT",
      "ALTER TABLE messages ADD COLUMN read_at TEXT",
      "ALTER TABLE messages ADD COLUMN deleted_at TEXT",
      "ALTER TABLE messages ADD COLUMN sync_seq INTEGER DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN local_seq INTEGER DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN client_temp_id TEXT",
      "ALTER TABLE messages ADD COLUMN pending_state TEXT",
      // db.js originals (in case an older localDb-created table is the
      // one that won the race on this device)
      "ALTER TABLE messages ADD COLUMN sender_name TEXT",
      "ALTER TABLE messages ADD COLUMN file_name TEXT",
      "ALTER TABLE messages ADD COLUMN file_size INTEGER",
      "ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN reactions TEXT",
      "ALTER TABLE messages ADD COLUMN read_by TEXT",
      "ALTER TABLE messages ADD COLUMN raw_json TEXT",
      // [#1215 2026-05-19] Phone-first media: store the local file:// path
      // alongside the remote file_url so media rows survive a wipe of the
      // separate chatMediaCache index. Applies to photo/audio/video/gif/
      // sticker/file rows. When mediaCache.cacheMedia resolves, the
      // resulting filesystem URI is written here AND the optimistic _localUri
      // on the row is preserved. Polls/gifts/diamond bubbles keep their full
      // payload in raw_json so no extra columns needed for them.
      "ALTER TABLE messages ADD COLUMN local_path TEXT",
      // Media metadata (width/height/duration) — render the right aspect
      // ratio before the file finishes downloading. Backend already returns
      // these in some payloads; we just add the columns so they land.
      "ALTER TABLE messages ADD COLUMN media_width INTEGER",
      "ALTER TABLE messages ADD COLUMN media_height INTEGER",
      "ALTER TABLE messages ADD COLUMN media_duration INTEGER",
    ];
    for (const sql of ADDITIVE_COLUMNS) {
      try { await _db.execAsync(sql); }
      catch (e) {
        const msg = String(e?.message || '');
        if (!/duplicate column/i.test(msg)) {
          console.warn('[DB] migration ALTER failed:', sql, msg);
        }
      }
    }
    try {
      await _db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_messages_local_seq ON messages(conversation_id, local_seq);
        CREATE INDEX IF NOT EXISTS idx_messages_client_temp ON messages(client_temp_id);
      `);
    } catch {}

    // [#1223 2026-05-20 Wave 6] pending_messages schema mismatch.
    // chatCache.savePendingMessage() persists sender_email + client_message_id
    // + reply_to_id + mentions but the ORIGINAL table only had temp_id,
    // conversation_id, content, type, file_url, file_name, created_at,
    // retries, raw_json. Result: native INSERT silently fails (caught by
    // savePendingMessage's catch), MMKV fallback works, but cold-start
    // hydration from SQLite returns empty list — pending msgs DISAPPEAR
    // forever if MMKV is purged. Add the missing columns idempotently.
    const PENDING_ADDITIVE_COLUMNS = [
      "ALTER TABLE pending_messages ADD COLUMN sender_email TEXT",
      "ALTER TABLE pending_messages ADD COLUMN client_message_id TEXT",
      "ALTER TABLE pending_messages ADD COLUMN reply_to_id INTEGER",
      "ALTER TABLE pending_messages ADD COLUMN mentions TEXT",
      "ALTER TABLE pending_messages ADD COLUMN updated_at TEXT",
    ];
    for (const sql of PENDING_ADDITIVE_COLUMNS) {
      try { await _db.execAsync(sql); }
      catch (e) {
        const msg = String(e?.message || '');
        if (!/duplicate column/i.test(msg)) {
          console.warn('[DB] pending_messages migration failed:', sql, msg);
        }
      }
    }

    // Read watermark per conversation. The chat-list / open-thread paths
    // advance this as the local "highest message id the user has read" so a
    // cold start can hide already-read unread dots without a server round
    // trip. Added idempotently — older installs created `conversations`
    // without the column. dbUpdateConversationLastReadMessageId() writes it.
    const CONV_ADDITIVE_COLUMNS = [
      "ALTER TABLE conversations ADD COLUMN last_read_message_id INTEGER DEFAULT 0",
    ];
    for (const sql of CONV_ADDITIVE_COLUMNS) {
      try { await _db.execAsync(sql); }
      catch (e) {
        const msg = String(e?.message || '');
        if (!/duplicate column/i.test(msg)) {
          console.warn('[DB] conversations migration failed:', sql, msg);
        }
      }
    }

    // ── Self-check: blow up loud if schema is still missing required cols ──
    // This is the diagnostic that would have caught the localDb/db.js race
    // immediately instead of letting it bleed messages for days.
    try {
      const cols = await _db.getAllAsync("PRAGMA table_info(messages)");
      const colNames = cols.map(c => c.name);
      const required = [
        'id', 'conversation_id', 'sender_email', 'content', 'type',
        'raw_json', 'created_at', 'message_id', 'client_temp_id', 'pending_state'
      ];
      const missing = required.filter(c => !colNames.includes(c));
      if (missing.length > 0) {
        console.error('[db] CRITICAL schema mismatch — missing columns:', missing);
        // Beacon: if a crashReporter is wired, surface this server-side so
        // we don't rely on user-side console.error reaching us.
        try {
          const cr = require('./crashReporter');
          if (cr && typeof cr.reportError === 'function') {
            cr.reportError(new Error('db schema mismatch: missing ' + missing.join(',')), {
              scope: 'db.init',
              tableInfoCols: colNames,
            });
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[db] schema self-check failed:', e?.message);
    }

    _ready = true;
    _readyResolve();
    // Fire-and-forget telemetry self-check (2026-05-19). Probes a real
    // write+read on the messages table and POSTs the result to
    // sqlite_self_check so we can confirm on real devices that the
    // unified schema (#1206) actually persists writes. See server log at
    // /var/www/mail/data/sqlite-diag/YYYY-MM-DD.log.
    _runSelfCheck();
  } catch (err) {
    console.warn('[DB] Init failed:', err.message);
    _ready = true;
    _readyResolve();
  }
}

async function _runSelfCheck() {
  if (Platform.OS === 'web') return;
  try {
    const cols = await _db.getAllAsync("PRAGMA table_info(messages)");
    const colNames = cols.map(c => c.name);
    const required = ['id','conversation_id','sender_email','content','type','raw_json','created_at','message_id','client_temp_id','pending_state'];
    const missing = required.filter(c => !colNames.includes(c));

    // Probe write
    let probeWriteOk = false;
    let probeReadOk = false;
    try {
      await _db.runAsync(
        "INSERT OR REPLACE INTO messages (id, conversation_id, sender_email, content, type, raw_json, created_at) VALUES (-1, 0, 'probe', 'self_check', 'text', ?, ?)",
        [JSON.stringify({ id: -1, probe: true }), new Date().toISOString()]
      );
      probeWriteOk = true;
      const row = await _db.getFirstAsync("SELECT raw_json FROM messages WHERE id = -1");
      probeReadOk = !!row?.raw_json;
      await _db.runAsync("DELETE FROM messages WHERE id = -1");
    } catch (e) {
      console.error('[db.selfCheck] probe failed:', e.message);
    }

    const msgCount = (await _db.getFirstAsync("SELECT COUNT(*) AS c FROM messages"))?.c || 0;

    const payload = {
      platform: Platform.OS,
      build: require('../app.json')?.expo?.ios?.buildNumber || '?',
      db_open: true,
      columns: colNames,
      missing,
      probe_write_ok: probeWriteOk,
      probe_read_ok: probeReadOk,
      msg_count: msgCount,
    };

    // Best-effort report to backend
    try {
      const api = require('./api');
      await api.apiCall('sqlite_self_check', payload, 'POST');
    } catch {}

    if (missing.length > 0 || !probeWriteOk || !probeReadOk) {
      console.error('[db.selfCheck] FAILED:', JSON.stringify(payload));
    } else {
      console.log('[db.selfCheck] OK — columns:', colNames.length, '— msgs:', msgCount);
    }
  } catch (e) {
    console.error('[db.selfCheck] error:', e?.message);
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

/**
 * [P1] Advance the per-conversation read watermark. Sets
 * conversations.last_read_message_id to `messageId` ONLY when it moves the
 * watermark FORWARD (new id >= current) so an out-of-order / stale ack can't
 * drag it backward and resurrect already-read unread dots. No-op when the
 * conversation row doesn't exist yet or the args are invalid.
 *
 * Called by the api.js delivery/read path; fire-and-forget on the caller's
 * side, so we swallow errors (logged in __DEV__) rather than throwing.
 */
export async function dbUpdateConversationLastReadMessageId(conversationId, messageId) {
  if (isWeb || !_db) return;
  const convId = Number(conversationId);
  const msgId = Number(messageId);
  if (!Number.isFinite(convId) || !Number.isFinite(msgId) || msgId <= 0) return;
  try {
    // The guard is in the WHERE clause so the watermark only advances — an
    // older/equal id leaves the row untouched (changes === 0). COALESCE keeps
    // a NULL column (pre-migration row) behaving like 0.
    await _db.runAsync(
      `UPDATE conversations
         SET last_read_message_id = ?
       WHERE id = ? AND ? >= COALESCE(last_read_message_id, 0)`,
      [msgId, convId, msgId]
    );
  } catch (e) {
    if (__DEV__) console.warn('[db] dbUpdateConversationLastReadMessageId failed:', e?.message || e);
  }
}

// ══════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════

export async function dbSaveMessages(conversationId, messages) {
  if (isWeb || !_db || !messages?.length) return;
  // Unified writer (2026-05-19): localDb.saveMessage / saveMessages delegate
  // here. We persist the SUPERSET of fields so optimistic-send rows from the
  // outbox path (client_temp_id, local_seq, pending_state) survive a restart
  // alongside server-confirmed rows (sync_seq, read_at, deleted_at).
  // [#1218 2026-05-20 WhatsApp-parity] Include local_path + media_* columns
  // in INSERT. Earlier dbSaveMessages omitted them, so even when mediaCache
  // wrote a file://… into the DB via dbUpdateMessageFields, a subsequent
  // INSERT OR REPLACE (from fullHistorySync paging in the same row) wiped
  // local_path back to NULL. Result: user taps audio offline, msg.local_path
  // is NULL, bubble shows "mídia ainda não foi baixada" — even though the
  // file is on disk. Persisting all media columns closes the gap.
  const stmt = await _db.prepareAsync(
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
  // [#1206 2026-05-19] Surface row-level executeAsync failures via crash
  // beacon. Outer caller still gets the throw (existing semantics) — this
  // only adds a beacon hop so the bad row's id + error message reach us
  // instead of being lost in a swallowing catch block upstream.
  try {
    for (const m of messages) {
      if (!m.id || String(m.id).startsWith('tmp_')) continue;
      try {
        await stmt.executeAsync({
          $id: m.id,
          $convId: conversationId || m.conversation_id,
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
          // [#1218 2026-05-20] Preserve media path/dim across re-syncs.
          // m.local_path comes from a prior cacheMedia write-back; m._localUri
          // is the optimistic UI hint set on send. Prefer the persisted one
          // but fall back to optimistic so the bubble keeps showing the local
          // file while the row is in flight. media_width/height/duration
          // also persisted so a re-sync (INSERT OR REPLACE) doesn't blank the
          // aspect-ratio render data.
          $localPath: m.local_path || m._localUri || null,
          $mediaW: m.media_width || (m.media && m.media.width) || null,
          $mediaH: m.media_height || (m.media && m.media.height) || null,
          $mediaDur: m.media_duration || (m.media && m.media.duration) || null,
          $raw: JSON.stringify(m),
        });
      } catch (rowErr) {
        try { require('./crashReporter').reportCrash?.({ type: 'sqlite_error', context: 'dbSaveMessages_row', message: `id=${m?.id} ${rowErr?.message}`, stack: rowErr?.stack }); } catch {}
        throw rowErr;
      }
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
  // [#1206 2026-05-19] Wrap the read so a sudden getAllAsync failure (DB
  // locked / corrupted page / migration race) lands a beacon instead of
  // letting the screen render an empty thread silently. Re-throw so the
  // caller's existing fallback logic (MMKV) still kicks in.
  let rows;
  try {
    rows = await _db.getAllAsync(query, params);
  } catch (e) {
    try { require('./crashReporter').reportCrash?.({ type: 'sqlite_error', context: 'dbGetMessages', message: `conv=${conversationId} ${e?.message}`, stack: e?.stack }); } catch {}
    throw e;
  }
  let corrupt = 0;
  const parsed = rows.map(r => {
    try { return JSON.parse(r.raw_json); }
    catch { corrupt++; return null; }
  }).filter(Boolean);
  if (corrupt > 0 && __DEV__) {
    console.warn(`[db] dbGetMessages: ${corrupt} corrupt row(s) skipped for conv ${conversationId}`);
  }
  return parsed.reverse();
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

/**
 * [#1216 2026-05-19] Phone-first sync completeness — WhatsApp-restore parity.
 * Returns a single object with counters the UI uses to surface "Backup
 * completo no celular ✓" vs "Baixando: 12 mídias pendentes":
 *   - convsTotal:    rows in conversations table (a proxy for "everything
 *                    the server knows we're part of"); the SyncBar shows
 *                    this as the denominator.
 *   - msgsTotal:     rows in messages table.
 *   - mediaTotal:    msgs of media-bearing types (image/video/audio/voice/
 *                    short_video/gif/sticker/file/document).
 *   - mediaOnDisk:   mediaTotal where local_path IS NOT NULL.
 *   - mediaPending:  mediaTotal - mediaOnDisk.
 *
 * Cheap: 3 COUNT queries, no full table scan. Suitable for polling from
 * a Settings tile or the SyncBar status line.
 */
export async function getSyncStats() {
  if (isWeb || !_db) return null;
  try {
    const cTotal = await _db.getFirstAsync('SELECT COUNT(*) AS n FROM conversations');
    const mTotal = await _db.getFirstAsync('SELECT COUNT(*) AS n FROM messages');
    const mMedia = await _db.getFirstAsync(
      "SELECT COUNT(*) AS n FROM messages WHERE type IN ('image','video','audio','voice','short_video','gif','sticker','file','document')"
    );
    const mDisk = await _db.getFirstAsync(
      "SELECT COUNT(*) AS n FROM messages WHERE type IN ('image','video','audio','voice','short_video','gif','sticker','file','document') AND local_path IS NOT NULL AND local_path <> ''"
    );
    const convsTotal = Number(cTotal?.n || 0);
    const msgsTotal = Number(mTotal?.n || 0);
    const mediaTotal = Number(mMedia?.n || 0);
    const mediaOnDisk = Number(mDisk?.n || 0);
    return {
      convsTotal,
      msgsTotal,
      mediaTotal,
      mediaOnDisk,
      mediaPending: Math.max(0, mediaTotal - mediaOnDisk),
      // 100 when there's no media at all (nothing to download = complete).
      mediaPercent: mediaTotal === 0 ? 100 : Math.floor((mediaOnDisk / mediaTotal) * 100),
    };
  } catch (e) {
    if (__DEV__) console.warn('[db] getSyncStats failed:', e?.message);
    return null;
  }
}

/**
 * [#1216 2026-05-19] List media rows missing local_path so a Settings
 * "Baixar tudo agora" button can re-queue them through mediaCache. Caps
 * at 500 per call so we don't load the whole table into RAM on big
 * accounts; caller paginates if needed.
 */
export async function getMissingMediaMessages(limit = 500) {
  if (isWeb || !_db) return [];
  try {
    const rows = await _db.getAllAsync(
      `SELECT id, conversation_id, type, file_url, content, thumb_b64
       FROM messages
       WHERE type IN ('image','video','audio','voice','short_video','gif','sticker','file','document')
         AND (local_path IS NULL OR local_path = '')
         AND (
           (file_url IS NOT NULL AND file_url <> '')
           OR (type IN ('gif','sticker') AND content LIKE 'http%')
         )
       ORDER BY id DESC
       LIMIT ?`,
      [Math.max(1, Math.min(limit, 2000))]
    );
    return rows || [];
  } catch (e) {
    if (__DEV__) console.warn('[db] getMissingMediaMessages failed:', e?.message);
    return [];
  }
}

/**
 * [#1215 2026-05-19] Targeted field update — used by mediaCache write-back.
 * Updates ONLY the column(s) provided in `fields` (local_path, media_width,
 * media_height, media_duration, etc.) without touching content/edited_at.
 * Also merges into raw_json so cold reads via dbGetMessages reflect the
 * new file:// path immediately. Whitelisted columns only — silently
 * ignores unknown keys to avoid SQL injection from JS callers.
 */
const _ALLOWED_FIELD_UPDATES = new Set([
  'local_path', 'media_width', 'media_height', 'media_duration',
  'read_at', 'deleted_at', 'pending_state', 'sync_seq',
]);
export async function dbUpdateMessageFields(conversationId, messageId, fields) {
  if (isWeb || !_db) return;
  // [P1] Strict null/empty guard up top — a null/non-object/empty `fields`
  // arg must never reach the query (otherwise media local_path write-backs
  // could throw on Object.entries(null) and silently fail).
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) return;
  const entries = Object.entries(fields).filter(([k]) => _ALLOWED_FIELD_UPDATES.has(k));
  if (entries.length === 0) return;
  try {
    // Pull current row so we can merge into raw_json too.
    const row = await _db.getFirstAsync(
      'SELECT raw_json FROM messages WHERE id = ? AND conversation_id = ?',
      [messageId, conversationId]
    );
    if (!row) return;
    let merged = {};
    try { merged = { ...JSON.parse(row.raw_json || '{}'), ...fields }; } catch { merged = { ...fields }; }
    const setSql = entries.map(([k]) => `${k} = ?`).join(', ');
    const params = entries.map(([_, v]) => v);
    params.push(JSON.stringify(merged), messageId, conversationId);
    await _db.runAsync(
      `UPDATE messages SET ${setSql}, raw_json = ? WHERE id = ? AND conversation_id = ?`,
      params
    );
  } catch (e) {
    if (__DEV__) console.warn('[db] dbUpdateMessageFields failed:', e?.message || e);
  }
}

// [#1222 2026-05-20 Wave 5] NULL out local_path for any message whose
// local file was evicted by the mediaCache LRU sweep. Called as a bulk
// update from mediaCache.evictIfNeeded() so the bubble's `local_path` no
// longer lies about file presence after an eviction. Matches via the
// URL key (suffix of the file:// path) — the LRU operates on those keys.
// Fire-and-forget; failure is logged but doesn't surface.
export async function dbClearLocalPathByFilenames(filenames) {
  if (isWeb || !_db || !Array.isArray(filenames) || filenames.length === 0) return;
  try {
    // Use a single transaction so 50 evicted entries → 1 fsync (with WAL+NORMAL).
    await _db.withExclusiveTransactionAsync(async (txn) => {
      const stmt = await txn.prepareAsync(
        `UPDATE messages SET local_path = NULL WHERE local_path LIKE '%/' || $name`
      );
      try {
        for (const name of filenames) {
          if (!name || typeof name !== 'string') continue;
          await stmt.executeAsync({ $name: name });
        }
      } finally { await stmt.finalizeAsync(); }
    });
  } catch (e) {
    if (__DEV__) console.warn('[db] dbClearLocalPathByFilenames failed:', e?.message || e);
  }
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

/**
 * Full-text search across all cached messages. Uses FTS5 when available
 * (created by initDatabase), falls back to a LIKE scan otherwise. Optional
 * conversationId narrows results to a single thread.
 */
function ftsEscape(query) {
  if (!query) return '""';
  return '"' + String(query).replace(/"/g, '""') + '"';
}

export async function dbSearchMessages(query, limit = 50, conversationId = null) {
  if (isWeb || !_db) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const ftsQ = ftsEscape(q);
  try {
    const sql = conversationId
      ? `SELECT m.* FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.conversation_id = ? AND m.deleted = 0
         ORDER BY m.id DESC LIMIT ?`
      : `SELECT m.* FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.deleted = 0
         ORDER BY m.id DESC LIMIT ?`;
    const args = conversationId ? [ftsQ, conversationId, limit] : [ftsQ, limit];
    const rows = await _db.getAllAsync(sql, args);
    return rows.map(r => {
      try { return r.raw_json ? { ...JSON.parse(r.raw_json), _row: r } : r; }
      catch { return r; }
    });
  } catch {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const sql = conversationId
      ? `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' AND conversation_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' AND deleted = 0 ORDER BY id DESC LIMIT ?`;
    const args = conversationId ? [like, conversationId, limit] : [like, limit];
    try {
      const rows = await _db.getAllAsync(sql, args);
      return rows.map(r => { try { return r.raw_json ? JSON.parse(r.raw_json) : r; } catch { return r; } });
    } catch {
      return [];
    }
  }
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

// Retention: delete messages older than `maxAgeDays` (default 90) that have
// already been read (_readStatus >= 1). When `conversationId` is null, prunes
// across all conversations. Returns number of rows deleted (0 on failure).
//
// NOTE: schema currently doesn't carry _readStatus — until that column lands,
// the WHERE clause matches nothing and this is a no-op. The try/catch keeps
// the call site safe either way.
export async function dbPruneOldMessages(conversationId, maxAgeDays = 90) {
  if (!isDbReady()) return 0;
  try {
    const cutoff = Date.now() - (maxAgeDays * 86400000);
    const sql = conversationId
      ? `DELETE FROM messages WHERE conversation_id = ? AND created_at < ? AND _readStatus >= 1`
      : `DELETE FROM messages WHERE created_at < ? AND _readStatus >= 1`;
    const params = conversationId ? [conversationId, cutoff] : [cutoff];
    const result = await _db.runAsync(sql, params);
    return result.changes || 0;
  } catch { return 0; }
}

// Reclaim disk space + rebuild indexes after large deletes. Cheap to call
// post-prune; expensive on huge DBs so only invoke on a weekly cadence.
export async function dbVacuum() {
  if (!isDbReady()) return;
  try { await _db.execAsync('VACUUM;'); } catch {}
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
