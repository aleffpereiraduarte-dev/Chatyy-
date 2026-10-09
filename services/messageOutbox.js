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

// Feature flag — when true, this SQLite-backed outbox is the SINGLE source of
// truth for sent-message state, and the legacy MMKV path
// (chatCache.savePendingMessage + outboxDrainer.drainOnce) is decommissioned.
// Flip to false ONLY for emergency rollback if the v2 path regresses; the
// legacy code still exists behind the flag for that escape hatch.
//
// Set 2026-05-20: kill the dual-outbox race where text msgs went through
// MMKV → outboxDrainer while messageOutbox state machine sat empty,
// causing UI flags ("Enviando..."/"Falhou") to desync from reality.
//
// [#1225 2026-05-20] Web exception: messageOutbox is SQLite-backed and
// returns null on web at every entry point. If V2_ONLY were true on web,
// the legacy outboxDrainer would no-op + messageOutbox would no-op too →
// failed sends offline have NO retry path. Keep V2_ONLY native-only so
// web preserves the legacy MMKV/offlineCache replay flow until we wire
// IndexedDB persistence into messageOutbox.
import { Platform as _PlatformV2 } from 'react-native';
export const OUTBOX_V2_ONLY = _PlatformV2.OS !== 'web';

// Backoff schedule in ms. attempt index N picks BACKOFF[min(N, len-1)].
// 1s → 2s → 5s → 15s → 1min → 5min → 30min (cap).
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 15000, 60000, 300000, 1800000];

// Maximum attempts before we flip permanent-fail (UI shows tap-to-retry).
// We never truly remove — user owns the message until explicit clear.
export const MAX_ATTEMPTS = 7;

// ---------------------------------------------------------------------------
// [send-reliability 2026-10-06] WhatsApp-grade semantics
// ---------------------------------------------------------------------------
// • A TRANSIENT failure (timeout, socket drop, offline, 5xx, edge->US 503, 429,
//   401 while the session refreshes) NEVER flips a row to 'failed'. It goes back
//   to 'queued' with exponential backoff and the bubble keeps the clock — the
//   worker retries on reconnect / NetInfo-up / foreground / app start.
//   MAX_ATTEMPTS is kept only as an export for old callers; it no longer
//   promotes a transient error to a permanent fail.
// • While the device is OFFLINE attempts are NOT counted (no backoff growth).
// • Only a HARD rejection (definitive 4xx: 400/403/404/410/413/415/422, or an
//   error flagged isHardError / 'chat_send_rejected:') lands in 'failed' (red
//   "!" + tap-to-retry → requeue()).
// • Idempotency: every retry reuses the same client_message_id; chat.php dedups
//   it BEFORE its rate/slow-mode gates and returns the original row.
export const TRANSIENT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000];

/**
 * Classify a chat_send response / thrown error.
 * Returns 'ok' | 'hard' | 'offline' | 'transient'.
 * `r.__httpStatus` is attached (non-enumerable) by api.js _rawApiCall.
 */
export function classifySendResult(r, err = null) {
  if (err) {
    if (err.isHardError) return 'hard';
    const m = String(err?.message || err || '');
    if (/^chat_send_rejected:/.test(m)) return 'hard';
    if (err.offline || /^offline$/i.test(m)) return 'offline';
    return 'transient';
  }
  if (!r || typeof r !== 'object') return 'transient';
  if (r.success && (r.data?.id != null || r.message_id || r.data?.message_id || r.envelope_mode)) return 'ok';
  const status = Number(r.__httpStatus || 0);
  const msg = String(r.message || r.error || '');
  if (status === 0) {
    // Transport-level failure. 'Connection error' = fetch rejected (no route /
    // DNS / offline); 'Tempo limite excedido' = our AbortController timeout.
    return /connection error/i.test(msg) ? 'offline' : 'transient';
  }
  if (status >= 500 || status === 408 || status === 425 || status === 429 || status === 401) return 'transient';
  if (status >= 400 && status < 500) return 'hard';
  // 2xx with success:false and no status hint — treat known permanent strings
  // as hard, everything else transient (keeps retrying with the clock).
  if (/\b403\b|forbidden|not.?a.?member|no_permission|permission_denied|conversation.?deleted|admin.?only/i.test(msg)) return 'hard';
  return 'transient';
}

function _isDeviceOffline() {
  try {
    if (Platform.OS === 'web') return typeof navigator !== 'undefined' && navigator.onLine === false;
    const ni = require('./networkInfo');
    if (typeof ni?.isConnected === 'function') return ni.isConnected() === false;
  } catch {}
  return false;
}

// In-process ownership of rows in state 'sending'. A row that is 'sending' in
// SQLite but NOT owned here was orphaned (app killed / JS reloaded mid-send)
// and is safe to requeue immediately — no time threshold guesswork. Entries
// older than OWN_STALE_MS are treated as orphaned too (hung promise guard).
const _owned = new Map(); // cmi -> claimedAt
const OWN_STALE_MS = 90000;
function _own(cmi) { try { _owned.set(String(cmi), Date.now()); } catch {} }
function _disown(cmi) { try { _owned.delete(String(cmi)); } catch {} }
/** [2026-10-07 send-media] Refresh a live claim (long uploads outlive OWN_STALE_MS). */
export function touchOwned(cmi) {
  const k = String(cmi);
  if (_owned.has(k)) _owned.set(k, Date.now());
}
export function isOwnedSending(cmi) {
  const t = _owned.get(String(cmi));
  return !!t && (Date.now() - t) < OWN_STALE_MS;
}

// Conversations with at least one row waiting for a retry ('queued'). The
// foreground send path checks this SYNCHRONOUSLY so a new message never
// overtakes an older one that is still in backoff (per-conversation FIFO).
const _backlog = new Set();
export function hasBacklog(conversationId) {
  return conversationId != null && _backlog.has(Number(conversationId));
}
export function noteBacklog(conversationId) {
  if (conversationId != null && Number(conversationId)) _backlog.add(Number(conversationId));
}
/** Rebuild the backlog set from SQLite (worker calls this after each drain). */
export async function refreshBacklog() {
  const db = await _db_or_null();
  if (!db) return;
  try {
    // Rows the foreground currently owns ('sending' in this process) are not
    // a backlog — the foreground is already sending them in order.
    // [2026-10-07 send-media] upload-lane rows never block text (own lane).
    const owned = await db.getAllAsync(`SELECT conversation_id AS c, client_message_id AS k, state FROM outbox WHERE state IN ('queued','sending') AND lane = 'msg'`);
    const nonOwned = new Set();
    for (const r of owned || []) {
      const c = Number(r?.c);
      if (!c) continue;
      if (r.state === 'sending' && isOwnedSending(r.k)) continue;
      nonOwned.add(c);
    }
    _backlog.clear();
    for (const c of nonOwned) _backlog.add(c);
  } catch {}
}

// Subscriber bus — UI components register a callback keyed on
// client_message_id (or wildcard '*') and get notified on every state
// transition. Lightweight Set, no react context required.
const _subscribers = new Map(); // cmi → Set<fn>
const _wildcardSubs = new Set();

// States after which a per-cmi message can produce no further transitions.
// 'removed' is emitted by remove(); 'read' is the end of the ✓✓-blue ladder;
// 'failed' is the permanent-fail surface (the user must explicitly requeue(),
// which re-emits 'queued' and re-arms the listeners). Once we hit one of
// these we schedule a prune of that cmi's listener Set so a screen that
// forgot to call its unsubscribe (unmounted without cleanup) doesn't leak a
// dead closure for the lifetime of the process.
const _TERMINAL_STATES = new Set(['read', 'failed', 'removed']);
// Hard cap so a pathological caller that subscribes thousands of distinct
// CMIs without ever unsubscribing can't grow _subscribers unbounded. When we
// exceed the cap we drop the listener Sets whose cmi is already in a terminal
// state in the DB-independent fast path (we only have the last snapshot, so
// we prune lazily on notify below instead of scanning here).
const _MAX_TRACKED_CMI = 2000;

function _scheduleTerminalPrune(cmi) {
  // Defer one tick so the terminal snapshot is delivered to every current
  // listener before we drop them. requeue() resurrects the row (re-emits a
  // non-terminal state) and any live subscriber simply re-subscribes.
  try {
    setTimeout(() => {
      const set = _subscribers.get(cmi);
      if (set) _subscribers.delete(cmi);
    }, 0);
  } catch {
    _subscribers.delete(cmi);
  }
}

function _notify(cmi, snapshot) {
  if (cmi) {
    const set = _subscribers.get(cmi);
    if (set) {
      for (const fn of set) {
        try { fn(snapshot); } catch {}
      }
    }
    // Prune listeners for terminal-state messages so we don't leak closures
    // when a UI component unmounts without invoking its unsubscribe fn.
    if (snapshot && _TERMINAL_STATES.has(snapshot.state)) {
      _scheduleTerminalPrune(cmi);
    }
  }
  for (const fn of _wildcardSubs) {
    try { fn(snapshot); } catch {}
  }
}

/**
 * Subscribe to state transitions for a single client_message_id (or '*' /
 * null for the wildcard bus that fires on EVERY transition).
 *
 * CONTRACT: the returned unsubscribe fn MUST be called when the consumer goes
 * away (e.g. React useEffect cleanup) — failing to do so leaks the closure.
 * As a safety net, per-cmi listeners are auto-pruned once the message reaches
 * a terminal state (read / failed / removed); wildcard listeners are NEVER
 * auto-pruned (they're long-lived by design) so those callers must always
 * clean up explicitly.
 */
export function subscribe(cmi, fn) {
  if (typeof fn !== 'function') return () => {};
  if (cmi === '*' || cmi == null) {
    _wildcardSubs.add(fn);
    return () => _wildcardSubs.delete(fn);
  }
  // Stale-listener cap: if we're tracking an absurd number of distinct CMIs,
  // something upstream isn't cleaning up. Drop the oldest tracked Set (Map
  // preserves insertion order) to bound memory; its listeners were almost
  // certainly already terminal.
  if (_subscribers.size >= _MAX_TRACKED_CMI) {
    const oldest = _subscribers.keys().next().value;
    if (oldest != null && oldest !== cmi) _subscribers.delete(oldest);
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

// [2026-10-06] Serialized transaction (see db.js _runTx for the nested-BEGIN
// root cause). Two concurrent enqueue() calls used to nest BEGIN on this one
// connection → both rows lost (ghost message).
let _txTail = Promise.resolve();
function _tx(h, task) {
  const body = async () => {
    await h.execAsync('BEGIN IMMEDIATE');
    try { const r = await task(); await h.execAsync('COMMIT'); return r; }
    catch (e) { try { await h.execAsync('ROLLBACK'); } catch {} throw e; }
  };
  // [2026-10-09 sqlite-lane] 'chatyy.db' here is the SAME native connection as
  // db.js/localDb (expo-sqlite connection cache) → share the process-wide lane
  // so an enqueue can never nest its BEGIN inside a chat-cache batch (and get
  // the outbox row rolled back with it = ghost/lost message).
  try {
    const lane = require('./sqliteWriteLane');
    if (lane && typeof lane.runExclusive === 'function') return lane.runExclusive('outbox', body);
  } catch {}
  const run = _txTail.then(body);
  _txTail = run.catch(() => {});
  return run;
}

/** Close + drop this module's handle so db.js can rebuild the shared file. Reopens lazily. */
export async function resetOutboxDbHandle() {
  const h = _db;
  _db = null; _dbReady = null;
  try { await h?.closeAsync?.(); } catch {}
}

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
      try { await _db.execAsync('PRAGMA busy_timeout = 5000;'); } catch {}
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
      // [2026-10-07 send-media] `lane` column. 'msg' = the ordered per-
      // conversation chat_send FIFO (text, GIF, sticker, location and media
      // whose bytes are already on the CDN). 'upload' = media still being
      // compressed/uploaded by services/mediaSendQueue.js — those rows must NOT
      // head-block the conversation (a 2-minute video upload would otherwise
      // hold every text typed after it). Once the upload finishes the row is
      // promoted to 'msg' (keeping its seq) and the normal worker commits it.
      // Additive migration: ALTER fails harmlessly when the column exists.
      try { await _db.execAsync(`ALTER TABLE outbox ADD COLUMN lane TEXT NOT NULL DEFAULT 'msg'`); } catch {}
      try { await _db.execAsync(`CREATE INDEX IF NOT EXISTS idx_outbox_lane ON outbox(lane, state, next_retry_at)`); } catch {}
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
 *
 * Supported `payload.type` values:
 *   - 'text'  : `content` is the plaintext (or envelope) string. WS-first.
 *   - 'image' | 'video' | 'voice' | 'audio' | 'file':
 *       Media row. Worker reads `local_uri` (file://…), uploads via Rust/PHP,
 *       then chains `chat_send` with the resulting cdn_url. `mime_type`,
 *       `file_size`, `file_name`, `caption` may be provided for richer
 *       optimistic UI + server-side metadata. On web, `_blob_lost` should
 *       be set to true on replay-after-reload because blob:URLs die when
 *       the tab closes — the worker surfaces that as a re-attach prompt.
 *
 * Everything is JSON-serialized into the existing `payload` TEXT column —
 * no schema migration needed.
 */
export async function enqueue(payload, opts = null) {
  if (Platform.OS === 'web') return null;
  // [2026-10-06 latency] `opts.initialState = 'sending'` lets the foreground
  // send claim the row in the SAME transaction as the insert (one SQLite tx
  // instead of enqueue + markSending), so the HTTP/WS send no longer waits on
  // two serialized writes. Default stays 'queued' for every other caller.
  const initialState = (opts && opts.initialState === 'sending') ? 'sending' : 'queued';
  // [2026-10-07 send-media] lane: 'upload' for media that still needs bytes on
  // the CDN (mediaSendQueue owns it), 'msg' (default) for everything else.
  const lane = (opts && opts.lane === 'upload') ? 'upload' : 'msg';
  if (!payload || !payload.client_message_id || !payload.conversation_id) return null;
  const db = await _db_or_null();
  if (!db) return null;
  const cmi = String(payload.client_message_id);
  const conv = Number(payload.conversation_id);
  const now = Date.now();
  const payloadJson = JSON.stringify(payload);
  try {
    // Atomicity: two enqueue() calls racing on the same client_message_id (or
    // two messages in the same conversation racing the seq calc) used to do a
    // non-transactional SELECT-then-INSERT — both could read "no existing row"
    // and both compute the same MAX(seq)+1, producing a double-insert (caught
    // only by the UNIQUE constraint, the loser silently lost) or two rows
    // sharing a seq (FIFO ordering corrupted). Wrap the check + seq + INSERT in
    // a single SQLite transaction so the read and write are atomic. Use
    // INSERT OR IGNORE so a concurrent transaction that already inserted the
    // same CMI doesn't blow up — we detect the no-op (changes===0) and fall
    // through to returning the existing row.
    let result = null;
    if (typeof db.withTransactionAsync === 'function') {
      await _tx(db, async () => {
        const existing = await db.getFirstAsync(
          'SELECT id, seq, state FROM outbox WHERE client_message_id = ?',
          cmi
        );
        if (existing) {
          result = { id: existing.id, seq: existing.seq, state: existing.state, existed: true };
          return;
        }
        const seqRow = await db.getFirstAsync(
          'SELECT MAX(seq) AS m FROM outbox WHERE conversation_id = ?',
          conv
        );
        const seq = ((seqRow && (seqRow.m ?? seqRow['m'])) | 0) + 1;
        const res = await db.runAsync(
          `INSERT OR IGNORE INTO outbox
            (client_message_id, conversation_id, payload, state, attempts,
             next_retry_at, seq, created_at, updated_at, lane)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
          cmi, conv, payloadJson, initialState, seq, now, now, lane,
        );
        if ((res?.changes ?? 0) === 0) {
          // A concurrent transaction won the race — re-read the winner's row.
          const winner = await db.getFirstAsync(
            'SELECT id, seq, state FROM outbox WHERE client_message_id = ?',
            cmi
          );
          result = winner
            ? { id: winner.id, seq: winner.seq, state: winner.state, existed: true }
            : null;
          return;
        }
        result = { id: res?.lastInsertRowId || null, seq, state: initialState, _inserted: true };
      });
    } else {
      // Fallback for SQLite shims without withTransactionAsync: atomic
      // INSERT OR IGNORE guards against the double-insert, then we read back
      // the canonical row (whether ours or a racer's).
      const seqRow = await db.getFirstAsync(
        'SELECT MAX(seq) AS m FROM outbox WHERE conversation_id = ?',
        conv
      );
      const seq = ((seqRow && (seqRow.m ?? seqRow['m'])) | 0) + 1;
      const res = await db.runAsync(
        `INSERT OR IGNORE INTO outbox
          (client_message_id, conversation_id, payload, state, attempts,
           next_retry_at, seq, created_at, updated_at, lane)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
        cmi, conv, payloadJson, initialState, seq, now, now, lane,
      );
      if ((res?.changes ?? 0) === 0) {
        const existing = await db.getFirstAsync(
          'SELECT id, seq, state FROM outbox WHERE client_message_id = ?',
          cmi
        );
        result = existing
          ? { id: existing.id, seq: existing.seq, state: existing.state, existed: true }
          : null;
      } else {
        result = { id: res?.lastInsertRowId || null, seq, state: initialState, _inserted: true };
      }
    }
    if (!result) return null;
    if (result.existed) {
      _notify(cmi, await getStatus(cmi));
      return { id: result.id, seq: result.seq, state: result.state, existed: true };
    }
    if (initialState === 'sending') _own(cmi);
    _notify(cmi, { client_message_id: cmi, state: initialState, attempts: 0, conversation_id: conv, seq: result.seq });
    return { id: result.id, seq: result.seq, state: initialState };
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
          WHERE state = 'queued' AND next_retry_at <= ? AND lane = 'msg'
          ORDER BY conversation_id ASC, seq ASC
          LIMIT 1`,
        now
      );
    } else {
      // [send-reliability] Head-of-line: only the LOWEST pending seq of the
      // conversation may go out. A higher seq that is already due must wait
      // while an older row is still in backoff or in flight.
      row = await db.getFirstAsync(
        `SELECT * FROM outbox
          WHERE conversation_id = ? AND state IN ('queued','sending') AND lane = 'msg'
          ORDER BY seq ASC
          LIMIT 1`,
        Number(conversationId)
      );
      if (row && (row.state !== 'queued' || (Number(row.next_retry_at) || 0) > now)) row = null;
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
    if (ok) { _own(cmi); _notify(cmi, await getStatus(cmi)); }
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
  _disown(cmi);
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
        WHERE client_message_id = ? AND state NOT IN ('delivered','read')`,
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
  _disown(cmi);
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
 * Record a failed attempt. [send-reliability 2026-10-06]
 *   opts.kind = 'hard'      → state 'failed' (red "!", tap-to-retry). Only for
 *                             definitive rejections (4xx / isHardError).
 *   opts.kind = 'offline'   → back to 'queued', attempts NOT incremented, retry
 *                             in 30s (connectivity events wake it sooner).
 *   opts.kind = 'transient' → back to 'queued' with exponential backoff
 *                             (TRANSIENT_BACKOFF_MS, ±20% jitter). Never 'failed'.
 * When opts.kind is omitted it is derived from `err` (isHardError /
 * 'chat_send_rejected:' → hard; device offline → offline; else transient), so
 * legacy callers (offlineCache replay) keep working without changes.
 * A row already 'sent'/'delivered'/'read' is never demoted (late failure of a
 * duplicate attempt after another path confirmed it).
 */
export async function markFailed(cmi, err = null, opts = null) {
  _disown(cmi);
  const db = await _db_or_null();
  if (!db) return false;
  const now = Date.now();
  const errStr = err ? String(err?.message || err).slice(0, 500) : null;
  let kind = opts && opts.kind;
  if (!kind) {
    const c = classifySendResult(null, err || new Error('unknown'));
    kind = c === 'hard' ? 'hard' : (_isDeviceOffline() ? 'offline' : c);
  }
  if (kind !== 'hard' && kind !== 'offline') kind = _isDeviceOffline() ? 'offline' : 'transient';
  try {
    const row = await db.getFirstAsync(
      'SELECT attempts, state, conversation_id FROM outbox WHERE client_message_id = ?',
      String(cmi)
    );
    if (!row) return false;
    if (row.state === 'sent' || row.state === 'delivered' || row.state === 'read') return false;
    const prevAttempts = (row.attempts ?? 0) | 0;
    if (kind === 'hard') {
      await db.runAsync(
        `UPDATE outbox
            SET state = 'failed', attempts = ?, last_error = ?, updated_at = ?
          WHERE client_message_id = ?`,
        prevAttempts + 1, errStr, now, String(cmi)
      );
    } else {
      const attempts = kind === 'offline' ? prevAttempts : prevAttempts + 1;
      let delay;
      if (kind === 'offline') {
        delay = 30000;
      } else {
        const base = TRANSIENT_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), TRANSIENT_BACKOFF_MS.length - 1)];
        delay = Math.round(base * (0.8 + Math.random() * 0.4));
      }
      await db.runAsync(
        `UPDATE outbox
            SET state = 'queued',
                attempts = ?,
                next_retry_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE client_message_id = ?`,
        attempts, now + delay, errStr, now, String(cmi)
      );
      noteBacklog(row.conversation_id);
    }
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch (e) {
    try { console.warn('[messageOutbox] markFailed:', e?.message); } catch {}
    return false;
  }
}

/**
 * [send-reliability] Give a foreground-claimed row back to the worker without
 * counting an attempt (used when the foreground defers to keep FIFO order).
 */
export async function release(cmi) {
  _disown(cmi);
  const db = await _db_or_null();
  if (!db) return false;
  try {
    const row = await db.getFirstAsync('SELECT conversation_id FROM outbox WHERE client_message_id = ?', String(cmi));
    await db.runAsync(
      `UPDATE outbox SET state = 'queued', next_retry_at = 0, updated_at = ?
        WHERE client_message_id = ? AND state = 'sending'`,
      Date.now(), String(cmi)
    );
    if (row) noteBacklog(row.conversation_id);
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch { return false; }
}

/**
 * [send-reliability] Merge `patch` into a row's JSON payload (e.g. swap the
 * plaintext for the E2E envelope once encryption finished, so a worker retry
 * never sends plaintext). No-op when the row is gone.
 */
export async function updatePayload(cmi, patch) {
  const db = await _db_or_null();
  if (!db || !patch || typeof patch !== 'object') return false;
  try {
    const row = await db.getFirstAsync('SELECT payload FROM outbox WHERE client_message_id = ?', String(cmi));
    if (!row) return false;
    let p = {};
    try { p = JSON.parse(row.payload) || {}; } catch {}
    await db.runAsync('UPDATE outbox SET payload = ?, updated_at = ? WHERE client_message_id = ?',
      JSON.stringify({ ...p, ...patch }), Date.now(), String(cmi));
    return true;
  } catch { return false; }
}

/**
 * [send-reliability] Connectivity came back (WS authenticated / NetInfo up /
 * foreground): every queued row is due NOW — don't sit out a backoff that was
 * computed while the network was down.
 */
export async function retryNow(conversationId = null) {
  const db = await _db_or_null();
  if (!db) return 0;
  try {
    const res = conversationId == null
      ? await db.runAsync(`UPDATE outbox SET next_retry_at = 0 WHERE state = 'queued' AND next_retry_at > 0`)
      : await db.runAsync(`UPDATE outbox SET next_retry_at = 0 WHERE state = 'queued' AND next_retry_at > 0 AND conversation_id = ?`, Number(conversationId));
    return res?.changes ?? 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// [2026-10-07 send-media] Upload lane helpers (driven by mediaSendQueue.js)
// ---------------------------------------------------------------------------

/** Due upload-lane rows (queued, backoff elapsed), oldest conversation/seq first. */
export async function dequeueUploads(limit = 4) {
  const db = await _db_or_null();
  if (!db) return [];
  try {
    const rows = await db.getAllAsync(
      `SELECT * FROM outbox
        WHERE lane = 'upload' AND state = 'queued' AND next_retry_at <= ?
        ORDER BY created_at ASC, seq ASC
        LIMIT ?`,
      Date.now(), Math.max(1, limit | 0)
    );
    return (rows || []).map(_hydrate);
  } catch { return []; }
}

/** Earliest next_retry_at among queued upload-lane rows (epoch ms) or null. */
export async function nextUploadDueAt() {
  const db = await _db_or_null();
  if (!db) return null;
  try {
    const row = await db.getFirstAsync(`SELECT MIN(next_retry_at) AS m FROM outbox WHERE lane = 'upload' AND state = 'queued'`);
    const m = row ? (row.m ?? row['m']) : null;
    return m == null ? null : Number(m);
  } catch { return null; }
}

/**
 * Bytes are on the CDN: merge `patch` (cdn_url, server size/name…) into the
 * payload and park the row in state 'ready' (still upload lane) until every
 * OLDER upload of the same conversation is ready too — promoteReady() then
 * hands them to the chat_send FIFO in seq order (album order preserved even
 * when photo 3 finishes uploading before photo 1).
 */
export async function markUploadReady(cmi, patch = null) {
  _disown(cmi);
  const db = await _db_or_null();
  if (!db) return false;
  try {
    const row = await db.getFirstAsync('SELECT payload, state FROM outbox WHERE client_message_id = ?', String(cmi));
    if (!row) return false;
    if (row.state === 'sent' || row.state === 'delivered' || row.state === 'read') return false;
    let p = {};
    try { p = JSON.parse(row.payload) || {}; } catch {}
    await db.runAsync(
      `UPDATE outbox SET payload = ?, state = 'ready', last_error = NULL, updated_at = ? WHERE client_message_id = ?`,
      JSON.stringify({ ...p, ...(patch || {}) }), Date.now(), String(cmi)
    );
    _notify(cmi, await getStatus(cmi));
    return true;
  } catch { return false; }
}

/**
 * Promote the leading run of 'ready' upload rows of a conversation to the
 * 'msg' lane (state queued, due now, original seq kept). Stops at the first
 * row that is still uploading/backing off. Hard-failed uploads don't block.
 * Returns the promoted client_message_ids.
 */
export async function promoteReady(conversationId) {
  const db = await _db_or_null();
  if (!db || conversationId == null) return [];
  const promoted = [];
  try {
    const rows = await db.getAllAsync(
      `SELECT client_message_id AS k, state FROM outbox
        WHERE conversation_id = ? AND lane = 'upload' AND state IN ('queued','sending','ready')
        ORDER BY seq ASC`,
      Number(conversationId)
    );
    for (const r of rows || []) {
      if (r.state !== 'ready') break;
      const res = await db.runAsync(
        `UPDATE outbox SET lane = 'msg', state = 'queued', next_retry_at = 0, attempts = 0, updated_at = ?
          WHERE client_message_id = ? AND state = 'ready'`,
        Date.now(), String(r.k)
      );
      if ((res?.changes ?? 0) > 0) promoted.push(String(r.k));
    }
    if (promoted.length) noteBacklog(conversationId);
    for (const k of promoted) _notify(k, await getStatus(k));
  } catch {}
  return promoted;
}

/** Earliest next_retry_at among queued rows (epoch ms) or null. */
export async function nextDueAt() {
  const db = await _db_or_null();
  if (!db) return null;
  try {
    // Only each conversation's HEAD (lowest pending seq) is wakeable: rows
    // queued behind an older row (in backoff or in flight) can't go out before
    // it anyway, and the head's own transition re-pokes the worker. Without
    // this a released (due-now) row behind a backing-off head spun the wake
    // timer every 250ms.
    const row = await db.getFirstAsync(
      `SELECT MIN(o.next_retry_at) AS m FROM outbox o
        WHERE o.state = 'queued' AND o.lane = 'msg'
          AND NOT EXISTS (SELECT 1 FROM outbox h
                           WHERE h.conversation_id = o.conversation_id
                             AND h.state IN ('queued','sending')
                             AND h.lane = 'msg'
                             AND h.seq < o.seq)`
    );
    const m = row ? (row.m ?? row['m']) : null;
    return m == null ? null : Number(m);
  } catch { return null; }
}

/**
 * Manually requeue a permanently-failed message for another shot at the
 * network. UI calls this when the user taps the failed bubble.
 */
export async function requeue(cmi) {
  _disown(cmi);
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
  _disown(cmi);
  const db = await _db_or_null();
  if (!db) return false;
  try {
    await db.runAsync('DELETE FROM outbox WHERE client_message_id = ?', String(cmi));
    _notify(cmi, { client_message_id: String(cmi), state: 'removed' });
    return true;
  } catch { return false; }
}

/**
 * [2026-07-04 phantom-outbox fix] Reconcile stuck outbox rows against messages
 * the server already confirmed. A pending/failed row is DROPPED (so it stops
 * re-hydrating as a "tap to retry" bubble and the worker stops re-sending it)
 * when a confirmed server message matches it by:
 *   • client_action_id  (native direct-to-R2 uploader's idempotency key), OR
 *   • client_message_id (the JS send path's dedup key), OR
 *   • media match: same sender_email AND same remote file_url — this clears
 *     phantoms created BEFORE the client_action_id column existed (the founder's
 *     existing stuck photos), which have no id to reconcile on.
 *
 * `serverMessages` = confirmed rows (numeric id, not _pending/_failed/_queued).
 * Returns the list of removed client_message_ids so the caller can also drop
 * the matching bubbles from React state.
 */
export async function reconcileWithServer(conversationId, serverMessages) {
  if (Platform.OS === 'web') return [];
  if (!Array.isArray(serverMessages) || serverMessages.length === 0) return [];
  const pending = await getPending(conversationId);
  if (!pending.length) return [];

  const confirmedCmi = new Set();
  const confirmedAid = new Set();
  const confirmedMedia = new Set(); // `${sender}\n${file_url}`
  for (const m of serverMessages) {
    if (!m) continue;
    // Only trust rows the server actually confirmed (numeric id, no pending flags).
    if (typeof m.id !== 'number') continue;
    if (m._pending || m._failed || m._queued) continue;
    if (m.client_message_id) confirmedCmi.add(String(m.client_message_id));
    if (m.client_action_id) confirmedAid.add(String(m.client_action_id));
    const url = typeof m.file_url === 'string' ? m.file_url : '';
    // Only remote URLs (server-hosted) — a local file:// URI can never be a
    // server row's file_url, so this never false-matches an un-uploaded bubble.
    if (url && /^https?:\/\//i.test(url) && m.sender_email) {
      confirmedMedia.add(String(m.sender_email).toLowerCase() + '\n' + url);
    }
  }

  const removed = [];
  for (const row of pending) {
    const p = row?.payload || {};
    const cmi = String(row.client_message_id || p.client_message_id || '');
    const aid = p.client_action_id ? String(p.client_action_id) : '';
    const url = typeof p.file_url === 'string' ? p.file_url : '';
    const sender = p.sender_email ? String(p.sender_email).toLowerCase() : '';
    const mediaKey = (url && /^https?:\/\//i.test(url) && sender) ? (sender + '\n' + url) : '';
    const matched =
      (cmi && confirmedCmi.has(cmi)) ||
      (aid && confirmedAid.has(aid)) ||
      (mediaKey && confirmedMedia.has(mediaKey));
    if (matched && cmi) {
      try { await remove(cmi); removed.push(cmi); } catch { /* best-effort */ }
    }
  }
  return removed;
}

/**
 * All rows still pending (queued|sending|failed) — optionally filtered to one
 * conversation. Used by the worker on app boot to resume.
 */
export async function getPending(conversationId = null, opts = null) {
  const db = await _db_or_null();
  if (!db) return [];
  // [2026-10-07 send-media] opts.lane filters one lane ('msg' for the
  // chat_send worker, 'upload' for mediaSendQueue). Default = every lane (UI
  // rehydrate, reconcileWithServer, background-fetch counters).
  const lane = opts && (opts.lane === 'msg' || opts.lane === 'upload') ? opts.lane : null;
  const laneSql = lane ? ` AND lane = '${lane}'` : '';
  try {
    const rows = conversationId == null
      ? await db.getAllAsync(
          `SELECT * FROM outbox
            WHERE state IN ('queued','sending','failed','ready')${laneSql}
            ORDER BY conversation_id ASC, seq ASC`
        )
      : await db.getAllAsync(
          `SELECT * FROM outbox
            WHERE conversation_id = ?
              AND state IN ('queued','sending','failed','ready')${laneSql}
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
 * Recovery: a row in 'sending' that this process does NOT own was orphaned
 * (app killed / crashed / JS reloaded mid-flight). Demote it to 'queued' (due
 * now, attempt not counted) so the worker re-sends it — the server dedups on
 * client_message_id, so a send that actually landed comes back as the
 * original row. Rows owned by an in-flight send in THIS process are left alone
 * unless the claim is older than OWN_STALE_MS (hung request).
 * `thresholdMs` is kept for API compat: orphans younger than it are still
 * recovered when not owned (ownership is the precise signal).
 */
export async function recoverStuck(thresholdMs = 30000) {
  void thresholdMs;
  const db = await _db_or_null();
  if (!db) return 0;
  try {
    const rows = await db.getAllAsync(`SELECT client_message_id AS k FROM outbox WHERE state = 'sending'`);
    let n = 0;
    for (const r of rows || []) {
      const k = r?.k;
      if (!k || isOwnedSending(k)) continue;
      _disown(k);
      const res = await db.runAsync(
        `UPDATE outbox SET state = 'queued', next_retry_at = 0, updated_at = ?
          WHERE client_message_id = ? AND state = 'sending'`,
        Date.now(), String(k)
      );
      n += res?.changes ?? 0;
    }
    return n;
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
    // Timestamps are epoch-ms (~1.79e12): `| 0` truncates through ToInt32
    // (mod 2^32, signed) into garbage, so every backoff comparison read a
    // bogus value — retry storms burned MAX_ATTEMPTS in seconds and offline
    // media went permanent-failed instead of sending on reconnect.
    next_retry_at: Number(row.next_retry_at) || 0,
    seq: row.seq | 0,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
    last_error: row.last_error || null,
    server_id: row.server_id || null,
    lane: row.lane || 'msg', // [2026-10-07 send-media]
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
  reconcileWithServer,
  getPending,
  getAllPending,
  getStatus,
  cleanup,
  recoverStuck,
  release,
  updatePayload,
  retryNow,
  nextDueAt,
  dequeueUploads,
  nextUploadDueAt,
  markUploadReady,
  promoteReady,
  touchOwned,
  hasBacklog,
  noteBacklog,
  refreshBacklog,
  isOwnedSending,
  classifySendResult,
  subscribe,
  BACKOFF_SCHEDULE_MS,
  TRANSIENT_BACKOFF_MS,
  MAX_ATTEMPTS,
  OUTBOX_V2_ONLY,
};
