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

const { width: SCREEN_W } = Dimensions.get('window');
const SEEN_KEY = 'plus_onboarding_seen_v1';

const SLIDES = [
  { Icon: IconPhone,    color: '#7C3AED', title: 'Chamadas ilimitadas',   body: 'Áudio e vídeo, Chatyy↔Chatyy ou pra qualquer telefone — sem cap de minutos.' },
  { Icon: IconSparkles, color: '#A78BFA', title: 'IA prioritária',         body: 'Smart reply, resumo de conversa, transcrição de áudio sem limite. Tudo via Groq.' },
  { Icon: IconVideo,    color: '#a855f7', title: 'Reels e vídeo HD',       body: 'Upload em 1080p, sem compressão agressiva. Sua arte sai bonita.' },
  { Icon: IconStar,     color: '#f59e0b', title: 'Modo invisível e VIP',   body: 'Mensagens efêmeras, anel dourado no perfil, badge verificado, prioridade no support.' },
  { Icon: IconShield,   color: '#10b981', title: 'Backup ilimitado',       body: 'Suas conversas e mídia salvos com criptografia. Restaure em qualquer aparelho.' },
];

export async function checkShouldShowPlusOnboarding() {
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
  const [idx, setIdx] = useState(0);
  const slide = SLIDES[idx] || SLIDES[0];
  const { Icon } = slide;
  const fade = useRef(new Animated.Value(0)).current;
  const next = useCallback(() => {
    if (idx < SLIDES.length - 1) setIdx(idx + 1);
    else { markPlusOnboardingSeen(); onClose?.(); }
  }, [idx, onClose]);
  const prev = useCallback(() => { if (idx > 0) setIdx(idx - 1); }, [idx]);
  useEffect(() => {
    if (!visible) { setIdx(0); return; }
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [visible, idx, fade]);

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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 1.5, color: slide.color }}>CHATYY ONE</Text>
            </View>
            <Text style={[styles.title, { color: colors.text || '#000' }]}>{slide.title}</Text>
            <Text style={[styles.body, { color: colors.textSecondary || '#666' }]}>{slide.body}</Text>

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
                ? <TouchableOpacity onPress={prev} style={styles.backBtn}><IconArrowLeft size={20} color={colors.text || '#000'} /></TouchableOpacity>
                : <View style={{ width: 44 }} />}
              <TouchableOpacity
                onPress={next}
                activeOpacity={0.85}
                style={[styles.nextBtn, { backgroundColor: slide.color }]}
              >
                <Text style={styles.nextLabel}>{idx === SLIDES.length - 1 ? 'Vamos lá' : 'Continuar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { markPlusOnboardingSeen(); onClose?.(); }}>
                <Text style={[styles.skipLabel, { color: colors.textTertiary || '#999' }]}>Pular</Text>
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
