// [guest-reels 2026-10-22] "Entre ou crie sua conta" — folha do Reels sem login.
// NÃO é <Modal>: é uma camada absoluta dentro do próprio ReelsViewer (evita Modal sobre Modal
// no iOS quando ela abre a partir do compartilhar/comentários). Desce com toque fora, "Agora não"
// ou o botão voltar do Android (o pai trata onClose).
import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle } from 'react-native-svg';

const isWeb = Platform.OS === 'web';

function KindGlyph({ kind, size = 30, color = '#fff' }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (kind) {
    case 'like':
      return <Svg {...p}><Path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" /></Svg>;
    case 'comment':
      return <Svg {...p}><Path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z" /></Svg>;
    case 'follow': case 'profile':
      return <Svg {...p}><Circle cx="9" cy="8" r="4" /><Path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1" /><Path d="M19 8v6M16 11h6" /></Svg>;
    case 'save':
      return <Svg {...p}><Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></Svg>;
    case 'send':
      return <Svg {...p}><Path d="M22 2L11 13" /><Path d="M22 2l-7 20-4-9-9-4z" /></Svg>;
    default:
      return <Svg {...p}><Path d="M8 5v14l11-7z" /></Svg>;
  }
}

export default function GuestAuthSheet({ visible, kind = 'generic', t, onLogin, onSignup, onClose }) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(!!visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: !isWeb }).start();
    } else if (mounted) {
      Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: !isWeb }).start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mounted) return null;
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const bodyKey = ['like', 'comment', 'follow', 'save', 'send', 'profile', 'report', 'sound'].includes(kind) ? kind : 'generic';
  const BODY_FB = {
    like: 'Curta os reels que você ama — o Chatyy aprende o que mostrar para você.',
    comment: 'Entre para comentar e conversar com quem criou.',
    follow: 'Siga criadores para ver tudo o que eles publicarem.',
    save: 'Salve reels para assistir de novo quando quiser.',
    send: 'Envie reels para seus amigos direto no chat.',
    profile: 'Entre para ver o perfil completo.',
    report: 'Entre para denunciar este conteúdo.',
    sound: 'Entre para usar este som nos seus reels.',
    generic: 'Curta, comente, siga e envie reels para os amigos.',
  };
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [360, 0] });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'} accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={tr('guestReels.notNow', 'Agora não')} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8, transform: [{ translateY }] }]}>
        <View style={styles.grabber} />
        <View style={styles.glyphWrap}><KindGlyph kind={kind} /></View>
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.4}>{tr('guestReels.authTitle', 'Entre ou crie sua conta')}</Text>
        <Text style={styles.body} maxFontSizeMultiplier={1.5}>{tr(`guestReels.auth.${bodyKey}`, BODY_FB[bodyKey])}</Text>
        <Pressable onPress={onLogin} style={({ pressed }) => [styles.primary, { opacity: pressed ? 0.85 : 1 }]} accessibilityRole="button">
          <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>{tr('guestReels.login', 'Entrar')}</Text>
        </Pressable>
        <Pressable onPress={onSignup} style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.7 : 1 }]} accessibilityRole="button">
          <Text style={styles.secondaryText} maxFontSizeMultiplier={1.3}>{tr('guestReels.signup', 'Criar conta')}</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={8} style={styles.ghost} accessibilityRole="button">
          <Text style={styles.ghostText} maxFontSizeMultiplier={1.3}>{tr('guestReels.notNow', 'Agora não')}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#141414', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 24, paddingTop: 10, alignItems: 'center',
    alignSelf: 'center', width: '100%', maxWidth: 520,
    ...(isWeb ? { marginHorizontal: 'auto' } : null),
  },
  grabber: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 18 },
  glyphWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { color: '#fff', fontSize: 21, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.66)', fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, marginBottom: 20, maxWidth: 340 },
  primary: { alignSelf: 'stretch', minHeight: 50, borderRadius: 25, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '700' },
  secondary: { alignSelf: 'stretch', minHeight: 50, borderRadius: 25, marginTop: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6, paddingHorizontal: 16 },
  ghostText: { color: 'rgba(255,255,255,0.6)', fontSize: 15, fontWeight: '600' },
});
