import { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, KeyboardAvoidingView,
  Platform, Animated, TouchableOpacity,
} from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import {
  IconMailLogo, IconCheck, IconUser, IconLock, IconPhone, IconShield,
  IconSun, IconMoon,
} from '../Icons';

const STEP_ICONS = [IconUser, IconMailLogo, IconLock, IconPhone, IconShield, IconCheck];
const STEP_LABEL_KEYS = ['signup.stepLabels.data', 'signup.stepLabels.email', 'signup.stepLabels.password', 'signup.stepLabels.phone', 'signup.stepLabels.recovery', 'signup.stepLabels.confirm'];

export default function StepCard({ step, title, subtitle, children }) {
  const { colors, isDark, toggle } = useTheme();
  const { t } = useLanguage();
  const STEP_LABELS = STEP_LABEL_KEYS.map(k => t(k));
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(fadeAnim, { toValue: 1, tension: 60, friction: 10, useNativeDriver: false }),
      Animated.spring(translateY, { toValue: 0, tension: 60, friction: 12, useNativeDriver: false }),
    ]).start();
  }, []);

  const StepIcon = STEP_ICONS[step - 1] || IconCheck;
  const entryScale = fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });

  return (
    <View style={[s.outerRoot, { backgroundColor: isDark ? '#0a0f1e' : '#f0f4ff' }]}>
      {/* Gradient background layers */}
      <View style={s.gradientBg} pointerEvents="none">
        <View style={[s.gradientLayer1, { backgroundColor: isDark ? colors.primary + '08' : colors.primary + '06' }]} />
        <View style={[s.gradientLayer2, { backgroundColor: isDark ? '#1e3a5f10' : colors.primary + '04' }]} />
      </View>
      {/* Decorative background */}
      <View style={s.bgDecor} pointerEvents="none">
        <View style={[s.bgCircle1, { backgroundColor: colors.primary + (isDark ? '12' : '0c') }]} />
        <View style={[s.bgCircle2, { backgroundColor: colors.primary + (isDark ? '0c' : '08') }]} />
        <View style={[s.bgCircle3, { backgroundColor: (colors.authSuccessGreen || '#10b981') + (isDark ? '0c' : '08') }]} />
      </View>

      {/* Theme toggle */}
      <TouchableOpacity onPress={toggle} style={s.themeToggle} activeOpacity={0.7}>
        <View style={[s.themeBtn, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
          borderColor: colors.authInputBorder,
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          } : {
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
          }),
        }]}>
          {isDark ? <IconSun size={16} color="#fbbf24" /> : <IconMoon size={16} color={colors.textSecondary} />}
        </View>
      </TouchableOpacity>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.center}>
            <Animated.View style={[s.cardWrap, { opacity: fadeAnim, transform: [{ scale: entryScale }, { translateY }] }]}>

              {/* Card with glass morphism */}
              <View style={[s.card, {
                backgroundColor: isDark ? 'rgba(21, 30, 46, 0.85)' : 'rgba(255, 255, 255, 0.92)',
                borderColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.6)',
                borderWidth: 1,
                ...(Platform.OS === 'web' ? {
                  backdropFilter: 'blur(24px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                  boxShadow: isDark
                    ? '0 4px 16px rgba(0,0,0,0.4), 0 12px 48px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.05)'
                    : '0 2px 8px rgba(0,0,0,0.04), 0 8px 32px rgba(37,99,235,0.08), inset 0 1px 0 rgba(255,255,255,0.8)',
                } : {
                  shadowColor: isDark ? '#000' : colors.primary,
                  shadowOffset: { width: 0, height: 8 },
                  shadowOpacity: isDark ? 0.35 : 0.12,
                  shadowRadius: 28,
                  elevation: 12,
                }),
              }]}>

                {/* Icon with glow */}
                <View style={s.iconRow}>
                  <View style={s.iconWrap}>
                    <View style={[s.iconGlow, { backgroundColor: colors.primary + '0a' }]} />
                    <View style={[s.iconCircle, {
                      backgroundColor: isDark ? colors.primary + '15' : colors.primary + '08',
                    }]}>
                      <StepIcon size={26} color={colors.primary} />
                    </View>
                  </View>
                </View>

                {/* Title & subtitle */}
                {!!title && <Text style={[s.title, { color: colors.text }]}>{title}</Text>}
                {!!subtitle && <Text style={[s.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}

                {/* Segmented progress with labels */}
                <View style={s.progressSection}>
                  <View style={s.progressRow}>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const isDone = i < step - 1;
                      const isActive = i === step - 1;
                      return (
                        <View key={i} style={s.progressSegmentWrap}>
                          <View
                            style={[s.progressSegment, {
                              backgroundColor: isDone
                                ? (colors.authSuccessGreen || '#22c55e')
                                : isActive
                                  ? colors.primary
                                  : (isDark ? colors.authStepPendingBg || '#334155' : '#e2e8f0'),
                              ...(isActive && Platform.OS === 'web' ? {
                                boxShadow: `0 0 6px ${colors.primary}40`,
                              } : {}),
                              ...Platform.select({
                                web: { transition: 'all 0.4s cubic-bezier(0.4,0,0.2,1)' },
                                default: {},
                              }),
                            }]}
                          />
                        </View>
                      );
                    })}
                  </View>
                  <View style={s.stepLabelsRow}>
                    {STEP_LABELS.map((label, i) => {
                      const isDone = i < step - 1;
                      const isActive = i === step - 1;
                      return (
                        <Text key={i} style={[s.stepLabel, {
                          color: isDone
                            ? (colors.authSuccessGreen || '#22c55e')
                            : isActive
                              ? colors.primary
                              : colors.textTertiary,
                          fontWeight: isActive ? '700' : '400',
                        }]}>
                          {label}
                        </Text>
                      );
                    })}
                  </View>
                </View>

                {children}
              </View>

              {/* Footer */}
              <View style={s.footer}>
                <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('signup.footerLanguage')}</Text>
                <View style={s.footerLinks}>
                  <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('signup.help')}</Text>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> · </Text>
                  <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('signup.privacy')}</Text>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> · </Text>
                  <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('signup.terms')}</Text>
                </View>
              </View>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  outerRoot: { flex: 1, overflow: 'hidden' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },

  /* Gradient background */
  gradientBg: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0,
  },
  gradientLayer1: {
    position: 'absolute', top: 0, left: 0, right: 0, height: '50%',
  },
  gradientLayer2: {
    position: 'absolute', top: '30%', left: 0, right: 0, bottom: 0,
  },

  /* Decorative background */
  bgDecor: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0,
    overflow: 'hidden',
  },
  bgCircle1: {
    position: 'absolute', width: 450, height: 450, borderRadius: 225,
    top: -140, right: -120,
  },
  bgCircle2: {
    position: 'absolute', width: 350, height: 350, borderRadius: 175,
    bottom: -80, left: -100,
  },
  bgCircle3: {
    position: 'absolute', width: 250, height: 250, borderRadius: 125,
    top: '35%', left: '55%',
  },

  /* Theme toggle */
  themeToggle: { position: 'absolute', top: 16, right: 16, zIndex: 10 },
  themeBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },

  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 48, minHeight: '100%',
    zIndex: 1,
  },
  cardWrap: { width: '100%', maxWidth: 448 },

  card: {
    borderRadius: 28, paddingHorizontal: 36, paddingTop: 36, paddingBottom: 32,
    width: '100%',
  },

  /* Icon with glow */
  iconRow: { alignItems: 'center', marginBottom: 16 },
  iconWrap: { alignItems: 'center', justifyContent: 'center' },
  iconGlow: {
    position: 'absolute', width: 72, height: 72, borderRadius: 36,
  },
  iconCircle: {
    width: 52, height: 52, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },

  /* Title */
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center', marginBottom: 4, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 4, lineHeight: 20 },

  /* Progress */
  progressSection: { marginBottom: 24, marginTop: 8 },
  progressRow: { flexDirection: 'row', gap: 4 },
  progressSegmentWrap: { flex: 1 },
  progressSegment: { height: 4, borderRadius: 2 },
  stepLabelsRow: { flexDirection: 'row', marginTop: 6 },
  stepLabel: { flex: 1, fontSize: 9, textAlign: 'center', letterSpacing: 0.2 },

  /* Footer */
  footer: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 24, paddingHorizontal: 8,
  },
  footerLinks: { flexDirection: 'row', alignItems: 'center' },
  footerItem: { fontSize: 12 },
  footerDot: { fontSize: 12 },
});
