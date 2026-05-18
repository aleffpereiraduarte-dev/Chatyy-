// webVideoCompressor — client-side video compression for web uploads.
//
// Today the web app sends raw videos straight to the chat upload endpoint —
// a phone-recorded 1080p clip lands at 50–200MB. Native (iOS/Android) already
// compresses via expo-image-picker quality flags + the share extension's
// AVAssetExportSession path; web has no equivalent and is the long tail of
// huge uploads (audit gap).
//
// Strategy: re-encode in-browser using a canvas captureStream piped through
// MediaRecorder. Downscales to maxWidth (default 1280, "HD ready") and
// re-encodes at a fixed bitrate (default 1.5 Mbps VP9/webm) — same ballpark
// WhatsApp Web targets. Result: 5–15MB for a typical 30s clip.
//
// Limitations / fallbacks:
//   - Requires browser MediaRecorder API. Safari < 14.1 has no VP9 — we try
//     VP9 → VP8 → default and bail back to the original file if all fail.
//   - Runs at playback speed (not faster than realtime). A 60s clip takes
//     ~60s to compress. Show the progress ring so users know it's working.
//   - Native (Platform.OS !== 'web') is a no-op — returns the input.
//   - Any throw → returns the original file (callers should never block on
//     compression succeeding).
//
// TODO(chat-conversation): wire compressVideoWeb() into the chat video upload
//   path (before the multipart POST) and feed onProgress into the new
//   UploadProgressRing. Skipped here to avoid stepping on the call-screen agent.

import { Platform } from 'react-native';

// Cheapest possible "is this video-shaped?" guard.
function looksLikeVideo(file) {
  if (!file) return false;
  if (typeof file === 'string') return false; // already a URL/path
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  const name = (file.name || '').toLowerCase();
  return /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(name);
}

// Pick the best MediaRecorder mime the current browser supports.
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch (_) {
      /* ignore */
    }
  }
  return '';
}

/**
 * Compress a video File/Blob in the browser.
 *
 * @param {File|Blob} file - source video
 * @param {Object}  opts
 * @param {number}  opts.maxWidth   - downscale target, in pixels. Default 1280.
 * @param {number}  opts.bitrate    - video bits/sec. Default 1_500_000 (1.5 Mbps).
 * @param {(p:number)=>void} opts.onProgress - 0..1 progress callback (best-effort)
 * @returns {Promise<File|Blob>} compressed Blob, or the original file on any failure.
 */
export async function compressVideoWeb(file, opts = {}) {
  const { maxWidth = 1280, bitrate = 1_500_000, onProgress } = opts;

  // Native or non-browser env → no-op.
  if (Platform.OS !== 'web') return file;
  if (typeof window === 'undefined') return file;
  if (typeof window.MediaRecorder === 'undefined') return file;
  if (!looksLikeVideo(file)) return file;

  let url = null;
  let video = null;
  try {
    url = URL.createObjectURL(file);
    video = document.createElement('video');
    video.src = url;
    video.muted = true; // autoplay-policy: muted clips can play without gesture
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise((resolve, reject) => {
      const onMeta = () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = (e) => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onErr);
        reject(e);
      };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('error', onErr);
    });

    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;
    if (!srcW || !srcH) return file;

    const scale = Math.min(1, maxWidth / srcW);
    // Round to even numbers — many encoders require it.
    const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    if (typeof canvas.captureStream !== 'function') return file;
    const stream = canvas.captureStream(30);

    const mimeType = pickMimeType();
    const recorderOpts = { videoBitsPerSecond: bitrate };
    if (mimeType) recorderOpts.mimeType = mimeType;

    let recorder;
    try {
      recorder = new MediaRecorder(stream, recorderOpts);
    } catch (_) {
      // Fall back to defaults if the chosen mime is rejected.
      try {
        recorder = new MediaRecorder(stream);
      } catch (_e2) {
        return file;
      }
    }

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e && e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((res) => {
      recorder.onstop = res;
    });

    recorder.start();
    try {
      await video.play();
    } catch (_) {
      // Autoplay rejected — bail out cleanly.
      try { recorder.stop(); } catch (_e) { /* ignore */ }
      return file;
    }

    const duration = Math.max(0.001, Number(video.duration) || 0);
    let rafId = 0;
    const tick = () => {
      if (video.ended || video.paused) {
        try { recorder.stop(); } catch (_) { /* ignore */ }
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      if (typeof onProgress === 'function') {
        try {
          onProgress(Math.min(1, (video.currentTime || 0) / duration));
        } catch (_) { /* ignore */ }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    await stopped;
    if (rafId) cancelAnimationFrame(rafId);
    if (typeof onProgress === 'function') {
      try { onProgress(1); } catch (_) { /* ignore */ }
    }

    if (!chunks.length) return file;
    const outType = (mimeType && mimeType.split(';')[0]) || 'video/webm';
    return new Blob(chunks, { type: outType });
  } catch (_err) {
    return file;
  } finally {
    if (url) {
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    }
    if (video) {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (_) { /* ignore */ }
    }
  }
}

export default compressVideoWeb;
