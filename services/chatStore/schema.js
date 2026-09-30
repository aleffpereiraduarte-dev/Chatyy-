// services/chatStore/schema.js
//
// Single source of truth for the ADDITIVE chatStore tables + cross-account
// isolation primitives. Pure constants — NO react-native / expo import — so it
// is safe to `require` from:
//   - db.js          (native async migrations run at init)
//   - sqliteStore.js (native synchronous companion, ensures the cursors table)
//   - localDb.js / localDb.web.js (IndexedDB-mirror descriptors for web)
//   - chatStore/index.js (the facade)
//
// EVERYTHING here is additive. Every DDL statement is `CREATE TABLE IF NOT
// EXISTS` (or an idempotent ADD COLUMN swallowed on "duplicate column"). We
// NEVER drop or alter an existing table's data.

// ── Table names ──────────────────────────────────────────────────────────────
export const CURSORS_TABLE = 'cursors';
export const CONV_READ_STATE_TABLE = 'conv_read_state';

// ── New tables (native SQLite) ───────────────────────────────────────────────
// Delta-sync watermark, one row per scope. The facade namespaces `scope` with
// the active account (e.g. "user@x.com:global") so two accounts on the same
// device never collide on the PRIMARY KEY.
export const CREATE_CURSORS_SQL =
  `CREATE TABLE IF NOT EXISTS cursors (
     scope TEXT PRIMARY KEY,
     last_pts INTEGER,
     last_msg_id INTEGER,
     updated_at TEXT
   );`;

// Per-conversation read watermark. Kept in its own table (rather than reshaping
// `conversations`) so the facade has a stable home that does not depend on the
// legacy `conversations.last_read_message_id` column.
export const CREATE_CONV_READ_STATE_SQL =
  `CREATE TABLE IF NOT EXISTS conv_read_state (
     conversation_id INTEGER PRIMARY KEY,
     last_read_message_id INTEGER,
     last_read_at TEXT
   );`;

// Ordered list db.js executes during init. Each statement is idempotent so
// re-running on an existing DB is a no-op.
export const CHATSTORE_MIGRATIONS = [
  CREATE_CURSORS_SQL,
  CREATE_CONV_READ_STATE_SQL,
];

// ── Multi-account isolation ──────────────────────────────────────────────────
// The chat tables (`conversations`, `messages`) gain a nullable `account_email`
// column. Writes stamp the ACTIVE account; account-scoped reads filter by it.
// These are idempotent ADD COLUMNs — db.js runs them inside its ALTER loop that
// swallows "duplicate column name". Legacy (pre-upgrade) rows are NULL; once an
// active account is set they are NOT surfaced to any account (no leak — the
// active account simply re-syncs and re-stamps its own rows).
export const ACCOUNT_COLUMN = 'account_email';
export const ACCOUNT_COLUMN_ALTERS = [
  'ALTER TABLE conversations ADD COLUMN account_email TEXT',
  'ALTER TABLE messages ADD COLUMN account_email TEXT',
];

// Normalize an email into a stable account key. Exported so every layer
// (db.js, sqliteStore.js, smartChatCache.js, the facade) agrees on the exact
// same string for scoping.
export function normAccount(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

// Tiny deterministic FNV-1a hash → short hex. Used to build collision-safe,
// character-safe storage-key suffixes for the MMKV/localStorage accelerator
// (raw emails contain '@' / '.' which we'd rather keep out of key strings).
export function accountKeyHash(email) {
  const s = normAccount(email);
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// ── IndexedDB mirror (web) ───────────────────────────────────────────────────
// localDb.js / localDb.web.js open the shared `chatyy_v2` IndexedDB. Bumping the
// version here (single source) lets both files agree. The two stores mirror the
// SQLite tables 1:1 (keyPath = the SQLite PRIMARY KEY).
export const IDB_VERSION = 5;
export const IDB_STORES = [
  { name: 'cursors', keyPath: 'scope' },
  { name: 'conv_read_state', keyPath: 'conversation_id' },
];
