/**
 * Global call state holder.
 *
 * Lives outside Expo Router's screen modules so getGlobalCall() returns
 * the SAME instance whether called from app/call.js or from a component
 * like CallStatusBar.js (Expo Router loads screens in separate chunks).
 */

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
  try { gc.pc?.getSenders?.().forEach(s => { try { s.track?.stop(); } catch {} }); } catch {}
  try { gc.pc?.getReceivers?.().forEach(r => { try { r.track?.stop(); } catch {} }); } catch {}
  try { gc.pc?.close?.(); } catch {}
  try { gc.localStream?.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
  try { gc.screenStream?.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
  try { (gc.wsUnsubs || []).forEach(fn => { try { fn(); } catch {} }); } catch {}
  _globalCall = null;
  return true;
}
