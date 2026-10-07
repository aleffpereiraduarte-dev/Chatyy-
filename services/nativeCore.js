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

import { Platform } from 'react-native';
import { NATIVE_CORE_ENABLED, NATIVE_CORE_TEST_ACCOUNTS } from '../constants/featureFlags';

const PARITY_SETTLE_MS = 30 * 1000;      // a frame is judged once both sides had 30s to see it
const PARITY_TICK_MS = 60 * 1000;
const PARITY_REPORT_EVERY_MS = 10 * 60 * 1000;
const MERGE_DEBOUNCE_MS = 2500;
const MAX_TRACKED = 2000;

function _canon(e) {
  return String(e || '').trim().toLowerCase().replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
}

function _globalOn() {
  try { return globalThis.__chatyy_native_core === true; } catch { return false; }
}

function _testList() {
  return Array.isArray(NATIVE_CORE_TEST_ACCOUNTS) ? NATIVE_CORE_TEST_ACCOUNTS : [];
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
    if (s === 'authenticated') _nativeAuthedAt = Date.now();
    if (s === 'fatal' || s === 'acct_mismatch' || s === 'replaced' || s === 'no_bearer') {
      _running = s === 'no_bearer' ? _running : false;
      require('./crashReporter').reportStep?.('native_core_state', `state=${s} reason=${String(e?.reason || e?.email || '').slice(0, 60)}`);
    }
  } catch {}
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
    if (total === 0 && a.native_rcpt === 0 && a.js_rcpt === 0) return;
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
    _agg = _freshAgg();
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
    }
    _attachJsListeners();
    let lastEv = 0;
    try { lastEv = Number(_mailWs()?._lastEventId) || 0; } catch {}
    let dev = '';
    try { dev = require('./crashReporter').getAnonIdSync?.() || ''; } catch {}
    if (acct !== _acct) { _nativeSeen.clear(); _jsSeen.clear(); }
    _acct = acct;
    _running = true;
    m.start(acct, lastEv, dev)?.catch?.(() => {});
    if (!_tick) _tick = setInterval(() => _report('tick', false), PARITY_TICK_MS);
  } catch {}
}

function _stop(why) {
  try {
    const m = _native();
    if (m) m.stop(String(why || 'stop'))?.catch?.(() => {});
  } catch {}
  _running = false;
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
  };
}

export default { init, shutdown, getDiagnostics, isEnabledFor, isFlagPossiblyOn };
