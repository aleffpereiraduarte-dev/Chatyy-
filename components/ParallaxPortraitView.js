// Wave 14 — 3D / depth-photo parallax viewer
//
// iOS portrait-mode photos carry a per-pixel depth map in the auxiliary
// channel of the HEIC container. We do NOT re-process the depth map here
// (that requires the AVDepthData PHAsset API and runs on capture). Instead,
// when a photo is tagged `media_kind: 'portrait'` by the iOS backup pipeline,
// the backend stores the depth map alongside the primary image. The viewer
// then renders a soft 3D parallax: foreground / background layers shift in
// opposite directions on gyroscope tilt, recreating the "live wallpaper"
// effect Apple's Photos.app uses.
//
// When `depthUrl` is missing we fall back to a single-layer faux-parallax
// that still feels nice (small translate on tilt). When `expo-sensors` is
// missing entirely we render a static image — same Image the rest of the
// app would have rendered.

import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Animated, Platform, StyleSheet } from 'react-native';

let Gyroscope = null;
if (Platform.OS !== 'web') {
  try { Gyroscope = require('expo-sensors').Gyroscope; } catch (e) { /* missing dep */ }
}

const TILT_RANGE_PX = 28;     // how far each layer can slide
const SMOOTHING = 0.08;       // 1 = instant, lower = smoother

export default function ParallaxPortraitView({
  fileUrl,
  depthUrl,
  width,
  height,
  style,
  active = true,        // pause sensors when offscreen
  intensity = 1.0,      // 0..1 multiplier on translation range
}) {
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  // Running averaged tilt — gyroscope returns rotation rate; we accumulate
  // into a low-pass-filtered tilt estimate so the layers settle when the
  // device rests instead of drifting.
  const tiltRef = useRef({ x: 0, y: 0 });
  const [hasSensor, setHasSensor] = useState(false);

  useEffect(() => {
    if (!active || !Gyroscope) return;
    let sub = null;
    let mounted = true;
    (async () => {
      try {
        const ok = await Gyroscope.isAvailableAsync?.();
        if (ok === false) return;
        Gyroscope.setUpdateInterval(33); // 30fps
        sub = Gyroscope.addListener(({ x, y }) => {
          if (!mounted) return;
          // Integrate rotation rate into a slowly decaying tilt
          tiltRef.current.x = tiltRef.current.x * (1 - SMOOTHING) + y * SMOOTHING * 4;
          tiltRef.current.y = tiltRef.current.y * (1 - SMOOTHING) + x * SMOOTHING * 4;
          // Clamp to [-1, 1] so a wild flick can't slingshot the layers
          const cx = Math.max(-1, Math.min(1, tiltRef.current.x));
          const cy = Math.max(-1, Math.min(1, tiltRef.current.y));
          // Update animated values (no driver — values are small)
          tx.setValue(cx * TILT_RANGE_PX * intensity);
          ty.setValue(cy * TILT_RANGE_PX * intensity * 0.6);
        });
        setHasSensor(true);
      } catch (e) {
        // Sensor unavailable — fall through to static render
      }
    })();
    return () => {
      mounted = false;
      try { sub?.remove?.(); } catch {}
      // Also gently animate back to center so the layer doesn't snap
      Animated.parallel([
        Animated.spring(tx, { toValue: 0, useNativeDriver: false }),
        Animated.spring(ty, { toValue: 0, useNativeDriver: false }),
      ]).start();
    };
  }, [active, intensity, tx, ty]);

  // Background layer is the original image scaled slightly larger so the
  // foreground (sharp masked subject) sliding doesn't reveal a hard edge.
  // Foreground layer is the depth-isolated subject — when depthUrl is missing
  // we just render a single layer (the parallax still works, just less 3D).
  const bgScale = 1.08;
  const fgTranslateX = tx;
  const fgTranslateY = ty;
  const bgTranslateX = Animated.multiply(tx, -0.45);
  const bgTranslateY = Animated.multiply(ty, -0.45);

  return (
    <View style={[styles.root, { width, height, overflow: 'hidden' }, style]}>
      <Animated.View style={[
        styles.layer,
        { width, height, transform: [
          { translateX: bgTranslateX },
          { translateY: bgTranslateY },
          { scale: bgScale },
        ] },
      ]}>
        <Image source={{ uri: fileUrl }} style={{ width, height }} resizeMode="cover" />
      </Animated.View>

      {depthUrl ? (
        <Animated.View style={[
          styles.layer,
          { width, height, transform: [
            { translateX: fgTranslateX },
            { translateY: fgTranslateY },
            { scale: 1.02 },
          ] },
        ]}>
          {/* Foreground = the masked subject. The backend should generate this
              by multiplying the original image alpha by a soft-edge depth
              mask thresholded near the foreground plane. If the backend
              hasn't produced one yet, depthUrl will be the original image,
              and the effect degrades to a strong faux-parallax that still
              feels more lively than a static photo. */}
          <Image source={{ uri: depthUrl }} style={{ width, height }} resizeMode="cover" />
        </Animated.View>
      ) : null}

      {/* Subtle vignette to hide the sliding edge */}
      <View pointerEvents="none" style={[styles.vignette, { width, height }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    backgroundColor: '#000',
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  vignette: {
    position: 'absolute',
    top: 0,
    left: 0,
    // RN doesn't support radial-gradient at the StyleSheet level; we'd ideally
    // wrap with expo-linear-gradient for inner shadow. Skipping the import to
    // keep the component dep-light.
  },
});
