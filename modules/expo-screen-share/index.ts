import { NativeModule, requireNativeModule, EventEmitter } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Events the native module emits to JS.
 *
 *  - onBroadcastStarted: fired when ReplayKit confirms recording began
 *    (user tapped "Start Broadcast" in the iOS system picker).
 *  - onBroadcastFrame:   fired for each frame the Broadcast Extension produced
 *    and the main app picked up from the App Group container. The payload
 *    includes a file:// URI to a fresh JPEG that the JS layer can hand to
 *    a custom RTCVideoCapturer.
 *  - onBroadcastStopped: fired when the user taps the red status bar to
 *    stop sharing, or when iOS kills the extension (e.g. RAM blown).
 *  - onBroadcastError:   fired for unrecoverable errors (App Group inaccessible,
 *    extension crashed silently, picker not available on this iOS version).
 */
interface ExpoScreenShareEvents {
  onBroadcastStarted: { extensionBundleId: string };
  onBroadcastFrame: { uri: string; seq: number; width: number; height: number };
  onBroadcastStopped: { reason: string };
  onBroadcastError: { message: string };
}

declare class ExpoScreenShareModuleType extends NativeModule<ExpoScreenShareEvents> {
  /**
   * Pops the iOS native ReplayKit broadcast picker — same UI users see in
   * the iOS Control Center "Screen Recording" tile, but pre-targeted at our
   * extension. User must confirm; we cannot start broadcasting silently.
   * Apple's privacy model forbids it.
   */
  presentBroadcastPicker(): Promise<void>;

  /** Returns true if our broadcast extension is currently active. */
  isBroadcasting(): boolean;

  /**
   * Begins the IPC pump from the Broadcast Extension's App Group file drop
   * to JS. Must be called before presentBroadcastPicker() so the first
   * frame isn't lost.
   */
  startReceivingFrames(): void;

  /** Stops the IPC pump (does NOT stop the broadcast itself — user does that). */
  stopReceivingFrames(): void;

  /**
   * Asks the extension to gracefully terminate. iOS only allows this when
   * the extension itself calls finishBroadcastWithError; we communicate via
   * a flag in the App Group container that the extension polls.
   */
  requestStopBroadcast(): void;
}

let mod: ExpoScreenShareModuleType | null = null;
let emitter: EventEmitter | null = null;

function getModule(): ExpoScreenShareModuleType | null {
  if (mod) return mod;
  // Android: native module returns "unsupported" stubs. Web: no module.
  if (Platform.OS === 'web') return null;
  try {
    mod = requireNativeModule<ExpoScreenShareModuleType>('ExpoScreenShare');
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

export function isSupported(): boolean {
  return Platform.OS === 'ios' && !!getModule();
}

export async function presentBroadcastPicker(): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.presentBroadcastPicker();
    return true;
  } catch (e: any) {
    console.warn('[ExpoScreenShare] presentBroadcastPicker error:', e?.message || e);
    return false;
  }
}

export function startReceivingFrames(): void {
  const m = getModule();
  if (!m) return;
  try { m.startReceivingFrames(); } catch {}
}

export function stopReceivingFrames(): void {
  const m = getModule();
  if (!m) return;
  try { m.stopReceivingFrames(); } catch {}
}

export function requestStopBroadcast(): void {
  const m = getModule();
  if (!m) return;
  try { m.requestStopBroadcast(); } catch {}
}

export function isBroadcasting(): boolean {
  const m = getModule();
  if (!m) return false;
  try { return m.isBroadcasting(); } catch { return false; }
}

export function onBroadcastStarted(cb: (data: { extensionBundleId: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onBroadcastStarted', cb);
  return () => sub.remove();
}

export function onBroadcastFrame(cb: (data: { uri: string; seq: number; width: number; height: number }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onBroadcastFrame', cb);
  return () => sub.remove();
}

export function onBroadcastStopped(cb: (data: { reason: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onBroadcastStopped', cb);
  return () => sub.remove();
}

export function onBroadcastError(cb: (data: { message: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onBroadcastError', cb);
  return () => sub.remove();
}

export default {
  isSupported,
  presentBroadcastPicker,
  isBroadcasting,
  startReceivingFrames,
  stopReceivingFrames,
  requestStopBroadcast,
  onBroadcastStarted,
  onBroadcastFrame,
  onBroadcastStopped,
  onBroadcastError,
};
