// Generic empty-state card. Replaces 7+ inline empty states across notifications,
// files, calendar, business, contacts, drive, parental-monitor, marketplace, etc.
//
// Pattern: tinted circle + icon → title → subtitle → optional CTA button.
// Animations: scale-in pop on mount (matches other polish in this app).
//
// Usage:
//   <EmptyStateCard
//     Icon={IconInbox}
//     title={t('inbox.empty.title')}
//     subtitle={t('inbox.empty.sub')}
//     ctaLabel={t('compose.new')}
//     onPress={() => router.push('/compose')}
//   />
//
// Optional props:
//   - tone: 'primary' (default) | 'success' | 'warning' | 'neutral'
//   - illustration: <ReactNode>  — render instead of Icon (e.g. SVG illustration)
//   - secondaryAction: { label, onPress } — ghost link below CTA
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import PressableScale from './PressableScale';
import { wrapRetryPress } from '../utils/userRetry'; // [2026-10-18 breaker-ux]
import { Springs, motionEnabled } from '../constants/motion'; // [2026-10-16 motion] entrada de estado vazio

export default function EmptyStateCard({
  Icon,
  illustration,
  title,
  subtitle,
  ctaLabel,
  onPress,
  secondaryAction,
  tone = 'primary',
  iconSize = 30,
  containerStyle,
}) {
  const { colors } = useTheme();
  const still = useRef(!motionEnabled('empty_state')).current;
  const scale = useRef(new Animated.Value(still ? 1 : 0.94)).current;
  const opacity = useRef(new Animated.Value(still ? 1 : 0)).current;

  useEffect(() => {
    if (still) return;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...Springs.gentle }),
      Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity, still]);

  const tint = tone === 'success' ? (colors.success || '#22c55e')
    : tone === 'warning' ? (colors.warning || '#f59e0b')
    : tone === 'neutral' ? (colors.textSecondary || '#64748b')
    : colors.primary;
  // [2026-10-12 empty-state system] One look app-wide (ScreenEmptyState
  // parity): 72pt soft neutral circle + ink glyph, title 18/700, body 14,
  // one 46pt pill CTA. Semantic tones keep their tint on the glyph only.
  const semantic = tone === 'success' || tone === 'warning';
  const circleBg = semantic ? tint + '1A' : (colors.surfaceVariant || colors.borderLight || '#F0F1F3');
  const glyph = semantic ? tint : (tone === 'neutral' ? colors.textSecondary : colors.text);
  const ctaBg = semantic ? tint : colors.primary;
  const ctaInk = semantic ? '#fff' : (colors.onPrimary || '#fff');

  return (
    <Animated.View
      style={[{
        paddingVertical: 40, paddingHorizontal: 24,
        alignItems: 'center', justifyContent: 'center',
        opacity, transform: [{ scale }],
      }, containerStyle]}
    >
      {illustration ? (
        <View style={{ marginBottom: 16 }}>{illustration}</View>
      ) : Icon ? (
        <View
          style={{
            width: 72, height: 72, borderRadius: 36,
            backgroundColor: circleBg,
            alignItems: 'center', justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <Icon size={iconSize} color={glyph} />
        </View>
      ) : null}

      {title ? (
        <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 6, letterSpacing: -0.2, lineHeight: 23 }}>
          {title}
        </Text>
      ) : null}

      {subtitle ? (
        <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, maxWidth: 320 }}>
          {subtitle}
        </Text>
      ) : null}

      {ctaLabel && onPress ? (
        // [2026-10-11 visual polish] Primary CTA → PressableScale (spring +
        // light haptic), same tactile tap as the other primary buttons.
        <PressableScale
          onPress={wrapRetryPress(onPress, ctaLabel)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          style={{
            marginTop: 22,
            minHeight: 46, paddingHorizontal: 24,
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 23, backgroundColor: ctaBg,
          }}
        >
          <Text style={{ color: ctaInk, fontSize: 15, fontWeight: '600' }}>{ctaLabel}</Text>
        </PressableScale>
      ) : null}

      {secondaryAction?.label && secondaryAction?.onPress ? (
        <TouchableOpacity
          onPress={secondaryAction.onPress}
          activeOpacity={0.6}
          accessibilityRole="button"
          style={{ marginTop: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
        >
          <Text style={{ color: semantic ? tint : colors.text, fontSize: 14, fontWeight: '600' }}>{secondaryAction.label}</Text>
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}
