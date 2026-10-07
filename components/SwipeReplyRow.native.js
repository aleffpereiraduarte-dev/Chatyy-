// [2026-10-07 native-polish] Swipe-to-reply on the UI thread (Reanimated 4 +
// RNGH Gesture API) — WhatsApp feel:
//   • the bubble follows the finger frame-by-frame on the UI thread (no JS
//     work per frame, so a busy JS thread — sync, decrypt, list diff — can't
//     make the drag stutter);
//   • rubber-band past the threshold, ONE light haptic at the moment the
//     threshold is crossed (not at release), reply fires on release, and the
//     row springs back — no "open → wait 200 ms → close" like the legacy
//     Swipeable, which also kept 2 Animated.Values + a PanGestureHandler
//     subscription per mounted row.
//   • left swipe (own messages) → message info, same mechanics.
//
// OTA SAFETY: only active when utils/threadKeyboard already loaded
// Reanimated/Worklets successfully on this binary (runtime 2.6.0+). Otherwise
// SWIPE_REPLY_UI_THREAD is false and chat-conversation keeps the legacy
// Swipeable path. Web resolves SwipeReplyRow.js (null export).
import React, { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../utils/threadKeyboard';

let Rea = null;
let GH = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // Already initialised by utils/threadKeyboard (same module instance).
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    GH = require('react-native-gesture-handler');
  } catch {
    Rea = null;
    GH = null;
  }
}

// Worklet helpers bound at module scope: a worklet closure must capture the
// FUNCTIONS, never the whole module object (it would be serialised to the UI
// runtime).
const runOnJS = Rea ? Rea.runOnJS : null;
const withSpring = Rea ? Rea.withSpring : null;
const interpolate = Rea ? Rea.interpolate : null;

export const SWIPE_REPLY_UI_THREAD = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && Rea.withSpring
  && Rea.interpolate && Rea.runOnJS
  && GH && GH.Gesture && GH.Gesture.Pan && GH.GestureDetector
);

const THRESHOLD = 64;    // px to arm the action (haptic here)
const MAX_DRAG = 110;    // hard cap after rubber-band
const RUBBER = 0.35;     // resistance past the threshold
const SPRING = { damping: 20, stiffness: 260, mass: 0.7 };

let _haptics = null;
function _tick() {
  try {
    if (!_haptics) _haptics = require('../services/haptics');
    _haptics.tap('light');
  } catch {}
}

export default function SwipeReplyRow({ children, onReply, onInfo, style, iconReply, iconInfo }) {
  const Animated = Rea.default;
  const tx = Rea.useSharedValue(0);
  const armed = Rea.useSharedValue(0); // 0 none, 1 reply (right), -1 info (left)

  // Latest callbacks without re-creating the gesture every render.
  const cbRef = useRef({ onReply, onInfo });
  cbRef.current = { onReply, onInfo };
  const hasReply = !!onReply;
  const hasInfo = !!onInfo;

  const fire = useCallback((dir) => {
    const { onReply: r, onInfo: i } = cbRef.current;
    try {
      if (dir > 0) r?.();
      else if (dir < 0) i?.();
    } catch {}
  }, []);

  const gesture = useMemo(() => {
    const maxRight = hasReply ? MAX_DRAG : 0;
    const maxLeft = hasInfo ? MAX_DRAG : 0;
    // Same tuning as the legacy Swipeable (build 526): capture only after a
    // deliberate horizontal drift; any early vertical motion → list scrolls.
    // Only reply (most rows): activate on a RIGHT drag only, so a leftward
    // drag never steals the touch from the bubble/list.
    const activeX = hasInfo && hasReply ? [-25, 25] : (hasInfo ? -25 : 25);
    return GH.Gesture.Pan()
      .enabled(hasReply || hasInfo)
      .activeOffsetX(activeX)
      .failOffsetY([-8, 8])
      .onUpdate((e) => {
        'worklet';
        let x = e.translationX;
        const sign = x < 0 ? -1 : 1;
        let abs = x < 0 ? -x : x;
        if (abs > THRESHOLD) abs = THRESHOLD + (abs - THRESHOLD) * RUBBER;
        const cap = sign > 0 ? maxRight : maxLeft;
        if (abs > cap) abs = cap;
        x = sign * abs;
        tx.set(x);
        const nowArmed = abs >= THRESHOLD ? sign : 0;
        if (nowArmed !== 0 && armed.get() !== nowArmed) {
          runOnJS(_tick)();
        }
        armed.set(nowArmed);
      })
      .onEnd(() => {
        'worklet';
        if (armed.get() !== 0) runOnJS(fire)(armed.get());
      })
      .onFinalize(() => {
        'worklet';
        armed.set(0);
        tx.set(withSpring(0, SPRING));
      });
  }, [hasReply, hasInfo, fire, tx, armed]);

  const contentStyle = Rea.useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }],
  }));
  const replyIconStyle = Rea.useAnimatedStyle(() => {
    const t = tx.get();
    const v = t > 0 ? t : 0;
    return {
      opacity: interpolate(v, [0, 20, 44], [0, 0.6, 1], 'clamp'),
      transform: [{ scale: interpolate(v, [0, THRESHOLD, MAX_DRAG], [0.4, 1, 1.12], 'clamp') }],
    };
  });
  const infoIconStyle = Rea.useAnimatedStyle(() => {
    const t = tx.get();
    const v = t < 0 ? -t : 0;
    return {
      opacity: interpolate(v, [0, 20, 44], [0, 0.6, 1], 'clamp'),
      transform: [{ scale: interpolate(v, [0, THRESHOLD, MAX_DRAG], [0.4, 1, 1.12], 'clamp') }],
    };
  });

  return (
    <GH.GestureDetector gesture={gesture}>
      <Animated.View style={style}>
        {hasReply ? (
          <Animated.View pointerEvents="none" style={[st.iconSlot, st.left, replyIconStyle]}>
            <View style={st.badge}>{iconReply}</View>
          </Animated.View>
        ) : null}
        {hasInfo ? (
          <Animated.View pointerEvents="none" style={[st.iconSlot, st.right, infoIconStyle]}>
            <View style={st.badge}>{iconInfo}</View>
          </Animated.View>
        ) : null}
        <Animated.View style={contentStyle}>{children}</Animated.View>
      </Animated.View>
    </GH.GestureDetector>
  );
}

const st = StyleSheet.create({
  iconSlot: { position: 'absolute', top: 0, bottom: 0, width: 44, alignItems: 'center', justifyContent: 'center' },
  left: { left: 6 },
  right: { right: 6 },
  badge: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(134,150,160,0.22)',
  },
});
