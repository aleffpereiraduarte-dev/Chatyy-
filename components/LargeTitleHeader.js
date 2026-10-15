// [2026-10-15 nav-motion] Título grande que colapsa ao rolar — padrão
// UINavigationBar (iOS) / M3 large top app bar (Android), extraído da home
// (ChatListTab + app/chat.js) p/ as abas que vivem DENTRO do /chat (Ligações,
// Status), que não são rotas do native-stack e por isso não podem usar o
// headerLargeTitle do sistema.
//
// Peças:
//   <LargeTitle title color />            → título 34pt que rola 1:1 com a lista
//   useLargeTitleCollapse(onChange, opts)  → { onScroll, scrollEventThrottle, reset }
//                                            chama onChange(true|false) SÓ na
//                                            troca (sem re-render por frame)
//   useCollapsedTitleAnim()                → [anim, setCollapsed] p/ o header
//                                            (spring nativo, 0 = expandido, 1 = compacto)
//
// RN Animated puro (useNativeDriver) → vai por OTA; web: o chamador decide
// (no web a home segue com o título fixo antigo).
import React, { useCallback, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { isReduceMotionEnabled } from './reducedMotion';

// Mesmo limiar da home (ChatListTab LARGE_TITLE_COLLAPSE_Y): quando o título
// grande passa por baixo do header, o compacto aparece.
export const LARGE_TITLE_COLLAPSE_Y = 34;

export function LargeTitle({ title, color, style, titleStyle, right, accessibilityRole = 'header' }) {
  if (!title) return null;
  return (
    <View style={[s.wrap, style]}>
      <Text
        style={[s.title, { color }, titleStyle]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.25}
        accessibilityRole={accessibilityRole}
      >
        {title}
      </Text>
      {right || null}
    </View>
  );
}

export function useLargeTitleCollapse(onChange, { threshold = LARGE_TITLE_COLLAPSE_Y, enabled = true } = {}) {
  const collapsedRef = useRef(false);
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const onScroll = useCallback((e) => {
    const y = e?.nativeEvent?.contentOffset?.y || 0;
    const c = y > threshold;
    if (c !== collapsedRef.current) {
      collapsedRef.current = c;
      try { cbRef.current?.(c); } catch {}
    }
  }, [threshold]);
  const reset = useCallback(() => {
    if (!collapsedRef.current) return;
    collapsedRef.current = false;
    try { cbRef.current?.(false); } catch {}
  }, []);
  if (!enabled || typeof onChange !== 'function') return { onScroll: undefined, scrollEventThrottle: undefined, reset };
  return { onScroll, scrollEventThrottle: 32, reset };
}

// Valor animado do título COMPACTO do header (0 → 1). Spring curto e sem
// overshoot visível (a opacidade satura em 1) — sente "de sistema".
export function useCollapsedTitleAnim() {
  const anim = useRef(new Animated.Value(0)).current;
  const setCollapsed = useCallback((collapsed) => {
    const to = collapsed ? 1 : 0;
    if (isReduceMotionEnabled()) { anim.setValue(to); return; }
    Animated.spring(anim, { toValue: to, useNativeDriver: true, tension: 300, friction: 30 }).start();
  }, [anim]);
  return [anim, setCollapsed];
}

const s = StyleSheet.create({
  // Mesmo layout de s.largeTitleWrap/largeTitleText da home (ChatListTab).
  wrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 },
  title: { flex: 1, fontSize: 34, fontWeight: '700', letterSpacing: -0.9 },
});

export default LargeTitle;
