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
  // Keep the legacy (status, isExpensive) shape so callkeep.js doesn't
  // need to change. Internally we also synthesize a transition type so
  // typed subscribers (subscribeNetworkChange) can react to wifi↔cellular
  // handovers without having to keep their own history.
  const info = _computeTransitionInfo(status, !!isExpensive);
  _lastNetworkStatus = status;
  _lastIsExpensive = !!isExpensive;
  for (const fn of [..._networkChangeListeners]) {
    try { fn(status, !!isExpensive, info); } catch {}
  }
  for (const fn of [..._typedNetworkChangeListeners]) {
    try { fn(info); } catch {}
  }
}

// Typed subscribers receive a richer object: { type, status, isExpensive,
// prevStatus, prevIsExpensive }. `type` is one of:
//   - 'wifi-to-cellular' : was on Wi-Fi/ethernet, moved to cellular
//   - 'cellular-to-wifi' : was on cellular, moved to Wi-Fi/ethernet
//   - 'lost'             : went offline / unreachable
//   - 'restored'         : came back online from offline
//   - 'metered-flip'     : same transport, isExpensive flipped
//   - 'noop'             : status/expensive unchanged — emitted on first
//                          subscribe so consumers can synchronously read
//                          the current state.
// We deliberately keep the legacy bus so existing consumers (chat header
// reconnect badge etc) don't have to migrate.
const _typedNetworkChangeListeners = new Set();
let _lastNetworkStatus = null;
let _lastIsExpensive = false;

function _normalizeStatus(s) {
  // ExpoCallKit emits 'wifi' / 'cellular' / 'offline' / 'unknown'; iOS path
  // names differ slightly. Map everything to 4 canonical values so the
  // transition logic doesn't have to deal with 'cellular' vs 'mobile' vs
  // 'wwan' vs 'cell'.
  if (!s) return 'unknown';
  const x = String(s).toLowerCase();
  if (x === 'wifi' || x === 'ethernet' || x === 'wired') return 'wifi';
  if (x === 'cellular' || x === 'mobile' || x === 'wwan' || x === 'cell') return 'cellular';
  if (x === 'offline' || x === 'none' || x === 'lost' || x === 'unreachable') return 'offline';
  return 'unknown';
}

function _computeTransitionInfo(status, isExpensive) {
  const prevStatus = _normalizeStatus(_lastNetworkStatus);
  const curStatus = _normalizeStatus(status);
  let type = 'noop';
  if (prevStatus === 'wifi' && curStatus === 'cellular') type = 'wifi-to-cellular';
  else if (prevStatus === 'cellular' && curStatus === 'wifi') type = 'cellular-to-wifi';
  else if (curStatus === 'offline' && prevStatus !== 'offline') type = 'lost';
  else if (prevStatus === 'offline' && curStatus !== 'offline') type = 'restored';
  else if (prevStatus === curStatus && _lastIsExpensive !== isExpensive) type = 'metered-flip';
  return {
    type,
    status: curStatus,
    isExpensive: !!isExpensive,
    prevStatus,
    prevIsExpensive: _lastIsExpensive,
    raw: status,
  };
}

/**
 * Typed subscription: callback receives one argument `info` shaped like
 *   { type, status, isExpensive, prevStatus, prevIsExpensive, raw }
 * The unsubscribe fn it returns matches the rest of the call-state bus.
 * Designed for in-call ICE restart on Wi-Fi↔cellular handover (gap D3) —
 * callkeep.js already pipes the native NWPathMonitor / ConnectivityManager
 * events into notifyNetworkChange, so subscribers fire as soon as the OS
 * sees the change.
 */
export function subscribeNetworkChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _typedNetworkChangeListeners.add(fn);
  return () => _typedNetworkChangeListeners.delete(fn);
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
