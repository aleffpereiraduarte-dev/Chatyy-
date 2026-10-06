// PressableScale — the canonical "premium tap" primitive.
//
// Why this exists: the app had 277 bare <TouchableOpacity> tap targets whose
// only press feedback was an opacity fade. Only the FAB (BrandFab) and the
// voice mic button felt tactile. This consolidates the proven spring recipe
// (extracted from the inline AnimatedPressable in chat-conversation.js —
// "iMessage feel": fast snap-down tension 460, soft settle tension 200) plus
// the theme `haptic` helper into ONE drop-in replacement, so future polish
// lands once and every tap across the app reads as "I felt it".
//
// Drop-in for TouchableOpacity: same onPress / onLongPress / style API.
//   <PressableScale onPress={...}>...</PressableScale>
//
// Props (beyond the usual Touchable ones):
//   • haptic   — 'light' (default) | 'medium' | 'heavy' | 'select' | false
//                fires on press-IN (most responsive, matches BrandFab). No-op
//                on web (the theme helper never throws).
//   • scaleTo  — press-in scale target (default 0.97 — CLEAN 2026: subtle,
//                like WhatsApp). Use ~0.95 for small icon buttons if you want
//                a touch more travel; big surfaces (cards/rows) keep 0.97.
//   • disabled — skips scale + haptic, dims to 0.5 unless you style it.
//
// Zero native deps — RN Animated only (no Reanimated), so it ships via OTA.
import React, { useRef } from 'react';
import { TouchableOpacity, Animated } from 'react-native';
import { haptic as themeHaptic } from '../constants/theme';
import { isReduceMotionEnabled } from './reducedMotion';

export default function PressableScale({
  children,
  onPress,
  onLongPress,
  onPressIn,
  onPressOut,
  delayLongPress,
  style,
  activeOpacity = 0.9,
  haptic = 'light',
  scaleTo = 0.97,
  disabled = false,
  ...props
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = (e) => {
    if (!disabled) {
      // Reduce Motion: skip the scale spring (keep the haptic — a tactile tick
      // isn't "motion" and still confirms the tap for low-animation users).
      if (!isReduceMotionEnabled()) {
        // CLEAN 2026: snap-down suave (tension 340 vs 460) — sente responsivo
        // mas leve, sem "tapa". Combina com o scale sutil 0.97.
        Animated.spring(scaleAnim, {
          toValue: scaleTo,
          useNativeDriver: true,
          tension: 340,
          friction: 12,
        }).start();
      }
      // Tactile tick on press-in — feels instant, like iMessage / WhatsApp.
      if (haptic && themeHaptic?.[haptic]) {
        try { themeHaptic[haptic](); } catch {}
      }
    }
    onPressIn?.(e);
  };

  const handlePressOut = (e) => {
    if (!disabled && !isReduceMotionEnabled()) {
      Animated.spring(scaleAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 220,
        friction: 13,
      }).start();
    }
    onPressOut?.(e);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      activeOpacity={activeOpacity}
      disabled={disabled}
      {...props}
    >
      <Animated.View style={[style, { transform: [{ scale: scaleAnim }] }]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}
