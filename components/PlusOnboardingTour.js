/**
 * PlusOnboardingTour — primeira vez que o app detecta plan='one'/'plus',
 * mostra um tour visual rápido das features desbloqueadas. Roda 1 vez por
 * conta (flag em AsyncStorage), e o user pode dispensar a qualquer momento.
 *
 * Trigger: chat.js (home Chatyy) chama a probe `usePlusOnboardingProbe()`
 * que detecta `plan='one'` + `!seen` e abre o modal.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Modal, Animated, Dimensions, StyleSheet, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';
import { IconPhone, IconSparkles, IconVideo, IconStar, IconShield, IconArrowLeft } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import PressableScale from './PressableScale';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { PLANS_ENABLED } from '../constants/featureFlags';

const { width: SCREEN_W } = Dimensions.get('window');
const SEEN_KEY = 'plus_onboarding_seen_v1';

const SLIDES = [
  { Icon: IconPhone,    color: '#25D366', titleKey: 'plusTour.callsTitle',  bodyKey: 'plusTour.callsDesc' },
  { Icon: IconSparkles, color: '#8B5CF6', titleKey: 'plusTour.aiTitle',     bodyKey: 'plusTour.aiDesc' },
  { Icon: IconVideo,    color: '#EC4899', titleKey: 'plusTour.reelsTitle',  bodyKey: 'plusTour.reelsDesc' },
  { Icon: IconStar,     color: '#f59e0b', titleKey: 'plusTour.vipTitle',    bodyKey: 'plusTour.vipDesc' },
  { Icon: IconShield,   color: '#10b981', titleKey: 'plusTour.backupTitle', bodyKey: 'plusTour.backupDesc' },
];

export async function checkShouldShowPlusOnboarding() {
  // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
  // Tour celebrates a paid-plan upgrade; with plans hidden there is no
  // such upgrade so always skip. Kept short-circuit here so callers don't
  // need to know about the flag.
  if (!PLANS_ENABLED) return false;
  try {
    const seen = await AsyncStorage.getItem(SEEN_KEY);
    if (seen === '1') return false;
    const r = await api.planInfo?.();
    const plan = String(r?.data?.plan || '').toLowerCase();
    return plan === 'one' || plan === 'plus' || plan === 'business';
  } catch { return false; }
}

export function markPlusOnboardingSeen() {
  AsyncStorage.setItem(SEEN_KEY, '1').catch(() => {});
}

export default function PlusOnboardingTour({ visible, onClose, colors, isDark }) {
  const { t } = useLanguage();
  const [idx, setIdx] = useState(0);
  const slide = SLIDES[idx] || SLIDES[0];
  const { Icon } = slide;
  const fade = useRef(new Animated.Value(0)).current;
  // slideIn: cada troca de slide entra com um leve deslize vertical + fade,
  // dando a sensação viva/premium (em vez de só trocar o conteúdo).
  const slideIn = useRef(new Animated.Value(0)).current;
  const next = useCallback(() => {
    if (idx < SLIDES.length - 1) setIdx(idx + 1);
    else { markPlusOnboardingSeen(); onClose?.(); }
  }, [idx, onClose]);
  const prev = useCallback(() => { if (idx > 0) setIdx(idx - 1); }, [idx]);
  useEffect(() => {
    if (!visible) { setIdx(0); return; }
    fade.setValue(0);
    slideIn.setValue(14);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(slideIn, { toValue: 0, tension: 180, friction: 18, useNativeDriver: true }),
    ]).start();
  }, [visible, idx, fade, slideIn]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { markPlusOnboardingSeen(); onClose?.(); }}>
      <View style={[styles.backdrop, { backgroundColor: isDark ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.65)' }]}>
        <Animated.View style={[styles.card, { backgroundColor: colors.surface || '#fff', opacity: fade }]}>
          {/* Hero header com cor do slide atual */}
          <View style={[styles.hero, { backgroundColor: slide.color + '14' }]}>
            <View style={[styles.iconBubble, { backgroundColor: slide.color }]}>
              <Icon size={34} color="#fff" />
            </View>
          </View>

          <View style={styles.content}>
            <Animated.View style={{ opacity: fade, transform: [{ translateY: slideIn }] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 1.5, color: slide.color }}>{t('plusTour.badge')}</Text>
              </View>
              <Text style={[styles.title, { color: colors.text || '#000' }]}>{t(slide.titleKey)}</Text>
              <Text style={[styles.body, { color: colors.textSecondary || '#666' }]}>{t(slide.bodyKey)}</Text>
            </Animated.View>

            {/* Dots indicator */}
            <View style={styles.dots}>
              {SLIDES.map((_, i) => (
                <View key={i} style={[styles.dot, {
                  backgroundColor: i === idx ? slide.color : (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)'),
                  width: i === idx ? 22 : 6,
                }]} />
              ))}
            </View>

            {/* Actions */}
            <View style={styles.actions}>
              {idx > 0
                ? <TouchableOpacity onPress={prev} style={styles.backBtn} accessibilityRole="button"><IconArrowLeft size={20} color={colors.text || '#000'} /></TouchableOpacity>
                : <View style={{ width: 44 }} />}
              <PressableScale
                onPress={next}
                activeOpacity={0.9}
                haptic="light"
                style={[styles.nextBtn, { backgroundColor: slide.color }]}
                accessibilityRole="button"
              >
                <Text style={styles.nextLabel}>{idx === SLIDES.length - 1 ? t('plusTour.start') : t('plusTour.next')}</Text>
              </PressableScale>
              <TouchableOpacity onPress={() => { markPlusOnboardingSeen(); onClose?.(); }} accessibilityRole="button">
                <Text style={[styles.skipLabel, { color: colors.textTertiary || '#999' }]}>{t('plusTour.skip')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: Math.min(SCREEN_W - 32, 420),
    borderRadius: 24,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.25, shadowRadius: 30 },
      android: { elevation: 14 },
      web: { boxShadow: '0 18px 40px rgba(0,0,0,0.25)' },
    }),
  },
  hero: { paddingVertical: 36, alignItems: 'center', justifyContent: 'center' },
  iconBubble: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.18, shadowRadius: 12 },
      android: { elevation: 6 },
    }),
  },
  content: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 22 },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 22 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 22 },
  dot: { height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  backBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  nextBtn: { flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  nextLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
  skipLabel: { fontSize: 13, fontWeight: '500', paddingHorizontal: 6 },
});
