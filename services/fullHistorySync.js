// services/fullHistorySync.js
//
// WhatsApp-grade "tudo fica no celular" bootstrap.
//
// Goal: once per (user, device) after first login, walk EVERY conversation
// the user belongs to and download EVERY message into local SQLite. After
// the bootstrap completes for a given conversation, opening that chat is
// pure SQLite — no network call, works offline, scrolling up never blocks.
//
// Subsequent runs are incremental: WS push, deltaSync via `chat_sync` (pts),
// and the per-conv `since_id` watermark inside chat_messages handle steady
// state. The bootstrap NEVER runs again for a conversation once its
// `fully_synced` flag flips in sync_state.
//
// Storage of progress flags piggybacks on the existing `sync_state` key/value
// table — no schema migration required, OTA-shippable.
//
//   sync_state key                          | value
//   ────────────────────────────────────────┼──────────────────────────────
//   chat_full_bootstrap:<email>             | 'started' | 'done' | iso
//   chat_full_synced:<convId>               | '1' when conv reached its tail
//   chat_full_oldest:<convId>               | smallest msg id we've stored
//
// Per-conv loop:
//   1. Read `oldest` watermark for this conv (or pick min(id) from messages
//      table). If unset, start from "newest first" (before_id = null).
//   2. Call chat_messages(convId, limit=200, before_id=oldest). Save rows
//      to SQLite via existing chatCache.cacheMessages.
//   3. If response has < 200 rows OR no rows → this conv has reached its
//      tail. Flip `chat_full_synced:<convId>` to '1', emit per-conv done.
//   4. Otherwise update `chat_full_oldest:<convId>` to the new minimum id
//      and loop with a 100ms throttle.
//
// Concurrency / pacing:
//   - 1 conv at a time (serialized via internal queue).
//   - 200 msgs/page (backend cap is 100 — we send 100 and let server clamp).
//   - 100ms gap between pages so the UI thread breathes.
//   - Pauses while AppState is 'background'; resumes on 'active'.
//   - Pauses if battery <20% (best-effort via expo-battery; silent skip if
//     module not installed). Resumes on charging or battery >25%.
//   - Single-flight: only one bootstrap loop per process.
//
// Progress emission:
//   `EventBus.emit('chat:bootstrap:progress', {
//       phase: 'start' | 'conv' | 'done',
//       convDone, convTotal, currentConvId, currentConvName
//   })`
//   SyncBar mirrors via the `mailWs` event bus so the chat list paints a
//   thin progress strip while it runs.

import { Platform, AppState } from 'react-native';
import * as localDb from './localDb';
import { cacheMessages } from './chatCache';

let mailWs = null;
try { mailWs = require('./websocket').default; } catch {}

// ─── Tunables ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 100;            // server clamps to min(100, limit)
const PAGE_DELAY_MS = 100;        // gap between pages of the same conv
const CONV_DELAY_MS = 200;        // gap between conversations
const MAX_PAGES_PER_CONV = 1000;  // 1000 × 100 = 100k msg ceiling per conv
const MAX_RUNTIME_MS = 30 * 60 * 1000; // 30min cap per bootstrap session
const RESUME_POLL_MS = 5000;      // re-check battery/AppState every 5s while paused

// ─── State ─────────────────────────────────────────────────────────────────
let _running = false;             // true while loop is in flight
let _abort = false;               // set on logout / clear to stop loop
let _pausedReason = null;         // 'background' | 'battery' | null
let _startedAt = 0;
let _resumeWaiters = [];          // promises waiting for unpause

// ─── Public ────────────────────────────────────────────────────────────────

/**
 * Top-level entry. Idempotent — safe to call from chat.js mount + AppState
 * → 'active' resume. No-op if:
 *   - web (no SQLite)
 *   - already running in this process
 *   - bootstrap key `chat_full_bootstrap:<email>` says 'done'
 */
export async function bootstrapFullHistoryOnce(apiCall, email) {
  if (Platform.OS === 'web') return { skipped: 'web' };
  if (!apiCall || !email) return { skipped: 'no_api_or_email' };
  if (_running) return { skipped: 'already_running' };

  const gateKey = `chat_full_bootstrap:${email.toLowerCase()}`;
  try {
    const v = await localDb.getSyncState(gateKey);
    if (v === 'done') return { skipped: 'already_done' };
  } catch {}

  _running = true;
  _abort = false;
  _startedAt = Date.now();
  _setupLifecycleHooks();
  emit('start', { convDone: 0, convTotal: 0 });

  try {
    await localDb.setSyncState(gateKey, 'started');
    const result = await _runBootstrap(apiCall);
    if (!_abort && !result.timedOut) {
      await localDb.setSyncState(gateKey, 'done');
    }
    emit('done', { convDone: result.convDone, convTotal: result.convTotal });
    return { success: true, ...result };
  } catch (e) {
    console.warn('[fullHistorySync] bootstrap error:', e?.message);
    emit('done', { convDone: 0, convTotal: 0, error: e?.message });
    return { error: e?.message };
  } finally {
    _running = false;
    _teardownLifecycleHooks();
  }
}

/** Force-resume if anything is waiting. Called on AppState → active. */
export function nudgeFullHistorySync() {
  if (!_running) return;
  _pausedReason = null;
  const waiters = _resumeWaiters.splice(0);
  for (const w of waiters) { try { w(); } catch {} }
}

/** Abort the in-flight loop (logout / cache clear). */
export function abortFullHistorySync() {
  _abort = true;
  nudgeFullHistorySync();
}

/** Is a given conversation fully downloaded? UI uses this to decide whether
 *  it can skip the initial network fetch.  Synchronous-friendly wrapper. */
export async function isConvFullySynced(convId) {
  if (Platform.OS === 'web' || !convId) return false;
  try {
    const v = await localDb.getSyncState(`chat_full_synced:${convId}`);
    return v === '1';
  } catch {
    return false;
  }
}

// ─── Core loop ─────────────────────────────────────────────────────────────

async function _runBootstrap(apiCall) {
  // 1. Pull the full conversation list (server caps at 500/page; we paginate).
  const convs = await _fetchAllConversations(apiCall);
  const convTotal = convs.length;
  emit('start', { convDone: 0, convTotal });

  let convDone = 0;
  for (const conv of convs) {
    if (_abort) break;
    if (Date.now() - _startedAt > MAX_RUNTIME_MS) {
      return { convDone, convTotal, timedOut: true };
    }

    const convId = Number(conv?.id);
    if (!convId) { convDone++; continue; }

    const alreadyDone = await localDb.getSyncState(`chat_full_synced:${convId}`);
    if (alreadyDone === '1') { convDone++; emit('conv', { convDone, convTotal, currentConvId: convId, currentConvName: conv?.name }); continue; }

    emit('conv', {
      convDone, convTotal,
      currentConvId: convId,
      currentConvName: conv?.name || null,
    });

    try {
      await _drainConv(apiCall, convId);
      await localDb.setSyncState(`chat_full_synced:${convId}`, '1');
    } catch (e) {
      // Per-conv error doesn't abort the whole bootstrap. The next launch
      // re-tries from the same oldest watermark — idempotent.
      console.warn(`[fullHistorySync] conv ${convId} drain failed:`, e?.message);
    }

    convDone++;
    await _sleep(CONV_DELAY_MS);
    await _waitWhilePaused();
  }

  return { convDone, convTotal, timedOut: false };
}

// Walk one conversation's history pagewise from its current oldest watermark
// back to the very first message. Saves to SQLite via cacheMessages.
async function _drainConv(apiCall, convId) {
  const oldestKey = `chat_full_oldest:${convId}`;
  let beforeId = null;
  try {
    const raw = await localDb.getSyncState(oldestKey);
    const n = raw ? parseInt(raw, 10) : 0;
    if (Number.isFinite(n) && n > 0) beforeId = n;
  } catch {}

  for (let page = 0; page < MAX_PAGES_PER_CONV; page++) {
    if (_abort) return;
    await _waitWhilePaused();
    if (Date.now() - _startedAt > MAX_RUNTIME_MS) return;

    // Use the api wrapper so the request goes through the same auth/retry
    // path the rest of the app uses. apiCall name: 'chat_messages'.
    let r;
    try {
      r = await apiCall('chat_messages', {
        conversation_id: convId,
        limit: PAGE_SIZE,
        before_id: beforeId || 0,
      });
    } catch (e) {
      // Network blip — back off and retry the same page once. If it still
      // fails, throw to bail this conv.
      await _sleep(2000);
      r = await apiCall('chat_messages', {
        conversation_id: convId,
        limit: PAGE_SIZE,
        before_id: beforeId || 0,
      });
    }

    if (!r || !r.success) {
      // Backend returned an error (403 not-a-member, etc.) — bail this conv.
      // The flip-to-fully_synced at the call site is skipped so we'll retry
      // next launch.
      throw new Error(r?.message || 'chat_messages_failed');
    }

    const msgs = Array.isArray(r.data?.messages)
      ? r.data.messages
      : (Array.isArray(r.messages) ? r.messages : []);

    if (!msgs.length) return; // reached the start of history

    // Save into SQLite + MMKV mirror via the canonical cacheMessages path so
    // dedup/upsert semantics match WS-driven inserts.
    try { await cacheMessages(convId, msgs); } catch (e) {
      console.warn(`[fullHistorySync] cacheMessages conv ${convId}:`, e?.message);
    }

    // Advance the watermark to the smallest id we just received.
    let minId = beforeId || Number.MAX_SAFE_INTEGER;
    for (const m of msgs) {
      const id = Number(m?.id);
      if (Number.isFinite(id) && id > 0 && id < minId) minId = id;
    }
    if (minId > 0 && minId !== Number.MAX_SAFE_INTEGER) {
      beforeId = minId;
      try { await localDb.setSyncState(oldestKey, String(minId)); } catch {}
    }

    // Less than a full page = we hit the start.
    if (msgs.length < PAGE_SIZE) return;

    await _sleep(PAGE_DELAY_MS);
  }
}

// ─── Conversation list (paginated) ─────────────────────────────────────────

async function _fetchAllConversations(apiCall) {
  const PAGE = 500;
  const out = [];
  let offset = 0;
  while (true) {
    if (_abort) break;
    let r;
    try {
      r = await apiCall('chat_conversations', { limit: PAGE, offset });
    } catch (e) {
      console.warn('[fullHistorySync] chat_conversations:', e?.message);
      break;
    }
    if (!r?.success) break;
    // chat_conversations historically returns `data: [...]` (top-level array)
    // while newer endpoints sometimes nest it under `data.conversations`. Handle
    // both shapes so this module survives backend evolution.
    let list = [];
    if (Array.isArray(r.data)) list = r.data;
    else if (Array.isArray(r.data?.conversations)) list = r.data.conversations;
    else if (Array.isArray(r.conversations)) list = r.conversations;
    if (!list.length) break;
    out.push(...list);
    if (list.length < PAGE) break;
    offset += list.length;
    await _sleep(100);
  }
  return out;
}

// ─── Lifecycle: pause/resume on AppState + battery ─────────────────────────

let _appStateSub = null;
function _setupLifecycleHooks() {
  if (_appStateSub) return;
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        _pausedReason = null;
        nudgeFullHistorySync();
      } else if (s === 'background') {
        _pausedReason = 'background';
      }
    });
  } catch {}
}
function _teardownLifecycleHooks() {
  try { _appStateSub?.remove?.(); } catch {}
  _appStateSub = null;
}

async function _checkBattery() {
  // Best-effort, optional dep. If expo-battery isn't installed, we skip the
  // gate (assume battery OK).
  try {
    const Battery = require('expo-battery');
    if (!Battery?.getBatteryLevelAsync) return true;
    const lvl = await Battery.getBatteryLevelAsync();
    const charging = (await Battery.getBatteryStateAsync()) === Battery.BatteryState?.CHARGING;
    if (charging) return true;
    // Pause below 20%, resume only after 25% (hysteresis).
    if (lvl != null && lvl < 0.20) return false;
    return true;
  } catch {
    return true;
  }
}

async function _waitWhilePaused() {
  // Background pause
  if (_pausedReason === 'background') {
    await new Promise(res => {
      _resumeWaiters.push(res);
      // Also poll periodically in case the AppState listener missed it.
      setTimeout(() => {
        if (AppState.currentState === 'active') {
          _pausedReason = null;
          res();
        }
      }, RESUME_POLL_MS);
    });
  }
  // Battery pause (re-check on every page boundary)
  const batteryOk = await _checkBattery();
  if (!batteryOk) {
    _pausedReason = 'battery';
    await _sleep(RESUME_POLL_MS);
    return _waitWhilePaused();
  }
  if (_pausedReason === 'battery') _pausedReason = null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function emit(phase, payload) {
  try {
    mailWs?._emit?.('chat_bootstrap_progress', { phase, ...payload });
  } catch {}
}
