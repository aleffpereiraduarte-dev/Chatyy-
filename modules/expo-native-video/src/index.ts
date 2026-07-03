// modules/expo-native-video/src/index.ts
//
// TypeScript bridge for the `expo-native-video` module — native H.264 video
// compression + thumbnail/info utilities used by chat upload paths.
//
// Why this exists: today video clips (camera capture, video notes, gallery
// picks) are sent UNCOMPRESSED — a 60s 720p capture lands at 50-100MB. WhatsApp
// re-encodes to ~3-8MB before upload. This module brings parity.
//
// Implementation strategy:
//   • iOS: AVAssetExportSession with a 1280x720 (or smaller) preset → H.264/AAC
//     MP4. Trivial — the OS does the heavy lifting.
//   • Android: MediaCodec H.264 encoder + MediaMuxer via a Surface-based
//     decode→encode pipeline. Stage 1 ships getInfo + generateThumbnail
//     (trivial via MediaMetadataRetriever) and a best-effort compressVideo
//     that falls back to copying the source URI if the heavy MediaCodec
//     pipeline isn't shippable in this stage. See ExpoNativeVideoModule.kt.
//
// All native calls are guarded so the JS upload path falls back to the
// existing "upload raw" behaviour if the module fails or isn't compiled in
// (Expo Go, web, dev client without rebuild).

import {
  NativeModule,
  requireNativeModule,
  requireOptionalNativeModule,
} from 'expo-modules-core';

// ─── Public types ────────────────────────────────────────────────────────────

export interface CompressOptions {
  /** Max output width in pixels. Default 1280. */
  maxWidth?: number;
  /** Max output height in pixels. Default 720. */
  maxHeight?: number;
  /** Target video bitrate in bits/sec. Default 1_500_000 (1.5 Mbps). */
  bitrate?: number;
  /** Target audio bitrate in bits/sec. Default 128_000. */
  audioBitrate?: number;
  /** Max frame rate. Default 30 (capped, never up-samples). */
  fps?: number;
}

export interface CompressResult {
  /** file:// URI of the compressed clip in the app cache dir. */
  uri: string;
  /** Output file size in bytes. */
  size: number;
  /** Output video width in pixels. */
  width: number;
  /** Output video height in pixels. */
  height: number;
  /** Duration in ms (mirrors source). */
  durationMs: number;
}

export interface ThumbnailResult {
  /** file:// URI of the JPEG thumbnail in cache. */
  uri: string;
  width: number;
  height: number;
}

export interface VideoInfo {
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
}

// ─── Native module declaration ───────────────────────────────────────────────

export interface VideoSegment {
  /** file:// URI of the segment clip in cache (or the source URI if not split). */
  uri: string;
  /** 0-based order index. */
  index: number;
  /** Segment duration in ms. */
  durationMs: number;
}

export interface SegmentResult {
  /** true if the clip was split into multiple segments. */
  segmented: boolean;
  /** Ordered segments to post back-to-back. Length 1 (the source) when not split. */
  segments: VideoSegment[];
}

declare class ExpoNativeVideoModuleType extends NativeModule {
  compressVideo(srcUri: string, options: CompressOptions): Promise<CompressResult>;
  generateThumbnail(srcUri: string, atMs: number, maxDim: number): Promise<ThumbnailResult>;
  getInfo(srcUri: string): Promise<VideoInfo>;
  segmentVideo(srcUri: string, segmentMs: number): Promise<SegmentResult>;
}

let mod: ExpoNativeVideoModuleType | null = null;

function getModule(): ExpoNativeVideoModuleType | null {
  if (mod) return mod;
  try {
    const opt =
      typeof requireOptionalNativeModule === 'function'
        ? requireOptionalNativeModule<ExpoNativeVideoModuleType>('ExpoNativeVideo')
        : null;
    mod = opt ?? requireNativeModule<ExpoNativeVideoModuleType>('ExpoNativeVideo');
    return mod;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Whether the native module is loaded (false on web / Expo Go / missing build). */
export function isAvailable(): boolean {
  return !!getModule();
}

const DEFAULT_OPTS: Required<CompressOptions> = {
  maxWidth: 1280,
  maxHeight: 720,
  bitrate: 1_500_000,
  audioBitrate: 128_000,
  fps: 30,
};

/**
 * Re-encode a video to H.264/AAC at the target dimensions + bitrate. Output
 * lives in the app cache dir and is returned as a `file://` URI. The caller
 * is responsible for cleaning it up when the upload completes (the existing
 * chat upload path already discards local temp files post-success).
 *
 * If the source is already within the target envelope (dims ≤ max AND bitrate
 * already low) the native side may return the source URI unchanged — callers
 * should not assume `result.uri !== srcUri`.
 *
 * Throws if the module isn't available; callers should try/catch and fall
 * back to uploading the raw source.
 */
export async function compressVideo(
  srcUri: string,
  opts: CompressOptions = {}
): Promise<CompressResult> {
  const m = getModule();
  if (!m) throw new Error('ExpoNativeVideo not available');
  const merged = { ...DEFAULT_OPTS, ...opts };
  return m.compressVideo(srcUri, merged);
}

/**
 * Generate a JPEG thumbnail at `atMs` (default 0 — first keyframe). `maxDim`
 * caps the longest edge (default 480 — enough for chat list thumbnails).
 */
export async function generateThumbnail(
  srcUri: string,
  atMs: number = 0,
  maxDim: number = 480
): Promise<ThumbnailResult> {
  const m = getModule();
  if (!m) throw new Error('ExpoNativeVideo not available');
  return m.generateThumbnail(srcUri, atMs, maxDim);
}

/** Read duration / dimensions / mime / size without decoding the whole stream. */
export async function getInfo(srcUri: string): Promise<VideoInfo> {
  const m = getModule();
  if (!m) throw new Error('ExpoNativeVideo not available');
  return m.getInfo(srcUri);
}

/**
 * Split a long video into back-to-back ≤`segmentMs` chunks (default 30s),
 * WhatsApp-status style. Sample-copy remux on both platforms — no re-encode,
 * so it's fast and lossless. A clip already within one segment resolves with
 * `segmented:false` and the source URI as the single segment.
 *
 * Throws if the module isn't available; callers should try/catch and fall back
 * to posting the single (capped) video so a user's post is never lost.
 */
export async function segmentVideo(
  srcUri: string,
  segmentMs: number = 30_000
): Promise<SegmentResult> {
  const m = getModule();
  if (!m || typeof (m as any).segmentVideo !== 'function') {
    throw new Error('ExpoNativeVideo.segmentVideo not available');
  }
  return m.segmentVideo(srcUri, segmentMs);
}

export default {
  isAvailable,
  compressVideo,
  generateThumbnail,
  getInfo,
  segmentVideo,
};
