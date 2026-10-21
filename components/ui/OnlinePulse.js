// components/ui/OnlinePulse.js — [2026-10-20 grafite]
// Ponto "online" do tema Grafite suave: bolinha na cor do texto com um halo
// que se expande e some a cada 2,4 s (mockup visual.html, @keyframes pulse).
// Reanimated na UI thread (zero re-render). Reduzir Movimento ou tema antigo
// (globalThis.__chatyy_theme_v2 = false) → ponto parado.
import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, cancelAnimation, Easing } from 'react-native-reanimated';
import { useReducedMotion } from '../reducedMotion';
import { THEME_V2 } from '../../constants/theme';

function OnlinePulse({ color = '#18181B', size = 7, style }) {
  const reduce = useReducedMotion();
  const p = useSharedValue(0);
  const animate = THEME_V2 && !reduce;
  useEffect(() => {
    if (!animate) { cancelAnimation(p); p.value = 0; return undefined; }
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1, false);
    return () => cancelAnimation(p);
  }, [animate, p]);
  const halo = useAnimatedStyle(() => {
    // 0 → 70%: cresce até +7 px e some; 70 → 100%: parado (igual ao CSS)
    const t = Math.min(1, p.value / 0.7);
    return { opacity: p.value < 0.7 ? 0.35 * (1 - t) : 0, transform: [{ scale: 1 + t * (14 / size) }] };
  });
  const r = size / 2;
  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none">
      {animate ? <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: r, backgroundColor: color }, halo]} /> : null}
      <View style={[StyleSheet.absoluteFill, { borderRadius: r, backgroundColor: color }]} />
    </View>
  );
}

export default React.memo(OnlinePulse);
