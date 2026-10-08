/**
 * Backup upload governor — [2026-10-08 upload-br]
 *
 * Photo backup is BACKGROUND work; it must never compete with what the user is
 * doing right now. While a call is ringing/active, or the user is actively
 * chatting (a chat media upload in flight, or a send/enqueue in the last
 * ~20 s), the backup is paused; it resumes ~15 s after things are quiet again.
 *
 *  - JS engine (Android / fallback): pauseBackup()/resumeBackup() of the
 *    unified facade (engine.isPaused → the upload loop idles between items).
 *  - iOS native pass (startNativeBackup): the Swift module has no pause, only
 *    stopBackup() (finishes in-flight assets, then returns). We stop it and,
 *    once quiet, kick ONE auto pass again (autoBackup.startForegroundBackup
 *    with {auto:true}, which re-checks Wi-Fi/charging gates).
 *
 * Only undoes what IT did: a backup the user paused stays paused.
 * Zero native deps; every require is lazy (no import cycles with
 * mediaSendQueue / autoBackup / backupEngine).
 */
import { Platform } from 'react-native';

const CHAT_ACTIVE_MS = 20 * 1000;
const RESUME_QUIET_MS = 15 * 1000;
const POLL_MS = 5 * 1000;

let _lastChatActivity = 0;
let _pausedReason = null;      // 'call' | 'chat' | null — set only when WE paused
let _engineWasPausedByUs = false;
let _nativeStoppedByUs = false;
let _quietSince = 0;
let _pollTimer = null;
let _unsubCall = null;
let _startedAt = 0;
const _subs = new Set();

/** Cheap signal from the chat send paths (mediaSendQueue.enqueueMedia, sendWorker). */
export function noteChatActivity() {
  _lastChatActivity = Date.now();
  if (_pollTimer) _evaluate();
}

/** 'call' | 'chat' | null — exposed for the Backup settings UI ("pausado: em chamada"). */
export function getPauseReason() { return _pausedReason; }

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
function _notify() { for (const fn of _subs) { try { fn(_pausedReason); } catch {} } }

function _callActive() {
  try {
    const cs = require('../callState');
    const st = cs?.getCallState?.();
    if (st === 'ringing' || st === 'answered' || st === 'active') return true;
  } catch {}
  try { return !!globalThis.__chatyyNativeCallActive; } catch { return false; }
}

function _chatBusy() {
  if (Date.now() - _lastChatActivity < CHAT_ACTIVE_MS) return true;
  try {
    const q = require('../mediaSendQueue');
    if (typeof q?.activeUploadCount === 'function' && q.activeUploadCount() > 0) return true;
  } catch {}
  return false;
}

/** Current reason the backup SHOULD be held (independent of whether it runs). */
export function currentBusyReason() {
  if (_callActive()) return 'call';
  if (_chatBusy()) return 'chat';
  return null;
}

function _facade() { try { return require('./index'); } catch { return null; } }
function _auto() { try { return require('../autoBackup'); } catch { return null; } }
function _native() {
  if (Platform.OS !== 'ios') return null;
  try { const m = require('../../modules/expo-background-upload'); return m?.default || m; } catch { return null; }
}

function _pauseNow(reason) {
  _pausedReason = reason;
  _quietSince = 0;
  try {
    const f = _facade();
    const engine = require('../backupEngine').getBackupEngine?.();
    if (engine && engine.isRunning && !engine.isPaused) { f?.pauseBackup?.(); _engineWasPausedByUs = true; }
  } catch {}
  try {
    const a = _auto();
    const nativeRunning = typeof a?.isNativeBackupRunning === 'function' ? a.isNativeBackupRunning() : false;
    const n = _native();
    if (nativeRunning && n && typeof n.stopBackup === 'function') { n.stopBackup(); _nativeStoppedByUs = true; }
  } catch {}
  _notify();
}

function _resumeNow() {
  const hadNative = _nativeStoppedByUs;
  if (_engineWasPausedByUs) { try { _facade()?.resumeBackup?.(); } catch {} }
  _engineWasPausedByUs = false;
  _nativeStoppedByUs = false;
  _pausedReason = null;
  _quietSince = 0;
  _notify();
  if (hadNative) {
    // Give the stopped native pass a moment to return and release its lock.
    setTimeout(() => {
      try { _auto()?.startForegroundBackup?.(null, { auto: true })?.catch?.(() => {}); } catch {}
    }, 3000);
  }
}

function _evaluate() {
  const reason = currentBusyReason();
  if (reason) {
    if (!_pausedReason) {
      // Only bother pausing when a backup is actually running.
      let running = false;
      try { running = !!_facade()?.isBackupRunning?.(); } catch {}
      try { const a = _auto(); if (!running && typeof a?.isNativeBackupRunning === 'function') running = a.isNativeBackupRunning(); } catch {}
      if (running) _pauseNow(reason);
    } else if (_pausedReason !== reason) {
      _pausedReason = reason; _quietSince = 0; _notify();
    } else {
      _quietSince = 0;
    }
    return;
  }
  if (_pausedReason) {
    if (!_quietSince) _quietSince = Date.now();
    else if (Date.now() - _quietSince >= RESUME_QUIET_MS) _resumeNow();
    return;
  }
  // Self-clean: nothing paused, nothing running for a while → stop polling.
  if (_startedAt && Date.now() - _startedAt > 30000) {
    let running = false;
    try { running = !!_facade()?.isBackupRunning?.(); } catch {}
    try { const a = _auto(); if (!running && typeof a?.isNativeBackupRunning === 'function') running = a.isNativeBackupRunning(); } catch {}
    if (!running) _clearTimers();
  }
}

function _clearTimers() {
  if (_pollTimer) { try { clearInterval(_pollTimer); } catch {} _pollTimer = null; }
  if (_unsubCall) { try { _unsubCall(); } catch {} _unsubCall = null; }
  _startedAt = 0;
}

/** Start watching (idempotent). Called when a backup run starts. */
export function start() {
  if (Platform.OS === 'web' || _pollTimer) return;
  try {
    const cs = require('../callState');
    if (typeof cs?.subscribeCallState === 'function') _unsubCall = cs.subscribeCallState(() => _evaluate());
  } catch {}
  _pollTimer = setInterval(_evaluate, POLL_MS);
  _startedAt = Date.now();
  _evaluate();
}

/** Stop watching; resumes anything we paused. Called when the run ends. */
export function stop() {
  // A native pass WE stopped ends its run too — keep watching so it gets
  // restarted once the call/chat is over (_resumeNow), then self-cleans.
  if (_nativeStoppedByUs) return;
  _clearTimers();
  if (_engineWasPausedByUs) { try { _facade()?.resumeBackup?.(); } catch {} }
  _engineWasPausedByUs = false;
  _nativeStoppedByUs = false;
  if (_pausedReason) { _pausedReason = null; _notify(); }
}

export default { noteChatActivity, getPauseReason, currentBusyReason, subscribe, start, stop };
