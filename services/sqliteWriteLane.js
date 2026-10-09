// services/sqliteWriteLane.js
//
// [2026-10-09 sqlite-lane] ONE write lane for chatyy.db, shared by every module.
//
// ROOT CAUSE of the SQLite errors still seen after the 2026-10-06 fix
// (push_diag 07–09/10: "cannot start a transaction within a transaction",
// "cannot commit - no transaction is active" in cacheSingleMessage /
// dbSaveMessages, plus rollback/retry heals):
//   expo-sqlite CACHES native connections by path. Every
//   openDatabaseAsync('chatyy.db') / openDatabaseSync('chatyy.db') with default
//   options (useNewConnection=false) gets the SAME native sqlite3 handle
//   (SQLiteModule.findCachedDatabase + addRef, iOS and Android). db.js,
//   localDb.js, messageOutbox.js, sqliteStore.js and bgJournal.js each believed
//   they had "their own connection" and each serialized only ITS OWN
//   transactions. So a localDb/outbox BEGIN IMMEDIATE, or a synchronous
//   BEGIN from bgJournal, landing while db.js's async transaction was open on
//   the shared handle threw "within a transaction" — and the failing side's
//   ROLLBACK aborted the OTHER module's batch, whose COMMIT then failed with
//   "no transaction is active". Both batches lost (busy_timeout never applies:
//   it's the same connection, not a lock wait).
//
// Fix: a single process-wide FIFO (globalThis singleton, survives duplicate
// module instances) that every transactional writer on chatyy.db goes through.
// Synchronous writers (bgJournal.mergeSync, sqliteStore.upsertMessagesSync)
// must check isWriteLaneBusy() first: a sync BEGIN…COMMIT block can't
// interleave with anything (it never yields), so it is safe exactly when no
// async transaction is open; otherwise they defer/retry instead of BEGIN.
//
// Pure JS, no native change → OTA-safe on the current binary.

const G = (() => {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    if (!g.__chatyySqliteWriteLane) {
      g.__chatyySqliteWriteLane = { tail: Promise.resolve(), depth: 0, active: '', queued: 0, stalls: 0 };
    }
    return g.__chatyySqliteWriteLane;
  } catch {
    return { tail: Promise.resolve(), depth: 0, active: '', queued: 0, stalls: 0 };
  }
})();

// A task that never settles (native call wedged) must not freeze every write
// in the app forever: after this long the lane moves on (the task's own
// promise still settles for its caller whenever it finishes).
const STALL_RELEASE_MS = 20000;

function _beacon(context, message) {
  try {
    setTimeout(() => {
      try { require('./crashReporter').reportCrash?.({ type: 'sqlite_heal', context, message: String(message || '').slice(0, 200) }); } catch {}
    }, 0);
  } catch {}
}

/**
 * Run `task()` exclusively on the chatyy.db write lane (FIFO, one at a time,
 * across ALL modules). `task` should do the whole BEGIN … COMMIT/ROLLBACK.
 * NEVER call runExclusive from inside a task (it would wait for itself).
 */
export function runExclusive(label, task) {
  G.queued++;
  const run = G.tail.then(async () => {
    G.queued = Math.max(0, G.queued - 1);
    G.depth++;
    G.active = String(label || 'tx');
    try { return await task(); }
    finally { G.depth = Math.max(0, G.depth - 1); G.active = ''; }
  });
  let timer = null;
  const released = new Promise((resolve) => {
    try {
      timer = setTimeout(() => {
        G.stalls++;
        // The wedged task still counts as "busy" for sync writers until it
        // settles (its finally{} lowers depth) — only the FIFO moves on.
        _beacon('lane_stall', `label=${label} after=${STALL_RELEASE_MS}ms`);
        resolve();
      }, STALL_RELEASE_MS);
    } catch {}
  });
  const settled = run.then(() => {}, () => {});
  settled.then(() => { try { if (timer) clearTimeout(timer); } catch {} });
  G.tail = Promise.race([settled, released]);
  return run;
}

/** True while an async transaction holds (or is about to take) the lane. */
export function isWriteLaneBusy() { return G.depth > 0; }

/** Diagnostics. */
export function getWriteLaneStats() { return { depth: G.depth, queued: G.queued, active: G.active, stalls: G.stalls }; }
