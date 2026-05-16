import { NativeModule, requireNativeModule, EventEmitter } from 'expo-modules-core';

interface ExpoCallKitEvents {
  onCallAnswered: { callId: string };
  onCallEnded: { callId: string };
  onVoipTokenReceived: { token: string };
  onIncomingCall: { callId: string; callerName: string; hasVideo: boolean };
  // [bug 2026-05-15 #9] Fired when CXProvider:didActivate runs, i.e. CallKit
  // now owns the AVAudioSession. /call uses this on the CallKit accept path
  // to gate Room.connect — otherwise LiveKit's audio session setup races
  // CallKit's and we end up with competing setCategory paths.
  onCallKitAudioActivated: Record<string, never>;
  onCallKitAudioDeactivated: Record<string, never>;
  // [#992 Stage 1 Android + Stage 2 iOS] Native LiveKit Room events. Shape is
  // a union of the two platforms — some fields are platform-specific. JS
  // listeners should treat all fields as optional and branch as needed.
  onLkConnected: { callId?: string; snapshot?: Record<string, any>; roomName?: string; localIdentity?: string };
  onLkParticipantConnected: { callId?: string; identity: string; sid?: string; name?: string };
  onLkParticipantDisconnected: { callId?: string; identity: string };
  onLkTrackSubscribed: { callId?: string; identity?: string; participantIdentity?: string; kind: string; sid?: string; trackSid?: string };
  onLkTrackUnsubscribed: { callId?: string; identity?: string; participantIdentity?: string; kind: string; trackSid?: string };
  onLkConnectionQuality: { callId?: string; identity?: string; participantIdentity?: string; quality: string };
  onLkDisconnected: { callId?: string; reason: string };
  onLkDataReceived: { callId?: string; identity?: string; data: string };
  onLkError: { callId?: string; message: string };
}

declare class ExpoCallKitModuleType extends NativeModule<ExpoCallKitEvents> {
  setup(): Promise<void>;
  displayIncomingCall(callId: string, callerName: string, hasVideo: boolean): Promise<void>;
  endCall(callId: string): void;
  registerVoipPush(): void;
  getVoipToken(): string | null;
  getDiagnostics(): Record<string, any>;
  consumePendingEvents(): Array<Record<string, any>>;
  consumePendingCall(): { callId: string; callerName: string; hasVideo: boolean } | null;
  // [#992 Stage 1+2] Native LiveKit Room control. Positional args; both
  // platforms accept this shape (Android Kotlin via @AsyncFunction direct
  // positional; iOS Swift adapts internally).
  persistAuthForNativeCall(token: string, baseUrl: string): Promise<void>;
  persistPendingLkToken(roomName: string, token: string, url: string): Promise<void>;
  isNativeRoomConnected(): boolean;
  adoptNativeRoom(callId: string): Promise<Record<string, any> | null>;
  lkConnect(url: string, token: string, callId: string, hasVideo: boolean): Promise<void>;
  lkDisconnect(): Promise<void>;
  lkSetMicEnabled(enabled: boolean): Promise<void>;
  lkSetCameraEnabled(enabled: boolean): Promise<void>;
}

let mod: ExpoCallKitModuleType | null = null;
let emitter: EventEmitter | null = null;

function getModule(): ExpoCallKitModuleType | null {
  if (mod) return mod;
  try {
    mod = requireNativeModule<ExpoCallKitModuleType>('ExpoCallKit');
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

export async function setup(): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.setup();
    return true;
  } catch (e) {
    console.warn('[ExpoCallKit] setup error:', e);
    return false;
  }
}

export async function displayIncomingCall(callId: string, callerName: string, hasVideo: boolean): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.displayIncomingCall(callId, callerName, hasVideo);
    return true;
  } catch (e) {
    console.warn('[ExpoCallKit] displayIncomingCall error:', e);
    return false;
  }
}

export function endCall(callId: string): void {
  const m = getModule();
  if (!m) return;
  try {
    m.endCall(callId);
  } catch {}
}

export function registerVoipPush(): void {
  const m = getModule();
  if (!m) return;
  try {
    m.registerVoipPush();
  } catch {}
}

export function onCallAnswered(cb: (data: { callId: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onCallAnswered', cb);
  return () => sub.remove();
}

export function onCallEnded(cb: (data: { callId: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onCallEnded', cb);
  return () => sub.remove();
}

export function onVoipTokenReceived(cb: (data: { token: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onVoipTokenReceived', cb);
  return () => sub.remove();
}

export function onIncomingCall(cb: (data: { callId: string; callerName: string; hasVideo: boolean }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onIncomingCall', cb);
  return () => sub.remove();
}

export function onCallKitAudioActivated(cb: () => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onCallKitAudioActivated', cb);
  return () => sub.remove();
}

export function onCallKitAudioDeactivated(cb: () => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onCallKitAudioDeactivated', cb);
  return () => sub.remove();
}

export function getVoipToken(): string | null {
  const m = getModule();
  if (!m) return null;
  try {
    return m.getVoipToken();
  } catch {
    return null;
  }
}

export function getDiagnostics(): Record<string, any> | null {
  const m = getModule();
  if (!m) return null;
  try {
    return m.getDiagnostics();
  } catch {
    return null;
  }
}

export function consumePendingEvents(): Array<Record<string, any>> {
  const m = getModule();
  if (!m) return [];
  try {
    return m.consumePendingEvents() || [];
  } catch {
    return [];
  }
}

export function consumePendingCall(): { callId: string; callerName: string; hasVideo: boolean } | null {
  const m = getModule();
  if (!m) return null;
  try {
    return m.consumePendingCall() || null;
  } catch {
    return null;
  }
}

// ─── Native LiveKit Room (Stage 1+2 #992 #993) ───────────────────────────────
// Bridges the JS /call screen to the native-owned Room. Eliminates the
// 4-8s cold-start audio gap on Android. iOS Stage 2 lands the equivalent.

/** Stash auth token + API base URL into native SharedPreferences (Android)
 *  / App Group UserDefaults (iOS). Call from services/api.js setAuthTokenDirect
 *  so cold-start accept paths can fetch LK tokens without JS. */
export async function persistAuthForNativeCall(token: string, baseUrl: string): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.persistAuthForNativeCall(token, baseUrl);
  } catch (e) {
    console.warn('[ExpoCallKit] persistAuthForNativeCall error:', e);
  }
}

export async function persistPendingLkToken(roomName: string, token: string, url: string): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.persistPendingLkToken(roomName, token, url);
  } catch (e) {
    console.warn('[ExpoCallKit] persistPendingLkToken error:', e);
  }
}

export function isNativeRoomConnected(): boolean {
  const m = getModule();
  if (!m) return false;
  try { return !!m.isNativeRoomConnected(); } catch { return false; }
}

export async function adoptNativeRoom(callId: string): Promise<Record<string, any> | null> {
  const m = getModule();
  if (!m) return null;
  try {
    return (await m.adoptNativeRoom(callId)) ?? null;
  } catch {
    return null;
  }
}

export async function lkConnect(url: string, token: string, callId: string, hasVideo: boolean): Promise<void> {
  const m = getModule();
  if (!m) throw new Error('Native CallKit module unavailable');
  await m.lkConnect(url, token, callId, hasVideo);
}

export async function lkDisconnect(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try { await m.lkDisconnect(); } catch {}
}

export async function lkSetMicEnabled(enabled: boolean): Promise<void> {
  const m = getModule();
  if (!m) return;
  try { await m.lkSetMicEnabled(enabled); } catch {}
}

export async function lkSetCameraEnabled(enabled: boolean): Promise<void> {
  const m = getModule();
  if (!m) return;
  try { await m.lkSetCameraEnabled(enabled); } catch {}
}

type LkEventName =
  | 'onLkConnected' | 'onLkParticipantConnected' | 'onLkParticipantDisconnected'
  | 'onLkTrackSubscribed' | 'onLkTrackUnsubscribed' | 'onLkConnectionQuality'
  | 'onLkDisconnected' | 'onLkDataReceived' | 'onLkError';

export function onLkEvent<K extends LkEventName>(
  event: K,
  cb: (data: any) => void
): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener(event, cb);
  return () => sub.remove();
}
