// FadeSlideIn — the canonical "screen content settles in" primitive.
//
// Why this exists: ~46 secondary screens (settings, storage, activity log,
// linked devices, starred messages…) render statically — content just
// *appears*, which reads cheap next to the chat core (which animates
// everything). Wrapping a screen's main content in <FadeSlideIn> gives it the
// same premium settle-in the ScreenEmptyState already uses (fade 420ms +
// slide-up cubic), so the whole app feels like one system on open.
//
// Usage — wrap the screen body (below the header), NOT the whole screen:
//   <FadeSlideIn>
//     <ScrollView>…</ScrollView>
//   </FadeSlideIn>
//
// For lists that render row-by-row, pass `delay` on successive sections to
// get a subtle stagger:
//   <FadeSlideIn delay={0}>{header}</FadeSlideIn>
//   <FadeSlideIn delay={60}>{list}</FadeSlideIn>
//
// Props:
//   • delay    — ms before the animation starts (default 0). Use for stagger.
//   • distance — px it slides up from (default 10 — CLEAN 2026: subtle). 0 = fade only.
//   • duration — fade duration ms (default 220 — CLEAN 2026: quick, light entrance).
//   • style    — extra style on the wrapper (it's a plain Animated.View).
//
// RN Animated only (no Reanimated) → ships via OTA. useNativeDriver:true so
// it runs on the UI thread and never jank-blocks JS.
import React, { useRef, useEffect } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';
import { isReduceMotionEnabled } from './reducedMotion';

// [2026-10-14 piscada-voltar] Founder: "TODA transição entre páginas em
// nativo". No iOS/Android a tela já entra com o push NATIVO (slide + parallax
// do UINavigationController / transição do sistema); um fade-in JS do corpo
// da tela montando JUNTO com o push = a tela chega "vazia" e o conteúdo
// aparece depois (sensação de piscada). Regra: no nativo, o FadeSlideIn que
// monta junto com a rota (≤ 700 ms desde a 1ª vez que a rota foi vista)
// nasce assentado; conteúdo que chega depois (lista após skeleton, resumo de
// IA carregado, empty state tardio) continua com o fade. Web (stack sem
// animação) mantém o fade como transição.
let _NavRouteCtx = null;
try { _NavRouteCtx = require('@react-navigation/native').NavigationRouteContext || null; } catch {}
const _routeFirstSeen = new Map();
const _NAV_SETTLE_MS = 700;
// Chamado pelo Stack raiz (screenListeners.focus em app/_layout.js): marca o
// momento em que a rota apareceu, p/ um FadeSlideIn que só monta DEPOIS (dados
// carregados) saber que não está mais na transição e manter o fade.
export function noteRouteSeen(routeKey) {
  if (!routeKey || _routeFirstSeen.has(routeKey)) return;
  _routeFirstSeen.set(routeKey, Date.now());
  if (_routeFirstSeen.size > 300) { const k = _routeFirstSeen.keys().next().value; _routeFirstSeen.delete(k); }
}
function _mountedWithRouteTransition(routeKey) {
  if (Platform.OS === 'web' || !routeKey) return false;
  const now = Date.now();
  let first = _routeFirstSeen.get(routeKey);
  if (first == null) {
    first = now;
    _routeFirstSeen.set(routeKey, now);
    if (_routeFirstSeen.size > 300) { const k = _routeFirstSeen.keys().next().value; _routeFirstSeen.delete(k); }
  }
  return now - first < _NAV_SETTLE_MS;
}

// [2026-10-15 polish-ota] No web, `flex: 0` vira CSS `flex: 0 1 0%` (base 0%)
// → o wrapper colapsa p/ altura 0 e seções empilham umas sobre as outras (ex.:
// "HOJE/ONTEM/ESTA SEMANA" sobrepostos na aba Ligações). Quem passa flex:0 quer
// "tamanho do conteúdo": no web trocamos pelos longhands equivalentes.
const _WEB_NOFLEX = { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' };

export default function FadeSlideIn({
  children,
  delay = 0,
  distance = 10,
  duration = 220,
  style,
  // [2026-10-07 coldstart] `skip` = render settled (no fade/slide). Used when
  // content is painted from LOCAL cache on frame 1 (chat list cold start):
  // fading it in from opacity 0 only delayed the first visible rows ~260 ms.
  skip = false,
  onLayout,
}) {
  // Reduce Motion: skip the fade + slide-up entirely — content appears
  // settled (opacity 1, no offset) so low-animation users get no movement.
  const _route = _NavRouteCtx ? React.useContext(_NavRouteCtx) : null; // eslint-disable-line react-hooks/rules-of-hooks
  const _settledByNav = useRef(null);
  if (_settledByNav.current === null) _settledByNav.current = _mountedWithRouteTransition(_route?.key);
  const reduceMotion = isReduceMotionEnabled() || !!skip || _settledByNav.current;
  const fade = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const slide = useRef(new Animated.Value(reduceMotion ? 0 : distance)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const anim = Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: duration + 60,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
    // Run once on mount — deliberately no deps so re-renders don't replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web + flex:0 → tira o shorthand `flex` (o RNW ignora os longhands quando
  // ele está presente) e aplica tamanho-do-conteúdo explícito.
  let _webNoFlexStyle = null;
  if (Platform.OS === 'web' && style) {
    const _flat = StyleSheet.flatten(style);
    if (_flat && _flat.flex === 0) {
      const { flex: _dropFlex, ...rest } = _flat; // eslint-disable-line no-unused-vars
      _webNoFlexStyle = { ...rest, ..._WEB_NOFLEX };
    }
  }
  return (
    <Animated.View
      style={_webNoFlexStyle ? [{ opacity: fade, transform: [{ translateY: slide }] }, _webNoFlexStyle] : [{ flex: 1, opacity: fade, transform: [{ translateY: slide }] }, style]}
      onLayout={onLayout}
    >
      {children}
    </Animated.View>
  );
}
