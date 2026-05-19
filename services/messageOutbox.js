/**
 * Message Outbox — WhatsApp-grade SQLite-backed send queue with state machine.
 *
 * Sits NEXT TO the existing `offline_queue` infra (services/localDb.js) and
 * the legacy outboxDrainer.js. The dedicated `outbox` table here is what
 * the new sendWorker.js drives, and what SendStatusText.js subscribes to.
 *
 * State machine:
 *   queued      — enqueued, waiting for worker pickup
 *   sending     — worker picked up, network attempt in flight
 *   sent        — server persisted (server_id assigned; ✓ in UI)
 *   delivered   — recipient device acked (✓✓ in UI)
 *   read        — recipient opened (✓✓ blue in UI)
 *   failed      — soft failure; will retry at next_retry_at
 *
 * Backoff ladder (ms, capped at 30min, jitter ±1s):
 *   [1000, 2000, 5000, 15000, 60000, 300000, 1800000]
 *
 * Idempotency:
 *   client_message_id is UNIQUE — enqueue() of an existing CMI returns the
 *   existing row id. Server dedups on (sender_email, client_message_id) too,
 *   so a retry that races a successful send is harmless.
 *
 * Ordering:
 *   `seq` is per-conversation monotonic. dequeueNext() always returns the
 *   lowest seq for that conversation that's in `queued` state and whose
 *   next_retry_at has elapsed. Worker enforces FIFO with one in-flight per
 *   conversation.
 *
 * Web fallback:
 *   When expo-sqlite isn't available (web bundle), we no-op the persistence
 *   layer — the legacy IndexedDB outbox + chatCache still handles those
 *   platforms via services/chatCache.js.
 */
import { Platform } from 'react-native';

// Backoff schedule in ms. attempt index N picks BACKOFF[min(N, len-1)].
// 1s → 2s → 5s → 15s → 1min → 5min → 30min (cap).
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 15000, 60000, 300000, 1800000];

// Maximum attempts before we flip permanent-fail (UI shows tap-to-retry).
// We never truly remove — user owns the message until explicit clear.
export const MAX_ATTEMPTS = 7;

// Subscriber bus — UI components register a callback keyed on
// client_message_id (or wildcard '*') and get notified on every state
// transition. Lightweight Set, no react context required.
const _subscribers = new Map(); // cmi → Set<fn>
const _wildcardSubs = new Set();

function _notify(cmi, snapshot) {
  if (cmi) {
    const set = _subscribers.get(cmi);
    if (set) {
      for (const fn of set) {
        try { fn(snapshot); } catch {}
      }
    }
  }
  for (const fn of _wildcardSubs) {
    try { fn(snapshot); } catch {}
  }
}

export function subscribe(cmi, fn) {
  if (typeof fn !== 'function') return () => {};
  if (cmi === '*' || cmi == null) {
    _wildcardSubs.add(fn);
    return () => _wildcardSubs.delete(fn);
  }
  let set = _subscribers.get(cmi);
  if (!set) { set = new Set(); _subscribers.set(cmi, set); }
  set.add(fn);
  return () => {
    const s = _subscribers.get(cmi);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) _subscribers.delete(cmi);
  };
}

// ---------------------------------------------------------------------------
// SQLite init (additive — does not touch localDb.js's `chatyy.db` schema)
// ---------------------------------------------------------------------------
let _db = null;
let _dbReady = null;
let _SQLite = null;

async function _ensureDb() {
  if (Platform.OS === 'web') return null;
  if (_db) return _db;
  if (_dbReady) return _dbReady;
  _dbReady = (async () => {
    try {
      _SQLite = require('expo-sqlite');
    } catch {
      return null;
    }
    try {
      // Re-use the same chatyy.db — single SQLite file, multiple tables.
      // openDatabaseSync if available (faster startup on iOS), else async.
      if (typeof _SQLite.openDatabaseAsync === 'function') {
        _db = await _SQLite.openDatabaseAsync('chatyy.db');
      } else if (typeof _SQLite.openDatabase === 'function') {
        _db = _SQLite.openDatabase('chatyy.db');
      }
      if (!_db) return null;
      // Schema. NOT NULL guards prevent garbage rows from breaking the worker.
      await _db.execAsync(`
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_message_id TEXT NOT NULL UNIQUE,
          conversation_id INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_retry_at INTEGER NOT NULL DEFAULT 0,
          seq INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_error TEXT,
          server_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_conv_seq ON outbox(conversation_id, seq);
        CREATE INDEX IF NOT EXISTS idx_outbox_cmi ON outbox(client_message_id);
      `);
      return _db;
    } catch (e) {
      try { console.warn('[messageOutbox] init failed:', e?.message); } catch {}
      return null;
    }
  })();
  return _dbReady;
}

// Convenience getter — callers that want to short-circuit when SQLite
// isn't available (web bundle, RN sqlite module missing).
async function _db_or_null() {
  const d = await _ensureDb();
  return d || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a new send. `payload` MUST include client_message_id +
 * conversation_id. Returns { id, seq, state } or null if SQLite unavailable.
 * Idempotent — repeat CMI returns the existing row without re-insertion.
 */
export async function enqueue(payload) {
  if (Platform.OS === 'web') return null;
  if (!payload || !payload.client_message_id || !payload.conversation_id) return null;
  const db = await _db_or_null();
  if (!db) return null;
  const cmi = String(payload.client_message_id);
  const conv = Number(payload.conversation_id);
  const now = Date.now();
  try {
    // Idempotency check first.
    const existing = await db.getFirstAsync(
      'SELECT id, seq, state FROM outbox WHERE client_message_id = ?',
      cmi
    );
    if (existing) {
      _notify(cmi, await getStatus(cmi));
      return { id: existing.id, seq: existing.seq, state: existing.state, existed: true };
    }
    // seq = max(seq) + 1 for the conversation.
    const seqRow = await db.getFirstAsync(
      'SELECT MAX(seq) AS m FROM outbox WHERE conversation_id = ?',
      conv
    );
    const seq = ((seqRow && (seqRow.m ?? seqRow['m'])) | 0) + 1;
    const res = await db.runAsync(
      `INSERT INTO outbox
        (client_message_id, conversation_id, payload, state, attempts,
         next_retry_at, seq, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?)`,
      cmi,
      conv,
      JSON.stringify(payload),
      seq,
      now,
      now,
    );
    const id = res?.lastInsertRowId || null;
    _notify(cmi, { client_message_id: cmi, state: 'queued', attempts: 0, conversation_id: conv, seq });
    return { id, seq, state: 'queued' };
  } catch (e) {
    try { console.warn('[messageOutbox] enqueue:', e?.message); } catch {}
    return null;
  }
}

/**
 * Return the next row in `queued` state for the given conversation whose
 * next_retry_at has elapsed, ordered by seq. If conversationId is null,
 * returns the next-due row across ALL conversations.
 */
export async function dequeueNext(conversationId = null) {
  const db = await _db_or_null();
  if (!db) return null;
  const now = Date.now();
  try {
    let row;
    if (conversationId == null) {
      row = await db.getFirstAsync(
        `SELECT * FROM outbox
          WHERE state = 'queued' AND next_retry_at <= ?
          ORDER BY conversation_id ASC, seq ASC
          LIMIT 1`,
        now
      );
    } else {
      row = await db.getFirstAsync(
        `SELECT * FROM outbox
          WHERE conversation_id = ? AND state = 'queued' AND next_retry_at <= ?
          ORDER BY seq ASC
          LIMIT 1`,
        Number(conversationId),
        now
      );
    }
    if (!row) return null;
    return _hydrate(row);
  } catch (e) {
    try { console.warn('[messageOutbox] dequeueNext:', e?.message); } catch {}
    return null;
  }
}

/**
 * Mark a row 'sending'. Returns true on success, false if already in flight.
 * Worker calls this immediately after dequeueNext to claim ownership.
 */
export async function markSending(cmi) {
  const db = await _db_or_null();
  if (!db) return false;
  const now = Date.now();
  try {
    const res = await db.runAsync(
      `UPDATE outbox
          SET state = 'sending', updated_at = ?
        WHERE client_message_id = ? AND state = 'queued'`,
      now,
      String(cmi),
    );
    const ok = (res?.changes ?? 0) > 0;
    if (ok) _notify(cmi, await getStatus(cmi));
    return ok;
  } catch (e) {
    try { console.warn('[messageOutbox] markSending:', e?.message); } catch {}
    return false;
  }
}

/**
 * Mark sent with server_id. Once the server has it, we keep the row around
 * until delivered/read so the UI status text stays accurate. Garbage
 * collection happens via cleanup() on a long timer.
 */
export async function markSent(cmi, serverId = null) {
  const db = await _db_or_null();
  if (!db) return false;
  const now = Date.now();
  try {
    await db.runAsync(
      `UPDATE outbox
          SET state = 'sent',
              server_id = COALESCE(?, server_id),
              updated_at = ?,
              last_error = NULL
        WHERE client_message_id = ?`,
      serverId != null ? Number(serverId) : null,
      now,
      String(cmi),
    );
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch (e) {
    try { console.warn('[messageOutbox] markSent:', e?.message); } catch {}
    return false;
  }
}

export async function markDelivered(cmi) {
  return _setState(cmi, 'delivered');
}

export async function markRead(cmi) {
  return _setState(cmi, 'read');
}

async function _setState(cmi, state) {
  const db = await _db_or_null();
  if (!db) return false;
  try {
    await db.runAsync(
      `UPDATE outbox SET state = ?, updated_at = ? WHERE client_message_id = ?`,
      state, Date.now(), String(cmi)
    );
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch { return false; }
}

/**
 * Mark a row failed and schedule retry. attempts increments. If attempts
 * reaches MAX_ATTEMPTS we leave state='failed' indefinitely (UI surface).
 * Otherwise the row goes back to 'queued' with next_retry_at set.
 */
export async function markFailed(cmi, err = null) {
  const db = await _db_or_null();
  if (!db) return false;
  const now = Date.now();
  const errStr = err ? String(err?.message || err).slice(0, 500) : null;
  try {
    const row = await db.getFirstAsync(
      'SELECT attempts FROM outbox WHERE client_message_id = ?',
      String(cmi)
    );
    if (!row) return false;
    const attempts = ((row.attempts ?? 0) | 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Permanent fail surface — UI will show "Falhou — tocar pra tentar"
      await db.runAsync(
        `UPDATE outbox
            SET state = 'failed', attempts = ?, last_error = ?, updated_at = ?
          WHERE client_message_id = ?`,
        attempts, errStr, now, String(cmi)
      );
    } else {
      // Schedule retry with jitter (±1s).
      const baseIdx = Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1);
      const base = BACKOFF_SCHEDULE_MS[baseIdx];
      const jitter = Math.floor(Math.random() * 1000);
      const nextAt = now + base + jitter;
      await db.runAsync(
        `UPDATE outbox
            SET state = 'queued',
                attempts = ?,
                next_retry_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE client_message_id = ?`,
        attempts, nextAt, errStr, now, String(cmi)
      );
    }
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch (e) {
    try { console.warn('[messageOutbox] markFailed:', e?.message); } catch {}
    return false;
  }
}

/**
 * Manually requeue a permanently-failed message for another shot at the
 * network. UI calls this when the user taps the failed bubble.
 */
export async function requeue(cmi) {
  const db = await _db_or_null();
  if (!db) return false;
  try {
    await db.runAsync(
      `UPDATE outbox
          SET state = 'queued',
              next_retry_at = 0,
              attempts = 0,
              last_error = NULL,
              updated_at = ?
        WHERE client_message_id = ?`,
      Date.now(), String(cmi)
    );
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch { return false; }
}

/**
 * Remove a row entirely (user explicitly cleared the message).
 */
export async function remove(cmi) {
  const db = await _db_or_null();
  if (!db) return false;
  try {
    await db.runAsync('DELETE FROM outbox WHERE client_message_id = ?', String(cmi));
    _notify(cmi, { client_message_id: String(cmi), state: 'removed' });
    return true;
  } catch { return false; }
}

/**
 * All rows still pending (queued|sending|failed) — optionally filtered to one
 * conversation. Used by the worker on app boot to resume.
 */
export async function getPending(conversationId = null) {
  const db = await _db_or_null();
  if (!db) return [];
  try {
    const rows = conversationId == null
      ? await db.getAllAsync(
          `SELECT * FROM outbox
            WHERE state IN ('queued','sending','failed')
            ORDER BY conversation_id ASC, seq ASC`
        )
      : await db.getAllAsync(
          `SELECT * FROM outbox
            WHERE conversation_id = ?
              AND state IN ('queued','sending','failed')
            ORDER BY seq ASC`,
          Number(conversationId)
        );
    return rows.map(_hydrate);
  } catch { return []; }
}

export async function getAllPending() { return getPending(null); }

export async function getStatus(cmi) {
  const db = await _db_or_null();
  if (!db) return null;
  try {
    const row = await db.getFirstAsync(
      'SELECT * FROM outbox WHERE client_message_id = ?',
      String(cmi)
    );
    return row ? _hydrate(row) : null;
  } catch { return null; }
}

/**
 * Garbage-collect long-acked rows. Called periodically from sendWorker —
 * rows in state 'delivered' or 'read' older than 24h are dropped. The
 * `messages` SQLite table already holds the durable copy.
 */
export async function cleanup(olderThanMs = 24 * 60 * 60 * 1000) {
  const db = await _db_or_null();
  if (!db) return 0;
  const cutoff = Date.now() - olderThanMs;
  try {
    const res = await db.runAsync(
      `DELETE FROM outbox
        WHERE state IN ('delivered','read','sent')
          AND updated_at < ?`,
      cutoff
    );
    return res?.changes ?? 0;
  } catch { return 0; }
}

/**
 * Recovery hook for app boot: any row stuck in 'sending' for >30s probably
 * was killed mid-flight (app force-quit, crash). Demote it back to 'queued'
 * so the worker picks it up again.
 */
export async function recoverStuck(thresholdMs = 30000) {
  const db = await _db_or_null();
  if (!db) return 0;
  const cutoff = Date.now() - thresholdMs;
  try {
    const res = await db.runAsync(
      `UPDATE outbox
          SET state = 'queued', updated_at = ?
        WHERE state = 'sending' AND updated_at < ?`,
      Date.now(), cutoff
    );
    return res?.changes ?? 0;
  } catch { return 0; }
}

// Normalize row from raw SQLite output into a clean shape with parsed payload.
function _hydrate(row) {
  if (!row) return null;
  let parsed = null;
  try { parsed = JSON.parse(row.payload); } catch { parsed = null; }
  return {
    id: row.id,
    client_message_id: row.client_message_id,
    conversation_id: row.conversation_id,
    payload: parsed,
    payload_raw: row.payload,
    state: row.state,
    attempts: row.attempts | 0,
    next_retry_at: row.next_retry_at | 0,
    seq: row.seq | 0,
    created_at: row.created_at | 0,
    updated_at: row.updated_at | 0,
    last_error: row.last_error || null,
    server_id: row.server_id || null,
  };
}

export default {
  enqueue,
  dequeueNext,
  markSending,
  markSent,
  markDelivered,
  markRead,
  markFailed,
  requeue,
  remove,
  getPending,
  getAllPending,
  getStatus,
  cleanup,
  recoverStuck,
  subscribe,
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
};
