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
//   • scaleTo  — press-in scale target (default 0.95). Use ~0.97 for big
//                surfaces (cards/rows), ~0.9 for small icon buttons.
//   • disabled — skips scale + haptic, dims to 0.5 unless you style it.
//
// Zero native deps — RN Animated only (no Reanimated), so it ships via OTA.
import React, { useRef } from 'react';
import { TouchableOpacity, Animated } from 'react-native';
import { haptic as themeHaptic } from '../constants/theme';

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
  scaleTo = 0.95,
  disabled = false,
  ...props
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = (e) => {
    if (!disabled) {
      Animated.spring(scaleAnim, {
        toValue: scaleTo,
        useNativeDriver: true,
        tension: 460,
        friction: 11,
      }).start();
      // Tactile tick on press-in — feels instant, like iMessage / WhatsApp.
      if (haptic && themeHaptic?.[haptic]) {
        try { themeHaptic[haptic](); } catch {}
      }
    }
    onPressIn?.(e);
  };

  const handlePressOut = (e) => {
    if (!disabled) {
      Animated.spring(scaleAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 200,
        friction: 9,
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
