// PressableRow — native list-cell press feedback.  [2026-10-07 app-feel-ui]
//
// Why: full-width rows (chat list, settings, menus) used PressableScale /
// TouchableOpacity — the whole row SHRANK and FADED on tap, which reads as a
// web button, not a native cell. Native platforms do:
//   • iOS (UITableViewCell): no scale, no fade — a flat gray highlight behind
//     the content while the finger is down.
//   • Android (Material list item): a ripple drawn from the touch point.
// This primitive does exactly that, and falls back to PressableScale on web
// (keeps hover/onContextMenu/mouse props working through RN-web).
//
// API mirrors TouchableOpacity: onPress / onPressIn / onPressOut / onLongPress
// / delayLongPress / style / disabled / accessibility props.
//   • highlightColor — override the pressed tint (iOS + web) / ripple color.
//   • haptic         — false (default) | 'light' | 'select' … fires on press-in
//                      (rows usually haptic in their own handler).
//   • delayPressIn   — accepted for TouchableOpacity parity (maps to the
//                      Pressable press delay so scroll flicks don't flash).
// Zero native deps — ships via OTA.
import React from 'react';
import { Pressable, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { haptic as themeHaptic } from '../constants/theme';
import PressableScale from './PressableScale';

export default function PressableRow({
  children,
  style,
  highlightColor,
  haptic = false,
  delayPressIn,
  onPressIn,
  activeOpacity, // eslint-disable-line no-unused-vars — TouchableOpacity parity, ignored on native
  ...props
}) {
  const { isDark } = useTheme() || {};

  if (Platform.OS === 'web') {
    return (
      <PressableScale
        style={style}
        haptic={haptic}
        scaleTo={0.99}
        activeOpacity={0.85}
        delayPressIn={delayPressIn}
        onPressIn={onPressIn}
        {...props}
      >
        {children}
      </PressableScale>
    );
  }

  // OPAQUE by default: rows inside swipeables sit on top of the colored
  // action buttons — a translucent tint would let them bleed through.
  const tint = highlightColor || (isDark ? '#26292C' : '#EBEBED');
  const handlePressIn = (e) => {
    if (haptic && themeHaptic?.[haptic]) { try { themeHaptic[haptic](); } catch {} }
    onPressIn?.(e);
  };

  return (
    <Pressable
      {...props}
      onPressIn={handlePressIn}
      unstable_pressDelay={typeof delayPressIn === 'number' ? delayPressIn : 40}
      android_ripple={Platform.OS === 'android'
        ? { color: highlightColor || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'), foreground: true }
        : undefined}
      style={({ pressed }) => [
        typeof style === 'function' ? style({ pressed }) : style,
        // iOS: flat cell highlight. Android: the ripple IS the feedback —
        // don't double it with a tint.
        pressed && Platform.OS === 'ios' ? { backgroundColor: tint } : null,
      ]}
    >
      {children}
    </Pressable>
  );
}
