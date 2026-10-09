// services/chatStore/index.js
//
// THE FACADE. One stable, cross-platform API over the already-working
// local-first chat storage so the screen + sync builders code against a single
// surface instead of reaching into db.js / sqliteStore.js / chatCache.js /
// smartChatCache.js directly.
//
// It is intentionally THIN — every function delegates to an existing module.
// No storage logic is duplicated here.
//
// Platform behaviour:
//   - native: synchronous reads come from sqliteStore (durable, full history),
//     falling back to smartChatCache (in-memory accelerator) while the SQLite
//     sync handle is still cold at splash. Writes fan out through chatCache
//     (durable SQLite) + smartChatCache (instant paint).
//   - web:    there is no synchronous SQLite; sync reads come from
//     smartChatCache (MMKV/localStorage-backed) and the chatCache localStorage
//     mirror. Durable writes go to IndexedDB via chatCache.
//
// MULTI-ACCOUNT ISOLATION (bulletproof, additive):
//   - setActiveAccount(email) propagates the active account to EVERY layer
//     (db.js stamp+filter, sqliteStore stamp+filter, smartChatCache key scope)
//     and raises the cache-scope lock during the swap.
//   - While locked (or before the swap settles) every sync read returns [] —
//     never another account's rows, not even for one frame.
//   - Cursors are namespaced by the active account so two accounts can't
//     collide on a scope string.

import { Platform } from 'react-native';
import { getString, setString } from '../mmkv';
import { normAccount } from './schema';

import * as sqliteStore from '../sqliteStore';
import * as smartChatCache from '../smartChatCache';
import * as chatCache from '../chatCache';

const isWeb = Platform.OS === 'web';

// Per-user scoping for the web localStorage conversation mirror — mirror of the
// helper in chatCache.js so getConversationsSync reads the same key the write
// path (chatCache.cacheConversations) produced.
function _scopedConvsKey() {
  try { const { userScopedKey } = require('../cache'); return userScopedKey('chatyy_convs_v1'); }
  catch { return 'chatyy_convs_v1'; }
}

// ─── Active account ──────────────────────────────────────────────────────────
let _activeAccount = '';

/**
 * Point the whole chat store at `email`. Call on login and on every account
 * switch (see report for the exact AuthContext call site). Idempotent for the
 * same account. Raises the cache-scope lock so in-flight renders can't paint the
 * outgoing account while the layers re-scope.
 */
export function setActiveAccount(email, opts = {}) {
  const next = normAccount(email);
  const prev = _activeAccount;
  const changed = next !== prev;
  // [2026-10-07 bgsync] COLD START ('' → X, opts.coldStart): nothing of another
  // account has been painted yet, so no lock — locking here would blank the
  // chat list's frame-1 read for 800 ms (the whole point of the local-first
  // boot). A real switch (X → Y, or login after logout) still locks.
  if (changed && !(opts && opts.coldStart && !prev)) {
    // Hold the lock across the swap so every sync read short-circuits to [].
    try { chatCache.lockCacheScope?.(800); } catch {}
  }
  _activeAccount = next;
  // [2026-10-07 bgsync] Legacy owner: pre-isolation rows (account_email NULL,
  // written by every cold-start session before this fix) stay visible to the
  // device's single account instead of vanishing. See schema.acctClause.
  let owner = '';
  if (next && !isWeb) {
    try { owner = sqliteStore.resolveLegacyOwnerSync?.(next, opts && opts.deviceAccounts) || ''; } catch {}
  }
  try { sqliteStore.setLegacyOwner?.(owner); } catch {}
  try { require('../db').dbSetLegacyOwner?.(owner); } catch {}
  const adoptLegacy = !!next && (owner === next ||
    (isWeb && opts && Number.isFinite(opts.deviceAccounts) && opts.deviceAccounts <= 1));
  // Propagate to every layer (each is a no-op if already on this account).
  try { sqliteStore.setActiveAccount?.(next); } catch {}
  try { smartChatCache.setActiveAccount?.(next, { adoptLegacy }); } catch {}
  try { require('../db').dbSetActiveAccount?.(next); } catch {}
  // A newly-active account may have journaled messages waiting.
  if (changed) _journalPending = true;
}

// ─── [2026-10-07 bgsync] Background-journal merge hook ───────────────────────
// Messages stored natively while the app was backgrounded/killed (Android FCM
// service + WorkManager, iOS NSE + BGAppRefreshTask) are merged into SQLite
// right BEFORE the first synchronous list read (cold start) and again after
// each foreground (services/bgJournal.js flips the flag on AppState active).
// Sync, bounded (~ms for a few lines); never throws.
let _journalPending = true;
export function markJournalPending() { _journalPending = true; }
function _maybeMergeJournal() {
  if (!_journalPending || isWeb || !_activeAccount) return;
  _journalPending = false;
  try {
    const r = require('../bgJournal').mergeSync?.('first_read');
    if (r && r.retry) {
      _journalPending = true;
      // Busy DB at boot (db.js migrating) → never block the paint; retry right
      // after it (bgJournal emits MERGED_EVENT so the list picks it up).
      try {
        require('../bootTrace').afterFirstPaint(() => {
          try { const r2 = require('../bgJournal').mergeSync?.('after_paint'); if (!r2 || !r2.retry) _journalPending = false; } catch {}
        }, 300);
      } catch {}
    }
  } catch {}
}

export function getActiveAccount() { return _activeAccount; }

/**
 * Prepare for an account switch: raise the lock and drain the outgoing account's
 * accelerator + durable mirrors so nothing from `prevEmail` can leak into the
 * next account. Safe to call before setActiveAccount(newEmail). Returns a
 * promise that resolves when the durable clear has drained.
 */
export function clearForAccountSwitch(prevEmail) {
  try { chatCache.lockCacheScope?.(800); } catch {}
  // Wipe the synchronous accelerator immediately (in-memory + persisted blobs)
  // so no sync read can serve the previous account during the swap.
  try { smartChatCache.clearChatCache?.(); } catch {}
  // Reopen the sqlite sync handle fresh (cheap; data cleared separately).
  try { sqliteStore.reset?.(); } catch {}
  // Drain the durable MMKV/IndexedDB mirrors (async). chatCache.clearChatCache
  // also clears SmartCache again — harmless.
  try { return Promise.resolve(chatCache.clearChatCache?.()); } catch { return Promise.resolve(); }
}

/** True while an account switch / scope lock is in progress. */
export function isLocked() {
  try { return !!chatCache.isCacheScopeLocked?.(); } catch { return false; }
}

// ─── Synchronous reads (frame-1 paint) ───────────────────────────────────────

// Recency of a conversation row: last message id (monotonic) first, then the
// parsed last-activity timestamp. Used only to pick the fresher copy of a row.
function _convRecency(c) {
  const lm = c && c.last_message && typeof c.last_message === 'object' ? c.last_message : null;
  const id = lm && typeof lm.id === 'number' ? lm.id : 0;
  const ts = Date.parse(String((c && (c.last_message_at || (lm && lm.created_at) || c.updated_at)) || '')) || 0;
  return { id, ts };
}
function _isNewer(a, b) {
  const ra = _convRecency(a); const rb = _convRecency(b);
  if (ra.id && rb.id) return ra.id > rb.id;
  return ra.ts > rb.ts;
}
// Base = accelerator list (authoritative membership). Same-id rows are taken
// from SQLite only when strictly newer; SQLite-only rows are added only when
// newer than the accelerator's newest row (a chat that arrived after the
// snapshot) — never a stale/left/deleted conversation the superset still holds.
function _overlayNewer(acc, rows) {
  const byId = new Map();
  for (const r of rows) if (r && r.id != null) byId.set(String(r.id), r);
  let newestTs = 0;
  const out = acc.map((c) => {
    const ts = _convRecency(c).ts; if (ts > newestTs) newestTs = ts;
    const k = c && c.id != null ? String(c.id) : null;
    const s = k ? byId.get(k) : null;
    if (k) byId.delete(k);
    if (!s || !_isNewer(s, c)) return c;
    // Only the activity fields — a bgJournal row can be partial (no avatar,
    // empty name), so never let it blank out the snapshot's identity fields.
    const o = { ...c };
    if (s.last_message != null) o.last_message = s.last_message;
    if (s.last_message_at) o.last_message_at = s.last_message_at;
    if (s.updated_at) o.updated_at = s.updated_at;
    if (typeof s.unread_count === 'number') o.unread_count = s.unread_count;
    return o;
  });
  for (const s of byId.values()) {
    if (newestTs && _convRecency(s).ts > newestTs) out.push(s);
  }
  return out;
}

/**
 * Chat list, synchronous. Native: durable SQLite (sqliteStore), falling back to
 * the in-memory accelerator while the sync handle is cold. Web: accelerator +
 * localStorage mirror. Returns [] while locked — never the wrong account.
 * @returns {object[]}
 */
export function getConversationsSync() {
  if (isLocked()) return [];
  if (!isWeb) {
    _maybeMergeJournal();
    // [2026-10-08 chatlist-instant] ACCELERATOR FIRST. The in-memory list
    // (smartChatCache — MMKV-backed, account-scoped, hydrated before the gate
    // opens, also fed by the bgJournal merge above) is the exact last full
    // server snapshot. The SQLite table is only a superset that INSERT OR
    // REPLACE never prunes, and on iOS it held just the few rows the bgJournal
    // inserted (dbSaveConversations failed every batch — see db.js) → frame 1
    // painted 2-3 chats and the rest "came from the server". SQLite now only
    // overlays rows that are strictly newer (e.g. the accelerator's debounced
    // MMKV flush lost to a kill) and remains the fallback when the accelerator
    // is empty (MMKV evicted / first boot after an update).
    let acc = null;
    try { acc = smartChatCache.getCachedConversationsSync(); } catch {}
    let rows = null;
    try { rows = sqliteStore.getConversationsSync(); } catch {}
    if (Array.isArray(acc) && acc.length) {
      if (Array.isArray(rows) && rows.length) {
        try { return _overlayNewer(acc, rows); } catch {}
      }
      return acc;
    }
    return Array.isArray(rows) ? rows : [];
  }
  // Web.
  try {
    const mem = smartChatCache.getCachedConversationsSync();
    if (Array.isArray(mem) && mem.length) return mem;
  } catch {}
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(_scopedConvsKey());
      if (raw) { const list = JSON.parse(raw); if (Array.isArray(list)) return list; }
    }
  } catch {}
  return [];
}

/**
 * Messages for a conversation, synchronous, oldest→newest. Native: durable
 * SQLite, falling back to the accelerator. Web: accelerator. Returns [] while
 * locked. Ordering invariant (numeric server id; created_at only an ISO
 * tiebreaker) is enforced by the delegate reads.
 * @param {number|string} convId
 * @param {number} limit newest N (default 50)
 * @returns {object[]}
 */
export function getMessagesSync(convId, limit = 50) {
  if (isLocked() || convId == null) return [];
  if (!isWeb) {
    try {
      const rows = sqliteStore.getMessagesSync(convId, limit);
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {}
    try { return smartChatCache.getCachedMessagesSync(convId, limit) || []; } catch { return []; }
  }
  try { return smartChatCache.getCachedMessagesSync(convId, limit) || []; } catch { return []; }
}

// ─── Writes (durable + accelerator fan-out) ──────────────────────────────────

/**
 * Upsert conversation rows. Writes the accelerator synchronously (instant next
 * paint) then the durable store (SQLite native / IndexedDB web). Returns the
 * durable write promise.
 */
export function upsertConversations(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return Promise.resolve();
  try { smartChatCache.cacheConversations(rows); } catch {}
  try { return Promise.resolve(chatCache.cacheConversations(rows)); } catch { return Promise.resolve(); }
}

/**
 * Upsert messages for a conversation. Accelerator first (keeps optimistic tmp_
 * rows in memory), then durable store (which skips tmp_/client ids — invariant
 * preserved by the delegates). Returns the durable write promise.
 */
export function upsertMessages(convId, rows) {
  if (convId == null || !Array.isArray(rows) || rows.length === 0) return Promise.resolve();
  try { smartChatCache.cacheMessages(convId, rows); } catch {}
  try { return Promise.resolve(chatCache.cacheMessages(convId, rows)); } catch { return Promise.resolve(); }
}

/**
 * Tombstone (soft-delete) a message by id. Sets deleted_at — the row stays as a
 * "message deleted" tombstone, never a hard delete. Native only (the durable
 * soft-delete keys by id); web tombstones flow through the per-conversation
 * update paths. Returns a promise<boolean>.
 */
export function tombstoneMessage(id) {
  if (id == null) return Promise.resolve(false);
  if (isWeb) return Promise.resolve(false);
  try {
    const localDb = require('../localDb');
    return Promise.resolve(localDb.deleteMessage(id)).then(() => true).catch(() => false);
  } catch { return Promise.resolve(false); }
}

// ─── Delta-sync cursor ───────────────────────────────────────────────────────
// Scope is namespaced with the active account so two accounts never collide.
function _scopeKey(scope) {
  const s = scope == null ? '' : String(scope);
  return (_activeAccount ? _activeAccount + ':' : '') + s;
}
const _webCursorKey = (scope) => `chat_cursor_${_scopeKey(scope)}`;

/**
 * Read a delta-sync cursor for `scope`. Native: cursors table (sqliteStore).
 * Web: MMKV/localStorage mirror. Always returns { last_pts, last_msg_id }.
 */
export function getCursor(scope) {
  const empty = { last_pts: 0, last_msg_id: 0 };
  if (scope == null) return empty;
  if (!isWeb) {
    try {
      const c = sqliteStore.getCursorSync(_scopeKey(scope));
      if (c) return { last_pts: Number(c.last_pts || 0), last_msg_id: Number(c.last_msg_id || 0) };
    } catch {}
    return empty;
  }
  try {
    const raw = getString(_webCursorKey(scope));
    if (raw) { const o = JSON.parse(raw); return { last_pts: Number(o.last_pts || 0), last_msg_id: Number(o.last_msg_id || 0) }; }
  } catch {}
  return empty;
}

/**
 * Write a delta-sync cursor for `scope`. MONOTONIC — never moves a watermark
 * backward. Native: cursors table. Web: MMKV mirror. Returns boolean.
 */
export function setCursor(scope, cursor = {}) {
  if (scope == null) return false;
  const next = {
    last_pts: Number(cursor.last_pts || 0) || 0,
    last_msg_id: Number(cursor.last_msg_id || 0) || 0,
  };
  if (!isWeb) {
    try { return sqliteStore.setCursor(_scopeKey(scope), next); } catch { return false; }
  }
  try {
    const cur = getCursor(scope);
    const merged = {
      last_pts: Math.max(cur.last_pts, next.last_pts),
      last_msg_id: Math.max(cur.last_msg_id, next.last_msg_id),
    };
    setString(_webCursorKey(scope), JSON.stringify(merged));
    return true;
  } catch { return false; }
}

export default {
  setActiveAccount,
  getActiveAccount,
  markJournalPending,
  clearForAccountSwitch,
  isLocked,
  getConversationsSync,
  getMessagesSync,
  upsertConversations,
  upsertMessages,
  tombstoneMessage,
  getCursor,
  setCursor,
};
