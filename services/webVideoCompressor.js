// webVideoCompressor — client-side video compression for web uploads.
//
// Today the web app sends raw videos straight to the chat upload endpoint —
// a phone-recorded 1080p clip lands at 50–200MB. Native (iOS/Android) already
// compresses via expo-image-picker quality flags + the share extension's
// AVAssetExportSession path; web has no equivalent and is the long tail of
// huge uploads (audit gap).
//
// Strategy: re-encode in-browser using a canvas captureStream piped through
// MediaRecorder. [2026-10-11 video-fullhd] Downscales by the SHORT side
// (default 1080 → landscape 1920×1080, portrait 1080×1920; never upscales)
// and re-encodes at ~4.5 Mbps, preferring MP4/H.264 (plays natively on
// iOS/Android/every browser) over WebM/VP9. Skips the re-encode entirely when
// the source already fits (short side ≤ target, bitrate ≤ target+20%, and a
// universally playable MP4/MOV) — re-encoding would only lose quality.
// The AUDIO track is carried over through WebAudio (the old canvas-only
// stream sent SILENT videos); if audio can't be captured we return the
// original file instead of muting it (unless it would blow the 200 MB cap).
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
// MP4/H.264 first: iOS (AVPlayer) cannot play WebM/VP9 sent from the web.
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
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

const SIZE_CAP_BYTES = 190 * 1024 * 1024; // server hard cap 200 MB (413)

/** Target canvas size: fit short side ≤ maxShort and long side ≤ maxLong, never upscale. */
export function fitShortSide(srcW, srcH, maxShort = 1080, maxLong = 1920) {
  if (!srcW || !srcH) return { w: 0, h: 0, scale: 1 };
  const short = Math.min(srcW, srcH);
  const long = Math.max(srcW, srcH);
  const scale = Math.min(1, maxShort / short, maxLong / long);
  // Round to even numbers — many encoders require it.
  return {
    w: Math.max(2, Math.round((srcW * scale) / 2) * 2),
    h: Math.max(2, Math.round((srcH * scale) / 2) * 2),
    scale,
  };
}

/**
 * Compress a video File/Blob in the browser.
 *
 * @param {File|Blob} file - source video
 * @param {Object}  opts
 * @param {number}  opts.maxShortSide - short-side target, px. Default 1080 (Full HD).
 * @param {number}  opts.maxLongSide  - long-side cap, px. Default 1920.
 * @param {number}  opts.maxWidth     - LEGACY width box (only when maxShortSide is absent).
 * @param {number}  opts.maxHeight    - LEGACY height box.
 * @param {number}  opts.bitrate      - video bits/sec. Default 4_500_000 (alias videoBitsPerSecond).
 * @param {number}  opts.audioBitrate - audio bits/sec. Default 128_000 (alias audioBitsPerSecond).
 * @param {(p:number)=>void} opts.onProgress - 0..1 progress callback (best-effort)
 * @returns {Promise<File|Blob>} compressed Blob, or the original file on any failure.
 */
export async function compressVideoWeb(file, opts = {}) {
  const { onProgress } = opts;
  const bitrate = Number(opts.bitrate || opts.videoBitsPerSecond) || 4_500_000;
  const audioBitrate = Number(opts.audioBitrate || opts.audioBitsPerSecond) || 128_000;
  const legacyBox = opts.maxShortSide == null && (opts.maxWidth != null || opts.maxHeight != null);
  const maxShort = Number(opts.maxShortSide) || 1080;
  const maxLong = Number(opts.maxLongSide) || Math.round(maxShort * 16 / 9);

  // Native or non-browser env → no-op.
  if (Platform.OS !== 'web') return file;
  if (typeof window === 'undefined') return file;
  if (typeof window.MediaRecorder === 'undefined') return file;
  if (!looksLikeVideo(file)) return file;

  let url = null;
  let video = null;
  let audioCtx = null;
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

    let w; let h; let scale;
    if (legacyBox) {
      const mw = Number(opts.maxWidth) || 1280;
      const mh = Number(opts.maxHeight) || 100000;
      scale = Math.min(1, mw / srcW, mh / srcH);
      w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
      h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
    } else {
      ({ w, h, scale } = fitShortSide(srcW, srcH, maxShort, maxLong));
    }

    // Already within envelope → keep the original bytes (no generation loss,
    // no realtime wait). Only for containers every player handles (MP4/MOV);
    // a WebM/MKV source still gets re-encoded so iOS can play it.
    const dur = Number(video.duration) || 0;
    const srcType = String(file.type || '').toLowerCase();
    const srcName = String(file.name || '').toLowerCase();
    const playableEverywhere = /video\/(mp4|quicktime)/.test(srcType) || /\.(mp4|m4v|mov)$/.test(srcName);
    if (scale >= 1 && dur > 0 && playableEverywhere
      && (file.size || 0) * 8 / dur <= (bitrate + audioBitrate) * 1.2) {
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    if (typeof canvas.captureStream !== 'function') return file;
    const stream = canvas.captureStream(30);

    // Audio: route the element through WebAudio into the recorder stream
    // (not to the speakers, so nothing is heard). Needs the element unmuted;
    // autoplay of an unmuted element can be refused outside a user gesture →
    // handled below (fallback = original file, never a silent video).
    let audioOk = false;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = new AC();
        const srcNode = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        srcNode.connect(dest);
        const at = dest.stream.getAudioTracks();
        if (at && at.length) { at.forEach((tr) => stream.addTrack(tr)); audioOk = true; }
        try { await audioCtx.resume(); } catch (_) { /* ignore */ }
        video.muted = false;
      }
    } catch (_) {
      audioOk = false;
    }
    // Without an audio path we only proceed when sending the original is
    // impossible (over the cap); otherwise keep the original (with sound).
    if (!audioOk && (file.size || 0) <= SIZE_CAP_BYTES) return file;

    const mimeType = pickMimeType();
    const recorderOpts = { videoBitsPerSecond: bitrate, audioBitsPerSecond: audioBitrate };
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

    recorder.start(1000);
    try {
      await video.play();
    } catch (_) {
      // Autoplay (unmuted) rejected — bail out cleanly with the original.
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
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) { /* ignore */ }
    }
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
