// [2026-10-18 onb-telegram] Boas-vindas estilo Telegram (P&B premium):
// marca animada no topo que "se transforma" conforme o cartão (mensagens →
// chamadas → e-mail → nuvem) + 4 cartões deslizáveis com texto curto + pontos.
// Tudo dirigido pelo scroll (Animated.event, useNativeDriver → UI thread).
// Sem emoji: ícones SVG (components/Icons). Visual apenas — o botão "Começar"
// e os termos ficam no rodapé do NativeOnboardingFlow (mesma lógica de antes).
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, Animated, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import BrandHero from './BrandHero';
import { IconPhone, IconMail, IconCloud } from '../Icons';

const OVERLAY_ICONS = [null, IconPhone, IconMail, IconCloud];

export default function WelcomeIntro({ fg, bg, sub, reduced, T, onIndexChange }) {
  const { width: winW, height: winH } = useWindowDimensions();
  const [pageW, setPageW] = useState(Math.min(winW, 520));
  const [index, setIndex] = useState(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef(null);

  const cards = useMemo(() => [
    { title: T('nob.intro.t1', 'Chatyy'), body: T('nob.intro.b1', 'Mensagens rápidas e privadas, com fotos, vídeos e áudios — em todos os seus aparelhos.') },
    { title: T('nob.intro.t2', 'Chamadas'), body: T('nob.intro.b2', 'Ligações de voz e vídeo nítidas, a dois ou em grupo, sem custo.') },
    { title: T('nob.intro.t3', 'E-mail'), body: T('nob.intro.b3', 'Seu endereço @chatyy.com.br de presente, junto das suas conversas.') },
    { title: T('nob.intro.t4', 'Nuvem'), body: T('nob.intro.b4', 'Fotos e arquivos guardados com segurança, prontos em qualquer lugar.') },
  ], [T]);

  const heroSize = Math.round(Math.max(76, Math.min(112, winW * 0.28, winH * 0.14)));
  const box = heroSize * 1.9;
  const W = Math.max(1, pageW);

  const indexRef = useRef(0);
  const settle = useCallback((x) => {
    const i = Math.max(0, Math.min(cards.length - 1, Math.round(x / W)));
    if (i !== indexRef.current) { indexRef.current = i; setIndex(i); try { onIndexChange?.(i); } catch {} }
  }, [W, cards.length, onIndexChange]);

  // Nativo: scroll → Animated na UI thread. Web: sem driver nativo e sem
  // onMomentumScrollEnd confiável com scroll-snap → acompanha pelo listener.
  const onScroll = useMemo(() => Animated.event(
    [{ nativeEvent: { contentOffset: { x: scrollX } } }],
    Platform.OS === 'web'
      ? { useNativeDriver: false, listener: (e) => settle(e.nativeEvent.contentOffset.x) }
      : { useNativeDriver: true },
  ), [scrollX, settle]);

  const goTo = useCallback((i) => {
    try { scrollRef.current?.scrollTo?.({ x: i * W, animated: !reduced }); } catch {}
    if (Platform.OS === 'web' || reduced) settle(i * W);
  }, [W, reduced, settle]);

  // Marca: a 1a página mostra o BrandHero (balão digitando); as outras trocam
  // por um squircle com o ícone da página (cross-fade + leve escala).
  const brandOpacity = scrollX.interpolate({ inputRange: [0, W * 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const brandScale = scrollX.interpolate({ inputRange: [0, W], outputRange: [1, 0.86], extrapolate: 'clamp' });

  return (
    <View style={st.wrap}>
      <View style={[st.heroArea, { height: box }]}>
        <Animated.View style={{ opacity: brandOpacity, transform: [{ scale: brandScale }] }}>
          <BrandHero size={heroSize} fg={fg} bg={bg} reduced={reduced} />
        </Animated.View>
        {OVERLAY_ICONS.map((Ico, i) => {
          if (!Ico) return null;
          const range = [(i - 1) * W, i * W, (i + 1) * W];
          const op = scrollX.interpolate({ inputRange: range, outputRange: [0, 1, 0], extrapolate: 'clamp' });
          const sc = scrollX.interpolate({ inputRange: range, outputRange: [0.82, 1, 0.82], extrapolate: 'clamp' });
          const rot = scrollX.interpolate({ inputRange: range, outputRange: ['-8deg', '0deg', '8deg'], extrapolate: 'clamp' });
          return (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={[st.overlay, { opacity: op, transform: [{ scale: sc }, { rotate: rot }] }]}
            >
              <View style={{ width: heroSize, height: heroSize, borderRadius: heroSize * 0.29, backgroundColor: fg, alignItems: 'center', justifyContent: 'center' }}>
                <Ico size={Math.round(heroSize * 0.44)} color={bg} />
              </View>
            </Animated.View>
          );
        })}
      </View>

      <View style={{ width: '100%', height: Math.round(Math.min(190, Math.max(150, winH * 0.2))) }} onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w && w !== pageW) setPageW(w); }}>
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.x)}
          decelerationRate="fast"
          testID="nob-intro"
        >
          {cards.map((cd, i) => (
            <View key={i} style={[st.card, { width: W }]} accessible accessibilityLabel={`${cd.title}. ${cd.body}`}>
              <Text
                style={[st.title, { color: fg }]}
                accessibilityRole="header"
                maxFontSizeMultiplier={1.3}
                testID={i === 0 ? 'nob-welcome-title' : undefined}
              >{cd.title}</Text>
              <Text style={[st.body, { color: sub }]} maxFontSizeMultiplier={1.4}>{cd.body}</Text>
            </View>
          ))}
        </Animated.ScrollView>
      </View>

      <View style={st.dots} accessibilityRole="adjustable" accessibilityLabel={T('nob.intro.page', `Página ${index + 1} de ${cards.length}`, { n: index + 1, total: cards.length })}>
        {cards.map((_, i) => {
          const range = [(i - 1) * W, i * W, (i + 1) * W];
          const op = scrollX.interpolate({ inputRange: range, outputRange: [0.28, 1, 0.28], extrapolate: 'clamp' });
          const sx = scrollX.interpolate({ inputRange: range, outputRange: [1, 2.6, 1], extrapolate: 'clamp' });
          return (
            <Pressable key={i} onPress={() => goTo(i)} hitSlop={8} style={st.dotHit} accessibilityRole="button" testID={`nob-intro-dot-${i}`}>
              <Animated.View style={[st.dot, { backgroundColor: fg, opacity: op, transform: [{ scaleX: sx }] }]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', paddingBottom: 12 },
  heroArea: { alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  card: { paddingHorizontal: 32, paddingTop: 10, alignItems: 'center' },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 10, maxWidth: 360 },
  dots: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 4, height: 28, marginBottom: 8 },
  dotHit: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
