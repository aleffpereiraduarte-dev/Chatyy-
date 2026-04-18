/**
 * Instagram-style image editor with gestures:
 * - Pinch to zoom (2 fingers)
 * - Rotate with 2 fingers
 * - Pan/drag with 1 finger
 * - Double-tap to reset
 * - Snap rotation to 0°/90°/180°/270° when close
 *
 * Works on both web (mouse wheel zoom + drag) and native (touch gestures).
 */
import React, { useRef, useState, useCallback } from 'react';
import { View, Image, StyleSheet, Platform, Animated, PanResponder, TouchableOpacity, Text } from 'react-native';

const SNAP_ANGLE_THRESHOLD = 12; // degrees — snap to cardinal when within this

function distance(t1, t2) {
  const dx = t2.pageX - t1.pageX;
  const dy = t2.pageY - t1.pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function angle(t1, t2) {
  const dx = t2.pageX - t1.pageX;
  const dy = t2.pageY - t1.pageY;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function snapRotation(deg) {
  const norm = ((deg % 360) + 360) % 360;
  const cardinals = [0, 90, 180, 270, 360];
  for (const c of cardinals) {
    if (Math.abs(norm - c) < SNAP_ANGLE_THRESHOLD) {
      return c === 360 ? 0 : c;
    }
  }
  return deg;
}

export default function ImageEditorGestures({
  uri,
  filterOverlay,  // optional React node to overlay (filter tint)
  onTransformChange,
  style,
}) {
  // Current transform values (committed after gesture ends)
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  // Gesture state refs
  const gestureStart = useRef({ distance: 0, angle: 0, tx: 0, ty: 0, scale: 1, rotation: 0 });
  const lastTap = useRef(0);

  // For panResponder — doesn't cause re-renders during gesture
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const animScale = useRef(new Animated.Value(1)).current;
  const animRotation = useRef(new Animated.Value(0)).current;

  const _commit = useCallback((nx, ny, ns, nr) => {
    setTx(nx); setTy(ny); setScale(ns); setRotation(nr);
    pan.setValue({ x: nx, y: ny });
    animScale.setValue(ns);
    animRotation.setValue(nr);
    onTransformChange?.({ tx: nx, ty: ny, scale: ns, rotation: nr });
  }, [pan, animScale, animRotation, onTransformChange]);

  const _reset = useCallback(() => {
    Animated.parallel([
      Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true, damping: 18, stiffness: 150 }),
      Animated.spring(animScale, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 150 }),
      Animated.spring(animRotation, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 150 }),
    ]).start();
    setTimeout(() => _commit(0, 0, 1, 0), 350);
  }, [pan, animScale, animRotation, _commit]);

  // Rotate 90° clockwise — handy for upside-down photos
  const _rotate90 = useCallback(() => {
    const newRot = ((rotation + 90) % 360);
    Animated.spring(animRotation, { toValue: newRot, useNativeDriver: true, damping: 16, stiffness: 120 }).start();
    setTimeout(() => _commit(tx, ty, scale, newRot), 400);
  }, [rotation, tx, ty, scale, animRotation, _commit]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;

        // Double-tap detection
        const now = Date.now();
        if (touches.length === 1 && now - lastTap.current < 300) {
          lastTap.current = 0;
          _reset();
          return;
        }
        lastTap.current = now;

        gestureStart.current = {
          tx, ty, scale, rotation,
          distance: touches.length === 2 ? distance(touches[0], touches[1]) : 0,
          angle: touches.length === 2 ? angle(touches[0], touches[1]) : 0,
        };
      },
      onPanResponderMove: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const start = gestureStart.current;

        if (touches.length === 2) {
          // Pinch zoom + rotation
          const d = distance(touches[0], touches[1]);
          const a = angle(touches[0], touches[1]);
          if (start.distance > 0) {
            const scaleFactor = d / start.distance;
            const newScale = Math.max(0.5, Math.min(4, start.scale * scaleFactor));
            animScale.setValue(newScale);

            const deltaAngle = a - start.angle;
            const newRotation = start.rotation + deltaAngle;
            animRotation.setValue(newRotation);
          }
        } else if (touches.length === 1) {
          // Single-finger pan
          pan.setValue({ x: start.tx + gs.dx, y: start.ty + gs.dy });
        }
      },
      onPanResponderRelease: () => {
        // Read animated values
        const cx = pan.x.__getValue();
        const cy = pan.y.__getValue();
        const cs = animScale.__getValue();
        let cr = animRotation.__getValue();
        cr = snapRotation(cr);
        // Animate to snapped rotation
        Animated.spring(animRotation, { toValue: cr, useNativeDriver: true, damping: 20, stiffness: 180 }).start();
        _commit(cx, cy, cs, cr);
      },
    })
  ).current;

  // Web mouse wheel zoom support
  const handleWheel = Platform.OS === 'web' ? (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    const newScale = Math.max(0.5, Math.min(4, scale * delta));
    _commit(tx, ty, newScale, rotation);
  } : undefined;

  return (
    <View style={[styles.container, style]} {...responder.panHandlers} {...(handleWheel && { onWheel: handleWheel })}>
      <Animated.View
        style={[
          styles.imageWrap,
          {
            transform: [
              { translateX: pan.x },
              { translateY: pan.y },
              { scale: animScale },
              { rotate: animRotation.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
            ],
          },
        ]}
      >
        <Image source={{ uri }} style={styles.image} resizeMode="contain" />
        {filterOverlay}
      </Animated.View>

      {/* Floating rotate button — bottom-left */}
      <TouchableOpacity onPress={_rotate90} style={styles.rotateBtn} activeOpacity={0.7}>
        <Text style={styles.rotateBtnText}>↻ 90°</Text>
      </TouchableOpacity>

      {/* Reset button — bottom-right, only if transformed */}
      {(tx !== 0 || ty !== 0 || scale !== 1 || rotation !== 0) && (
        <TouchableOpacity onPress={_reset} style={styles.resetBtn} activeOpacity={0.7}>
          <Text style={styles.resetBtnText}>Reset</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  rotateBtn: {
    position: 'absolute', left: 16, bottom: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20,
  },
  rotateBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  resetBtn: {
    position: 'absolute', right: 16, bottom: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20,
  },
  resetBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
