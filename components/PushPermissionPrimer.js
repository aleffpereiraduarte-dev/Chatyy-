// [2026-10-07 native-polish] Push pre-permission sheet (gap P0-6).
//
// Shown (once, with backoff on "Agora não") the first time a chat is opened
// while the push permission is still undetermined — see services/pushPrimer.js.
// "Ativar" → OS dialog (services/pushNotifications.enablePushFromPrimer).
// Native only; renders null on web. No emoji (SVG icon only).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconBell } from './Icons';
import { subscribePushPrimer, pushPrimerClosed } from '../services/pushPrimer';

function tr(t, key, fallback) {
  try {
    const v = t?.(key);
    if (v && v !== key) return v;
  } catch {}
  return fallback;
}

export default function PushPermissionPrimer() {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef('');
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    return subscribePushPrimer((evt) => {
      if (evt?.type !== 'show') return;
      reasonRef.current = evt.reason || '';
      // Let the screen that triggered it (chat open) finish its transition.
      setTimeout(() => {
        setVisible(true);
        try { require('../services/pushNotifications').diagPushPrimer('primer_shown', reasonRef.current); } catch {}
      }, 900);
    });
  }, []);

  useEffect(() => {
    if (!visible) return;
    slide.setValue(0);
    Animated.timing(slide, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [visible, slide]);

  const close = useCallback((accepted) => {
    setVisible(false);
    pushPrimerClosed(accepted);
  }, []);

  const onEnable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    // Close our sheet BEFORE the OS dialog so the two never stack.
    close(true);
    try {
      const { enablePushFromPrimer } = require('../services/pushNotifications');
      await enablePushFromPrimer();
    } catch {}
    setBusy(false);
  }, [busy, close]);

  const onLater = useCallback(() => {
    try { require('../services/pushNotifications').diagPushPrimer('primer_later', reasonRef.current); } catch {}
    close(false);
  }, [close]);

  if (Platform.OS === 'web' || !visible) return null;

  const bg = isDark ? '#1c1c1e' : '#ffffff';
  const fg = isDark ? '#F5F5F7' : '#111b21';
  const sub = isDark ? '#8E8E93' : '#667781';
  const ctaBg = isDark ? '#ffffff' : '#111111';
  const ctaFg = isDark ? '#111111' : '#ffffff';
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onLater}>
      <Pressable style={s.backdrop} onPress={onLater} accessibilityLabel={tr(t, 'pushPrimer.later', 'Agora não')}>
        <Animated.View
          style={[s.sheet, { backgroundColor: bg, paddingBottom: 20 + (insets?.bottom || 0), transform: [{ translateY }] }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={[s.iconWrap, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.06)' }]}>
            <IconBell size={40} color={fg} />
          </View>
          <Text style={[s.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.6}>
            {tr(t, 'pushPrimer.title', 'Ative as notificações')}
          </Text>
          <Text style={[s.body, { color: sub }]} maxFontSizeMultiplier={1.6}>
            {tr(t, 'pushPrimer.body', 'Receba mensagens e chamadas mesmo com o Chatyy fechado, e deixe quem te escreve saber que a mensagem chegou.')}
          </Text>
          <Pressable
            onPress={onEnable}
            style={({ pressed }) => [s.cta, { backgroundColor: ctaBg, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={tr(t, 'pushPrimer.enable', 'Ativar notificações')}
          >
            <Text style={[s.ctaText, { color: ctaFg }]} maxFontSizeMultiplier={1.4}>
              {tr(t, 'pushPrimer.enable', 'Ativar notificações')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onLater}
            style={s.later}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[s.laterText, { color: sub }]} maxFontSizeMultiplier={1.4}>
              {tr(t, 'pushPrimer.later', 'Agora não')}
            </Text>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 28, paddingHorizontal: 24, alignItems: 'center',
  },
  iconWrap: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 22, maxWidth: 340 },
  cta: { alignSelf: 'stretch', minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: 16, fontWeight: '700' },
  later: { marginTop: 10, minHeight: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  laterText: { fontSize: 15, fontWeight: '600' },
});
