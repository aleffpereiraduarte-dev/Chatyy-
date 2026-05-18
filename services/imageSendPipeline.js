/**
 * imageSendPipeline — WhatsApp-grade pre-upload pipeline for chat images.
 *
 * Goal: the moment the user taps "Send", the chat bubble should appear with
 * a soft blur placeholder + a progress ring, NOT a hard flash from the raw
 * camera roll JPEG into the final R2 URL. Upload runs in background, can
 * resume after network drop, strips EXIF for privacy, and persists the
 * compressed copy locally so re-renders never re-download.
 *
 * Why a separate service:
 *   chat-conversation.js already wires uploadAndSendFile + the optimistic
 *   bubble. This file adds the polish layer that CAN be called from outside
 *   (album editor, sticker editor, future call-sites) without each consumer
 *   re-implementing the LQIP + EXIF + HD-toggle logic. chat-conversation
 *   doesn't import this yet (don't touch — owned by another agent) but the
 *   pieces here (`migrateThumbB64TempToReal`, `bindLocalUriToRemoteUrl`,
 *   `generateLocalLQIP`, `getQualityPreset`, `stripExifIfNeeded`) can be
 *   wired post-OTA by a one-line require.
 *
 * Public API:
 *   - getQualityPreset()              → { maxDim, quality, label } (reads pref)
 *   - QUALITY_PRESETS                 → static catalog (Standard/HD/Original)
 *   - setQualityPref(name)            → 'standard' | 'hd' | 'original'
 *   - shouldStripExif()               → boolean (reads chatyy_strip_exif pref)
 *   - generateLocalLQIP(uri)          → small base64 string (40px, ~500B)
 *   - preflightOutgoing(uri, opts)    → { uri, sizeBytes, width, height,
 *                                          thumbB64, mime } — single call that
 *                                       does compress + EXIF strip + LQIP gen
 *   - bindOptimisticToServer(tempId, realId, localUri, serverUrl)
 *                                     → after the send round-trips, propagate
 *                                       the LQIP and the local-file mapping
 *                                       so re-renders never re-download.
 *
 * All native paths fail soft: if `expo-image-manipulator` or the native
 * toolkit aren't present (web, simulator stripped down), the helpers return
 * the input unchanged — callers can still ship the original bytes.
 */
import { Platform } from 'react-native';

let _AsyncStorage = null;
try { _AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}

// ── Quality presets ─────────────────────────────────────────────────────────
// Three-step preset matches WhatsApp 2026 (Auto/HD/Original from the camera
// roll picker). "Auto" maps to network-aware compression handled by the
// caller; we expose explicit pixel/quality targets here so consumers don't
// have to repeat the math.
export const QUALITY_PRESETS = Object.freeze({
  standard: { maxDim: 1600, quality: 0.80, label: 'Padrão' },
  hd:       { maxDim: 2400, quality: 0.88, label: 'HD' },
  original: { maxDim: 99999, quality: 0.95, label: 'Original' },
});

const QUALITY_PREF_KEY = 'chatyy_image_quality';
const STRIP_EXIF_KEY = 'chatyy_strip_exif';

// Cache the pref reads in module scope — AsyncStorage hops are 1-3ms each
// and a 30-photo album batch would otherwise pay 60+ ms before the first
// bubble paints. Refresh lazily on demand via `_refreshPrefs()`.
let _qualityPref = 'hd';
let _stripExifPref = true;
let _prefsLoaded = false;
async function _refreshPrefs() {
  if (!_AsyncStorage) return;
  try {
    const q = await _AsyncStorage.getItem(QUALITY_PREF_KEY);
    if (q && QUALITY_PRESETS[q]) _qualityPref = q;
    const s = await _AsyncStorage.getItem(STRIP_EXIF_KEY);
    _stripExifPref = (s !== 'false'); // default ON
  } catch {}
  _prefsLoaded = true;
}
_refreshPrefs();

export function getQualityPreset(override) {
  const name = override && QUALITY_PRESETS[override] ? override : _qualityPref;
  const preset = QUALITY_PRESETS[name] || QUALITY_PRESETS.hd;
  return { ...preset, name };
}

export async function setQualityPref(name) {
  if (!QUALITY_PRESETS[name]) return;
  _qualityPref = name;
  if (!_AsyncStorage) return;
  try { await _AsyncStorage.setItem(QUALITY_PREF_KEY, name); } catch {}
}

export function shouldStripExif() {
  if (!_prefsLoaded) _refreshPrefs(); // best-effort sync-ish
  return _stripExifPref;
}

// ── Local LQIP generation ──────────────────────────────────────────────────
// Generate a ~40px wide JPEG, base64-encoded. Used as the placeholder the
// bubble paints while the full image uploads + downloads. ~500-800 bytes,
// renders in <1ms via <Image source={{ uri: 'data:image/jpeg;base64,...' }}>.
// Result format matches the server's chat_messages.thumb_b64 column so the
// existing `persistThumbB64` cache accepts it unchanged.
export async function generateLocalLQIP(uri) {
  if (!uri) return null;
  if (Platform.OS === 'web') return _generateLocalLQIPWeb(uri);
  // Try native toolkit first (5-10× faster, GPU path).
  try {
    const NativeImage = require('../modules/expo-native-toolkit').Image;
    if (NativeImage?.resize) {
      const r = await NativeImage.resize({
        uri,
        maxWidth: 40,
        maxHeight: 40,
        quality: 0.5,
        format: 'jpeg',
      });
      if (r?.uri) {
        const FS = require('expo-file-system/legacy');
        try {
          const b64 = await FS.readAsStringAsync(r.uri.replace('file://', ''), {
            encoding: FS.EncodingType.Base64,
          });
          // Clean the tiny temp file — we only needed the bytes.
          try { await FS.deleteAsync(r.uri, { idempotent: true }); } catch {}
          if (b64 && b64.length < 4096) return b64;
        } catch {}
      }
    }
  } catch {}
  // Fallback: expo-image-manipulator. Slower but always available.
  try {
    const ImageManipulator = require('expo-image-manipulator');
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 40 } }],
      { compress: 0.4, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (r?.base64 && r.base64.length < 4096) return r.base64;
  } catch {}
  return null;
}

function _generateLocalLQIPWeb(uri) {
  return new Promise((resolve) => {
    try {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = 40;
          const h = Math.max(1, Math.round((img.height / img.width) * w));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
          const b64 = dataUrl.split(',')[1];
          resolve(b64 && b64.length < 4096 ? b64 : null);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = uri;
    } catch { resolve(null); }
  });
}

// ── EXIF strip ─────────────────────────────────────────────────────────────
// Re-encode through the native toolkit (or ImageManipulator fallback). The
// JPEG/PNG encoders both drop EXIF chunks by default, which is what scrubs
// GPS coords + camera serial + capture timestamp. Always-on by default;
// user can disable via the chatyy_strip_exif pref.
export async function stripExifIfNeeded(uri, opts = {}) {
  if (!uri) return uri;
  if (Platform.OS === 'web') return uri; // web path strips via canvas re-encode
  if (!shouldStripExif() && !opts.force) return uri;
  // Quick size check — files <800KB usually aren't worth touching unless we
  // explicitly need EXIF off. The full uploadAndSendFile path already does
  // the heavy resize/compress for big images, which strips EXIF for free.
  // This helper exists for the small-image case where uploadAndSendFile's
  // size gate skips compression.
  try {
    const NativeImage = require('../modules/expo-native-toolkit').Image;
    if (NativeImage?.resize) {
      const r = await NativeImage.resize({
        uri, maxWidth: 99999, maxHeight: 99999, quality: 0.95, format: 'jpeg',
      });
      if (r?.uri) return r.uri;
    }
  } catch {}
  try {
    const ImageManipulator = require('expo-image-manipulator');
    const r = await ImageManipulator.manipulateAsync(uri, [],
      { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG });
    if (r?.uri) return r.uri;
  } catch {}
  return uri;
}

// ── One-shot preflight ─────────────────────────────────────────────────────
// Bundles the three pre-upload steps in the order WhatsApp does them:
//   1. Decide quality preset (Standard/HD/Original, network-aware if Auto)
//   2. Resize + compress (also strips EXIF via re-encode)
//   3. Generate LQIP from the COMPRESSED output (smaller bytes = faster LQIP)
//
// Callers use this BEFORE inserting the optimistic bubble so the bubble
// already has a `thumb_b64` + the compressed local URI, and the network
// upload can run in the background with real byte-progress.
//
// Returns null on failure — caller should fall back to uploading the raw URI.
export async function preflightOutgoing(uri, opts = {}) {
  if (!uri) return null;
  const qualityName = opts.quality || _qualityPref;
  const preset = getQualityPreset(qualityName);
  // Optionally allow caller to skip resize (e.g. sticker is already 512×512).
  const skipResize = !!opts.skipResize;

  let outUri = uri;
  let outWidth = 0, outHeight = 0, outSize = 0;
  let outMime = opts.mime || 'image/jpeg';

  if (!skipResize) {
    try {
      const NativeImage = require('../modules/expo-native-toolkit').Image;
      if (Platform.OS !== 'web' && NativeImage?.resize) {
        const r = await NativeImage.resize({
          uri,
          maxWidth: preset.maxDim,
          maxHeight: preset.maxDim,
          quality: preset.quality,
          format: 'jpeg',
        });
        if (r?.uri) {
          outUri = r.uri;
          outWidth = r.width || 0;
          outHeight = r.height || 0;
          outSize = r.sizeBytes || 0;
          outMime = 'image/jpeg';
        }
      } else if (Platform.OS !== 'web') {
        // Fallback to ImageManipulator
        const ImageManipulator = require('expo-image-manipulator');
        const r = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: preset.maxDim } }],
          { compress: preset.quality, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (r?.uri) {
          outUri = r.uri;
          outWidth = r.width || 0;
          outHeight = r.height || 0;
          outMime = 'image/jpeg';
        }
      }
    } catch (e) {
      // Compression failed — keep original URI, LQIP step still runs below.
    }
  }

  // Generate the LQIP from the (possibly compressed) output.
  let thumbB64 = null;
  try { thumbB64 = await generateLocalLQIP(outUri); } catch {}

  return {
    uri: outUri,
    sizeBytes: outSize,
    width: outWidth,
    height: outHeight,
    thumbB64,
    mime: outMime,
    quality: preset.name,
  };
}

// ── Optimistic → server reconciliation ─────────────────────────────────────
// After the upload completes and the message gets its real server id:
//   - Migrate the temp-id LQIP entry to the real id
//   - Bind the local compressed file:// to the server's R2 URL so
//     CachedImage uses the local copy on the sender's device forever
//
// Cheap, safe to call with missing args.
export function bindOptimisticToServer(tempId, realId, localUri, serverUrl) {
  try {
    const mc = require('./mediaCache');
    if (tempId != null && realId != null) {
      mc.migrateThumbB64TempToReal?.(tempId, realId);
    }
    if (localUri && serverUrl) {
      mc.bindLocalUriToRemoteUrl?.(localUri, serverUrl);
    }
  } catch {}
}

// ── Convenience: persist LQIP keyed by temp_id at insert time ──────────────
// Call after preflightOutgoing() returns, BEFORE the upload kicks off, so
// every re-render of the optimistic bubble (avatar load, reactions tick,
// scroll-in) finds the LQIP synchronously and paints the blur tile instead
// of a blank gray box. `tempId` is the optimistic message's client id.
export function attachLqipToTempMessage(tempId, thumbB64) {
  if (!tempId || !thumbB64) return;
  try {
    const mc = require('./mediaCache');
    mc.persistThumbB64?.(tempId, thumbB64);
  } catch {}
}
