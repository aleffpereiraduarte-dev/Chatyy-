import { NativeModule, requireNativeModule, EventEmitter } from 'expo-modules-core';

// ---------------------------------------------------------------------------
// expo-rtmp-publisher
//
// Native RTMP/RTMPS publisher for Expo. Lets the host of a Live broadcast push
// camera + mic from the device straight into Cloudflare Stream Live ingest
// (rtmps://live.cloudflare.com:443/live/{streamKey}). Viewers consume the
// HLS playback URL — no second WebRTC ladder.
//
// API surface is intentionally tiny: start / stop / switchCamera / setMuted,
// plus events for status / stats. Implementation lives in the native side:
//   - iOS  → HaishinKit (Swift Package Manager)
//   - Android → pedroSG94/rtmp-rtsp-stream-client-java (Maven)
// ---------------------------------------------------------------------------

export interface RtmpStartOptions {
  /** Full RTMP/RTMPS URL of the ingest endpoint, e.g. `rtmps://live.cloudflare.com:443/live`. */
  url: string;
  /** Stream key issued by Cloudflare Stream (or any RTMP ingest provider). */
  streamKey: string;
  /** Target video bitrate in bits/sec. Default: 2_500_000 (2.5 Mbps). */
  videoBitrate?: number;
  /** Target audio bitrate in bits/sec. Default: 128_000 (128 kbps). */
  audioBitrate?: number;
  /** Capture width. Default: 1280. */
  width?: number;
  /** Capture height. Default: 720. */
  height?: number;
  /** Target frame rate. Default: 30. */
  fps?: number;
  /** Camera to start with. Default: 'back'. */
  camera?: 'front' | 'back';
  /** Audio sample rate. Default: 44100. */
  sampleRate?: number;
}

export type RtmpStatus =
  | 'idle'
  | 'connecting'
  | 'publishing'
  | 'reconnecting'
  | 'stopped'
  | 'error';

export interface RtmpStats {
  /** Outbound bitrate sampled over the last second. */
  bitrateBps: number;
  /** Frames per second actually pushed. */
  fps: number;
  /** Dropped frames since start. */
  droppedFrames: number;
  /** Total bytes uploaded since start. */
  bytesSent: number;
  /** Round-trip time to ingest, in ms (if available). */
  rttMs?: number;
}

export interface RtmpEvents {
  onStatusChange: { status: RtmpStatus; reason?: string };
  onStats: RtmpStats;
  onError: { code: string; message: string };
  onConnected: { url: string };
  onDisconnected: { reason?: string };
}

declare class ExpoRtmpPublisherModuleType extends NativeModule<RtmpEvents> {
  /** Start capturing + publishing. Resolves once the RTMP handshake completes. */
  start(opts: RtmpStartOptions): Promise<void>;
  /** Stop publishing + tear down capture session. */
  stop(): Promise<void>;
  /** Flip between front/back camera mid-stream. */
  switchCamera(): Promise<void>;
  /** Mute / unmute the mic. */
  setMuted(muted: boolean): Promise<void>;
  /** Toggle video capture (audio-only stream when off). */
  setVideoEnabled(enabled: boolean): Promise<void>;
  /** Current publisher status (sync). */
  getStatus(): RtmpStatus;
  /** Latest stats snapshot. Returns null until first sample. */
  getStats(): RtmpStats | null;
}

let mod: ExpoRtmpPublisherModuleType | null = null;
let emitter: EventEmitter | null = null;

function getModule(): ExpoRtmpPublisherModuleType | null {
  if (mod) return mod;
  try {
    mod = requireNativeModule<ExpoRtmpPublisherModuleType>('ExpoRtmpPublisher');
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

export const RtmpPublisher = {
  async start(opts: RtmpStartOptions): Promise<void> {
    const m = getModule();
    if (!m) throw new Error('[ExpoRtmpPublisher] Native module unavailable. Run prebuild + native build.');
    return m.start(opts);
  },

  async stop(): Promise<void> {
    const m = getModule();
    if (!m) return;
    return m.stop();
  },

  async switchCamera(): Promise<void> {
    const m = getModule();
    if (!m) return;
    return m.switchCamera();
  },

  async setMuted(muted: boolean): Promise<void> {
    const m = getModule();
    if (!m) return;
    return m.setMuted(muted);
  },

  async setVideoEnabled(enabled: boolean): Promise<void> {
    const m = getModule();
    if (!m) return;
    return m.setVideoEnabled(enabled);
  },

  getStatus(): RtmpStatus {
    const m = getModule();
    if (!m) return 'idle';
    try {
      return m.getStatus();
    } catch {
      return 'idle';
    }
  },

  getStats(): RtmpStats | null {
    const m = getModule();
    if (!m) return null;
    try {
      return m.getStats();
    } catch {
      return null;
    }
  },

  // ---- Events ----------------------------------------------------------------

  onStatusChange(cb: (data: RtmpEvents['onStatusChange']) => void): () => void {
    const e = getEmitter();
    if (!e) return () => {};
    const sub = e.addListener('onStatusChange', cb);
    return () => sub.remove();
  },

  onStats(cb: (data: RtmpStats) => void): () => void {
    const e = getEmitter();
    if (!e) return () => {};
    const sub = e.addListener('onStats', cb);
    return () => sub.remove();
  },

  onError(cb: (data: RtmpEvents['onError']) => void): () => void {
    const e = getEmitter();
    if (!e) return () => {};
    const sub = e.addListener('onError', cb);
    return () => sub.remove();
  },

  onConnected(cb: (data: RtmpEvents['onConnected']) => void): () => void {
    const e = getEmitter();
    if (!e) return () => {};
    const sub = e.addListener('onConnected', cb);
    return () => sub.remove();
  },

  onDisconnected(cb: (data: RtmpEvents['onDisconnected']) => void): () => void {
    const e = getEmitter();
    if (!e) return () => {};
    const sub = e.addListener('onDisconnected', cb);
    return () => sub.remove();
  },
};

// ---------------------------------------------------------------------------
// Convenience helper for Cloudflare Stream — most callers just have the
// stream key from the dashboard / API and don't care about the ingest URL.
// ---------------------------------------------------------------------------

export function cfStreamUrl(): string {
  return 'rtmps://live.cloudflare.com:443/live';
}

export default RtmpPublisher;
