/**
 * ScreenEmptyState — THE canonical premium empty state for the whole app.
 * ---------------------------------------------------------------------------
 * Replaces the per-screen bespoke empty states (meetings.renderEmpty,
 * marketplace.emptyState, contacts EmptyStateCard, feed inline, etc.) so every
 * empty screen shares ONE look: a floating gradient-halo illustration, a clear
 * title + subtitle, a premium primary CTA, an optional ghost secondary link,
 * and — most importantly — an optional "tips" list that turns dead space into
 * onboarding (exactly what the product brief asked for).
 *
 * Usage:
 *   <ScreenEmptyState
 *     kind="meetings"
 *     title={t('meetings.empty.title')}
 *     subtitle={t('meetings.empty.sub')}
 *     cta={{ label: t('meetings.new'), onPress: () => router.push('/meeting-create') }}
 *     secondary={{ label: t('meetings.join'), onPress: openJoin }}
 *     tips={[
 *       { icon: 'calendar', label: t('meetings.tip.schedule') },
 *       { icon: 'link', label: t('meetings.tip.invite') },
 *     ]}
 *   />
 *
 * `kind` selects the illustration + accent. Everything else is optional.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Circle, Rect, Defs, LinearGradient, RadialGradient, Stop, G, Line } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';

const AC = '#7C3AED'; // brand accent

/* ---------------------------------------------------------------- glyphs --- */
// Each glyph is a single stroked icon drawn on a 96×96 canvas, centered inside
// the gradient halo. Kept minimal + line-based for a clean, modern Apple/Linear
// feel rather than busy clip-art.
function Glyph({ kind, color }) {
  const s = { stroke: color, strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  switch (kind) {
    case 'feed':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Rect x={20} y={18} width={56} height={60} rx={10} {...s} />
          <Line x1={32} y1={34} x2={64} y2={34} {...s} />
          <Line x1={32} y1={46} x2={64} y2={46} {...s} />
          <Line x1={32} y1={58} x2={50} y2={58} {...s} />
        </Svg>
      );
    case 'contacts':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Circle cx={48} cy={38} r={13} {...s} />
          <Path d="M26 74 C26 60 38 54 48 54 C58 54 70 60 70 74" {...s} />
        </Svg>
      );
    case 'meetings':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Rect x={18} y={30} width={42} height={36} rx={8} {...s} />
          <Path d="M60 44 L78 34 L78 62 L60 52 Z" {...s} />
        </Svg>
      );
    case 'marketplace':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Path d="M24 34 L72 34 L68 70 C67.5 73 65 75 62 75 L34 75 C31 75 28.5 73 28 70 Z" {...s} />
          <Path d="M36 34 C36 24 42 20 48 20 C54 20 60 24 60 34" {...s} />
        </Svg>
      );
    case 'bots':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Rect x={24} y={34} width={48} height={36} rx={10} {...s} />
          <Line x1={48} y1={22} x2={48} y2={34} {...s} />
          <Circle cx={48} cy={20} r={3.5} fill={color} />
          <Circle cx={39} cy={52} r={3.5} fill={color} />
          <Circle cx={57} cy={52} r={3.5} fill={color} />
        </Svg>
      );
    case 'files':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Path d="M22 30 C22 26 25 23 29 23 L42 23 L50 31 L67 31 C71 31 74 34 74 38 L74 66 C74 70 71 73 67 73 L29 73 C25 73 22 70 22 66 Z" {...s} />
        </Svg>
      );
    case 'photos':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Rect x={20} y={26} width={56} height={44} rx={9} {...s} />
          <Circle cx={36} cy={42} r={6} {...s} />
          <Path d="M24 64 L44 48 L58 60 L66 54 L72 60" {...s} />
        </Svg>
      );
    case 'notifications':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Path d="M34 44 C34 33 40 26 48 26 C56 26 62 33 62 44 C62 58 68 62 68 62 L28 62 C28 62 34 58 34 44 Z" {...s} />
          <Path d="M42 68 C42 72 45 74 48 74 C51 74 54 72 54 68" {...s} />
        </Svg>
      );
    case 'lives':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Circle cx={48} cy={48} r={10} {...s} />
          <Path d="M30 30 C20 40 20 56 30 66" {...s} />
          <Path d="M66 30 C76 40 76 56 66 66" {...s} />
        </Svg>
      );
    case 'search':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Circle cx={44} cy={44} r={20} {...s} />
          <Line x1={59} y1={59} x2={72} y2={72} {...s} />
        </Svg>
      );
    case 'tasks':
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Rect x={22} y={22} width={52} height={52} rx={12} {...s} />
          <Path d="M36 48 L45 57 L62 38" {...s} />
        </Svg>
      );
    case 'chat':
    default:
      return (
        <Svg width={96} height={96} viewBox="0 0 96 96">
          <Path d="M22 38 C22 30 28 24 36 24 L60 24 C68 24 74 30 74 38 L74 54 C74 62 68 68 60 68 L40 68 L28 78 L30 68 C25 67 22 62 22 56 Z" {...s} />
          <Circle cx={40} cy={46} r={3.5} fill={color} />
          <Circle cx={48} cy={46} r={3.5} fill={color} />
          <Circle cx={56} cy={46} r={3.5} fill={color} />
        </Svg>
      );
  }
}

/* --------------------------------------------------------------- chevron --- */
function Chevron({ color }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16">
      <Path d="M6 4 L10 8 L6 12" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

function TipIcon({ name, color }) {
  const s = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      {name === 'calendar' && <><Rect x={4} y={5} width={16} height={15} rx={3} {...s} /><Line x1={4} y1={9} x2={20} y2={9} {...s} /><Line x1={9} y1={3} x2={9} y2={6} {...s} /><Line x1={15} y1={3} x2={15} y2={6} {...s} /></>}
      {name === 'link' && <><Path d="M9 13 L15 7" {...s} /><Path d="M11 5 L13 3 C15 1 19 1 21 3 C23 5 23 9 21 11 L19 13" {...s} /><Path d="M13 19 L11 21 C9 23 5 23 3 21 C1 19 1 15 3 13 L5 11" {...s} /></>}
      {name === 'plus' && <><Line x1={12} y1={5} x2={12} y2={19} {...s} /><Line x1={5} y1={12} x2={19} y2={12} {...s} /></>}
      {name === 'upload' && <><Path d="M12 16 L12 4" {...s} /><Path d="M7 9 L12 4 L17 9" {...s} /><Path d="M4 18 L4 20 L20 20 L20 18" {...s} /></>}
      {name === 'bell' && <><Path d="M18 8 A6 6 0 0 0 6 8 C6 15 3 17 3 17 L21 17 C21 17 18 15 18 8" {...s} /><Path d="M10 20 A2 2 0 0 0 14 20" {...s} /></>}
      {name === 'star' && <Path d="M12 3 L14.5 9 L21 9.5 L16 14 L17.5 20.5 L12 17 L6.5 20.5 L8 14 L3 9.5 L9.5 9 Z" {...s} />}
      {name === 'users' && <><Circle cx={9} cy={8} r={3.5} {...s} /><Path d="M3 19 C3 14 6 12 9 12 C12 12 15 14 15 19" {...s} /><Path d="M16 5 A3.2 3.2 0 0 1 16 11" {...s} /><Path d="M17 12 C20 12 21.5 14.5 21.5 18" {...s} /></>}
      {name === 'search' && <><Circle cx={11} cy={11} r={6} {...s} /><Line x1={16} y1={16} x2={21} y2={21} {...s} /></>}
      {name === 'sparkles' && <><Path d="M12 4 L13.2 9 L18 10.2 L13.2 11.4 L12 16 L10.8 11.4 L6 10.2 L10.8 9 Z" {...s} /><Path d="M18 15 L18.6 17.4 L21 18 L18.6 18.6 L18 21 L17.4 18.6 L15 18 L17.4 17.4 Z" {...s} /></>}
      {(name === 'play' || !name) && <Path d="M8 5 L19 12 L8 19 Z" {...s} />}
    </Svg>
  );
}

/* ----------------------------------------------------------------- main --- */
export default function ScreenEmptyState({
  kind = 'chat',
  title,
  subtitle,
  cta,            // { label, onPress, icon? }
  secondary,      // { label, onPress }
  tips,           // [{ icon, label, onPress? }]
  accent,
  compact = false,
  style,
}) {
  const { colors } = useTheme();
  const A = accent || colors.primary || AC;

  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(16)).current;
  const scale = useRef(new Animated.Value(0.92)).current;
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }),
    ]).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [fade, slide, scale, float]);

  const translateY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });
  const haloSize = compact ? 120 : 148;

  return (
    <Animated.View style={[styles.wrap, compact && styles.wrapCompact, { opacity: fade, transform: [{ translateY: slide }] }, style]}>
      {/* Illustration: gradient halo + floating glyph */}
      <Animated.View style={{ transform: [{ translateY }, { scale }] }}>
        <View style={{ width: haloSize, height: haloSize, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={haloSize} height={haloSize} viewBox="0 0 148 148" style={StyleSheet.absoluteFill}>
            <Defs>
              <RadialGradient id="halo" cx="50%" cy="46%" r="55%">
                <Stop offset="0" stopColor={A} stopOpacity={0.20} />
                <Stop offset="0.7" stopColor={A} stopOpacity={0.07} />
                <Stop offset="1" stopColor={A} stopOpacity={0} />
              </RadialGradient>
              <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={A} stopOpacity={0.9} />
                <Stop offset="1" stopColor={A} stopOpacity={0.4} />
              </LinearGradient>
            </Defs>
            <Circle cx={74} cy={70} r={70} fill="url(#halo)" />
            <Circle cx={74} cy={70} r={46} fill={colors.surface} opacity={0.0} />
          </Svg>
          <Glyph kind={kind} color={A} />
        </View>
      </Animated.View>

      {!!title && <Text style={[styles.title, { color: colors.text }]}>{title}</Text>}
      {!!subtitle && <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}

      {!!cta && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={cta.onPress}
          style={[styles.cta, { backgroundColor: A }, Shadow.purpleGlow]}
        >
          {!!cta.icon && <View style={{ marginRight: 8 }}><TipIcon name={cta.icon} color="#fff" /></View>}
          <Text style={styles.ctaText}>{cta.label}</Text>
        </TouchableOpacity>
      )}

      {!!secondary && (
        <TouchableOpacity activeOpacity={0.7} onPress={secondary.onPress} style={styles.secondary}>
          <Text style={[styles.secondaryText, { color: A }]}>{secondary.label}</Text>
        </TouchableOpacity>
      )}

      {Array.isArray(tips) && tips.length > 0 && (
        <View style={[styles.tips, { backgroundColor: colors.surface, borderColor: colors.border }, Shadow.cardRest]}>
          {tips.map((tip, i) => {
            const Row = tip.onPress ? TouchableOpacity : View;
            return (
              <Row
                key={i}
                {...(tip.onPress ? { activeOpacity: 0.7, onPress: tip.onPress } : {})}
                style={[styles.tipRow, i < tips.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              >
                <View style={[styles.tipIcon, { backgroundColor: A + '14' }]}>
                  <TipIcon name={tip.icon} color={A} />
                </View>
                <Text style={[styles.tipLabel, { color: colors.text }]} numberOfLines={2}>{tip.label}</Text>
                {!!tip.onPress && <Chevron color={colors.textTertiary} />}
              </Row>
            );
          })}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 40 },
  wrapCompact: { flex: 0, paddingVertical: 24 },
  title: { fontSize: FontSize.title, fontWeight: '800', marginTop: Spacing.lg, textAlign: 'center', letterSpacing: -0.3 },
  subtitle: { fontSize: FontSize.base, lineHeight: 21, marginTop: Spacing.sm, textAlign: 'center', maxWidth: 320 },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: Spacing.xl, paddingHorizontal: 24, paddingVertical: 13,
    borderRadius: BorderRadius.full,
  },
  ctaText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700', letterSpacing: 0.2 },
  secondary: { marginTop: Spacing.md, paddingVertical: 8, paddingHorizontal: 12 },
  secondaryText: { fontSize: FontSize.base, fontWeight: '600' },
  tips: {
    marginTop: Spacing.xxl, width: '100%', maxWidth: 380,
    borderRadius: BorderRadius.xl, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  tipRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  tipIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tipLabel: { flex: 1, fontSize: FontSize.base, fontWeight: '500', lineHeight: 19 },
});
