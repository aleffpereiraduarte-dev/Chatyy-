// FaceFilters — AR face-overlay filter PRESET DATA (asset + anchor specs).
//
// [2026-05-26] This module is now DATA-ONLY for the live AR path. The actual
// face tracking + overlay draw runs in StatusVisionCamera.js, which uses
// react-native-vision-camera-face-detector's MLKit `useFaceDetector` inside a
// single-session Skia frame processor. StatusVisionCamera imports only
// `resolveFilterPreset` / `FACE_FILTER_PRESETS` from here; it does NOT use the
// legacy `getMediaPipe()` loader (kept as a no-op for the disabled
// FaceFilterOverlay only). The historical landmark-index notes below refer to
// the old MediaPipe-478 numbering and are retained for reference; the live
// path anchors on MLKit's named landmarks (LEFT_EYE, NOSE_BASE, etc.).
//
// On-device, 30fps target (15fps fallback on weak devices). Each preset
// declares which landmarks anchor which PNG overlay.
//
// (Legacy reference) MediaPipe FaceLandmarker returns 478 normalized
// landmarks. The ones the old overlay anchored on:
//   landmark[1]   → nose tip (used for sunglasses center, hearts eyes)
//   landmark[10]  → forehead center (party hat anchor)
//   landmark[152] → chin (vampire teeth lower mouth)
//   landmark[33]  → left eye outer corner
//   landmark[263] → right eye outer corner
//   landmark[61]  → left mouth corner
//   landmark[291] → right mouth corner
//   landmark[323] / [93] → right/left ear (dog ears, cat whiskers)
//
// Bundled PNG overlay names (assets/ar-filters/<key>.png) — these are
// transparent PNGs sized so that 1024×1024 maps to the head bounding
// box at 1.4× scale. The runtime auto-scales by inter-pupillary
// distance (landmark 33 ↔ 263) to keep aspect right on every face.
//
// Performance:
//   - 30fps cap (max). On devices reporting <2GB RAM (Device.totalMemory)
//     or hermesInternal === undefined the runtime drops to 15fps.
//   - Landmark inference runs in a worker (native side, off main thread).
//   - Overlay positioning happens on the JS side with native-driven
//     translate transforms so frame drops don't tear.
import { Platform } from 'react-native';

// Six presets bundled in `assets/ar-filters/`. Anchor keys reference
// landmark indices documented above; scale = relative to IPD.
export const FACE_FILTER_PRESETS = [
  {
    key: 'none',
    label: 'Nenhum',
    asset: null,
    anchors: [],
  },
  {
    key: 'dog_ears',
    label: 'Cachorro',
    asset: require('../../assets/ar-filters/dog_ears.png'),
    // Two ear assets — top of head, scaled with face width
    anchors: [{ landmark: 10, scale: 2.2, offsetY: -0.6, anchor: 'bottom-center' }],
    // Fall back to a single ears overlay even if MediaPipe never confirms a face
    fallback: { centerOffsetY: -0.35, scale: 0.55 },
  },
  {
    key: 'cat_whiskers',
    label: 'Gato',
    asset: require('../../assets/ar-filters/cat_whiskers.png'),
    anchors: [{ landmark: 1, scale: 2.4, offsetY: 0, anchor: 'center' }],
    fallback: { centerOffsetY: 0, scale: 0.7 },
  },
  {
    key: 'sunglasses',
    label: 'Óculos',
    asset: require('../../assets/ar-filters/sunglasses.png'),
    // Sized to IPD between landmarks 33 ↔ 263, ratio ≈ 1.8
    anchors: [{ landmarkPair: [33, 263], scaleByIpd: 1.8, anchor: 'center' }],
    fallback: { centerOffsetY: -0.1, scale: 0.55 },
  },
  {
    key: 'heart_eyes',
    label: 'Corações',
    asset: require('../../assets/ar-filters/heart_eyes.png'),
    // Per-eye overlay — paints twice, once over each pupil (landmark 468/473)
    anchors: [
      { landmark: 468, scale: 0.7, anchor: 'center' },
      { landmark: 473, scale: 0.7, anchor: 'center' },
    ],
    fallback: { centerOffsetY: -0.1, scale: 0.5 },
  },
  {
    key: 'party_hat',
    label: 'Festa',
    asset: require('../../assets/ar-filters/party_hat.png'),
    anchors: [{ landmark: 10, scale: 1.6, offsetY: -1.2, anchor: 'bottom-center' }],
    fallback: { centerOffsetY: -0.6, scale: 0.5 },
  },
  {
    key: 'vampire',
    label: 'Vampiro',
    asset: require('../../assets/ar-filters/vampire_teeth.png'),
    // Anchored to lower mouth between landmarks 13 (upper) and 14 (lower)
    anchors: [{ landmarkPair: [13, 14], scaleByIpd: 3.0, anchor: 'center', offsetY: 0.3 }],
    fallback: { centerOffsetY: 0.15, scale: 0.4 },
  },
];

// [2026-05-26 DEAD PATH — hard no-op] The legacy second-camera-session face
// tracker (ExpoMediaPipeFace / expo-mediapipe-face, consumed only by the
// now-disabled FaceFilterOverlay) is gone. AR face tracking is owned entirely
// by the SINGLE-session Skia frame processor in StatusVisionCamera.js, which
// uses react-native-vision-camera-face-detector's MLKit detector directly and
// does NOT call into this function.
//
// We keep `getMediaPipe()` as an exported no-op (returns null) purely so the
// orphaned FaceFilterOverlay.js — which is hard-disabled and imported nowhere —
// still resolves at module-eval without throwing. There is NO native binding
// behind it anymore. Do NOT re-introduce a `requireNativeModule(...)` call
// here: the only modern AR consumer is StatusVisionCamera via useFaceDetector.
export function getMediaPipe() {
  return null;
}

// Heuristic device-class probe — drops the inference cap to 15fps when
// the device is likely to struggle at 30fps. Cheap to compute, run once
// on mount and memoize the result.
let _classCache = null;
export function getDeviceClass() {
  if (_classCache) return _classCache;
  let isWeak = false;
  try {
    const Device = require('expo-device');
    const ram = Device?.totalMemory || 0;
    if (ram && ram < 3 * 1024 * 1024 * 1024) isWeak = true; // < 3GB
  } catch {}
  // Hermes presence implies a relatively modern RN runtime; absence is
  // a soft signal we're on an old AOSP build.
  if (typeof HermesInternal === 'undefined') isWeak = true;
  _classCache = isWeak ? 'weak' : 'strong';
  return _classCache;
}

// Get the target fps for face-landmark inference.
export function getTargetFps() {
  return getDeviceClass() === 'weak' ? 15 : 30;
}

// Resolve a preset by key (case-insensitive). Returns the `none` entry
// when unknown so callers can render the camera without crashing.
export function resolveFilterPreset(key) {
  const want = (key || 'none').toLowerCase();
  return FACE_FILTER_PRESETS.find(p => p.key === want) || FACE_FILTER_PRESETS[0];
}
