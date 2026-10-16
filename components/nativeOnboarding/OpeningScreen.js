// [2026-10-16 onb-opening] Substitui o "spinner + Abrindo seu Chatyy…" em tela
// branca do fim do cadastro/entrada (passo 'finishing').
//
// POR QUE essa tela existe: depois do código/conta criada o fluxo ainda decide
// (a) quais permissões pedir (local, instantâneo) e (b) se há algo p/ restaurar
// (backup E2E no servidor, backup CYB2/iCloud/Drive, histórico completo) —
// probeRestore() faz chamadas de rede com timeout. Só depois disso vai p/ /chat.
//
// Agora: pinta o ESQUELETO da tela que vai abrir (lista de conversas: título,
// busca, filtros, linhas com shimmer — o mesmo ChatListSkeleton da lista real,
// então a troca p/ /chat — que já entra com fade — não "pula"), uma marca
// pequena respirando e, só se passar de 2,5 s, um status honesto conforme o
// estado real (rede/sondagem). Sem internet → "Tentar novamente"; demorou → "Abrir
// agora" (pula a sondagem de restauração; dá p/ restaurar depois em Ajustes).
// Não pinta conversas do cache aqui de propósito: a conta acabou de autenticar
// neste instante e o cache local é por conta — quem pinta do cache é a própria
// lista (/chat), já com a conta certa carregada.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, Easing, StyleSheet, Platform } from 'react-native';
import { Shimmer, ChatListSkeleton } from '../SkeletonLoader';
import BrandHero from './BrandHero';

const STATUS_AFTER_MS = 2500;
const OPEN_NOW_AFTER_MS = 7000;

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let unsub = null;
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      const apply = (s) => {
        if (!s) return;
        const off = s.isConnected === false || s.isInternetReachable === false;
        setOnline(!off);
      };
      NetInfo.fetch().then(apply).catch(() => {});
      unsub = NetInfo.addEventListener(apply);
    } catch {}
    return () => { try { unsub && unsub(); } catch {} };
  }, []);
  return online;
}

export default function OpeningScreen({
  colors, T, reduced = false, topPad = 44, bottomPad = 24,
  phase = 'probe', // 'perm' | 'probe' | 'modal'
  onRetry, onOpenNow,
}) {
  const fg = colors.text;
  const sub = colors.textSecondary;
  const online = useOnline();
  const [elapsed, setElapsed] = useState(0);
  const fadeIn = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const statusIn = useRef(new Animated.Value(0)).current;

  // Entra suave (atrasado 120 ms: se a decisão for instantânea, nem aparece).
  useEffect(() => {
    if (reduced) return undefined;
    const a = Animated.timing(fadeIn, { toValue: 1, duration: 220, delay: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [reduced, fadeIn]);

  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, []);

  const showStatus = phase !== 'modal' && (elapsed >= STATUS_AFTER_MS || !online);
  useEffect(() => {
    if (!showStatus) return;
    if (reduced) { statusIn.setValue(1); return; }
    Animated.timing(statusIn, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [showStatus, reduced, statusIn]);

  let status = '';
  if (!online) status = T('nob.boot.offline', 'Sem internet. Continuamos assim que a conexão voltar.');
  else if (phase === 'perm') status = T('nob.boot.preparing', 'Preparando suas conversas…');
  else status = T('nob.boot.backup', 'Procurando backup das suas conversas…');
  const showOpenNow = phase !== 'modal' && (elapsed >= OPEN_NOW_AFTER_MS || !online);
  const chip = (label, i) => (
    <View key={i} style={[st.chip, { borderColor: colors.border }]}>
      <Text style={[st.chipText, { color: sub }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{label}</Text>
    </View>
  );

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, opacity: fadeIn }]}
      accessibilityLabel={T('signupPhone.redirecting', 'Abrindo seu Chatyy…')}
      testID="nob-opening"
    >
      {/* esqueleto da lista de conversas (a tela que vai abrir) */}
      <View style={{ flex: 1, paddingTop: topPad }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none">
        <View style={st.header}>
          <Text style={[st.title, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{T('chat.tabChats', 'Conversas')}</Text>
          <Shimmer style={{ width: 34, height: 34, borderRadius: 17 }} />
        </View>
        <Shimmer style={st.search} delay={30} />
        <View style={st.chips}>
          {[T('chat.filterAll', 'Todas'), T('chat.filterUnread', 'Não lidas'), T('chat.filterGroups', 'Grupos')].map(chip)}
        </View>
        <View style={{ flex: 1, overflow: 'hidden' }}>
          <ChatListSkeleton count={9} />
        </View>
      </View>

      {/* marca respirando + status (só se demorar) */}
      <View style={[st.dock, { paddingBottom: bottomPad }]} pointerEvents="box-none">
        <View style={[st.card, { backgroundColor: colors.background, borderColor: showStatus ? colors.border : 'transparent' }]}>
          <View style={st.brand} pointerEvents="none">
            <BrandHero size={26} fg={fg} bg={colors.background} reduced={reduced} />
          </View>
          {showStatus ? (
            <Animated.View style={{ alignItems: 'center', opacity: statusIn, transform: [{ translateY: statusIn.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
              <Text style={[st.status, { color: sub }]} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.4} testID="nob-opening-status">{status}</Text>
              {(!online || showOpenNow) ? (
                <View style={st.actions}>
                  {!online && onRetry ? (
                    <Pressable onPress={onRetry} style={({ pressed }) => [st.btn, { backgroundColor: fg, opacity: pressed ? 0.85 : 1 }]} accessibilityRole="button" testID="nob-opening-retry">
                      <Text style={[st.btnText, { color: colors.background }]} maxFontSizeMultiplier={1.3}>{T('common.tryAgain', 'Tentar novamente')}</Text>
                    </Pressable>
                  ) : null}
                  {showOpenNow && onOpenNow ? (
                    <Pressable onPress={onOpenNow} style={({ pressed }) => [st.btn, { borderWidth: 1.5, borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]} accessibilityRole="button" testID="nob-opening-open-now">
                      <Text style={[st.btnText, { color: fg }]} maxFontSizeMultiplier={1.3}>{T('nob.boot.openNow', 'Abrir agora')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </Animated.View>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 52 },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.6, flexShrink: 1 },
  search: { height: 38, borderRadius: 12, marginHorizontal: 16, marginTop: 6 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
  chip: { paddingHorizontal: 14, height: 32, borderRadius: 16, borderWidth: 1, justifyContent: 'center' },
  chipText: { fontSize: 14, fontWeight: '600' },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: 20 },
  card: {
    alignItems: 'center', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingVertical: 10, maxWidth: 420,
    ...(Platform.OS === 'web' ? {} : { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } }),
  },
  brand: { width: 50, height: 50, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  status: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 2, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 2, justifyContent: 'center', flexWrap: 'wrap' },
  btn: { height: 40, paddingHorizontal: 18, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 14, fontWeight: '700' },
});
