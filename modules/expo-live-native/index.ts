// expo-live-native — TypeScript surface.
//
// This is intentionally a thin declaration file. The JS callers go through
// `services/liveNative.js`, which is platform-aware and safe to call on web
// (where this module is absent). Anything that wants stronger typing can
// import the types from here directly.

import { NativeModule, requireNativeModule, EventEmitter } from 'expo-modules-core';

export interface ExpoLiveNativeEvents {
  /** Host pressed "end live" OR viewer pressed "close" OR the room ended remotely. */
  onLiveEnded: { roomName: string; reason: string };
  /** Any error coming out of LiveKit Room/Participant/Track APIs. */
  onLiveError: { roomName: string; message: string };
  /** A viewer subscribed to the host's track (host-side event). */
  onViewerJoined: { roomName: string; identity: string; participantCount: number };
  /** Data message of type "like" arrived (host-side event). */
  onLikeReceived: { roomName: string; from: string; color?: string };
}

declare class ExpoLiveNativeModuleType extends NativeModule<ExpoLiveNativeEvents> {
  openHost(token: string, url: string, roomName: string, hostName: string): Promise<void>;
  openViewer(
    token: string,
    url: string,
    roomName: string,
    hostName: string,
    hostAvatarUrl: string,
  ): Promise<void>;
  closeLive(): void;
}

let mod: ExpoLiveNativeModuleType | null = null;
let emitter: EventEmitter | null = null;

export function getModule(): ExpoLiveNativeModuleType | null {
  if (mod) return mod;
  try {
    mod = requireNativeModule<ExpoLiveNativeModuleType>('ExpoLiveNative');
    return mod;
  } catch {
    return null;
  }
}

export function getEmitter(): EventEmitter | null {
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

export default getModule;
