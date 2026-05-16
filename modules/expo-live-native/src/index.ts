// modules/expo-live-native/src/index.ts
//
// TypeScript bridge for the `expo-live-native` module — host + viewer
// fullscreen Live broadcast UI implemented natively (Kotlin Activity on
// Android, UIViewController on iOS). Stage 1 ships a black placeholder
// screen with a hangup button; Stage 2+ wires LiveKit publish/subscribe.
//
// The exported surface intentionally matches the runtime expectations of
// `services/liveNative.js` (the legacy JS stub that's been imagined-against
// for weeks): isAvailable, openHost, openViewer, plus event helpers
// onLiveEnded / onLiveError / onViewerJoined / onLikeReceived.
//
// Pattern follows modules/expo-callkit/index.ts — requireNativeModule guarded
// with try/catch so Expo Go and web fall back to the JS path cleanly.

import {
  NativeModule,
  requireNativeModule,
  requireOptionalNativeModule,
  EventEmitter,
} from 'expo-modules-core';

// ─── Event payloads ──────────────────────────────────────────────────────────

export interface ExpoLiveNativeEvents {
  /** Emitted when the host or viewer closes the native Live screen. */
  onLiveEnded: { roomName?: string; reason?: string };
  /** Emitted on a fatal error (LiveKit connect failure, camera permission denied, etc.). */
  onLiveError: { roomName?: string; message: string };
  /** Host-only: fired when a remote viewer participant joins the room. */
  onViewerJoined: { roomName?: string; identity: string; name?: string };
  /** Host-only: fired when a viewer sends a like reaction over the data channel. */
  onLikeReceived: { roomName?: string; identity?: string; count?: number };
}

// ─── Function param types ────────────────────────────────────────────────────

export interface OpenHostParams {
  lkToken: string;
  lkUrl: string;
  roomName: string;
  hostEmail: string;
  title?: string;
  audience?: 'public' | 'friends' | 'private';
}

export interface OpenViewerParams {
  lkToken: string;
  lkUrl: string;
  roomName: string;
  hostName?: string;
  hostAvatarUrl?: string;
}

// ─── Native module declaration ───────────────────────────────────────────────

declare class ExpoLiveNativeModuleType extends NativeModule<ExpoLiveNativeEvents> {
  openHost(
    lkToken: string,
    lkUrl: string,
    roomName: string,
    hostEmail: string,
    title: string | null,
    audience: string | null
  ): Promise<void>;
  openViewer(
    lkToken: string,
    lkUrl: string,
    roomName: string,
    hostName: string | null,
    hostAvatarUrl: string | null
  ): Promise<void>;
  closeLive(): Promise<void>;
}

let mod: ExpoLiveNativeModuleType | null = null;
let emitter: EventEmitter | null = null;

function getModule(): ExpoLiveNativeModuleType | null {
  if (mod) return mod;
  try {
    const opt =
      typeof requireOptionalNativeModule === 'function'
        ? requireOptionalNativeModule<ExpoLiveNativeModuleType>('ExpoLiveNative')
        : null;
    mod = opt ?? requireNativeModule<ExpoLiveNativeModuleType>('ExpoLiveNative');
    return mod;
  } catch {
    return null;
  }
}

function getEmitter(): EventEmitter | null {
  if (emitter) return emitter;
  const m = getModule();
  if (!m) return null;
  try {
    emitter = new EventEmitter(m);
    return emitter;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Whether the native module is loaded (false on web / Expo Go / missing build). */
export function isAvailable(): boolean {
  return !!getModule();
}

export async function openHost(params: OpenHostParams): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.openHost(
      params.lkToken,
      params.lkUrl,
      params.roomName,
      params.hostEmail,
      params.title ?? null,
      params.audience ?? null
    );
    return true;
  } catch (e) {
    console.warn('[ExpoLiveNative] openHost error:', e);
    return false;
  }
}

export async function openViewer(params: OpenViewerParams): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.openViewer(
      params.lkToken,
      params.lkUrl,
      params.roomName,
      params.hostName ?? null,
      params.hostAvatarUrl ?? null
    );
    return true;
  } catch (e) {
    console.warn('[ExpoLiveNative] openViewer error:', e);
    return false;
  }
}

export async function closeLive(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.closeLive();
  } catch {}
}

// ─── Event helpers ───────────────────────────────────────────────────────────

function on<K extends keyof ExpoLiveNativeEvents>(
  event: K,
  cb: (data: ExpoLiveNativeEvents[K]) => void
): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener(event as string, cb as (data: any) => void);
  return () => sub.remove();
}

export function onLiveEnded(cb: (data: ExpoLiveNativeEvents['onLiveEnded']) => void) {
  return on('onLiveEnded', cb);
}
export function onLiveError(cb: (data: ExpoLiveNativeEvents['onLiveError']) => void) {
  return on('onLiveError', cb);
}
export function onViewerJoined(cb: (data: ExpoLiveNativeEvents['onViewerJoined']) => void) {
  return on('onViewerJoined', cb);
}
export function onLikeReceived(cb: (data: ExpoLiveNativeEvents['onLikeReceived']) => void) {
  return on('onLikeReceived', cb);
}
export function addListener<K extends keyof ExpoLiveNativeEvents>(
  event: K,
  cb: (data: ExpoLiveNativeEvents[K]) => void
) {
  return on(event, cb);
}

export default {
  isAvailable,
  openHost,
  openViewer,
  closeLive,
  onLiveEnded,
  onLiveError,
  onViewerJoined,
  onLikeReceived,
  addListener,
};
