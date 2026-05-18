/**
 * services/onlineRecoveryOrchestrator.js
 *
 * WhatsApp-grade auto-sync orchestrator. When the device transitions from
 * any "we may have missed events" state back to a healthy online state we
 * run a single coalesced recovery sequence to flush the outbox, pull the
 * delta of conversation events, refresh the chat list metadata and trigger
 * the encrypted envelope puller.
 *
 * Triggers (any one of these, coalesced with a 800ms debounce so a flap
 * that fires NetInfo + WS + AppState in quick succession only runs ONE
 * recovery):
 *   1. NetInfo flips offline → online (`@react-native-community/netinfo`)
 *   2. WS `connection` event with status === 'authenticated' (reconnect
 *      finished re-handshake)
 *   3. AppState transitions to 'active' (foreground after backgrounded for
 *      long enough that we might have missed real-time delivery)
 *
 * Recovery sequence (strict ordering — see comments per step):
 *   a. replayOfflineQueue(api)          flush outbox (chat sends, marks)
 *   b. syncConversations(allConvIds)    pts-based delta pull for ALL
 *                                       cached conversations, concurrency 4
 *   c. chatConversations()              refresh list-level metadata
 *                                       (unread, last_message, members…)
 *   d. envelopePuller.flushEnvelopesNow E2EE backlog (if enabled)
 *
 * Side effects:
 *   - globalThis.__chatyy_syncing = true during the run (false at the end)
 *   - globalThis.__chatyy_emit('online_sync_start' | 'online_sync_done')
 *     when listeners are wired via subscribeSyncStatus()
 *
 * Public API:
 *   startOnlineRecovery(apiCall, opts) — wire all 3 triggers, idempotent
 *   stopOnlineRecovery()                — tear down all subscriptions
 *   forceSync()                         — fire the recovery sequence now
 *   subscribeSyncStatus(cb)             — receive {running:boolean} updates
 *   isSyncing()                         — synchronous read
 */

import { AppState, Platform } from 'react-native';
import { onNetworkChange, isConnected as netIsConnected } from './networkInfo';

let _wsUnsub = null;
let _netUnsub = null;
let _appStateSub = null;
let _debounceTimer = null;
let _running = false;        // is the orchestrator wired up?
let _syncing = false;        // is a recovery in flight right now?
let _lastSyncAt = 0;
let _lastScheduledAt = 0;    // hard cooldown gate — see SCHEDULE_COOLDOWN_MS
let _apiRef = null;
let _opts = {};
// Subscribers for the syncing badge (ChatListTab consumes these).
const _listeners = new Set();

// Dev-only logger. The `[onlineRecovery] start — ws_authenticated` line used
// to fire on every WS reconnect (sometimes hundreds of times in a row when
// the WS thrashed). Suppress in prod so the console isn't flooded; keep it
// on in dev so debugging the trigger path is still trivial.
const _isDev = (typeof __DEV__ !== 'undefined') ? __DEV__ : false;
function _log(...args) { if (_isDev) { try { console.log(...args); } catch {} } }

// Minimum gap between two successful recoveries. Triggers that fire inside
// this window are dropped — prevents WS flap loops from hammering the
// backend.
const MIN_GAP_MS = 1500;
// Hard cooldown at the schedule layer. The debounce alone collapses bursts
// fired in the same tick, but a sustained WS reconnect storm (auth_success
// every ~1s after each fast reconnect attempt) would otherwise queue a fresh
// recovery every cycle. With this cooldown, any trigger arriving within
// SCHEDULE_COOLDOWN_MS of the last accepted schedule is silently dropped.
const SCHEDULE_COOLDOWN_MS = 5000;
// Debounce so multiple triggers in the same tick collapse to one run.
const DEBOUNCE_MS = 800;
// chat_sync caps at 200 convs / request. Smaller batches = faster individual
// calls + better UX. 2026-05-17: bumped down 100→25 because users reported
// "Sincronizando…" stuck for 30s+ on dense accounts; each batch was waiting
// on the backend's longest conv.
const CONV_BATCH = 25;
const CONV_CONCURRENCY = 4;
// Max time the syncing badge stays visible. Sync may continue in the
// background but UI dismisses to avoid the user thinking the app is stuck.
const BADGE_MAX_MS = 8000;

function _notify() {
  for (const fn of _listeners) {
    try { fn({ running: _syncing }); } catch {}
  }
}

function _schedule(reason) {
  if (!_running) return;
  // Hard cooldown — drop triggers that fire while a recent schedule is still
  // pending or just finished. Without this a thrashing WS (close→reconnect→
  // auth_success looping every ~1s) would queue a fresh recovery every cycle
  // because each trigger resets the debounce timer instead of riding the
  // existing one. Prints to the console were a clear symptom of that loop.
  const now = Date.now();
  if (now - _lastScheduledAt < SCHEDULE_COOLDOWN_MS) return;
  _lastScheduledAt = now;
  if (_debounceTimer) { try { clearTimeout(_debounceTimer); } catch {} _debounceTimer = null; }
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    _runRecovery(reason).catch((e) => {
      try { console.warn('[onlineRecovery] failed:', e?.message || e); } catch {}
    });
  }, DEBOUNCE_MS);
}

async function _gatherConvIds() {
  // Use the same source of truth as the chat list — chatCache.getCachedConversations
  // returns SQLite (native) → IndexedDB (web) → MMKV in order. If the cache
  // is empty we fall back to an empty list; the chatConversations() call in
  // step C will then seed it.
  try {
    const { getCachedConversations } = await import('./chatCache');
    const convs = await getCachedConversations();
    if (!Array.isArray(convs)) return [];
    return convs
      .map(c => Number(c?.id))
      .filter(n => Number.isFinite(n) && n > 0);
  } catch { return []; }
}

async function _runDeltaForAll(allConvIds) {
  if (!allConvIds.length) return { batches: 0, convs: 0 };
  let { syncConversations } = await import('./chatSync');
  if (typeof syncConversations !== 'function') return { batches: 0, convs: 0 };

  // Optional WS->SQLite event applier so the delta payloads actually land
  // in the local DB (otherwise the chat list would still paint from stale
  // cache until the screen re-mounts).
  let applyRealtimeEvent = null;
  try {
    const ld = await import('./localDb');
    if (typeof ld.applyRealtimeEvent === 'function') applyRealtimeEvent = ld.applyRealtimeEvent;
  } catch {}

  // Build batches of CONV_BATCH and process CONV_CONCURRENCY in parallel.
  const batches = [];
  for (let i = 0; i < allConvIds.length; i += CONV_BATCH) {
    batches.push(allConvIds.slice(i, i + CONV_BATCH));
  }

  let totalConvs = 0;
  for (let i = 0; i < batches.length; i += CONV_CONCURRENCY) {
    const slice = batches.slice(i, i + CONV_CONCURRENCY);
    const results = await Promise.all(slice.map(async (ids) => {
      try {
        const out = await syncConversations(ids);
        // Best-effort apply of each event into localDb. We skip if applyRealtimeEvent
        // wasn't available — syncConversations already bumped lastPts so the
        // next foreground render picks up the same events via normal load.
        if (applyRealtimeEvent && Array.isArray(out)) {
          for (const conv of out) {
            const events = Array.isArray(conv?.events) ? conv.events : [];
            for (const ev of events) {
              try { await applyRealtimeEvent(ev); } catch {}
            }
          }
        }
        return ids.length;
      } catch (e) {
        try { console.warn('[onlineRecovery] delta batch failed:', e?.message); } catch {}
        return 0;
      }
    }));
    totalConvs += results.reduce((a, b) => a + b, 0);
  }

  return { batches: batches.length, convs: totalConvs };
}

async function _runRecovery(reason) {
  if (_syncing) return;                                 // dedup with in-flight
  if (Date.now() - _lastSyncAt < MIN_GAP_MS) return;    // throttle flaps
  if (typeof _apiRef !== 'object' || !_apiRef) return;  // not wired yet

  _syncing = true;
  try { globalThis.__chatyy_syncing = true; } catch {}
  _notify();
  _log('[onlineRecovery] start —', reason);

  // Watchdog: clear the visible badge after BADGE_MAX_MS even if the sync
  // is still running in background. WhatsApp parity — sincronizando deve
  // sumir rápido pro user não achar que travou.
  const _badgeWatchdog = setTimeout(() => {
    try {
      _syncing = false;
      globalThis.__chatyy_syncing = false;
      _notify();
      _log('[onlineRecovery] badge timed out — hiding (sync may continue)');
    } catch {}
  }, BADGE_MAX_MS);

  try {
    // a) Outbox flush — chat_sends + email actions queued offline. Runs
    //    first because subsequent pulls might otherwise overlap with our
    //    own pending sends and surface dup/missing rows.
    try {
      const { replayOfflineQueue } = await import('./offlineCache');
      if (typeof replayOfflineQueue === 'function') {
        await replayOfflineQueue(_apiRef);
      }
    } catch (e) {
      try { console.warn('[onlineRecovery] outbox replay:', e?.message); } catch {}
    }

    // b) pts-based delta sync for every cached conversation, in parallel
    //    batches. Even if this partially fails we proceed to (c) so the
    //    chat list metadata still refreshes.
    try {
      const convIds = await _gatherConvIds();
      await _runDeltaForAll(convIds);
    } catch (e) {
      try { console.warn('[onlineRecovery] delta sync:', e?.message); } catch {}
    }

    // c) Chat list metadata refresh — picks up newly created conversations
    //    (which wouldn't be in our cached convIds yet) plus unread bumps
    //    and last_message updates.
    try {
      if (typeof _apiRef.chatConversations === 'function') {
        const r = await _apiRef.chatConversations();
        if (r?.success) {
          try {
            const { cacheConversations } = await import('./chatCache');
            const list = r.data?.conversations || r.data?.chats || [];
            if (Array.isArray(list) && list.length) {
              cacheConversations(list).catch(() => {});
            }
          } catch {}
        }
      }
    } catch (e) {
      try { console.warn('[onlineRecovery] chat list refresh:', e?.message); } catch {}
    }

    // d) E2EE envelope backlog — feature-gated inside the puller itself,
    //    so this is a cheap no-op when envelope mode is off.
    try {
      const ep = await import('./envelopePuller');
      if (typeof ep.flushEnvelopesNow === 'function') {
        await ep.flushEnvelopesNow();
      }
    } catch (e) {
      try { console.warn('[onlineRecovery] envelope pull:', e?.message); } catch {}
    }

    _lastSyncAt = Date.now();
    _log('[onlineRecovery] done');
  } finally {
    try { clearTimeout(_badgeWatchdog); } catch {}
    _syncing = false;
    try { globalThis.__chatyy_syncing = false; } catch {}
    _notify();
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Wire up triggers and start listening. Idempotent — safe to call from
 * any mount. `apiCall` is the services/api module (we use chatConversations
 * + the api object as the arg to replayOfflineQueue).
 */
export function startOnlineRecovery(apiCall, opts) {
  if (_running) return;
  if (!apiCall) return;
  // Belt-and-suspenders: if stopOnlineRecovery wasn't called between two
  // starts (e.g. fast logout→login), make sure no stray subscriptions from
  // the previous wire-up remain. Without this, every login would stack a
  // fresh `ws.on('connection')` listener on top of the old one and each
  // auth_success would fan out to N listeners, each scheduling its own
  // recovery — the symptom users saw as the WS reconnect storm log spam.
  if (_netUnsub) { try { _netUnsub(); } catch {} _netUnsub = null; }
  if (_wsUnsub)  { try { _wsUnsub();  } catch {} _wsUnsub  = null; }
  if (_appStateSub && typeof _appStateSub.remove === 'function') {
    try { _appStateSub.remove(); } catch {}
  }
  _appStateSub = null;
  _running = true;
  _lastScheduledAt = 0;
  _apiRef = apiCall;
  _opts = opts || {};

  // 1) NetInfo offline → online flip
  try {
    let lastConnected = netIsConnected();
    _netUnsub = onNetworkChange((state) => {
      const now = !!state?.isConnected;
      // Only fire on the transition (false → true). onNetworkChange fires
      // immediately with the current state on subscribe, which would
      // otherwise queue a recovery on every mount.
      if (!lastConnected && now) _schedule('netinfo_online');
      lastConnected = now;
    });
  } catch {}

  // 2) WS connection — subscribe via require so we don't choke if the file
  //    isn't loaded yet (websocket.js is large and lazy in some flows).
  try {
    const ws = require('./websocket').default;
    if (ws && typeof ws.on === 'function') {
      _wsUnsub = ws.on('connection', (evt) => {
        if (evt?.status === 'authenticated') _schedule('ws_authenticated');
      });
    }
  } catch {}

  // 3) AppState 'active' transition — covers the case where NetInfo never
  //    flapped (carrier kept the radio up) but the OS suspended us long
  //    enough that the WS dropped silently.
  try {
    let lastState = AppState.currentState;
    _appStateSub = AppState.addEventListener('change', (next) => {
      if (lastState !== 'active' && next === 'active') {
        _schedule('appstate_active');
      }
      lastState = next;
    });
  } catch {}

  // 4) Kick once at startup so the boot-time recovery doesn't have to wait
  //    for one of the triggers to fire (it usually does within ~500ms but
  //    a freshly-killed app with no event flap would otherwise idle).
  _schedule('boot');
}

/** Tear down listeners. Called from logout. */
export function stopOnlineRecovery() {
  _running = false;
  _apiRef = null;
  _lastScheduledAt = 0;
  if (_debounceTimer) { try { clearTimeout(_debounceTimer); } catch {} _debounceTimer = null; }
  if (_netUnsub) { try { _netUnsub(); } catch {} _netUnsub = null; }
  if (_wsUnsub)  { try { _wsUnsub();  } catch {} _wsUnsub  = null; }
  if (_appStateSub && typeof _appStateSub.remove === 'function') {
    try { _appStateSub.remove(); } catch {}
  }
  _appStateSub = null;
}

/** Run the recovery sequence immediately (bypass debounce). */
export function forceSync() {
  if (!_running || !_apiRef) return Promise.resolve();
  if (_debounceTimer) { try { clearTimeout(_debounceTimer); } catch {} _debounceTimer = null; }
  return _runRecovery('force');
}

/** Subscribe to {running:boolean} updates — chat list badge consumes this. */
export function subscribeSyncStatus(cb) {
  if (typeof cb !== 'function') return () => {};
  _listeners.add(cb);
  try { cb({ running: _syncing }); } catch {}
  return () => _listeners.delete(cb);
}

/** Synchronous read of the syncing flag. */
export function isSyncing() { return _syncing; }

export default {
  startOnlineRecovery,
  stopOnlineRecovery,
  forceSync,
  subscribeSyncStatus,
  isSyncing,
};
