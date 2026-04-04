/**
 * ActiveCallBar — Bridge module.
 *
 * call.js and IncomingCallListener still import setActiveCall / clearActiveCall
 * from this file. Those functions now forward to CallContext so the new
 * CallStatusBar component (which reads CallContext) stays in sync.
 *
 * The default export renders nothing — CallStatusBar is the visible bar.
 */

// ── Module-level bridge ──
// CallContext lives in React-land, but setActiveCall/clearActiveCall are called
// from imperative code (call.js setup effects). We keep a tiny pub/sub so the
// bridge component below can relay into context.
let _pendingCall = null;
let _bridgeCallback = null;

export function setActiveCall(data) {
  _pendingCall = data;
  if (_bridgeCallback) _bridgeCallback(data);
}

export function getActiveCall() {
  return _pendingCall;
}

export function clearActiveCall() {
  _pendingCall = null;
  if (_bridgeCallback) _bridgeCallback(null);
}

/**
 * Register the bridge callback (called by ActiveCallBridge below).
 * Returns unsubscribe function.
 */
export function _subscribeBridge(cb) {
  _bridgeCallback = cb;
  // Flush any pending call that was set before the bridge mounted
  if (_pendingCall) cb(_pendingCall);
  return () => { if (_bridgeCallback === cb) _bridgeCallback = null; };
}

// ── React bridge component ──
// Mounted inside the provider tree so it can call useCall().
import { useEffect } from 'react';
import { useCall } from '../context/CallContext';

export function ActiveCallBridge() {
  const { startCall, endCall } = useCall();

  useEffect(() => {
    const unsub = _subscribeBridge((data) => {
      if (data) {
        startCall(data);
      } else {
        endCall();
      }
    });
    return unsub;
  }, [startCall, endCall]);

  return null;
}

// Default export: no-op (CallStatusBar is used in _layout.js instead)
export default function ActiveCallBar() {
  return null;
}
