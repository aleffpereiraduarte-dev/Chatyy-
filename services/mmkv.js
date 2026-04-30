// Chatyy Storage — AsyncStorage with in-memory sync cache
// Pre-loads during splash so reads are instant
import { Platform } from 'react-native';

let _asyncStorage = null;
let _mem = {};
let _ready = false;
let _readyResolve = null;
const _readyPromise = new Promise(r => { _readyResolve = r; });

async function _init() {
  if (Platform.OS === 'web') { _ready = true; _readyResolve(); return; }
  try {
    _asyncStorage = require('@react-native-async-storage/async-storage').default;
    const keys = await _asyncStorage.getAllKeys();
    const mk = (keys || []).filter(k => k.startsWith('mmkv_'));
    if (mk.length > 0) {
      const pairs = await _asyncStorage.multiGet(mk);
      for (const [k, v] of pairs) { if (v !== null) _mem[k] = v; }
    }
  } catch {}
  _ready = true;
  _readyResolve();
}
_init();

export function waitForCacheReady() { return _readyPromise; }
export function isCacheReady() { return _ready; }

export function getString(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(`mmkv_${key}`) : null; } catch { return null; }
  }
  return _mem[`mmkv_${key}`] ?? null;
}

export function setString(key, value) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(`mmkv_${key}`, value); } catch {}
    return;
  }
  _mem[`mmkv_${key}`] = value;
  if (_asyncStorage) _asyncStorage.setItem(`mmkv_${key}`, value).catch(() => {});
}

export function getNumber(key) {
  const v = getString(key); return v !== null ? Number(v) : null;
}
export function setNumber(key, value) { setString(key, String(value)); }

export function getBoolean(key) {
  const v = getString(key);
  if (v === 'true') return true; if (v === 'false') return false; return null;
}
export function setBoolean(key, value) { setString(key, value ? 'true' : 'false'); }

export function getJSON(key) {
  const v = getString(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export function setJSON(key, value) {
  // JSON.stringify(undefined) === undefined → grava "undefined" no web e
  // quebra no native. Tratar undefined como deleção.
  if (value === undefined) return remove(key);
  setString(key, JSON.stringify(value));
}

export function remove(key) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(`mmkv_${key}`); } catch {}
    return;
  }
  delete _mem[`mmkv_${key}`];
  if (_asyncStorage) _asyncStorage.removeItem(`mmkv_${key}`).catch(() => {});
}

export function getAllKeys() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k.substring(5));
      }
      return keys;
    } catch { return []; }
  }
  return Object.keys(_mem).filter(k => k.startsWith('mmkv_')).map(k => k.substring(5));
}

export function clearAll() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
    return;
  }
  _mem = {};
  if (_asyncStorage) {
    _asyncStorage.getAllKeys().then(keys => {
      const mk = (keys || []).filter(k => k.startsWith('mmkv_'));
      if (mk.length) _asyncStorage.multiRemove(mk).catch(() => {});
    }).catch(() => {});
  }
}
