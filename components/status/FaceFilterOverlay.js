// FaceFilterOverlay — renders the active AR face filter on top of the
// camera preview. Subscribes to face landmark events from the native
// binding (iOS Vision / Android ML Kit, exposed by expo-native-toolkit
// as ExpoMediaPipeFace) and re-positions the PNG overlay each frame.
//
// Falls back to a static positioned overlay when:
//   - The native binding isn't loaded (web, debug binary without the
//     rebuilt ExpoFaceLandmarkerModule).
//   - The binding hasn't emitted a face for > 800ms (e.g. user is
//     off-camera or lens is covered).
//   - The preset's key === 'none' (no overlay).
//
// All overlay positioning is normalized to the preview's box (0..1).
// We multiply by previewSize from parent so this component is agnostic
// to the actual camera aspect ratio.
//
// Smoothing:
//   The 15–30fps landmark stream can jitter on weak devices (especially
//   when the face is near-frontal and ML Kit's per-frame landmark noise
//   floor is ~2px). We apply a low-pass filter (lerp toward target with
//   smoothing factor 0.35) so the overlay glides instead of vibrating.
import React, { useEffect, useRef, useState } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { getMediaPipe, getTargetFps, resolveFilterPreset } from './FaceFilters';

export default function FaceFilterOverlay({ filterKey, previewSize, facing = 'front' }) {
  const preset = resolveFilterPreset(filterKey);
  const [face, setFace] = useState(null);     // last detected face packet
  const lastSeenRef = useRef(0);
  const subRef = useRef(null);

  // Smoothing state — last interpolated positions keyed by anchor id.
  // Persists across frames so we don't snap when a landmark drops out
  // for one frame.
  const smoothRef = useRef({});

  // Subscribe to landmark events from the native binding. The actual
  // wiring lives in the native module; here we listen + drop the face
  // when the stream stalls.
  useEffect(() => {
    if (!preset || preset.key === 'none') return undefined;
    let mp = null;
    try { mp = getMediaPipe(); } catch (e) {
      if (__DEV__) console.warn('[FaceFilterOverlay] getMediaPipe threw:', e?.message);
      return undefined;
    }
    if (!mp || typeof mp.startFaceLandmarker !== 'function') return undefined;
    try {
      const fps = getTargetFps();
      // Start inference at target fps. Native side throttles so the JS
      // thread never sees more than `fps` events per second.
      mp.startFaceLandmarker?.({ fps });
      const handler = (data) => {
        if (!data?.landmarks || !data.landmarks.length) return;
        lastSeenRef.current = Date.now();
        setFace(data.landmarks[0]); // first face only — single-subject status
      };
      subRef.current = mp.addListener?.('faceLandmarks', handler);
    } catch (e) {
      if (__DEV__) console.warn('[FaceFilterOverlay] startFaceLandmarker threw:', e?.message);
    }
    return () => {
      try { subRef.current?.remove?.(); } catch {}
      try { getMediaPipe()?.stopFaceLandmarker?.(); } catch {}
      smoothRef.current = {};
    };
  }, [preset?.key]);

  // Drop the face if the binding stops emitting for > 800ms — avoids a
  // stale overlay glued to the last position when the user turns away.
  // 800ms is a balance: shorter feels twitchy when ML Kit briefly loses
  // lock during a head turn; longer leaves a "stuck filter" smell.
  useEffect(() => {
    if (!face) return undefined;
    const id = setInterval(() => {
      if (Date.now() - lastSeenRef.current > 800) {
        setFace(null);
        smoothRef.current = {};
      }
    }, 200);
    return () => clearInterval(id);
  }, [face]);

  // Belt-and-braces: bail when any prerequisite is missing. Each check
  // protects a separate crash path — missing asset (someone deleted the
  // PNG but kept the preset), 0×0 previewSize (camera not laid out),
  // stale filterKey post-HMR.
  if (!preset || preset.key === 'none' || !preset.asset || !previewSize?.width || !previewSize?.height) return null;

  const { width: pw, height: ph } = previewSize;

  // Convert a normalized landmark (0..1 in image-space) to screen-pixel
  // coordinates inside the preview box. Mirror X when the front camera is
  // active so the overlay tracks what the user sees (front-cam preview is
  // mirrored by default on iOS/Android).
  const toPx = (lm) => {
    if (!lm) return null;
    const x = facing === 'front' ? (1 - lm.x) * pw : lm.x * pw;
    const y = lm.y * ph;
    return { x, y };
  };

  // Pull a landmark from the new packet shape. The native modules emit
  //   { indexed: { '1': {x,y}, '33': {x,y}, ... }, bbox: {x,y,w,h}, rollDeg }
  // Old payloads (or future MediaPipe-array shape) are accepted as a
  // fallback so we don't ever crash on a shape change.
  const getLm = (id) => {
    if (!face) return null;
    if (face.indexed && face.indexed[String(id)]) return face.indexed[String(id)];
    if (Array.isArray(face) && face[id]) return face[id];
    return null;
  };

  // Compute the inter-pupil distance (IPD) from landmarks 33↔263 for
  // anchor scaling. Falls back to bbox.w * 0.45 when eyes weren't
  // detected this frame (e.g. user tilted past Vision/ML Kit's range).
  const computeIpd = () => {
    const a = getLm(33), b = getLm(263);
    if (a && b) {
      const dx = (a.x - b.x) * pw;
      const dy = (a.y - b.y) * ph;
      return Math.sqrt(dx * dx + dy * dy);
    }
    if (face?.bbox?.w) return face.bbox.w * pw * 0.45;
    return null;
  };

  // Low-pass filter on each anchor's center to erase 15–30fps jitter.
  // Alpha 0.35 lands the visual delay around ~60ms, below the
  // perceptual lag threshold and well above the per-frame noise floor.
  const smooth = (key, target) => {
    const ALPHA = 0.35;
    const prev = smoothRef.current[key];
    if (!prev) {
      smoothRef.current[key] = target;
      return target;
    }
    const next = {
      x: prev.x + (target.x - prev.x) * ALPHA,
      y: prev.y + (target.y - prev.y) * ALPHA,
    };
    smoothRef.current[key] = next;
    return next;
  };

  // Roll rotation — Android ML Kit emits face.rollDeg (Z-axis euler).
  // iOS Vision doesn't expose roll directly, so the overlay just tracks
  // position with rotation=0 there. We negate on the front camera
  // because the preview is mirrored.
  const rollDeg = (typeof face?.rollDeg === 'number')
    ? (facing === 'front' ? -face.rollDeg : face.rollDeg)
    : 0;

  // Render each anchor in the preset. When `face` is null we render a
  // single centered fallback so the user still sees the filter while
  // tracking spools up (matches Snapchat's preview-without-lock UX).
  const overlays = [];
  if (face) {
    const ipd = computeIpd() || pw * 0.18; // sensible default for 50cm distance
    preset.anchors.forEach((a, i) => {
      let center = null;
      if (a.landmarkPair) {
        const p1 = toPx(getLm(a.landmarkPair[0]));
        const p2 = toPx(getLm(a.landmarkPair[1]));
        if (p1 && p2) center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      } else if (typeof a.landmark === 'number') {
        center = toPx(getLm(a.landmark));
      }

      // bbox fallback when a named landmark didn't resolve this frame
      // (e.g. ML Kit drops MOUTH_BOTTOM on partial-mouth occlusion).
      if (!center && face.bbox) {
        const b = face.bbox;
        const bcx = b.x + b.w / 2;
        const bcy = b.y + b.h / 2;
        const bx = facing === 'front' ? (1 - bcx) * pw : bcx * pw;
        const by = bcy * ph;
        center = { x: bx, y: by };
      }
      if (!center) return;

      center = smooth(`f${i}`, center);

      const sizeBase = a.scaleByIpd ? ipd * a.scaleByIpd : ipd * (a.scale || 1.6);
      const w = sizeBase;
      const h = sizeBase;
      let dy = (a.offsetY || 0) * sizeBase;
      // Anchor mode lets us pin the overlay's bottom (e.g. hat sits ON
      // the forehead) instead of dead-center on the landmark.
      let translateY = center.y - h / 2 + dy;
      if (a.anchor === 'bottom-center') translateY = center.y - h + dy;
      const translateX = center.x - w / 2;
      overlays.push({ key: `f${i}`, w, h, translateX, translateY, rotate: rollDeg });
    });
  } else if (preset.fallback) {
    // Static fallback anchor — center of preview with a slight Y offset
    // per preset spec. Lets the user see the filter before tracking
    // locks on (or when the binding isn't loaded on web/debug).
    const w = pw * preset.fallback.scale;
    const h = w;
    const translateX = pw / 2 - w / 2;
    const translateY = ph / 2 - h / 2 + preset.fallback.centerOffsetY * ph;
    overlays.push({ key: 'fallback', w, h, translateX, translateY, rotate: 0 });
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {overlays.map((o) => (
        <Image
          key={o.key}
          source={preset.asset}
          style={{
            position: 'absolute',
            width: o.w,
            height: o.h,
            left: 0,
            top: 0,
            transform: [
              { translateX: o.translateX },
              { translateY: o.translateY },
              { rotate: `${o.rotate}deg` },
            ],
          }}
          resizeMode="contain"
          // Swallow PNG decode errors so a missing/corrupt asset doesn't
          // crash the camera. Overlay just renders blank — capture works.
          onError={(e) => {
            if (__DEV__) console.warn('[FaceFilterOverlay] image load error:', e?.nativeEvent?.error);
          }}
        />
      ))}
    </View>
  );
}
