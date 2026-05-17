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
  // [#992 Stage 3] Launches the full-native call screen (CallActivity on
  // Android, CallViewController hosting SwiftUI CallView on iOS). Replaces
  // the RN /call.js screen for outgoing/incoming calls.
  openNativeCall(
    callId: string,
    callerName: string,
    callerEmail: string,
    hasVideo: boolean,
    lkUrl: string | null,
    lkToken: string | null
  ): Promise<void>;
  // [Stage #996] Native outgoing-call entry point. On iOS submits a
  // CXStartCallAction (so CallKit tracks the call in Recents / lock screen)
  // and then presents CallViewController; on Android starts CallActivity
  // with EXTRA_IS_OUTGOING=true so it fires call_invite + plays ringback.
  // The single-object signature is what JS callers prefer (vs. the long
  // positional list of openNativeCall) — Expo Modules adapts maps to the
  // platform native dictionary/Map shape automatically.
  startOutgoingCall(params: {
    callee_email: string;
    callee_name?: string;
    caller_name?: string;
    is_video: boolean;
    room_name?: string;
    conversation_id?: string;
    call_id?: string;
    lk_url?: string;
    lk_token?: string;
  }): Promise<boolean>;
  // [2026-05-16] Group-call scaffold (Android). Launches GroupCallActivity
  // with an N×N grid of tiles, one per remote participant. Participants are
  // serialized as JSON so the native side can pre-seed placeholder tiles
  // before LiveKit's ParticipantConnected events fire. iOS counterpart will
  // mirror this signature once SwiftUI GroupCallView lands.
  openGroupCall(
    roomName: string,
    lkUrl: string,
    lkToken: string,
    participantsJson: string,
    hasVideo: boolean
  ): Promise<void>;
}

export interface OpenNativeCallParams {
  callId: string;
  callerName: string;
  callerEmail: string;
  hasVideo: boolean;
  lkUrl?: string;
  lkToken?: string;
}

/** Group-call invitee. `email` is the LiveKit participant identity (stable
 *  across reconnects); `name` is the display label rendered on the tile;
 *  `avatarUrl` is reserved for the avatar fallback (not yet wired in the
 *  Android scaffold — it renders the first letter of `name` for now). */
export interface GroupCallParticipant {
  email: string;
  name: string;
  avatarUrl?: string;
}

export interface OpenGroupCallParams {
  roomName: string;
  lkUrl: string;
  lkToken: string;
  participants: GroupCallParticipant[];
  hasVideo: boolean;
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

/** Launches the full-native call screen. Replaces the RN /call.js screen for
 *  outgoing/incoming calls (CallActivity on Android, CallViewController +
 *  SwiftUI CallView on iOS). lkUrl/lkToken are optional — pass them when the
 *  caller already has a LiveKit room minted, otherwise the native side
 *  fetches via the auth persisted by persistAuthForNativeCall. */
export async function openNativeCall(params: OpenNativeCallParams): Promise<void> {
  const m = getModule();
  if (!m) throw new Error('Native CallKit module unavailable');
  await m.openNativeCall(
    params.callId,
    params.callerName,
    params.callerEmail,
    params.hasVideo,
    params.lkUrl ?? null,
    params.lkToken ?? null
  );
}

export interface StartOutgoingCallParams {
  /** Email of the person being called. Always required — used as the
   *  CXHandle on iOS and as the chat target on the WS layer. */
  calleeEmail: string;
  /** Display name shown on the native call screen while ringing. Defaults
   *  to the email when omitted. */
  calleeName?: string;
  /** Display name of the local user. Forwarded into call_invite so the
   *  callee's incoming-call UI can show "Maria está chamando…". */
  callerName?: string;
  /** True for video calls, false for audio-only. Drives the CXCallUpdate
   *  hasVideo flag on iOS and the LiveKit setCamera path on Android. */
  isVideo: boolean;
  /** LiveKit room name. Defaults to callId when omitted. Stick with callId
   *  unless you need a stable room across devices (e.g., bridging an
   *  existing meeting). */
  roomName?: string;
  /** Chat conversation row id. Used as the second key (alongside callId)
   *  when firing call_invite / call_end via CallSignalWs. Empty string is
   *  valid for dialer-style flows. */
  conversationId?: string;
  /** Server-side call id. Lets the JS layer pin a known value so the
   *  WS call_invite payload sent by the native side matches what the JS
   *  side reports to /api/call_notify. */
  callId?: string;
  /** LiveKit websocket URL — when JS already minted a token via
   *  chat_livekit_token, forward it here so the native side can connect
   *  the Room without an extra HTTP round trip. */
  lkUrl?: string;
  /** LiveKit access token (publisher grant). Pair with `lkUrl`. */
  lkToken?: string;
}

/** Stage #996 — kick off an outgoing call through the native CallKit /
 *  CallActivity flow. On iOS this submits a CXStartCallAction so the system
 *  tracks the call (Recents, lock-screen UI, audio session ownership) and
 *  presents CallViewController; on Android it starts CallActivity with the
 *  outgoing flag so it fires call_invite + plays the standard ringback
 *  tone. Returns true once the transaction was queued; the call lifecycle
 *  continues via the onCallAnswered / onCallEnded events.
 *
 *  Throws on iOS if no CXCallController is ready (provider hasn't been set
 *  up — should never happen in practice since OnCreate wires it). Throws
 *  on Android if context.startActivity fails (typically a packaging error).
 *  Callers should treat any rejection as "fall back to the JS /call screen". */
export async function startOutgoingCall(params: StartOutgoingCallParams): Promise<boolean> {
  const m = getModule();
  if (!m) throw new Error('Native CallKit module unavailable');
  return await m.startOutgoingCall({
    callee_email: params.calleeEmail,
    callee_name: params.calleeName,
    caller_name: params.callerName,
    is_video: !!params.isVideo,
    room_name: params.roomName,
    conversation_id: params.conversationId,
    call_id: params.callId,
    lk_url: params.lkUrl,
    lk_token: params.lkToken,
  });
}

/** Launches the full-native group-call screen (Android: GroupCallActivity).
 *  Replaces the RN WebView `/group-call.js` path for native group calls. The
 *  participants array is JSON-stringified into a single intent extra so the
 *  Android side can pre-seed one placeholder tile per invitee before any
 *  LiveKit `ParticipantConnected` events arrive — giving users a "ringing
 *  Maria…" view instead of a blank black screen during the connect phase. */
export async function openGroupCall(params: OpenGroupCallParams): Promise<void> {
  const m = getModule();
  if (!m) throw new Error('Native CallKit module unavailable');
  await m.openGroupCall(
    params.roomName,
    params.lkUrl,
    params.lkToken,
    JSON.stringify(params.participants ?? []),
    params.hasVideo
  );
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
