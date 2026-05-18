// FaceFilterOverlay — renders the active AR face filter on top of the
// camera preview. Subscribes to MediaPipe FaceLandmarker output via the
// native binding and re-positions the PNG overlay each frame with
// native-driven transforms (translateX/Y/scale) so we don't drop frames
// even on weak Androids.
//
// Falls back to a static positioned overlay when:
//   - The native binding isn't loaded (web, debug simulator without
//     the pod installed yet).
//   - MediaPipe hasn't detected a face for > 500ms (e.g. the user is
//     off-camera or the lens is covered).
//   - The preset's key === 'none' (no overlay).
//
// All overlay positioning is normalized to the preview's box (0..1).
// We multiply by previewSize from parent so this component is agnostic
// to the actual camera aspect ratio.
import React, { useEffect, useRef, useState } from 'react';
import { View, Image, StyleSheet, Animated, Platform } from 'react-native';
import { getMediaPipe, getTargetFps, resolveFilterPreset } from './FaceFilters';

export default function FaceFilterOverlay({ filterKey, previewSize, facing = 'front' }) {
  const preset = resolveFilterPreset(filterKey);
  const [face, setFace] = useState(null);     // last detected face landmarks
  const lastSeenRef = useRef(0);
  const subRef = useRef(null);

  // Subscribe to landmark events from the native binding. The actual
  // wiring lives in the bridge; here we just listen + throttle. If the
  // binding isn't present we leave `face` null and the overlay falls
  // back to the preset's centered fallback anchor.
  useEffect(() => {
    if (!preset || preset.key === 'none') return undefined;
    const mp = getMediaPipe();
    if (!mp) return undefined;
    try {
      const fps = getTargetFps();
      // Start inference at target fps. Binding handles native-side
      // throttling so the JS thread never sees more than `fps` events.
      mp.startFaceLandmarker?.({ fps });
      const handler = (data) => {
        if (!data?.landmarks || !data.landmarks.length) return;
        lastSeenRef.current = Date.now();
        setFace(data.landmarks[0]); // first face only — single-subject status
      };
      subRef.current = mp.addListener?.('faceLandmarks', handler);
    } catch {}
    return () => {
      try { subRef.current?.remove?.(); } catch {}
      try { getMediaPipe()?.stopFaceLandmarker?.(); } catch {}
    };
  }, [preset?.key]);

  // Drop the face if MediaPipe stops emitting for > 500ms — avoids
  // stale overlay glued to the last position when the user turns away.
  useEffect(() => {
    if (!face) return undefined;
    const id = setInterval(() => {
      if (Date.now() - lastSeenRef.current > 500) setFace(null);
    }, 200);
    return () => clearInterval(id);
  }, [face]);

  if (!preset || preset.key === 'none' || !preset.asset || !previewSize?.width) return null;

  const { width: pw, height: ph } = previewSize;

  // Helper: convert a normalized landmark (0..1 in image-space) to
  // screen-pixel coordinates inside the preview box. Mirror X when the
  // front camera is active so the overlay tracks what the user sees.
  const toPx = (lm) => {
    if (!lm) return null;
    const x = facing === 'front' ? (1 - lm.x) * pw : lm.x * pw;
    const y = lm.y * ph;
    return { x, y };
  };

  // Compute the inter-pupil distance (IPD) from landmarks 33↔263 for
  // anchor scaling. Returns null if either landmark missing — caller
  // falls back to a default scale.
  const computeIpd = (lms) => {
    const a = lms?.[33], b = lms?.[263];
    if (!a || !b) return null;
    const dx = (a.x - b.x) * pw;
    const dy = (a.y - b.y) * ph;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Render each anchor in the preset. When `face` is null we render a
  // single centered fallback so the user still sees something happen.
  const overlays = [];
  if (face) {
    const ipd = computeIpd(face) || pw * 0.18; // sensible default
    preset.anchors.forEach((a, i) => {
      let center = null;
      if (a.landmarkPair) {
        const p1 = toPx(face[a.landmarkPair[0]]);
        const p2 = toPx(face[a.landmarkPair[1]]);
        if (p1 && p2) center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      } else if (typeof a.landmark === 'number') {
        center = toPx(face[a.landmark]);
      }
      if (!center) return;
      const sizeBase = a.scaleByIpd ? ipd * a.scaleByIpd : ipd * (a.scale || 1.6);
      const w = sizeBase;
      const h = sizeBase;
      let dy = (a.offsetY || 0) * sizeBase;
      // Anchor mode lets us pin the overlay's bottom (e.g. hat sitting
      // ON the forehead) instead of dead-center on the landmark.
      let translateY = center.y - h / 2 + dy;
      if (a.anchor === 'bottom-center') translateY = center.y - h + dy;
      const translateX = center.x - w / 2;
      overlays.push({ key: `f${i}`, w, h, translateX, translateY });
    });
  } else if (preset.fallback) {
    // Static fallback anchor — center of preview, slight Y offset per
    // preset spec. Lets the user see the filter even when MediaPipe
    // hasn't locked on yet (or is disabled because the binding isn't
    // loaded). UX matches Snapchat's "filter previews even when no face
    // is detected" pattern.
    const w = pw * preset.fallback.scale;
    const h = w;
    const translateX = pw / 2 - w / 2;
    const translateY = ph / 2 - h / 2 + preset.fallback.centerOffsetY * ph;
    overlays.push({ key: 'fallback', w, h, translateX, translateY });
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
            ],
          }}
          resizeMode="contain"
        />
      ))}
    </View>
  );
}
