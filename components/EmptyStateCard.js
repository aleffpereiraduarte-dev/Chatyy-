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

export default function EmptyStateCard({
  Icon,
  illustration,
  title,
  subtitle,
  ctaLabel,
  onPress,
  secondaryAction,
  tone = 'primary',
  iconSize = 28,
  containerStyle,
}) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(0.94)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 100 }),
      Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  const tint = tone === 'success' ? (colors.success || '#22c55e')
    : tone === 'warning' ? (colors.warning || '#f59e0b')
    : tone === 'neutral' ? (colors.textSecondary || '#64748b')
    : colors.primary;

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
            width: 64, height: 64, borderRadius: 32,
            backgroundColor: tint + '15',
            alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <Icon size={iconSize} color={tint} />
        </View>
      ) : null}

      {title ? (
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 6 }}>
          {title}
        </Text>
      ) : null}

      {subtitle ? (
        <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 18, maxWidth: 320 }}>
          {subtitle}
        </Text>
      ) : null}

      {ctaLabel && onPress ? (
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          style={{
            marginTop: 20,
            paddingVertical: 12, paddingHorizontal: 22,
            borderRadius: 12, backgroundColor: tint,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{ctaLabel}</Text>
        </TouchableOpacity>
      ) : null}

      {secondaryAction?.label && secondaryAction?.onPress ? (
        <TouchableOpacity
          onPress={secondaryAction.onPress}
          activeOpacity={0.6}
          accessibilityRole="button"
          style={{ marginTop: 12, paddingVertical: 6, paddingHorizontal: 12 }}
        >
          <Text style={{ color: tint, fontSize: 13, fontWeight: '600' }}>{secondaryAction.label}</Text>
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}
