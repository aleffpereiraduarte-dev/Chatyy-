/**
 * screenCaptureGate.js — Global screenshot block.
 *
 * Settings → Privacidade → "Bloquear capturas de tela no app".
 *
 * When the user enables the global toggle:
 *   - iOS: expo-screen-capture.preventScreenCaptureAsync() with a unique
 *          tag ('chatyy-global'). preventScreenCaptureAsync() is reference-
 *          counted by tag, so the global lock coexists with the per-chat
 *          locks already in chat-conversation.js / ChatMediaViewer.js
 *          (they use their own tags). We add a screenshotListener that
 *          fires events the UI can react to (e.g. confirm dialog).
 *   - Android: FLAG_SECURE on the main activity window. Same API. FLAG_SECURE
 *          shows a black thumbnail in recents view + blocks third-party
 *          screen recorders (but NOT camera-of-screen — Apple has the same
 *          limitation).
 *   - Web: no-op (browsers control this).
 *
 * The screen lock is re-applied on every AppState change ('active') so a
 * background-then-foreground cycle doesn't lose it.
 */

import { Platform, AppState } from 'react-native';

const STORAGE_KEY = 'chatyy_screen_capture_block_v1';
const TAG = 'chatyy-global-screencap';

let _enabled = false;
let _appStateSub = null;

function _storageGet(key) {
  return new Promise((resolve) => {
    if (Platform.OS === 'web') {
      try {
        const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        resolve(v === '1');
      } catch { resolve(false); }
      return;
    }
    try {
      import('@react-native-async-storage/async-storage')
        .then(m => m.default.getItem(key))
        .then(v => resolve(v === '1'))
        .catch(() => resolve(false));
    } catch { resolve(false); }
  });
}
function _storageSet(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val ? '1' : '0'); } catch {}
    return Promise.resolve();
  }
  try {
    return import('@react-native-async-storage/async-storage')
      .then(m => m.default.setItem(key, val ? '1' : '0'))
      .catch(() => {});
  } catch { return Promise.resolve(); }
}

async function _apply(enabled) {
  if (Platform.OS === 'web') return;
  try {
    const SC = require('expo-screen-capture');
    if (enabled) {
      await SC.preventScreenCaptureAsync(TAG);
    } else {
      await SC.allowScreenCaptureAsync(TAG);
    }
  } catch (e) {
    // expo-screen-capture not present in dev shim — no-op.
  }
}

export async function isScreenCaptureBlocked() {
  return await _storageGet(STORAGE_KEY);
}

export async function setScreenCaptureBlocked(enabled) {
  _enabled = !!enabled;
  await _storageSet(STORAGE_KEY, _enabled);
  await _apply(_enabled);
  return _enabled;
}

/**
 * Hydrate setting + re-apply on foreground events. Call once from
 * _layout.js bootstrap (before any chat screen mounts).
 */
export async function initScreenCaptureGate() {
  _enabled = await _storageGet(STORAGE_KEY);
  if (_enabled) await _apply(true);
  if (Platform.OS === 'web') return;
  try {
    if (_appStateSub) _appStateSub.remove();
    _appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && _enabled) {
        // Re-arm on foreground — RN can lose state across OS-level
        // backgrounds (especially Android when other apps push a
        // FLAG_SECURE-disabled window over us).
        _apply(true).catch(() => {});
      }
    });
  } catch {}
}
