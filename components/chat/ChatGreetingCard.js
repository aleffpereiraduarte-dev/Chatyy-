// components/chat/ChatGreetingCard.js — [2026-10-16 mascote] Estado vazio da
// conversa (1:1 e grupo): cartão translúcido sobre o papel de parede com o
// mascote do Chatyy acenando. Tocar no mascote → haptic + o cartão sai com
// animação + envia a figurinha animada de saudação (lottie_sticker, cmid
// normal pela fila de envio — quem envia é o chamador via onGreet()).
//
// Variações: `offline` (sem internet: mascote "sem sinal", sem toque) e
// `canSend=false` (canal/grupo só-admin/bloqueado: só o texto, sem convite).
// Reduzir movimento → mascote estático e sem escala na entrada/saída.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, Easing, Platform, StyleSheet } from 'react-native';
import ChatyyMascot from '../mascot/ChatyyMascot';
import { useReducedMotion, isReduceMotionEnabled } from '../reducedMotion';
import { IconLock } from '../Icons';
import { THEME_V2 as _THEME_V2, grafite as _grafite } from '../../constants/theme';

const ND = Platform.OS !== 'web';

// [2026-10-18 polish2] helper central (Core Haptics + pref "Vibração ao tocar"), não expo-haptics direto.
let Haptics = null;
try { Haptics = require('../../services/haptics').HapticsCompat; } catch {}

function ChatGreetingCard({ isDark, t, onGreet, canSend = true, offline = false, e2e = false }) {
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const reduce = useReducedMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const out = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (isReduceMotionEnabled()) { enter.setValue(1); return; }
    Animated.spring(enter, { toValue: 1, friction: 8, tension: 70, useNativeDriver: ND }).start();
  }, [enter]);

  const interactive = canSend && !offline && typeof onGreet === 'function';

  const onPress = () => {
    if (!interactive || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle?.Medium); } catch {}
    const go = () => {
      Promise.resolve().then(() => onGreet()).catch(() => {
        // falhou antes de entrar na fila → volta o cartão
        busyRef.current = false; setBusy(false); out.setValue(0);
      });
    };
    if (reduce) { out.setValue(1); go(); return; }
    Animated.timing(out, { toValue: 1, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(go);
  };

  const pressIn = () => { if (interactive && !reduce) Animated.spring(press, { toValue: 0.92, friction: 6, tension: 260, useNativeDriver: ND }).start(); };
  const pressOut = () => { if (!reduce) Animated.spring(press, { toValue: 1, friction: 4, tension: 160, useNativeDriver: ND }).start(); };

  const title = offline
    ? tr('mascot.offlineTitle', 'Sem internet')
    : tr('mascot.emptyConvTitle', 'Nenhuma mensagem ainda');
  const sub = offline
    ? tr('mascot.offlineSub', 'As mensagens aparecem assim que a conexão voltar.')
    : interactive
      ? tr('mascot.emptyConvSub', 'Envie uma mensagem ou toque no aceno abaixo')
      : tr('chatConv.empty', 'Envie uma mensagem para iniciar a conversa.');

  // [2026-10-21 polish-conv] Grafite: cartão/linha/texto da paleta (eram cinzas iOS).
  const _g = _THEME_V2 ? _grafite(isDark) : null;
  const cardBg = _g ? (isDark ? 'rgba(26,26,29,0.82)' : 'rgba(255,255,255,0.82)') : (isDark ? 'rgba(28,28,30,0.78)' : 'rgba(255,255,255,0.80)');
  const border = _g ? _g.line : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.06)');
  const fg = _g ? _g.text : (isDark ? '#F5F5F7' : '#111111');
  const fg2 = _g ? _g.text2 : (isDark ? 'rgba(245,245,247,0.66)' : 'rgba(17,17,17,0.62)');

  const cardStyle = {
    opacity: Animated.multiply(enter, out.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })),
    transform: reduce ? [] : [
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
      { scale: out.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] }) },
    ],
  };

  return (
    <Animated.View style={[st.card, { backgroundColor: cardBg, borderColor: border }, Platform.OS === 'web' ? { backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } : null, cardStyle]}>
      <Text style={[st.title, { color: fg }]} accessibilityRole="header">{title}</Text>
      <Text style={[st.sub, { color: fg2 }]}>{sub}</Text>
      <Pressable
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        disabled={!interactive || busy}
        hitSlop={8}
        accessibilityRole={interactive ? 'button' : undefined}
        accessibilityLabel={interactive ? tr('mascot.tapToWave', 'Enviar um aceno') : undefined}
        style={st.mascotBtn}
      >
        <Animated.View style={{ transform: [{ scale: press }] }}>
          <ChatyyMascot pose={offline ? 'offline' : 'wave'} size={138} dark={isDark} />
        </Animated.View>
      </Pressable>
      {e2e && !offline ? (
        <View style={st.e2eRow}>
          <IconLock size={11} color={fg2} />
          <Text style={[st.e2eText, { color: fg2 }]} numberOfLines={2}>{tr('chatConv.e2eEmptyTitle', 'Conversa protegida')}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

export default React.memo(ChatGreetingCard);

const st = StyleSheet.create({
  card: {
    alignSelf: 'center', width: '78%', maxWidth: 300, minWidth: 240,
    borderRadius: 24, borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 20, paddingBottom: 14, paddingHorizontal: 20, alignItems: 'center',
  },
  title: { fontSize: 16.5, fontWeight: '700', textAlign: 'center', letterSpacing: -0.2 },
  sub: { fontSize: 13.5, lineHeight: 19, textAlign: 'center', marginTop: 6 },
  mascotBtn: { marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  e2eRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  e2eText: { fontSize: 11.5, fontWeight: '600' },
});
