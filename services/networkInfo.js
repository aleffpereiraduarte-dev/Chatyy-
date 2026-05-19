/**
 * Network Info Service
 * Detects connectivity state (online/offline/wifi/cellular)
 * Uses @react-native-community/netinfo on native, navigator.onLine on web
 */
import { Platform } from 'react-native';

let NetInfo = null;
if (Platform.OS !== 'web') {
  try {
    NetInfo = require('@react-native-community/netinfo').default;
  } catch {}
}

let _listeners = new Set();
let _currentState = {
  isConnected: true,
  type: 'unknown',
  isWifi: false,
  // `isExpensive` mirrors NetInfo's `details.isConnectionExpensive` — set by
  // the OS when the carrier signals metered/roaming. Used as our roaming
  // heuristic since RN's NetInfo doesn't expose a dedicated `isRoaming` flag.
  isExpensive: false,
};

function _notify() {
  for (const cb of _listeners) { try { cb(_currentState); } catch {} }
}

function _normalize(s) {
  if (!s) return _currentState;
  const wifi = s.type === 'wifi' || s.type === 'ethernet';
  // `details.isConnectionExpensive` is iOS+Android-supported on cellular.
  // Wi-Fi can also flag expensive (personal hotspot) — we honor it as roaming.
  const isExpensive = !!(s.details && s.details.isConnectionExpensive);
  return {
    isConnected: !!s.isConnected,
    type: s.type || 'unknown', // 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown'
    isWifi: wifi,
    isExpensive,
  };
}

// Initialize on native — guard against duplicate subscriptions in Fast Refresh.
if (NetInfo && !globalThis.__netinfo_unsub) {
  // Seed state with current connectivity so the first render isn't optimistic.
  try { NetInfo.fetch().then(s => {
    if (s) { _currentState = _normalize(s); _notify(); }
  }).catch(() => {}); } catch {}
  globalThis.__netinfo_unsub = NetInfo.addEventListener(state => {
    _currentState = _normalize(state);
    _notify();
  });
}

// Initialize on web — guard against duplicate listeners in Fast Refresh.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  _currentState.isConnected = !!navigator.onLine;
  if (!window.__netinfo_online) {
    window.__netinfo_online = () => {
      _currentState = { isConnected: true, type: 'unknown', isWifi: false };
      _notify();
    };
    window.addEventListener('online', window.__netinfo_online);
  }
  if (!window.__netinfo_offline) {
    window.__netinfo_offline = () => {
      _currentState = { isConnected: false, type: 'none', isWifi: false };
      _notify();
    };
    window.addEventListener('offline', window.__netinfo_offline);
  }
}

export function getNetworkState() {
  return { ..._currentState };
}

export function onNetworkChange(callback) {
  _listeners.add(callback);
  // Fire immediately so caller doesn't have to wait for the first event.
  try { callback(_currentState); } catch {}
  return () => _listeners.delete(callback);
}

export function isConnected() {
  return !!_currentState.isConnected;
}

export function isWifi() {
  return !!_currentState.isWifi;
}

/**
 * Classify the current connection into one of the WhatsApp auto-download
 * matrix columns: 'wifi' | 'mobile' | 'roaming' | 'none'.
 *
 *   - 'none'    → no connectivity at all (NetInfo says disconnected).
 *   - 'wifi'    → Wi-Fi or wired Ethernet AND not flagged expensive.
 *   - 'roaming' → ANY connection (wifi or cellular) the OS flagged as
 *                 expensive (personal hotspot, carrier roaming). We prefer
 *                 this over 'mobile' because the user opted into the
 *                 stricter column.
 *   - 'mobile'  → cellular AND not expensive.
 *
 * Returns 'wifi' for web (no cellular concept) and 'unknown' before NetInfo
 * has probed — callers map 'unknown' to whichever column is most conservative
 * for the bucket in question.
 */
export function getNetworkType() {
  if (!_currentState.isConnected) return 'none';
  if (Platform.OS === 'web') return 'wifi';
  // Expensive flag wins — even Wi-Fi can be a personal hotspot the user is
  // paying for, and we want to behave like roaming there.
  if (_currentState.isExpensive) return 'roaming';
  if (_currentState.isWifi) return 'wifi';
  if (_currentState.type === 'cellular') return 'mobile';
  return 'unknown';
}
