// Debug logger - captures all logs for display in-app (like F12 console)
import { Platform } from 'react-native';
import { getBaseUrl } from './api';

const MAX_LOGS = 100;
let _logs = [];
let _listeners = [];

function _safeStringify(v) {
  if (v == null) return String(v);
  if (typeof v !== 'object') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function debugLog(category, message) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    category,
    message: _safeStringify(message).slice(0, 200),
    platform: Platform.OS,
  };
  _logs.unshift(entry);
  if (_logs.length > MAX_LOGS) _logs = _logs.slice(0, MAX_LOGS);
  _listeners.forEach(fn => { try { fn([..._logs]); } catch {} });
  // Also send to server for remote debugging
  try {
    fetch(`${getBaseUrl()}/api/email.php?action=debug_log&step=` + encodeURIComponent(`[${category}] ${entry.message}`) + '&platform=' + Platform.OS, { method: 'GET' }).catch(() => {});
  } catch {}
}

export function onLogsChange(fn) {
  _listeners.push(fn);
  fn([..._logs]);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

export function getLogs() { return [..._logs]; }
export function clearLogs() {
  _logs = [];
  _listeners.forEach(fn => { try { fn([]); } catch {} });
}
