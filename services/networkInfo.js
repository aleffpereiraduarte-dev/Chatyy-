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

// Initialize on native
if (NetInfo) {
  NetInfo.addEventListener(state => {
    _currentState = {
      isConnected: state.isConnected,
      type: state.type, // 'wifi', 'cellular', 'none', etc.
      isWifi: state.type === 'wifi',
    };
    _listeners.forEach(cb => { try { cb(_currentState); } catch {} });
  });
}

// Initialize on web
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  _currentState.isConnected = navigator.onLine;
  window.addEventListener('online', () => {
    _currentState = { isConnected: true, type: 'unknown', isWifi: false };
    _listeners.forEach(cb => { try { cb(_currentState); } catch {} });
  });
  window.addEventListener('offline', () => {
    _currentState = { isConnected: false, type: 'none', isWifi: false };
    _listeners.forEach(cb => { try { cb(_currentState); } catch {} });
  });
}

export function getNetworkState() {
  return _currentState;
}

export function onNetworkChange(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

export function isConnected() {
  return _currentState.isConnected;
}

export function isWifi() {
  return _currentState.isWifi;
}
