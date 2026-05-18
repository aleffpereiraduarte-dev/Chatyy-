/**
 * Media subtype detection — maps iOS PHAsset.mediaSubtypes / Android
 * MediaStore equivalents to our canonical media_kind values:
 *
 *   'live_photo'  iOS Live Photo (still + 3s motion clip)
 *   'burst'       iOS Burst (consecutive frames from rapid-fire shutter)
 *   'slowmo'      iOS Slo-mo (high-FPS video → 240/120 fps)
 *   'timelapse'   iOS / Android time-lapse (low-FPS condensed)
 *   'raw'         RAW capture (DNG / proprietary RAW formats)
 *   'regular'     none of the above
 *
 * Used by the backup pipeline to set `media_kind` after upload so the
 * fullscreen viewer can render live photos with motion, bursts as a
 * carousel, slo-mo with rate hints, etc. Pure function — no native
 * imports, safe to call from any thread.
 *
 * The Expo MediaLibrary API surfaces mediaSubtypes only via
 * getAssetInfoAsync (slow). Callers should hit it once per upload
 * batch and cache the kind onto the asset descriptor so the hot loop
 * stays fast.
 */
import { Platform } from 'react-native';

// PHAssetMediaSubtype bitfield values from Apple. We read the iOS-mapped
// strings Expo exposes via mediaSubtypes (lower-case strings, not bitmask
// integers — Expo abstracts the bridge).
const IOS_SUBTYPES = {
  livePhoto: 'live_photo',
  photoLive: 'live_photo',
  highFrameRateVideo: 'slowmo',
  slomo: 'slowmo',
  timelapseVideo: 'timelapse',
  timelapse: 'timelapse',
  burstPhoto: 'burst',
  burst: 'burst',
};

// Filenames + MIME extensions that conventionally mean RAW. Apple wraps RAW
// in DNG for export but proprietary extensions also leak through Lightroom
// imports. Lowercase the ext before lookup.
const RAW_EXTS = new Set([
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'pef', 'srw',
  'x3f', '3fr', 'mef', 'mos', 'mrw', 'erf', 'gpr',
]);

function getExt(name) {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Detect media kind from a hydrated asset record. Pass the result of
 * MediaLibrary.getAssetInfoAsync (which carries mediaSubtypes + duration).
 *
 * @param {object} assetInfo MediaLibrary asset record
 * @param {object} [opts]    Optional context — `mimeType`, `name`
 * @returns {string} one of 'live_photo' | 'burst' | 'slowmo' | 'timelapse' | 'raw' | 'regular'
 */
export function detectMediaKind(assetInfo, opts = {}) {
  if (!assetInfo) return 'regular';
  const name = opts.name || assetInfo.filename || assetInfo.name || '';
  const ext = getExt(name);

  // RAW is detectable from extension regardless of platform — covers DSLR
  // imports + DNG exports the camera roll surfaces as `image/dng`.
  if (RAW_EXTS.has(ext)) return 'raw';
  if ((opts.mimeType || assetInfo.mimeType || '').toLowerCase().includes('raw')) {
    return 'raw';
  }

  // iOS: mediaSubtypes is an array of string identifiers per Expo SDK 55+.
  if (Platform.OS === 'ios') {
    const subs = assetInfo.mediaSubtypes;
    if (Array.isArray(subs)) {
      for (const s of subs) {
        const norm = String(s || '').toLowerCase();
        for (const [k, v] of Object.entries(IOS_SUBTYPES)) {
          if (norm === k.toLowerCase() || norm.includes(k.toLowerCase())) {
            return v;
          }
        }
      }
    }
  }

  // Android: no clean Live Photo equivalent, but slow-mo / time-lapse can be
  // inferred from capture frame rate. Expo doesn't expose frame rate, so we
  // fall back to filename hints (Samsung / Pixel both use "_slomo" / "_TL_").
  if (Platform.OS === 'android') {
    const lname = name.toLowerCase();
    if (lname.includes('slomo') || lname.includes('slow_motion')) return 'slowmo';
    if (lname.includes('_tl_') || lname.includes('timelapse')) return 'timelapse';
    if (lname.includes('burst')) return 'burst';
  }

  return 'regular';
}

/**
 * Backend tagging helper — wraps the API call so the backup pipeline doesn't
 * have to know the action name. Safe to call without awaiting (fire and
 * forget); the viewer falls back to a regular render if media_kind is null.
 */
export async function persistMediaKind(api, fileId, kind) {
  if (!fileId || !kind || kind === 'regular') return;
  try {
    if (api?.photosSetMediaKind) {
      await api.photosSetMediaKind(fileId, kind);
    }
  } catch {
    // Non-fatal — server just lacks the metadata; viewer will render as
    // regular media. Don't block the upload pipeline on this.
  }
}
