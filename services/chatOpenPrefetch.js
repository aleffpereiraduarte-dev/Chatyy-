// [2026-10-09 open-instant] "A mensagem chega (notificação), abro a conversa e
// demora pra aparecer lá."
//
// Before: after a tap / app resume the new message only reached the thread via
//   - chat_sync (services/chatSync.syncConversations): 500 ms debounce AND
//     serialized behind the foreground recovery that pulls ALL conversations
//     (onlineRecoveryOrchestrator, 800 ms debounce + N batches), or
//   - the WS, which on iOS has to reconnect + re-auth after the suspension.
// Now (all JS → OTA):
//   1. The push payload itself is written to the local store on arrival / tap
//      (services/bgJournal.ingestPushPayload) → frame 1 already has the bubble.
//   2. prefetchConversationDelta(cid): direct chat_messages since_id for ONE
//      conversation (tap on a push that couldn't carry the text: E2E/oversized).
//   3. Foreground catch-up (init): on AppState 'active', ONE chat_sync for the
//      conversations a push touched + the ones with unread — fired immediately,
//      outside the serialized/debounced queue — and the hydrated rows go to the
//      store (no watermark advance: the normal sync still runs and dedups).
// Rows go through chatStore.upsertMessages exactly like the existing
// loadMessages/applyEvents paths (server rows; E2E stays ciphertext), never into
// the conversation preview. MERGED_EVENT (bgJournal) tells a mounted
// conversation / the list. Never throws. Kill-switch: globalThis.__chatyy_open_prefetch = false.

import { AppState } from 'react-native';

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const _inflight = new Map(); // cid → at
const TIMEOUT_MS = 6000;

function _off() { return globalThis.__chatyy_open_prefetch === false; }

function _withTimeout(p, ms) {
  let t = null;
  return Promise.race([
    p,
    new Promise((res) => { t = setTimeout(() => res({ success: false, timeout: true }), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

function _emitRows(rows) {
  if (!rows.length) return;
  try {
    const { DeviceEventEmitter } = require('react-native');
    const bj = require('./bgJournal');
    DeviceEventEmitter.emit(bj.MERGED_EVENT, { convs: [], messages: rows, src: 'prefetch' });
  } catch {}
}

function _storeRows(cid, rows) {
  const ok = rows.filter((m) => m && typeof m.id === 'number' && m.id > 0 && _num(m.conversation_id || cid) === _num(cid));
  if (!ok.length) return [];
  const withCid = ok.map((m) => (m.conversation_id ? m : { ...m, conversation_id: _num(cid) }));
  try {
    const cs = require('./chatStore');
    if (cs.isLocked?.()) return [];
    const p = cs.upsertMessages(_num(cid), withCid);
    p?.catch?.(() => {});
  } catch { return []; }
  return withCid;
}

// Same delta start as chat-conversation loadMessages: never after the newest
// row the store really has (cursor can run ahead of the store).
function _sinceFor(cid) {
  try {
    const cs = require('./chatStore');
    if (cs.isLocked?.()) return 0;
    const recent = cs.getMessagesSync(_num(cid), 30) || [];
    let storeMax = 0;
    for (const m of recent) { const n = _num(m && m.id); if (n > storeMax) storeMax = n; }
    const cur = _num(cs.getCursor?.('conv:' + _num(cid))?.last_msg_id);
    if (!storeMax) return 0;
    return cur > 0 ? Math.min(cur, storeMax) : storeMax;
  } catch { return 0; }
}

/** Direct delta for one conversation (tap on a push without the text). */
export function prefetchConversationDelta(cid, reason = '') {
  if (_off()) return Promise.resolve(0);
  const id = _num(cid);
  if (!id) return Promise.resolve(0);
  const last = _inflight.get(id);
  if (last && Date.now() - last < 3000) return Promise.resolve(0);
  const since = _sinceFor(id);
  if (!since) return Promise.resolve(0); // never opened → the screen does the full first page
  _inflight.set(id, Date.now());
  const run = async () => {
    try {
      const api = require('./api');
      const r = await _withTimeout(api.chatMessages(id, 30, null, since), TIMEOUT_MS);
      if (!r || !r.success) return 0;
      const rows = _storeRows(id, Array.isArray(r.data?.messages) ? r.data.messages : []);
      _emitRows(rows);
      try { require('./bootTrace').mark?.('open_prefetch_' + (reason || 'x')); } catch {}
      return rows.length;
    } catch { return 0; } finally { _inflight.delete(id); }
  };
  return run();
}

/**
 * Foreground catch-up: ONE chat_sync for push-touched + unread conversations
 * (max 8, never the open one — its screen fetches its own delta), outside the
 * serialized sync queue. Hydrated rows → store + MERGED_EVENT.
 */
export async function foregroundCatchUp(reason = 'foreground') {
  if (_off()) return 0;
  try {
    const cs = require('./chatStore');
    if (cs.isLocked?.() || !cs.getActiveAccount?.()) return 0;
    let open = null;
    try { open = require('./pushNotifications').getActiveConversation?.() ?? null; } catch {}
    const want = new Map();
    try {
      for (const t of require('./bgJournal').takePushTouched?.() || []) {
        if (!t.locked) want.set(_num(t.cid), 1);
      }
    } catch {}
    try {
      const list = (cs.getConversationsSync?.() || [])
        .filter((c) => c && _num(c.unread_count) > 0 && !c.archived)
        .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
      for (const c of list.slice(0, 8)) want.set(_num(c.id), 1);
    } catch {}
    if (open != null) want.delete(_num(open));
    let getLastPts = null;
    try { getLastPts = require('./chatSync').getLastPts; } catch {}
    const convs = [];
    for (const id of want.keys()) {
      if (!id) continue;
      const pts = getLastPts ? _num(getLastPts(id)) : 0;
      if (pts > 0) convs.push({ id, since_pts: pts, limit: 50 });
      if (convs.length >= 8) break;
    }
    if (!convs.length) return 0;
    const api = require('./api');
    const acct = cs.getActiveAccount?.();
    const r = await _withTimeout(api.apiCall('chat_sync', { conversations: convs }, 'POST'), TIMEOUT_MS);
    if (!r || !r.success) return 0;
    if (cs.getActiveAccount?.() !== acct) return 0; // account switched meanwhile → drop
    let n = 0;
    const all = [];
    for (const c of (Array.isArray(r.data?.conversations) ? r.data.conversations : [])) {
      if (!c || c.denied || !Array.isArray(c.messages) || !c.messages.length) continue;
      const rows = _storeRows(c.id, c.messages);
      n += rows.length;
      all.push(...rows);
    }
    _emitRows(all);
    try { require('./bootTrace').mark?.('fg_catchup_' + reason); } catch {}
    return n;
  } catch { return 0; }
}

let _sub = null;
let _lastFg = 0;
export function init() {
  if (_sub) return;
  try {
    let last = AppState.currentState;
    _sub = AppState.addEventListener('change', (s) => {
      try {
        if (s === 'active' && last && last !== 'active' && Date.now() - _lastFg > 4000) {
          _lastFg = Date.now();
          foregroundCatchUp('foreground').catch?.(() => {});
        }
      } catch {}
      last = s;
    });
  } catch {}
}

export default { prefetchConversationDelta, foregroundCatchUp, init };
