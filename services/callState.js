/**
 * Global call state holder.
 *
 * Lives outside Expo Router's screen modules so getGlobalCall() returns
 * the SAME instance whether called from app/call.js or from a component
 * like CallStatusBar.js (Expo Router loads screens in separate chunks).
 */

// Lightweight event listeners for system-driven call state changes
// (audio interruption from PSTN call, network reachability, etc).
const _audioInterruptionListeners = new Set();
const _networkChangeListeners = new Set();

export function onAudioInterruption(fn) {
  _audioInterruptionListeners.add(fn);
  return () => _audioInterruptionListeners.delete(fn);
}
export function notifyAudioInterruption(state) {
  // Copy before iterating — listeners may unsubscribe themselves during dispatch.
  for (const fn of [..._audioInterruptionListeners]) {
    try { fn(state); } catch {}
  }
}
export function onNetworkChange(fn) {
  _networkChangeListeners.add(fn);
  return () => _networkChangeListeners.delete(fn);
}
export function notifyNetworkChange(status, isExpensive) {
  for (const fn of [..._networkChangeListeners]) {
    try { fn(status, isExpensive); } catch {}
  }
}

let _globalCall = null;
// Shape: { callId, pc, localStream, screenStream, wsUnsubs, duration, contactEmail, isCaller }

export function getGlobalCall() {
  return _globalCall;
}

export function setGlobalCall(call) {
  _globalCall = call;
}

export function clearGlobalCall() {
  _globalCall = null;
}

/**
 * Hard hangup: close everything we know about the call locally.
 * Returns true if anything was closed.
 */
export function hangupGlobalCall() {
  const gc = _globalCall;
  if (!gc) return false;
  _globalCall = null;
  try { gc.pc?.getSenders?.().forEach(s => { try { s.track?.stop(); } catch {} }); } catch {}
  try { gc.pc?.getReceivers?.().forEach(r => { try { r.track?.stop(); } catch {} }); } catch {}
  try { gc.pc?.close?.(); } catch {}
  try { gc.localStream?.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
  try { gc.screenStream?.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
  try { (gc.wsUnsubs || []).forEach(fn => { try { fn(); } catch {} }); } catch {}
  return true;
}
