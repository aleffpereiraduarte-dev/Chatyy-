// [2026-10-18 onb-telegram] Boas-vindas estilo Telegram (P&B premium).
// [2026-10-24 intro-v2] Carrossel novo: ilustração SVG própria por página
// (IntroArt — ícone real do app na 1ª), paralaxe + cross-fade dirigidos pelo
// scroll (Animated.event, useNativeDriver → UI thread), indicador "pílula que
// desliza", 5 páginas (Chatyy · Privacidade · Chamadas · E-mail · Nuvem),
// tamanhos que se ajustam a celular pequeno/tablet e à fonte do sistema.
// Visual apenas — o botão "Começar" e os termos ficam no rodapé do
// NativeOnboardingFlow (mesma lógica de antes). Sem Modal.
//
// RTL (ar/he/fa/ur): a geometria do pager fica SEMPRE LTR (direction: 'ltr')
// e o pager/indicador são espelhados (scaleX -1) — no web um ScrollView
// horizontal dentro de <html dir="rtl"> tinha scrollLeft negativo e os pontos
// levavam à página errada. Assim a página 1 fica à direita e o gesto segue o
// sentido de leitura, em web, iOS e Android.
//
// ⚠️ VERACIDADE (lojas): a página de privacidade mostra por padrão o texto
// verdadeiro HOJE para todos ("protegidas com criptografia" — TLS/QUIC+Noise
// em trânsito; E2EE v5 só para parte das contas). A frase forte de ponta a
// ponta (nob.intro.b5e2ee) só aparece com globalThis.__chatyy_intro_e2ee_claim
// === true — ligar (OTA) SÓ quando a E2EE estiver ligada por padrão para
// todos (E2EE5_PCT=100 e conversas novas sempre v5). Não é ligada pela flag
// por conta (__chatyy_e2ee5): a conversa só é E2EE se TODOS os membros
// estiverem liberados, então a frase seria falsa para parte das conversas.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Animated, Easing, Pressable, StyleSheet, Platform, I18nManager, useWindowDimensions, AccessibilityInfo } from 'react-native';
import IntroArt from './IntroArt';

const RTL_RE = /^(ar|he|fa|ur)(-|$)/i;

export function introE2eeClaimOn() {
  try { return globalThis.__chatyy_intro_e2ee_claim === true; } catch { return false; }
}

function readRTL() {
  if (Platform.OS === 'web') {
    try { return typeof document !== 'undefined' && document.documentElement.getAttribute('dir') === 'rtl'; } catch { return false; }
  }
  return !!I18nManager.isRTL;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export default function WelcomeIntro({ fg, bg, sub, reduced, T, onIndexChange, language }) {
  const { width: winW, height: winH, fontScale = 1 } = useWindowDimensions();
  const [pageW, setPageW] = useState(Math.min(winW, 560));
  const [index, setIndex] = useState(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef(null);
  const rtlDom = readRTL();
  const rtl = language ? RTL_RE.test(String(language)) || (Platform.OS !== 'web' && !!I18nManager.isRTL) : rtlDom;
  const strong = introE2eeClaimOn();

  // Chaves: t1/b1 Chatyy · t2/b2 chamadas · t3/b3 e-mail · t4/b4 nuvem (mesmo significado da v1 —
  // JS antigo + JSON remoto novo continuam batendo) · t5/b5/b5e2ee privacidade (nova).
  const cards = useMemo(() => [
    { art: 'chat', title: T('nob.intro.t1', 'Chatyy'), body: T('nob.intro.b1', 'Conversas rápidas com fotos, vídeos e áudios, em todos os seus aparelhos.') },
    {
      art: 'privacy',
      title: T('nob.intro.t5', 'Privacidade'),
      body: strong
        ? T('nob.intro.b5e2ee', 'Criptografia de ponta a ponta: só você e quem recebe podem ler suas conversas e fotos.')
        : T('nob.intro.b5', 'Suas conversas e fotos protegidas com criptografia.'),
    },
    { art: 'calls', title: T('nob.intro.t2', 'Chamadas'), body: T('nob.intro.b2', 'Ligações de voz e vídeo grátis, a dois ou em grupo.') },
    { art: 'mail', title: T('nob.intro.t3', 'E-mail'), body: T('nob.intro.b3', 'Um e-mail @chatyy.app grátis, junto das suas conversas.') },
    { art: 'cloud', title: T('nob.intro.t4', 'Nuvem'), body: T('nob.intro.b4', 'Fotos e arquivos guardados com segurança, prontos em qualquer lugar.') },
  ], [T, strong]);
  const N = cards.length;

  // Tamanhos: arte segue a altura (celular pequeno 320×568 → ~170) e a largura;
  // o texto cresce com a fonte do sistema (até 1,4×) sem cortar.
  const fs = clamp(fontScale, 1, 1.4);
  const small = winH < 640 || winW < 350;
  const artSize = Math.round(clamp(Math.min(winW * 0.74, winH * (small ? 0.3 : 0.36)), 150, 320));
  const titleSize = small ? 25 : (winW >= 700 ? 34 : 29);
  const bodySize = small ? 15 : (winW >= 700 ? 18 : 16.5);
  const textH = Math.round((titleSize * 1.2 + 10 + bodySize * 1.42 * (small ? 4 : 3.4)) * fs + 10);
  const W = Math.max(1, pageW);

  const indexRef = useRef(0);
  const settle = useCallback((x) => {
    const i = clamp(Math.round(x / W), 0, N - 1);
    if (i !== indexRef.current) {
      indexRef.current = i; setIndex(i);
      try { onIndexChange?.(i); } catch {}
    }
  }, [W, N, onIndexChange]);

  // Nativo: scroll → Animated na UI thread. Web: sem driver nativo e sem
  // onMomentumScrollEnd confiável com scroll-snap → acompanha pelo listener.
  const onScroll = useMemo(() => Animated.event(
    [{ nativeEvent: { contentOffset: { x: scrollX } } }],
    Platform.OS === 'web'
      ? { useNativeDriver: false, listener: (e) => settle(e.nativeEvent.contentOffset.x) }
      : { useNativeDriver: true },
  ), [scrollX, settle]);

  const goTo = useCallback((i) => {
    const k = clamp(i, 0, N - 1);
    try { scrollRef.current?.scrollTo?.({ x: k * W, animated: !reduced }); } catch {}
    if (Platform.OS === 'web' || reduced) settle(k * W);
  }, [W, N, reduced, settle]);

  // Largura mudou (rotação/tablet) → mantém a página atual.
  useEffect(() => {
    try { scrollRef.current?.scrollTo?.({ x: indexRef.current * W, animated: false }); } catch {}
  }, [W]);

  // Flutuação leve da arte (desligada com "reduzir movimento").
  useEffect(() => {
    if (reduced) { float.setValue(0); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(float, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
    ]));
    loop.start();
    return () => { try { loop.stop(); } catch {} };
  }, [reduced, float]);

  // Leitor de tela: anuncia a página nova (o pager em si é só deslizar).
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    try { AccessibilityInfo.announceForAccessibility?.(`${cards[index].title}. ${cards[index].body}`); } catch {}
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  const dir = rtl ? -1 : 1;
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });
  const pageLabel = T('nob.intro.page', `Página ${index + 1} de ${N}`, { n: index + 1, total: N });

  // Indicador: trilho de pontos + pílula que desliza (translateX = UI thread).
  const DOT = 7; const GAP = 16; const PILL = 24; const STEP = DOT + GAP;
  const trackW = N * DOT + (N - 1) * GAP;
  const pillX = scrollX.interpolate({
    inputRange: cards.map((_, i) => i * W),
    outputRange: cards.map((_, i) => i * STEP - (PILL - DOT) / 2),
    extrapolate: 'clamp',
  });

  return (
    <View style={st.wrap}>
      <Animated.View style={[st.heroArea, { height: artSize, transform: [{ translateY: floatY }] }]}>
        {cards.map((cd, i) => {
          const range = [(i - 1) * W, i * W, (i + 1) * W];
          const op = scrollX.interpolate({ inputRange: range, outputRange: [0, 1, 0], extrapolate: 'clamp' });
          const sc = scrollX.interpolate({ inputRange: range, outputRange: [0.86, 1, 0.86], extrapolate: 'clamp' });
          const tx = scrollX.interpolate({ inputRange: range, outputRange: [dir * W * 0.32, 0, -dir * W * 0.32], extrapolate: 'clamp' });
          return (
            <Animated.View
              key={cd.art}
              pointerEvents="none"
              style={[st.overlay, { opacity: op, transform: [{ translateX: tx }, { scale: sc }] }]}
            >
              <IntroArt kind={cd.art} size={artSize} fg={fg} bg={bg} />
            </Animated.View>
          );
        })}
      </Animated.View>

      <View
        style={[st.pagerBox, { height: textH }, rtl && st.mirror]}
        onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w && w !== pageW) setPageW(w); }}
      >
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.x)}
          decelerationRate="fast"
          style={st.ltr}
          contentContainerStyle={st.ltr}
          testID="nob-intro"
        >
          {cards.map((cd, i) => (
            <View
              key={cd.art}
              style={[st.card, { width: W }, rtl && st.mirror]}
              accessible
              accessibilityLabel={`${cd.title}. ${cd.body}`}
              importantForAccessibility={i === index ? 'yes' : 'no-hide-descendants'}
              accessibilityElementsHidden={i !== index}
              testID={`nob-intro-page-${i}`}
            >
              <Text
                style={[st.title, { color: fg, fontSize: titleSize, lineHeight: Math.round(titleSize * 1.2) }, rtl && st.rtlText]}
                accessibilityRole="header"
                maxFontSizeMultiplier={1.3}
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                testID={i === 0 ? 'nob-welcome-title' : undefined}
              >{cd.title}</Text>
              <Text
                style={[st.body, { color: sub, fontSize: bodySize, lineHeight: Math.round(bodySize * 1.42) }, rtl && st.rtlText]}
                maxFontSizeMultiplier={1.4}
                testID={i === 1 ? 'nob-intro-privacy' : undefined}
              >{cd.body}</Text>
            </View>
          ))}
        </Animated.ScrollView>
      </View>

      <View
        style={st.dotsRow}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={pageLabel}
        accessibilityValue={{ min: 1, max: N, now: index + 1, text: pageLabel }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const a = e?.nativeEvent?.actionName;
          if (a === 'increment') goTo(indexRef.current + 1);
          else if (a === 'decrement') goTo(indexRef.current - 1);
        }}
      >
        <View style={[{ width: trackW, height: 24 }, st.ltr, rtl && st.mirror]}>
          {cards.map((cd, i) => (
            <Pressable
              key={cd.art}
              onPress={() => goTo(i)}
              hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
              style={[st.dotHit, { left: i * STEP - (24 - DOT) / 2 }]}
              accessibilityRole="button"
              accessibilityLabel={T('nob.intro.page', `Página ${i + 1} de ${N}`, { n: i + 1, total: N })}
              importantForAccessibility="no"
              testID={`nob-intro-dot-${i}`}
            >
              <View style={[st.dot, { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: fg }]} />
            </Pressable>
          ))}
          <Animated.View
            pointerEvents="none"
            style={[st.pill, { width: PILL, height: DOT, borderRadius: DOT / 2, backgroundColor: fg, transform: [{ translateX: pillX }] }]}
          />
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', paddingBottom: 8, overflow: 'hidden' }, // RTL web: arte deslocada não pode alargar o documento
  heroArea: { width: '100%', alignItems: 'center', justifyContent: 'center', marginBottom: 18, overflow: 'hidden' },
  overlay: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  pagerBox: { width: '100%', direction: 'ltr' },
  ltr: { direction: 'ltr' },
  mirror: { transform: [{ scaleX: -1 }] },
  card: { paddingHorizontal: 32, alignItems: 'center' },
  title: { fontWeight: '800', letterSpacing: -0.6, textAlign: 'center' },
  rtlText: { writingDirection: 'rtl' },
  body: { textAlign: 'center', marginTop: 10, maxWidth: 380 },
  dotsRow: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center', height: 36, paddingHorizontal: 12, marginTop: 4 },
  dotHit: { position: 'absolute', top: 0, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  dot: { opacity: 0.22 },
  pill: { position: 'absolute', top: (24 - 7) / 2, left: 0 },
});
