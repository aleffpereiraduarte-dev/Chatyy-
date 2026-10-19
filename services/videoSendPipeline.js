// services/videoSendPipeline.js — WhatsApp 2026 video send orchestration.
//
// The existing chat-conversation.js inline path does three useful things:
//   1) creates an optimistic bubble using the local URI,
//   2) calls ExpoNativeVideo.compressVideo() before upload,
//   3) routes through rustUpload / chatUploadFile.
//
// What it does NOT do today:
//   • Extract a poster frame (~0.5s) for the bubble placeholder. Today the
//     bubble shows the raw video element directly — slow on weak devices,
//     no preview while the file is still on cellular tail latency, and the
//     recipient only sees a thumb once the server's ffmpeg cron writes
//     `<key>.thumb.jpg` (which can lag the message by 1-10s).
//   • Surface compression progress to the bubble — the AVAssetExportSession
//     export runs as a single promise with no progress signal, so the
//     overlay ring sits at 0% during the whole transcode.
//   • Honor an HD toggle (720p / 1080p / Original). [2026-10-11 video-fullhd]
//     Default is now 1080p (short side 1080 @ ~4.5 Mbps) from the saved
//     "Qualidade de envio de mídia" setting; the preview HD chip flips it.
//   • Detect "GIF candidate" videos (<6s, muted) so the bubble can render
//     them with autoplay + loop instead of the normal play-tap gate.
//   • Resume a chunked upload — the network drop today restarts from byte 0.
//     api.nativeChunkedUpload does have retry-per-chunk, but no
//     persisted session that survives an app restart.
//
// This module is the orchestrator that the chat-conversation send path
// (and future send paths: status, chat-new draft replay, sendQueue retry)
// can call to handle ALL of the above in one place. It does NOT replace the
// inline compress call in chat-conversation.js (per the user's constraint
// "NÃO mexa em chat-conversation.js") — it is a parallel surface so future
// callers can opt-in without duplicating the logic.
//
// Public API:
//
//   preparePoster(srcUri, durationMs?)                  → { posterUri, w, h }
//   prepareCompressed(srcUri, opts, onProgress?)        → { uri, size, w, h, durationMs, skipped }
//   detectGifLike(srcUri, info?)                        → boolean
//   getQualityProfile(label, info)                      → { maxWidth, maxHeight, bitrate, audioBitrate }
//   suggestHdToggle(info)                               → { defaultLabel, options: ['720p','1080p','original'] }
//
//   prepareVideoForSend(srcUri, { quality, onPosterReady, onCompressProgress, signal })
//     → orchestrated wrapper: getInfo → poster → compress → returns
//       { srcUri (compressed), posterUri, info, gifLike }
//
// All calls are guarded — if the native module isn't available (Expo Go,
// missing rebuild), they degrade to passthrough with `{ skipped: true }`.

import { Platform } from 'react-native';

let _nativeMod = null;
function loadNativeMod() {
  if (_nativeMod !== null) return _nativeMod;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    _nativeMod = false;
    return null;
  }
  try {
    const m = require('../modules/expo-native-video').default;
    _nativeMod = m && typeof m.isAvailable === 'function' && m.isAvailable() ? m : false;
  } catch {
    _nativeMod = false;
  }
  return _nativeMod || null;
}

// ─── Quality profiles ────────────────────────────────────────────────────────
//
// [2026-10-11 video-fullhd] WhatsApp-HD parity, smart about data:
//   • 720p  "Padrão" — short side 720,  ~1.5 Mbps H.264 High  (~11 MB/min)
//   • 1080p "HD"     — short side 1080, ~4.5 Mbps H.264 High  (~34 MB/min) — DEFAULT
//                      (Settings › Armazenamento e dados › Qualidade de envio
//                      de mídia; auto-drops to 720p on Data Saver / weak link —
//                      see services/mediaUploadQuality.js)
//   • original      — no transcode while the source fits 4K + the size cap;
//                     bigger sources are brought down to 2160p @ ~16 Mbps.
// maxWidth/maxHeight are a LONG×SHORT box: iOS (AVAssetWriter path) fits the
// display size orientation-agnostically. Android binaries with
// compressApiVersion >= 2 (2026-10-11) take maxShortSide/maxLongSide and fit
// the same way (+ rotation hint, High/VBR, faststart). OLDER Android binaries
// fit the CODED size against (maxWidth × maxHeight) literally, so for them
// nativeCompressOptions() keeps the square long×long box (a portrait clip
// coded 1080×1920 would otherwise be squashed to 607×1080). Never upscales.
const QUALITY_PROFILES = {
  '720p': {
    maxWidth: 1280,
    maxHeight: 720,
    bitrate: 1_500_000,
    audioBitrate: 128_000,
    fps: 30,
  },
  '1080p': {
    maxWidth: 1920,
    maxHeight: 1080,
    bitrate: 4_500_000,
    audioBitrate: 128_000,
    fps: 30,
  },
  // [2026-10-19 media-quality] "Full HD" level: 1080p at a high bitrate. A
  // source that already fits 1080p at ≤ 12 Mbps is sent untouched (see
  // shouldPassthroughFull); 4K / higher-bitrate sources come down to this.
  '1080p_full': {
    maxWidth: 1920,
    maxHeight: 1080,
    bitrate: 8_000_000,
    audioBitrate: 160_000,
    fps: 30,
  },
  '2160p': {
    maxWidth: 3840,
    maxHeight: 2160,
    bitrate: 16_000_000,
    audioBitrate: 192_000,
    fps: 30,
  },
  'original': null, // sentinel — skip compress (see getQualityProfile)
};

// Server hard cap is 200 MB (chat_upload / Rust upload → 413). Keep a margin
// for container overhead so a long HD clip never trips it.
export const VIDEO_SIZE_CAP_BYTES = 190 * 1024 * 1024;
const ORIGINAL_MAX_LONG_EDGE = 3840;

/**
 * Returns the encoder profile for a quality label, or null for "original"
 * (which means "do not transcode"). Falls back to 720p for unknown labels.
 * 'original' with a known source above 4K or above the size cap → 2160p.
 */
export function getQualityProfile(label, info = null) {
  if (label === 'original') {
    const longEdge = Math.max(info?.width || 0, info?.height || 0);
    const size = info?.sizeBytes || 0;
    if (longEdge > ORIGINAL_MAX_LONG_EDGE || size > VIDEO_SIZE_CAP_BYTES) return QUALITY_PROFILES['2160p'];
    return null;
  }
  const p = QUALITY_PROFILES[label];
  if (p) return p;
  return QUALITY_PROFILES['720p'];
}

/**
 * [2026-10-19 media-quality] Full HD: keep the original file when it already
 * fits the 1080p box, averages ≤ 12 Mbps (video+audio) and is under the cap —
 * re-encoding it to 8 Mbps would only lose detail. info = getInfo() result.
 */
export function shouldPassthroughFull(info) {
  const w = Number(info?.width) || 0; const h = Number(info?.height) || 0;
  const size = Number(info?.sizeBytes) || 0; const ms = Number(info?.durationMs) || 0;
  if (!(w > 0 && h > 0 && size > 0 && ms > 0)) return false;
  if (Math.max(w, h) > 1920 || Math.min(w, h) > 1080) return false;
  if (size > VIDEO_SIZE_CAP_BYTES) return false;
  let maxBps = 12_000_000;
  try { maxBps = require('./mediaUploadQuality').FULL_PASSTHROUGH_MAX_BPS || maxBps; } catch {}
  return (size * 8 * 1000) / ms <= maxBps;
}

/**
 * Lower the video bitrate so `durationMs` of footage fits under the 200 MB
 * cap (a 10-min clip at 4.5 Mbps would be ~340 MB). Floor 600 kbps.
 */
export function fitBitrateToCap(profile, durationMs) {
  if (!profile || !(durationMs > 0)) return profile;
  const sec = durationMs / 1000;
  const budget = Math.floor((VIDEO_SIZE_CAP_BYTES * 8) / sec) - (profile.audioBitrate || 128_000);
  if (budget >= profile.bitrate) return profile;
  return { ...profile, bitrate: Math.max(600_000, budget) };
}

function nativeCompressApiVersion() {
  try {
    const m = loadNativeMod();
    const v = m && typeof m.getCompressApiVersion === 'function' ? m.getCompressApiVersion() : 0;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Options for ExpoNativeVideo.compressVideo(). iOS + new Android (api >= 2):
 * long×short box + explicit maxShortSide/maxLongSide. Legacy Android binaries
 * get the square long×long box workaround. `apiVersion` is injectable for tests.
 */
export function nativeCompressOptions(profile, apiVersion) {
  const p = profile || QUALITY_PROFILES['720p'];
  const long = Math.max(p.maxWidth || 0, p.maxHeight || 0) || 1280;
  const short = Math.min(p.maxWidth || 0, p.maxHeight || 0) || 720;
  const isAndroid = Platform.OS === 'android';
  const api = typeof apiVersion === 'number' ? apiVersion : (isAndroid ? nativeCompressApiVersion() : 0);
  const legacyAndroid = isAndroid && api < 2;
  return {
    maxWidth: long,
    maxHeight: legacyAndroid ? long : short,
    ...(legacyAndroid ? null : { maxShortSide: short, maxLongSide: long }),
    bitrate: p.bitrate,
    audioBitrate: p.audioBitrate,
    fps: p.fps,
  };
}

/**
 * Effective label for one send: explicit HD chip (true/false) or the saved
 * "Qualidade de envio de mídia" default (null/undefined), network-aware.
 */
export function resolveVideoLabel(hd = null) {
  try { return require('./mediaUploadQuality').resolveVideoQuality(hd); } catch {}
  if (hd === 'full') return '1080p_full';
  return hd ? '1080p' : '720p';
}

/**
 * Suggest a default HD toggle state for the media preview chip.
 *   • Source short side ≤ 720 and small → 'original' (no gain transcoding)
 *   • otherwise → the saved default ('1080p' unless "Padrão"/Data Saver/weak link)
 */
export function suggestHdToggle(info) {
  const shortEdge = Math.min(info?.width || 0, info?.height || 0);
  const sizeMB = (info?.sizeBytes || 0) / (1024 * 1024);
  if (shortEdge > 0 && shortEdge <= 720 && sizeMB < 12) {
    return { defaultLabel: 'original', options: ['original', '720p', '1080p'] };
  }
  return {
    defaultLabel: resolveVideoLabel(null),
    options: ['720p', '1080p', 'original'],
  };
}

// ─── Poster extraction ───────────────────────────────────────────────────────
//
// WhatsApp picks the frame at ~0.5s (avoids the black fade-in many cameras
// record) and caches it locally so the optimistic bubble has a poster
// BEFORE the upload even starts. For clips shorter than 1s we pick mid-point.
//
// We don't fall back to JS-side decoding — if the native module is missing
// we just return null and the caller renders the existing video element
// directly (same as today's behavior).
export async function preparePoster(srcUri, durationMs = null) {
  const mod = loadNativeMod();
  if (!mod || !srcUri) return null;
  try {
    // Default to 500ms; clamp to mid-point for very short clips so we don't
    // request a frame beyond the asset duration (AVAssetImageGenerator
    // rejects with a "cannot decode" error in that case).
    let atMs = 500;
    if (typeof durationMs === 'number' && durationMs > 0 && durationMs < 1200) {
      atMs = Math.max(0, Math.floor(durationMs / 2));
    }
    const r = await mod.generateThumbnail(srcUri, atMs, 720);
    if (!r?.uri) return null;
    return { posterUri: r.uri, width: r.width || 0, height: r.height || 0 };
  } catch {
    return null;
  }
}

// ─── Compress ────────────────────────────────────────────────────────────────
//
// Wraps ExpoNativeVideo.compressVideo with:
//   • progress simulation — the native bridge doesn't expose a progress
//     signal so we run a wall-clock ramp from 0→0.9 over the expected
//     duration (assume ~1.5x realtime on iOS A14+, 2.5x on Android mid-tier).
//     Final 0.9→1.0 happens when the promise resolves. This gives the
//     bubble overlay something to animate against instead of a flat 0% bar.
//   • size delta logging — emits a single console.info line with before/after
//     sizes so the audit log can grep for compression effectiveness.
//   • signal forwarding — if the AbortController fires we cancel the simulated
//     progress immediately. The native side will still finish (export sessions
//     don't accept cancel mid-flight) but the caller can ignore the result.
export async function prepareCompressed(srcUri, opts = {}, onProgress = null, signal = null) {
  const mod = loadNativeMod();
  if (!mod || !srcUri) {
    return { uri: srcUri, size: 0, width: 0, height: 0, durationMs: 0, skipped: true };
  }
  const baseProfile = opts && Object.keys(opts).length ? opts : QUALITY_PROFILES['720p'];

  // Probe info up-front so the wall-clock progress ramp matches reality.
  let durationMs = 0;
  let srcSize = 0;
  let srcInfo = null;
  try {
    srcInfo = await mod.getInfo(srcUri);
    durationMs = srcInfo?.durationMs || 0;
    srcSize = srcInfo?.sizeBytes || 0;
  } catch {
    /* getInfo failure is non-fatal — we just lose progress fidelity */
  }
  // [2026-10-19 media-quality] Full HD + source already ≤1080p/≤12 Mbps → original.
  if (opts && opts.passthroughFull && shouldPassthroughFull(srcInfo)) {
    if (typeof onProgress === 'function') { try { onProgress(1); } catch {} }
    return {
      uri: srcUri, size: srcSize, width: srcInfo?.width || 0, height: srcInfo?.height || 0,
      durationMs, skipped: true, passthrough: true,
    };
  }

  // Estimated transcode wall time. iOS exports at ~1.5x realtime for 720p,
  // Android closer to 2.5x. Floor at 1s so very short clips still show
  // a brief animation.
  const realtimeFactor = Platform.OS === 'ios' ? 1.5 : 2.5;
  const estMs = Math.max(1000, (durationMs || 5000) / realtimeFactor);
  const startedAt = Date.now();
  let progressTimer = null;
  let cancelled = false;
  if (typeof onProgress === 'function') {
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      const p = Math.min(0.9, elapsed / estMs);
      try { onProgress(p); } catch {}
      progressTimer = setTimeout(tick, 200);
    };
    tick();
  }
  if (signal) {
    const onAbort = () => {
      cancelled = true;
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener?.('abort', onAbort);
  }

  try {
    // [2026-10-11 video-fullhd] long clips: shave bitrate to stay under the
    // 200 MB cap; Android: short-side fit (api>=2) or legacy square box.
    const profile = fitBitrateToCap(baseProfile, durationMs);
    const result = await mod.compressVideo(srcUri, nativeCompressOptions(profile));
    cancelled = true;
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    if (typeof onProgress === 'function') {
      try { onProgress(1); } catch {}
    }
    const outSize = result?.size || 0;
    if (srcSize > 0 && outSize > 0) {
      const ratio = ((1 - outSize / srcSize) * 100).toFixed(1);
      console.info(`[videoSendPipeline] compress ${(srcSize / 1024 / 1024).toFixed(1)}MB → ${(outSize / 1024 / 1024).toFixed(1)}MB (-${ratio}%)`);
    }
    return {
      uri: result?.uri || srcUri,
      size: outSize,
      width: result?.width || 0,
      height: result?.height || 0,
      durationMs: result?.durationMs || durationMs,
      skipped: false,
    };
  } catch (e) {
    cancelled = true;
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    console.warn('[videoSendPipeline] compress failed, returning source:', e?.message);
    return { uri: srcUri, size: srcSize, width: 0, height: 0, durationMs, skipped: true, error: e?.message };
  }
}

// ─── GIF detection ───────────────────────────────────────────────────────────
//
// A "GIF-like" clip per WhatsApp's rules: ≤6s, muted (or has no audio track),
// any resolution. Backend already tags chat messages with `type: 'video'` so
// we just attach `gif_like: true` to the message envelope and the renderer
// can auto-play + loop instead of the normal poster+tap-to-play gate.
//
// We can detect duration from getInfo but the "muted" property requires
// inspecting tracks — keep it simple: anything ≤6s gets the flag, the
// renderer can decide whether to honor it.
export function detectGifLike(srcUri, info = null) {
  if (!info) return false;
  const dMs = info.durationMs || 0;
  return dMs > 0 && dMs <= 6000;
}

// ─── Trim helper (placeholder for future UI) ─────────────────────────────────
//
// AVAssetExportSession on iOS supports timeRange — we can wire a trim UI
// later that passes { startMs, endMs } to the native side. For now this is
// a no-op stub so callers can future-proof their imports.
export async function trimVideo(/* srcUri, startMs, endMs */) {
  throw new Error('trimVideo: native trim not yet implemented (Stage 2)');
}

// ─── Orchestrated entry point ────────────────────────────────────────────────

/**
 * Run the full WhatsApp-style prepare pipeline:
 *
 *   1) probe info (duration, dims, size, mime)
 *   2) generate poster frame (~0.5s) and call `onPosterReady` so the bubble
 *      can swap from a placeholder gradient to a real preview INSTANTLY
 *   3) transcode if `quality !== 'original'`, streaming progress via
 *      `onCompressProgress(0..1)` for the bubble overlay ring
 *   4) decide GIF-like flag for the renderer
 *
 * Returns the descriptor the caller should hand to the upload step:
 *   { uri, posterUri, info, gifLike, compressed }
 *
 * The caller is still responsible for the actual network upload — keeping
 * the upload boundary here means a future chunked/resumable upload module
 * can wrap this without coupling.
 */
export async function prepareVideoForSend(srcUri, {
  quality = null, // null → saved default (resolveVideoLabel)
  onPosterReady = null,
  onCompressProgress = null,
  signal = null,
} = {}) {
  const mod = loadNativeMod();
  let info = null;
  if (mod) {
    try { info = await mod.getInfo(srcUri); } catch { /* non-fatal */ }
  }

  // Poster runs in parallel with compress kick-off — it's cheap (~50-150ms)
  // and the bubble wants it ASAP so users see SOMETHING the moment they tap
  // send.
  const posterPromise = preparePoster(srcUri, info?.durationMs).then((p) => {
    if (p && typeof onPosterReady === 'function') {
      try { onPosterReady(p); } catch {}
    }
    return p;
  });

  const profile = getQualityProfile(quality || resolveVideoLabel(null), info);
  let compressed = null;
  if (profile) {
    compressed = await prepareCompressed(srcUri, profile, onCompressProgress, signal);
  } else {
    compressed = { uri: srcUri, size: info?.sizeBytes || 0, width: info?.width || 0, height: info?.height || 0, durationMs: info?.durationMs || 0, skipped: true };
  }

  // Await poster — guaranteed resolved by now in 99% of cases since
  // compress takes seconds and poster takes ms.
  const poster = await posterPromise;

  const gifLike = detectGifLike(srcUri, info);

  return {
    uri: compressed.uri,
    posterUri: poster?.posterUri || null,
    posterWidth: poster?.width || 0,
    posterHeight: poster?.height || 0,
    info: info || null,
    gifLike,
    compressed,
  };
}

export default {
  preparePoster,
  prepareCompressed,
  prepareVideoForSend,
  detectGifLike,
  getQualityProfile,
  suggestHdToggle,
  resolveVideoLabel,
  fitBitrateToCap,
  shouldPassthroughFull,
  nativeCompressOptions,
  trimVideo,
};
