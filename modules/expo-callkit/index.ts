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
  // [stage 2 native LiveKit pre-connect, 2026-05-15] Mirrored from
  // NativeCallRoom (the iOS Swift singleton that owns a LiveKit.Room created
  // during CXAnswerCallAction). /call adopts this room via adoptNativeRoom()
  // and consumes these events instead of running its own Room.connect.
  onLkConnected: { roomName: string; localIdentity: string };
  onLkDisconnected: { reason: string };
  onLkParticipantConnected: { identity: string; name: string };
  onLkParticipantDisconnected: { identity: string };
  onLkTrackSubscribed: { participantIdentity: string; trackSid: string; kind: string };
  onLkTrackUnsubscribed: { participantIdentity: string; trackSid: string; kind: string };
  onLkConnectionQuality: { participantIdentity: string; quality: string };
}

export interface NativeRoomSnapshot {
  alreadyConnected: boolean;
  connected: boolean;
  roomName: string | null;
  localIdentity: string | null;
  participants: Array<{
    identity: string;
    name: string;
    isLocal: boolean;
    tracks: Array<{ sid: string; kind: string; subscribed: boolean; muted: boolean; source: string }>;
  }>;
  connectionQuality: string;
}

export interface LkConnectParams {
  url: string;
  token: string;
  identity: string;
  roomName: string;
}

export interface PersistAuthParams {
  authToken: string;
  email: string;
  apiBase?: string;
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
  // [stage 2 native LiveKit pre-connect, 2026-05-15]
  lkConnect(params: LkConnectParams): Promise<void>;
  lkDisconnect(): Promise<void>;
  lkSetMicEnabled(enabled: boolean): Promise<void>;
  lkSetCameraEnabled(enabled: boolean): Promise<void>;
  adoptNativeRoom(): Promise<NativeRoomSnapshot>;
  persistAuthForNativeCall(params: PersistAuthParams): Promise<void>;
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

// ---------------------------------------------------------------------------
// [stage 2 native LiveKit pre-connect, 2026-05-15]
//
// Native iOS owns a LiveKit Room when the user accepts a call from the lock
// screen / kill state. /call.js (running on the JS thread) calls
// adoptNativeRoom() once it mounts to find out whether to:
//   a) attach to an already-connected native Room (just render snapshot +
//      subscribe to onLk* events), or
//   b) fall through to the legacy JS Room.connect path.
//
// `persistAuthForNativeCall` is called from AuthContext on login so the
// AppDelegate subscriber can authenticate with the backend without the RN
// bridge being up.
// ---------------------------------------------------------------------------

export async function lkConnect(params: LkConnectParams): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  try {
    await m.lkConnect(params);
    return true;
  } catch (e) {
    console.warn('[ExpoCallKit] lkConnect error:', e);
    return false;
  }
}

export async function lkDisconnect(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.lkDisconnect();
  } catch {}
}

export async function lkSetMicEnabled(enabled: boolean): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.lkSetMicEnabled(enabled);
  } catch {}
}

export async function lkSetCameraEnabled(enabled: boolean): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.lkSetCameraEnabled(enabled);
  } catch {}
}

export async function adoptNativeRoom(): Promise<NativeRoomSnapshot | null> {
  const m = getModule();
  if (!m) return null;
  try {
    return await m.adoptNativeRoom();
  } catch (e) {
    console.warn('[ExpoCallKit] adoptNativeRoom error:', e);
    return null;
  }
}

export async function persistAuthForNativeCall(params: PersistAuthParams): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.persistAuthForNativeCall(params);
  } catch (e) {
    console.warn('[ExpoCallKit] persistAuthForNativeCall error:', e);
  }
}

export function onLkConnected(cb: (data: { roomName: string; localIdentity: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkConnected', cb);
  return () => sub.remove();
}

export function onLkDisconnected(cb: (data: { reason: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkDisconnected', cb);
  return () => sub.remove();
}

export function onLkParticipantConnected(cb: (data: { identity: string; name: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkParticipantConnected', cb);
  return () => sub.remove();
}

export function onLkParticipantDisconnected(cb: (data: { identity: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkParticipantDisconnected', cb);
  return () => sub.remove();
}

export function onLkTrackSubscribed(cb: (data: { participantIdentity: string; trackSid: string; kind: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkTrackSubscribed', cb);
  return () => sub.remove();
}

export function onLkTrackUnsubscribed(cb: (data: { participantIdentity: string; trackSid: string; kind: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkTrackUnsubscribed', cb);
  return () => sub.remove();
}

export function onLkConnectionQuality(cb: (data: { participantIdentity: string; quality: string }) => void): () => void {
  const e = getEmitter();
  if (!e) return () => {};
  const sub = e.addListener('onLkConnectionQuality', cb);
  return () => sub.remove();
}
