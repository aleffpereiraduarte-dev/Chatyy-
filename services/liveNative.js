// services/liveNative.js
//
// Thin JS wrapper around the `ExpoLiveNative` native module (modules/expo-
// live-native). v1 only ships Android (Compose + LiveKit Android SDK). iOS
// keeps the existing JS @livekit/react-native path until the native iOS
// counterpart lands.
//
// Usage from app code:
//   import * as liveNative from '../services/liveNative';
//
//   await liveNative.openLiveHost({ token, url, roomName, hostName });
//   await liveNative.openLiveViewer({ token, url, roomName, viewerCount,
//                                     hostName, hostAvatarUrl });
//   const sub = liveNative.addListener('onLiveEnded', () => router.back());
//   // ...
//   sub.remove();
//   liveNative.closeLive();
//
// All functions are no-ops on platforms where the native module is missing
// (e.g. iOS, web, Expo Go). The integration into `app/live-broadcast.js` and
// `app/live-viewer.js` is intentionally deferred to a later session — this
// module just exists so the bridge surface is in place and ready.

import { Platform } from 'react-native';

let _nativeModule = null;
let _eventEmitter = null;
let _resolveAttempted = false;

function resolveNativeModule() {
  if (_resolveAttempted) return _nativeModule;
  _resolveAttempted = true;

  if (Platform.OS !== 'android') {
    return null;
  }

  // requireNativeModule is the Expo Modules API entrypoint. We require()
  // lazily so this file is safe to import on web / iOS / Expo Go where
  // the module may not exist (it returns null instead of crashing).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (typeof requireOptionalNativeModule === 'function') {
      _nativeModule = requireOptionalNativeModule('ExpoLiveNative');
    }
  } catch (_e) {
    // ignore — fall through to requireNativeModule below
  }

  if (_nativeModule == null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { requireNativeModule } = require('expo-modules-core');
      if (typeof requireNativeModule === 'function') {
        _nativeModule = requireNativeModule('ExpoLiveNative');
      }
    } catch (_e) {
      _nativeModule = null;
    }
  }

  return _nativeModule;
}

export function isSupported() {
  return resolveNativeModule() != null;
}

/**
 * Launch the native host Activity (Android only for now).
 *
 * @param {Object} opts
 * @param {string} opts.token       LiveKit JWT for the host identity.
 * @param {string} opts.url         LiveKit URL (e.g. wss://livekit.chatyy.com.br)
 * @param {string} opts.roomName    LiveKit room name (live_<id>).
 * @param {string} [opts.hostName]  Display name shown in the top-bar UI.
 */
export async function openLiveHost({ token, url, roomName, hostName } = {}) {
  const mod = resolveNativeModule();
  if (!mod) return false;
  if (!token || !url || !roomName) {
    throw new Error('openLiveHost: token, url, roomName are required');
  }
  await mod.openHost(token, url, roomName, hostName || '');
  return true;
}

/**
 * Launch the native viewer Activity.
 *
 * @param {Object} opts
 * @param {string} opts.token         Subscribe-only LiveKit JWT.
 * @param {string} opts.url           LiveKit URL.
 * @param {string} opts.roomName      LiveKit room name.
 * @param {number} [opts.viewerCount] Server-reported initial viewer count (UI hint).
 * @param {string} [opts.hostName]    Display name shown in the top bar.
 * @param {string} [opts.hostAvatarUrl] Avatar URL for top bar (placeholder for v1).
 */
export async function openLiveViewer({
  token,
  url,
  roomName,
  viewerCount = 0,
  hostName,
  hostAvatarUrl,
} = {}) {
  const mod = resolveNativeModule();
  if (!mod) return false;
  if (!token || !url || !roomName) {
    throw new Error('openLiveViewer: token, url, roomName are required');
  }
  await mod.openViewer(
    token,
    url,
    roomName,
    Number(viewerCount) || 0,
    hostName || '',
    hostAvatarUrl || ''
  );
  return true;
}

/** Forces a teardown of any active host/viewer session. */
export function closeLive() {
  const mod = resolveNativeModule();
  if (!mod) return;
  try {
    mod.closeLive();
  } catch (_e) {
    // best-effort
  }
}

/** Returns 'host' | 'viewer' | 'none' (always 'none' if unsupported). */
export function getMode() {
  const mod = resolveNativeModule();
  if (!mod) return 'none';
  try {
    return mod.getMode();
  } catch (_e) {
    return 'none';
  }
}

/**
 * Subscribe to a native event. Returns a subscription with .remove().
 *
 * Supported events:
 *   - 'onLiveEnded'       payload: {}
 *   - 'onLiveError'       payload: { message: string }
 *   - 'onViewerJoined'    payload: { identity: string }
 *   - 'onLikeReceived'    payload: { from: string }
 */
export function addListener(event, handler) {
  const mod = resolveNativeModule();
  if (!mod) {
    return { remove() {} };
  }

  // expo-modules-core's NativeModule supports addListener directly.
  try {
    if (typeof mod.addListener === 'function') {
      const sub = mod.addListener(event, handler);
      if (sub && typeof sub.remove === 'function') return sub;
      return {
        remove() {
          try {
            if (typeof mod.removeListener === 'function') {
              mod.removeListener(event, handler);
            }
          } catch (_e) {
            /* ignore */
          }
        },
      };
    }
  } catch (_e) {
    // fall through to EventEmitter path
  }

  if (_eventEmitter == null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { EventEmitter } = require('expo-modules-core');
      _eventEmitter = new EventEmitter(mod);
    } catch (_e) {
      return { remove() {} };
    }
  }
  const sub = _eventEmitter.addListener(event, handler);
  return {
    remove() {
      try {
        sub.remove();
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

export default {
  isSupported,
  openLiveHost,
  openLiveViewer,
  closeLive,
  getMode,
  addListener,
};
