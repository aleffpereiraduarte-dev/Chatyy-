// services/callDiag.js — WAVE 104F (2026-05-21)
//
// Persistent ring-buffer for call lifecycle telemetry. Works identically to
// the live-broadcast diagnostics in cfStreamPublisher.js (liveDiagAppend /
// liveDiagRead / liveDiagClear) — same AsyncStorage + JSON pattern, same
// 100-entry cap, same best-effort contract (never throws to caller).
//
// Usage:
//   import { callDiagAppend } from './callDiag';
//   callDiagAppend('info', 'LK Room connected', { ttfc_ms: 412 });
//
// Reading:
//   import { getCallDiag } from './callDiag';
//   const entries = await getCallDiag(); // newest-last array

const DIAG_KEY = 'chatyy.call_diag';
const DIAG_MAX = 100;

let _AS = undefined;
function getAsyncStorage() {
  if (_AS !== undefined) return _AS;
  try {
    _AS = require('@react-native-async-storage/async-storage').default;
  } catch (e) {
    _AS = null;
  }
  return _AS;
}

/**
 * Append an entry to the call diagnostics ring buffer.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} msg  — kept to 600 chars
 * @param {object} [payload] — small optional JSON blob (ICE state, reason, etc.)
 */
export async function callDiagAppend(level, msg, payload) {
  try {
    const AS = getAsyncStorage();
    if (!AS) {
      // Web / dev — still visible in console for QA.
      console.log('[call-diag]', level, msg, payload || '');
      return;
    }
    const raw = await AS.getItem(DIAG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push({
      ts: Math.floor(Date.now() / 1000),
      level: String(level || 'info'),
      msg: String(msg || '').slice(0, 600),
      payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
    });
    if (list.length > DIAG_MAX) list.splice(0, list.length - DIAG_MAX);
    await AS.setItem(DIAG_KEY, JSON.stringify(list));
  } catch (e) {
    // Best-effort — never throw from diag.
  }
}

/**
 * Return all stored entries (oldest first). Returns [] on any error.
 */
export async function getCallDiag() {
  try {
    const AS = getAsyncStorage();
    if (!AS) return [];
    const raw = await AS.getItem(DIAG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Wipe the ring buffer.
 */
export async function clearCallDiag() {
  try {
    const AS = getAsyncStorage();
    if (!AS) return;
    await AS.removeItem(DIAG_KEY);
  } catch {}
}
