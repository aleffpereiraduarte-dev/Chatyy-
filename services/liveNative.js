// services/liveNative.js
// JS bridge stub for the native (iOS Swift + Android Kotlin) live module.
//
// The native module is `expo-live-native`. On iOS it presents a SwiftUI
// host/viewer fullscreen modal that talks directly to the LiveKit Swift
// SDK (no RN VideoView in the path — that fixed the flicker/mancha bug).
// On Android the module is being scaffolded in parallel by another agent;
// this bridge intentionally tries to import its stub too.
//
// Always call through this file — never `requireNativeModule` directly,
// because the native code is only present in custom dev clients / TestFlight
// builds and we want to no-op cleanly on Expo Go, web, and on Android until
// the Android scaffold lands.

import { Platform, NativeEventEmitter, NativeModules } from 'react-native';

let iosMod = null;
let iosEmitter = null;

function getIosModule() {
  if (Platform.OS !== 'ios') return null;
  if (iosMod) return iosMod;
  try {
    // Lazy require so web/Android builds don't blow up at import time.
    const { requireNativeModule, EventEmitter } = require('expo-modules-core');
    iosMod = requireNativeModule('ExpoLiveNative');
    try {
      iosEmitter = new EventEmitter(iosMod);
    } catch {
      iosEmitter = null;
    }
    return iosMod;
  } catch (e) {
    if (__DEV__) console.warn('[liveNative] iOS module missing:', e?.message || e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — all functions are safe to call on any platform. They no-op and
// return `false`/`null` when the native module isn't available.
// ---------------------------------------------------------------------------

export function isAvailable() {
  if (Platform.OS === 'ios') return !!getIosModule();
  if (Platform.OS === 'android') {
    try {
      return !!NativeModules?.ExpoLiveNative;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Open the native HOST screen (camera publisher).
 *
 * @param {Object} opts
 * @param {string} opts.token  LiveKit JWT
 * @param {string} opts.url    LiveKit WebSocket URL (e.g. wss://livekit.chatyy.com.br)
 * @param {string} opts.roomName
 * @param {string} [opts.hostName] – display name used in the top bar
 * @returns {Promise<boolean>}
 */
export async function openHost({ token, url, roomName, hostName }) {
  if (!token || !url || !roomName) {
    console.warn('[liveNative] openHost: token, url, roomName required');
    return false;
  }
  if (Platform.OS === 'ios') {
    const m = getIosModule();
    if (!m) return false;
    try {
      await m.openHost(token, url, roomName, hostName || '');
      return true;
    } catch (e) {
      console.warn('[liveNative] openHost error:', e);
      return false;
    }
  }
  if (Platform.OS === 'android') {
    try {
      const m = NativeModules?.ExpoLiveNative;
      if (!m) return false;
      await m.openHost(token, url, roomName, hostName || '');
      return true;
    } catch (e) {
      console.warn('[liveNative] openHost (android) error:', e);
      return false;
    }
  }
  return false;
}

/**
 * Open the native VIEWER screen (subscriber).
 *
 * @param {Object} opts
 * @param {string} opts.token
 * @param {string} opts.url
 * @param {string} opts.roomName
 * @param {string} [opts.hostName]
 * @param {string} [opts.hostAvatarUrl]
 * @returns {Promise<boolean>}
 */
export async function openViewer({ token, url, roomName, hostName, hostAvatarUrl }) {
  if (!token || !url || !roomName) {
    console.warn('[liveNative] openViewer: token, url, roomName required');
    return false;
  }
  if (Platform.OS === 'ios') {
    const m = getIosModule();
    if (!m) return false;
    try {
      await m.openViewer(token, url, roomName, hostName || '', hostAvatarUrl || '');
      return true;
    } catch (e) {
      console.warn('[liveNative] openViewer error:', e);
      return false;
    }
  }
  if (Platform.OS === 'android') {
    try {
      const m = NativeModules?.ExpoLiveNative;
      if (!m) return false;
      await m.openViewer(token, url, roomName, hostName || '', hostAvatarUrl || '');
      return true;
    } catch (e) {
      console.warn('[liveNative] openViewer (android) error:', e);
      return false;
    }
  }
  return false;
}

/** Dismiss the native modal (host or viewer). Safe to call when nothing is open. */
export function closeLive() {
  if (Platform.OS === 'ios') {
    const m = getIosModule();
    if (!m) return;
    try { m.closeLive(); } catch {}
    return;
  }
  if (Platform.OS === 'android') {
    try { NativeModules?.ExpoLiveNative?.closeLive?.(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Event subscriptions — each returns an unsubscribe function. JS callers can
// stack listeners (e.g. update analytics + UI both on onLiveEnded).
// ---------------------------------------------------------------------------

function subscribeIos(event, cb) {
  if (Platform.OS !== 'ios') return () => {};
  // ensure module is loaded (creates emitter as a side-effect)
  getIosModule();
  if (!iosEmitter) return () => {};
  const sub = iosEmitter.addListener(event, cb);
  return () => { try { sub.remove(); } catch {} };
}

function subscribeAndroid(event, cb) {
  if (Platform.OS !== 'android') return () => {};
  try {
    const m = NativeModules?.ExpoLiveNative;
    if (!m) return () => {};
    const emitter = new NativeEventEmitter(m);
    const sub = emitter.addListener(event, cb);
    return () => { try { sub.remove(); } catch {} };
  } catch {
    return () => {};
  }
}

function subscribe(event, cb) {
  if (Platform.OS === 'ios') return subscribeIos(event, cb);
  if (Platform.OS === 'android') return subscribeAndroid(event, cb);
  return () => {};
}

export const onLiveEnded = (cb) => subscribe('onLiveEnded', cb);
export const onLiveError = (cb) => subscribe('onLiveError', cb);
export const onViewerJoined = (cb) => subscribe('onViewerJoined', cb);
export const onLikeReceived = (cb) => subscribe('onLikeReceived', cb);

export default {
  isAvailable,
  openHost,
  openViewer,
  closeLive,
  onLiveEnded,
  onLiveError,
  onViewerJoined,
  onLikeReceived,
};
