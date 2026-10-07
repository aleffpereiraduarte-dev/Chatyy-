// [2026-10-07 native-core] Native messaging core — phase 1 (SHADOW) JS side.
//
// WhatsApp / Signal / Telegram keep the connection + local store in native
// code so messages land on the device even while the UI/JS is suspended; the
// UI only renders the store. Phase 1 validates the native transport WITHOUT
// changing who owns anything:
//
//   - the native ChatyyChatCore module (modules/expo-callkit: ChatCoreSocket.kt /
//     ChatCoreSocket.swift) opens its OWN WebSocket while the app is in the
//     foreground (same auth/resume/ping protocol as services/websocket.js, its
//     own instance_id so the hub never supersedes the JS socket);
//   - every chat_message / chat_summary it receives is appended to the
//     existing native journal (ChatBgJournal, src "ws") and emitted here →
//     a debounced bgJournal.mergeSync() folds it into SQLite (idempotent:
//     INSERT OR IGNORE by id; the conversation is only bumped when the
//     journal has a NEWER message than the local list) — so the journal never
//     grows during a foreground session and a frame the JS socket missed is
//     still persisted;
//   - native-vs-JS parity (frames seen by each side, arrival delta) goes to
//     push_diag (`native_core_parity`).
//
// The JS socket (services/websocket.js) keeps working exactly as today.
//
// Gate: constants/featureFlags NATIVE_CORE_ENABLED (default false) or the
// account allowlist NATIVE_CORE_TEST_ACCOUNTS, or globalThis.__chatyy_native_core.
// When everything is off, init() returns on its first statement.
// Capability-detected: requireOptionalNativeModule → null on binaries without
// the module → no-op. Never throws.
//
// [2026-10-08 native-core-2] PHASE 2 groundwork — flag NATIVE_CORE_PRIMARY
// (default OFF; dev override globalThis.__chatyy_native_core_primary). Only
// for accounts where the shadow runs, and only on binaries whose module
// reports version() >= 2. When active:
//   - native.setPrimary(true): the native socket forwards RAW every frame that
//     carries a per-user `event_id` ("onChatCoreRaw"); we inject it into
//     services/websocket.js `_handleMessage` → the SAME listeners as today.
//     A shared event_id dedup (mailWs._evDedup) makes the first socket win;
//     the JS socket stays connected as the fallback for everything (calls,
//     presence, typing, acks, frames without event_id, sends when the native
//     socket is down).
//   - text sends (services/api.js _tryNativeWsSend) go through the native
//     outbox: sendTextNative() → native.sendText (persisted, re-sent with the
//     same cmi on reconnect) → "onChatCoreAck" → resolves with the HTTP-shaped
//     result. Timeout → native.cancelSend + null → HTTP with the same cmi.

import { Platform } from 'react-native';
import { NATIVE_CORE_ENABLED, NATIVE_CORE_TEST_ACCOUNTS, NATIVE_CORE_PRIMARY } from '../constants/featureFlags';

const PARITY_SETTLE_MS = 30 * 1000;      // a frame is judged once both sides had 30s to see it
const PARITY_TICK_MS = 60 * 1000;
const PARITY_REPORT_EVERY_MS = 10 * 60 * 1000;
const MERGE_DEBOUNCE_MS = 2500;
const MAX_TRACKED = 2000;
const EV_DEDUP_MAX = 4096;
// Frames the native side must never inject (it already filters; belt+braces).
const CONTROL_TYPES = new Set([
  'auth_success', 'auth_error', 'welcome', 'pong', 'resume_result', 'resume_complete',
  'resume_full_sync', 'session_replaced', 'superseded', 'server_shutdown',
  'chat_send_ack', 'chat_send_fallback', 'subscribed', 'msgpack_upgraded',
]);

function _canon(e) {
  return String(e || '').trim().toLowerCase().replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
}

function _globalOn() {
  try { return globalThis.__chatyy_native_core === true; } catch { return false; }
}

function _testList() {
  return Array.isArray(NATIVE_CORE_TEST_ACCOUNTS) ? NATIVE_CORE_TEST_ACCOUNTS : [];
}

function _primaryOverride() {
  try {
    const o = globalThis.__chatyy_native_core_primary;
    return o === true || o === false ? o : undefined;
  } catch { return undefined; }
}

/** [phase 2] Is NATIVE_CORE_PRIMARY on for this account? (flag level only) */
export function isPrimaryEnabledFor(acct) {
  if (!isEnabledFor(acct)) return false;
  const o = _primaryOverride();
  if (o !== undefined) return o;
  return NATIVE_CORE_PRIMARY === true;
}

/** Could the flag be on for SOME account on this bundle? (cheap, sync) */
export function isFlagPossiblyOn() {
  if (Platform.OS === 'web') return false;
  return NATIVE_CORE_ENABLED === true || _globalOn() || _testList().length > 0;
}

/** Is the flag on for this account? */
export function isEnabledFor(acct) {
  if (!isFlagPossiblyOn()) return false;
  if (NATIVE_CORE_ENABLED === true || _globalOn()) return true;
  const a = _canon(acct);
  return !!a && _testList().some((x) => _canon(x) === a);
}

// ─── Native module (lazy, capability-detected) ───────────────────────────────
let _mod; // undefined = not probed yet
function _native() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ChatyyChatCore');
    if (m && typeof m.start === 'function' && typeof m.stop === 'function') _mod = m;
  } catch {}
  return _mod;
}

function _addNativeListener(name, fn) {
  const m = _native();
  if (!m) return null;
  try {
    if (typeof m.addListener === 'function') return m.addListener(name, fn);
  } catch {}
  try {
    const { EventEmitter } = require('expo-modules-core');
    const em = new EventEmitter(m);
    return em.addListener(name, fn);
  } catch {}
  return null;
}

// ─── State ───────────────────────────────────────────────────────────────────
let _inited = false;
let _running = false;
let _acct = '';
let _nativeState = 'idle';
let _nativeAuthedAt = 0;
let _subs = [];          // native subscriptions
let _wsUnsubs = [];      // mailWs listener removers
let _appStateSub = null;
let _tick = null;
let _mergeTimer = null;
let _lastReportAt = 0;
// [phase 2]
let _primary = false;          // primary active (flag + native v2 + running)
let _nativeAuthed = false;
let _nativeCaps = [];
const _evSeen = new Set();
const _evOrder = [];
const _pendingSends = new Map(); // cmi → { finish }
let _p2 = _freshP2();
function _freshP2() { return { inj: 0, inj_dup: 0, inj_stale: 0, js_dup: 0, tx: 0, ack: 0, fb: 0, to: 0, rej: 0 }; }

const _nativeSeen = new Map(); // "cid:mid" → ms
const _jsSeen = new Map();     // "cid:mid" → ms
let _agg = _freshAgg();

function _freshAgg() {
  return {
    both: 0, native_only: 0, js_only: 0, js_only_native_down: 0,
    native_first: 0, js_first: 0, delta_sum_ms: 0, delta_max_ms: 0,
    native_rcpt: 0, js_rcpt: 0, journaled: 0, merges: 0, states: {},
  };
}

function _track(map, key, at) {
  if (map.has(key)) return;
  map.set(key, at);
  if (map.size > MAX_TRACKED) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function _mailWs() {
  try { return require('./websocket').default; } catch { return null; }
}

function _activeAccount() {
  try {
    const ws = _mailWs();
    if (ws && ws.email) return _canon(ws.email);
  } catch {}
  try { return _canon(require('./chatStore').getActiveAccount?.() || ''); } catch { return ''; }
}

function _key(cid, mid) {
  const c = Number(cid); const m = Number(mid);
  if (!(c > 0) || !(m > 0)) return null;
  return c + ':' + m;
}

// ─── JS-side observation (only while running) ────────────────────────────────
function _onJsChat(payload) {
  try {
    const inner = (payload && (payload.message || (payload.data && (payload.data.message || payload.data)))) || payload;
    const cid = inner?.conversation_id || payload?.conversation_id || payload?.data?.conversation_id;
    const k = _key(cid, inner?.id);
    if (k) _track(_jsSeen, k, Date.now());
  } catch {}
}
function _onJsReceipt() { _agg.js_rcpt++; }

// ─── Native events ───────────────────────────────────────────────────────────
function _onNativeFrame(e) {
  try {
    if (!e || !e.type) return;
    if (e.type === 'message_delivered' || e.type === 'message_read') { _agg.native_rcpt++; return; }
    const k = _key(e.cid, e.mid);
    if (!k) return;
    _track(_nativeSeen, k, Number(e.at) || Date.now());
    if (e.journaled) { _agg.journaled++; _scheduleMerge(); }
  } catch {}
}

function _onNativeState(e) {
  try {
    const s = String(e?.state || '');
    _nativeState = s;
    _agg.states[s] = (_agg.states[s] || 0) + 1;
    if (s === 'authenticated') {
      _nativeAuthedAt = Date.now();
      _nativeAuthed = true;
      _nativeCaps = Array.isArray(e?.caps) ? e.caps.slice(0, 32) : [];
    } else if (s === 'closed' || s === 'fatal' || s === 'acct_mismatch' || s === 'replaced' || s === 'no_bearer' || s === 'connecting' || s === 'auth_error') {
      _nativeAuthed = false;
    }
    if (s === 'fatal' || s === 'acct_mismatch' || s === 'replaced' || s === 'no_bearer') {
      _running = s === 'no_bearer' ? _running : false;
      require('./crashReporter').reportStep?.('native_core_state', `state=${s} reason=${String(e?.reason || e?.email || '').slice(0, 60)}`);
    }
  } catch {}
}

// ─── [phase 2] Primary frames + native outbox ────────────────────────────────
function _evRemember(ev) {
  _evSeen.add(ev);
  _evOrder.push(ev);
  if (_evOrder.length > EV_DEDUP_MAX) _evSeen.delete(_evOrder.shift());
}

// Installed as mailWs._evDedup while primary. Called by websocket.js for every
// frame with a numeric event_id (both the JS socket's and the injected ones).
// true → drop (duplicate).
function _evDedup(msg) {
  const ev = msg.event_id;
  if (msg.__nc === true) return false; // injected by us — already remembered
  if (_evSeen.has(ev)) { _p2.js_dup++; return true; }
  _evRemember(ev);
  return false;
}

function _onNativeRaw(e) {
  try {
    if (!_primary || !e || typeof e.raw !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.event_id !== 'number' || !msg.type) return;
    if (CONTROL_TYPES.has(msg.type)) return;
    const ws = _mailWs();
    if (!ws || typeof ws._handleMessage !== 'function') return;
    if (_evSeen.has(msg.event_id)) { _p2.inj_dup++; return; }
    // Resume replays the JS socket already advanced past → it processed them.
    if (msg.resumed === true && msg.event_id <= (Number(ws._lastEventId) || 0)) { _p2.inj_stale++; return; }
    _evRemember(msg.event_id);
    delete msg.ack_id; // acks belong to the socket that received the frame
    msg.__nc = true;
    _p2.inj++;
    ws._handleMessage(msg);
  } catch {}
}

function _onNativeAck(e) {
  try {
    const cmi = e && e.cmi;
    if (!cmi) return;
    const p = _pendingSends.get(cmi);
    if (!p) return;
    if (e.ok === true && typeof e.raw === 'string') {
      let m = null;
      try { m = JSON.parse(e.raw); } catch {}
      const row = m && m.message;
      if (row && row.id != null) {
        _p2.ack++;
        p.finish({ success: true, data: row, message: m.status || 'Message sent', _native_send: true, _native_core: true, _dedup: !!m.dedup });
        return;
      }
    }
    _p2.fb++;
    p.finish(null);
  } catch {}
}

function _nativeVersion() {
  try { return Number(_native()?.version?.()) || 0; } catch { return 0; }
}

function _applyPrimary(acct) {
  const m = _native();
  const want = !!m && isPrimaryEnabledFor(acct) && _nativeVersion() >= 2 &&
    typeof m.setPrimary === 'function' && typeof m.sendText === 'function';
  const ws = _mailWs();
  if (want) {
    try { m.setPrimary(true); } catch {}
    if (ws) ws._evDedup = _evDedup;
    _primary = true;
  } else {
    if (_primary || (ws && ws._evDedup === _evDedup)) {
      try { m?.setPrimary?.(false); } catch {}
      if (ws && ws._evDedup === _evDedup) ws._evDedup = null;
    }
    _primary = false;
  }
}

/**
 * [phase 2] Can services/api.js route a text send through the native outbox
 * right now? (primary active + native socket authenticated + hub cap).
 */
export function canSendNative() {
  if (!_primary || !_running || !_nativeAuthed) return false;
  if (!_nativeCaps.includes('native_send')) return false;
  const m = _native();
  return !!m && typeof m.sendText === 'function';
}

/**
 * [phase 2] Send a hub `chat_send` frame through the native outbox.
 * Resolves: HTTP-shaped result on ack; null on fallback/timeout (caller → HTTP
 * with the same cmi); undefined when the native side refused it locally
 * (caller → JS socket path).
 */
export function sendTextNative(frame, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const m = _native();
    const cmi = frame && frame.client_message_id;
    if (!m || !cmi || !_acct) { resolve(undefined); return; }
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      _pendingSends.delete(cmi);
      resolve(v);
    };
    _pendingSends.set(cmi, { finish });
    timer = setTimeout(() => {
      _p2.to++;
      try { m.cancelSend?.(cmi); } catch {}
      finish(null);
    }, timeoutMs);
    let json;
    try { json = JSON.stringify(frame); } catch { finish(undefined); return; }
    _p2.tx++;
    Promise.resolve()
      .then(() => m.sendText(_acct, cmi, json))
      .then((ok) => { if (ok !== true) { _p2.rej++; finish(undefined); } })
      .catch(() => { _p2.rej++; finish(undefined); });
  });
}

function _scheduleMerge() {
  if (_mergeTimer) return;
  _mergeTimer = setTimeout(() => {
    _mergeTimer = null;
    try {
      const r = require('./bgJournal').mergeSync?.('native_core');
      _agg.merges++;
      if (r && r.retry) _scheduleMerge();
    } catch {}
  }, MERGE_DEBOUNCE_MS);
}

// ─── Parity accounting ───────────────────────────────────────────────────────
function _settle(force) {
  const now = Date.now();
  const cutoff = force ? Infinity : now - PARITY_SETTLE_MS;
  for (const [k, nAt] of _nativeSeen) {
    const jAt = _jsSeen.get(k);
    if (jAt !== undefined) {
      _agg.both++;
      const d = nAt - jAt; // < 0 → native first
      if (d < 0) _agg.native_first++; else _agg.js_first++;
      const ad = Math.abs(d);
      _agg.delta_sum_ms += ad;
      if (ad > _agg.delta_max_ms) _agg.delta_max_ms = ad;
      _nativeSeen.delete(k); _jsSeen.delete(k);
    } else if (nAt <= cutoff) {
      _agg.native_only++;
      _nativeSeen.delete(k);
    }
  }
  for (const [k, jAt] of _jsSeen) {
    if (jAt > cutoff) continue;
    // Only a real gap if the native socket was authenticated at that moment.
    if (_nativeAuthedAt && _nativeAuthedAt < jAt) _agg.js_only++; else _agg.js_only_native_down++;
    _jsSeen.delete(k);
  }
}

function _report(reason, force) {
  try {
    _settle(false);
    const now = Date.now();
    if (!force && now - _lastReportAt < PARITY_REPORT_EVERY_MS) return;
    const a = _agg;
    const total = a.both + a.native_only + a.js_only + a.js_only_native_down;
    if (total === 0 && a.native_rcpt === 0 && a.js_rcpt === 0 && !(_primary && (_p2.inj || _p2.tx))) return;
    _lastReportAt = now;
    let nat = null;
    try { nat = _native()?.getState?.() || null; } catch {}
    const st = nat && nat.stats ? nat.stats : {};
    const info = {
      r: reason, p: Platform.OS,
      both: a.both, n_only: a.native_only, js_only: a.js_only, js_only_nd: a.js_only_native_down,
      n_first: a.native_first, js_first: a.js_first,
      d_avg: a.both ? Math.round(a.delta_sum_ms / a.both) : 0, d_max: a.delta_max_ms,
      rc_n: a.native_rcpt, rc_js: a.js_rcpt, jn: a.journaled, mg: a.merges,
      st: a.states,
      ns: { c: st.connect || 0, a: st.auth_ok || 0, d: st.disconnect || 0, pt: st.pong_timeout || 0, rr: st.resume_replayed || 0, fs: st.resume_full_sync || 0, js: st.journal_skip || 0 },
    };
    if (_primary) info.p2 = _p2;
    _agg = _freshAgg();
    _p2 = _freshP2();
    require('./crashReporter').reportStep?.('native_core_parity', JSON.stringify(info).slice(0, 460));
  } catch {}
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
function _attachJsListeners() {
  if (_wsUnsubs.length) return;
  const ws = _mailWs();
  if (!ws || typeof ws.on !== 'function') return;
  _wsUnsubs.push(ws.on('chat_message', _onJsChat));
  _wsUnsubs.push(ws.on('chat_summary', _onJsChat));
  _wsUnsubs.push(ws.on('message_delivered', _onJsReceipt));
  _wsUnsubs.push(ws.on('message_read', _onJsReceipt));
}

// Account switch / first JS auth → (re)start for that account. Attached once
// in init() (only when the flag is possibly on) and kept for the session.
let _connUnsub = null;
function _attachConnListener() {
  if (_connUnsub) return;
  const ws = _mailWs();
  if (!ws || typeof ws.on !== 'function') return;
  _connUnsub = ws.on('connection', (c) => {
    try {
      if (!c || c.status !== 'authenticated' || !c.email) return;
      const a = _canon(c.email);
      if (a !== _acct || !_running) {
        const { AppState } = require('react-native');
        if (AppState.currentState === 'active') _start('js_auth');
      }
    } catch {}
  });
}

function _detachJsListeners() {
  for (const u of _wsUnsubs) { try { u && u(); } catch {} }
  _wsUnsubs = [];
}

function _start(why) {
  try {
    const acct = _activeAccount();
    if (!acct || !isEnabledFor(acct)) { if (_running) _stop('flag_off'); return; }
    const m = _native();
    if (!m) return;
    if (!_subs.length) {
      const a = _addNativeListener('onChatCoreFrame', _onNativeFrame);
      const b = _addNativeListener('onChatCoreState', _onNativeState);
      if (a) _subs.push(a);
      if (b) _subs.push(b);
      // [phase 2] cheap when primary is off (native never emits them).
      const c = _addNativeListener('onChatCoreRaw', _onNativeRaw);
      const d = _addNativeListener('onChatCoreAck', _onNativeAck);
      if (c) _subs.push(c);
      if (d) _subs.push(d);
    }
    _attachJsListeners();
    let lastEv = 0;
    try { lastEv = Number(_mailWs()?._lastEventId) || 0; } catch {}
    let dev = '';
    try { dev = require('./crashReporter').getAnonIdSync?.() || ''; } catch {}
    if (acct !== _acct) { _nativeSeen.clear(); _jsSeen.clear(); }
    if (acct !== _acct) { _nativeAuthed = false; _nativeCaps = []; }
    _acct = acct;
    _running = true;
    _applyPrimary(acct);
    m.start(acct, lastEv, dev)?.catch?.(() => {});
    if (!_tick) _tick = setInterval(() => _report('tick', false), PARITY_TICK_MS);
  } catch {}
}

function _stop(why) {
  try {
    const m = _native();
    if (_primary) {
      try { m?.setPrimary?.(false); } catch {}
      const ws = _mailWs();
      if (ws && ws._evDedup === _evDedup) ws._evDedup = null;
      _primary = false;
    }
    if (m) m.stop(String(why || 'stop'))?.catch?.(() => {});
  } catch {}
  _running = false;
  _nativeAuthed = false;
  // In-flight native sends → HTTP (same cmi); native keeps them persisted and
  // re-sends on the next connect (dedup), unless cancelled here.
  for (const [cmi, p] of _pendingSends) {
    try { _native()?.cancelSend?.(cmi); } catch {}
    try { p.finish(null); } catch {}
  }
  if (_tick) { clearInterval(_tick); _tick = null; }
  _report(why || 'stop', true);
  _detachJsListeners();
}

/**
 * Boot hook (app/_layout.js, after first paint). Returns immediately when the
 * flag is off for every account.
 */
export function init() {
  if (!isFlagPossiblyOn()) return;
  if (_inited) { _start('reinit'); return; }
  _inited = true;
  try {
    const { AppState } = require('react-native');
    let last = AppState.currentState;
    _appStateSub = AppState.addEventListener('change', (s) => {
      try {
        if (s === 'active' && last !== 'active') _start('foreground');
        else if (s === 'background') _stop('background');
      } catch {}
      last = s;
    });
    _attachConnListener();
    if (AppState.currentState === 'active') _start('boot');
  } catch {}
}

/** Explicit stop (logout / tests). */
export function shutdown(reason = 'shutdown') {
  if (!_inited) return;
  _stop(reason);
}

/** Diagnostics for a debug screen / console. */
export function getDiagnostics() {
  let nat = null;
  try { nat = _native()?.getState?.() || null; } catch {}
  return {
    flag: isFlagPossiblyOn(), running: _running, acct: _acct, state: _nativeState,
    available: !!_native(), native: nat, pending: { native: _nativeSeen.size, js: _jsSeen.size },
    primary: _primary, nativeAuthed: _nativeAuthed, caps: _nativeCaps, version: _nativeVersion(),
    p2: { ..._p2 }, sendsInFlight: _pendingSends.size,
  };
}

export default {
  init, shutdown, getDiagnostics, isEnabledFor, isFlagPossiblyOn,
  isPrimaryEnabledFor, canSendNative, sendTextNative,
};
