// [2026-10-07 login-ux] Inline notice for the auth screens (login / forgot).
// Replaces Alert.alert + ad-hoc red text: one calm row with an SVG glyph,
// optional action link, screen-reader live region. No emoji (founder rule).
import { useEffect, useRef } from 'react';
import { View, Text, Animated, TouchableOpacity, Platform } from 'react-native';
import Svg, { Path, Circle, Line } from 'react-native-svg';

function Glyph({ tone, color }) {
  const p = { stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  if (tone === 'offline') {
    return (
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Line x1="2" y1="2" x2="22" y2="22" {...p} />
        <Path d="M8.5 16.5a5 5 0 0 1 7 0" {...p} />
        <Path d="M2 8.82a15 15 0 0 1 4.17-2.65" {...p} />
        <Path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" {...p} />
        <Path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" {...p} />
        <Path d="M5 13a10 10 0 0 1 5.24-2.76" {...p} />
        <Circle cx="12" cy="20" r="1" fill={color} />
      </Svg>
    );
  }
  if (tone === 'success') {
    return (
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Circle cx="12" cy="12" r="10" {...p} />
        <Path d="M8 12.5l2.5 2.5L16 9.5" {...p} />
      </Svg>
    );
  }
  if (tone === 'info' || tone === 'hint') {
    return (
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Circle cx="12" cy="12" r="10" {...p} />
        <Line x1="12" y1="11" x2="12" y2="16" {...p} />
        <Circle cx="12" cy="7.8" r="1" fill={color} />
      </Svg>
    );
  }
  // error / warning
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" {...p} />
      <Line x1="12" y1="9" x2="12" y2="13" {...p} />
      <Circle cx="12" cy="17" r="1" fill={color} />
    </Svg>
  );
}

export default function LoginNotice({ tone = 'error', text, actionLabel, onAction, colors, style, compact = false }) {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    // Start at 0.4 (never 0) — prod iOS has had native-driver hiccups that
    // pinned Animated values at their initial value; the notice must stay
    // readable even if this never runs.
    anim.setValue(0.4);
    Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [text, anim]);
  if (!text) return null;

  const palette = {
    error: { fg: colors.error, bg: colors.errorBg },
    warning: { fg: colors.warning, bg: colors.warningBg || colors.surfaceVariant },
    offline: { fg: colors.text, bg: colors.surfaceVariant },
    info: { fg: colors.textSecondary, bg: colors.surfaceVariant },
    hint: { fg: colors.textSecondary, bg: 'transparent' },
    success: { fg: colors.success, bg: colors.successBg || colors.surfaceVariant },
  }[tone] || { fg: colors.error, bg: colors.errorBg };
  const isAlert = tone === 'error' || tone === 'offline';

  return (
    <Animated.View
      accessibilityRole={isAlert ? 'alert' : undefined}
      accessibilityLiveRegion={isAlert ? 'assertive' : 'polite'}
      style={[{
        flexDirection: 'row', alignItems: 'flex-start', gap: 8,
        paddingVertical: tone === 'hint' ? 4 : (compact ? 8 : 11),
        paddingHorizontal: tone === 'hint' ? 2 : 12,
        borderRadius: 12,
        backgroundColor: palette.bg,
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0.4, 1], outputRange: [-3, 0] }) }],
      }, style]}
    >
      <View style={{ marginTop: 1 }}><Glyph tone={tone} color={palette.fg} /></View>
      <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, fontWeight: tone === 'hint' ? '500' : '600', color: palette.fg }}>
        {text}
        {actionLabel && onAction ? ' ' : ''}
        {actionLabel && onAction ? (
          <Text
            onPress={onAction}
            accessibilityRole="button"
            style={{ fontWeight: '800', color: tone === 'error' ? colors.error : colors.text, textDecorationLine: 'underline', ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}) }}
          >
            {actionLabel}
          </Text>
        ) : null}
      </Text>
    </Animated.View>
  );
}

// Small helper re-exported for chips like "Você quis dizer gmail.com?"
export function SuggestionChip({ label, onPress, colors }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      style={{
        alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999,
        borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceVariant,
        ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
      }}
    >
      <Svg width={13} height={13} viewBox="0 0 24 24">
        <Path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" stroke={colors.text} strokeWidth={2} strokeLinejoin="round" fill="none" />
      </Svg>
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{label}</Text>
    </TouchableOpacity>
  );
}
