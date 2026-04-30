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
let _currentState = { isConnected: true, type: 'unknown', isWifi: false };

function _notify() {
  for (const cb of _listeners) { try { cb(_currentState); } catch {} }
}

// Initialize on native — guard against duplicate subscriptions in Fast Refresh.
if (NetInfo && !globalThis.__netinfo_unsub) {
  // Seed state with current connectivity so the first render isn't optimistic.
  try { NetInfo.fetch().then(s => {
    if (s) {
      _currentState = {
        isConnected: !!s.isConnected,
        type: s.type || 'unknown',
        isWifi: s.type === 'wifi' || s.type === 'ethernet',
      };
      _notify();
    }
  }).catch(() => {}); } catch {}
  globalThis.__netinfo_unsub = NetInfo.addEventListener(state => {
    _currentState = {
      isConnected: !!state.isConnected,
      type: state.type, // 'wifi', 'cellular', 'none', etc.
      isWifi: state.type === 'wifi' || state.type === 'ethernet',
    };
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
