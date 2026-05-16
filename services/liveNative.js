// services/liveNative.js
//
// Unified JS bridge for the native (iOS Swift + Android Kotlin) live module
// `expo-live-native`.
//
// - iOS: SwiftUI host/viewer fullscreen views talking to LiveKit Swift SDK.
// - Android: Jetpack Compose host/viewer activities talking to LiveKit
//   Android SDK directly.
//
// No-op cleanly on Expo Go / web. Always call through this file —
// never `requireNativeModule` directly.

import { Platform } from 'react-native';

let mod = null;
let emitter = null;
let initAttempted = false;

function getModule() {
  if (mod) return mod;
  if (initAttempted) return null;
  initAttempted = true;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const { requireOptionalNativeModule, requireNativeModule, EventEmitter } = require('expo-modules-core');
    mod = (typeof requireOptionalNativeModule === 'function'
      ? requireOptionalNativeModule('ExpoLiveNative')
      : null) || requireNativeModule('ExpoLiveNative');
    try {
      emitter = new EventEmitter(mod);
    } catch {
      emitter = null;
    }
    return mod;
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] native module missing:', e?.message || e);
    return null;
  }
}

export function isAvailable() {
  return !!getModule();
}
export const isSupported = isAvailable;

export async function openLiveHost(opts) {
  const m = getModule();
  if (!m) return false;
  try {
    await m.openHost(opts?.token, opts?.url, opts?.roomName);
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] openLiveHost error:', e?.message || e);
    return false;
  }
}

export async function openLiveViewer(opts) {
  const m = getModule();
  if (!m) return false;
  try {
    await m.openViewer(
      opts?.token,
      opts?.url,
      opts?.roomName,
      opts?.hostName || '',
      opts?.hostAvatarUrl || ''
    );
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] openLiveViewer error:', e?.message || e);
    return false;
  }
}

export async function closeLive() {
  const m = getModule();
  if (!m) return;
  try { await m.closeLive(); } catch {}
}

export function getMode() {
  const m = getModule();
  if (!m) return null;
  try { return typeof m.getMode === 'function' ? m.getMode() : null; } catch { return null; }
}

function on(eventName, cb) {
  getModule();
  if (!emitter) return () => {};
  const sub = emitter.addListener(eventName, cb);
  return () => sub.remove();
}

export function onLiveEnded(cb) { return on('onLiveEnded', cb); }
export function onLiveError(cb) { return on('onLiveError', cb); }
export function onViewerJoined(cb) { return on('onViewerJoined', cb); }
export function onLikeReceived(cb) { return on('onLikeReceived', cb); }
export function addListener(eventName, cb) { return on(eventName, cb); }

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
