// services/liveNative.js
//
// Unified JS bridge for the native (iOS Swift + Android Kotlin) live module
// `expo-live-native`.
//
// Stage 1 (2026-05-16): the native module is wired and presents a black
// placeholder screen. Callers can already use this bridge; when the native
// module is not available (Expo Go, web, or older builds) every call returns
// false and the caller is expected to fall back to its legacy JS path (e.g.
// router.push('/live-broadcast')).
//
// Stage 2+ will replace the placeholder VCs/Activities with real LiveKit
// publish/subscribe. The JS surface here is stable across stages.
//
// No-op cleanly on Expo Go / web. Always call through this file —
// never `requireNativeModule` directly.

import { Platform } from 'react-native';

let bridge = null;
let initAttempted = false;

function getBridge() {
  if (bridge) return bridge;
  if (initAttempted) return null;
  initAttempted = true;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../modules/expo-live-native');
    bridge = mod && (mod.default || mod);
    if (bridge && typeof bridge.isAvailable === 'function' && !bridge.isAvailable()) {
      // module package resolved but native side not linked into this build
      if (__DEV__) console.warn('[liveNative] native module unavailable (build missing)');
      bridge = null;
    }
    return bridge;
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] bridge import failed:', e?.message || e);
    return null;
  }
}

export function isAvailable() {
  return !!getBridge();
}
export const isSupported = isAvailable;

export async function openLiveHost(opts) {
  const b = getBridge();
  if (!b) return false;
  try {
    return await b.openHost({
      lkToken: opts?.token,
      lkUrl: opts?.url,
      roomName: opts?.roomName,
      hostEmail: opts?.hostEmail || '',
      title: opts?.title,
      audience: opts?.audience,
    });
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] openLiveHost error:', e?.message || e);
    return false;
  }
}

export async function openLiveViewer(opts) {
  const b = getBridge();
  if (!b) return false;
  try {
    return await b.openViewer({
      lkToken: opts?.token,
      lkUrl: opts?.url,
      roomName: opts?.roomName,
      hostName: opts?.hostName || '',
      hostAvatarUrl: opts?.hostAvatarUrl || '',
    });
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] openLiveViewer error:', e?.message || e);
    return false;
  }
}

export async function closeLive() {
  const b = getBridge();
  if (!b) return;
  try {
    await b.closeLive();
  } catch {}
}

export function getMode() {
  // Reserved for future stages (e.g. RTMP vs LiveKit). Stage 1 has no mode.
  return getBridge() ? 'native' : null;
}

function on(eventName, cb) {
  const b = getBridge();
  if (!b || typeof b.addListener !== 'function') return () => {};
  try {
    return b.addListener(eventName, cb);
  } catch {
    return () => {};
  }
}

export function onLiveEnded(cb) {
  return on('onLiveEnded', cb);
}
export function onLiveError(cb) {
  return on('onLiveError', cb);
}
export function onViewerJoined(cb) {
  return on('onViewerJoined', cb);
}
export function onLikeReceived(cb) {
  return on('onLikeReceived', cb);
}
export function addListener(eventName, cb) {
  return on(eventName, cb);
}

export default {
  isAvailable,
  isSupported,
  openLiveHost,
  openLiveViewer,
  closeLive,
  getMode,
  onLiveEnded,
  onLiveError,
  onViewerJoined,
  onLikeReceived,
  addListener,
};
