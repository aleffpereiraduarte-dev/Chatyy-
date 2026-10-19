// components/games/Confetti.js — [jogos 2026-10-18] chuva de confete da vitória (Reanimated, 100% JS,
// funciona em iOS/Android/web). Peças pretas, brancas e nas cores das cartas; some sozinha em ~3 s.
import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming, Easing } from 'react-native-reanimated';

const COLORS = ['#0A0A0A', '#FFFFFF', '#E5484D', '#F0B400', '#22A55B', '#2F6FEB', '#9A9A9E'];

function Bit({ x, w, h, color, delay, dur, drift, spin, H }) {
  const p = useSharedValue(0);
  useEffect(() => { p.value = withDelay(delay, withTiming(1, { duration: dur, easing: Easing.out(Easing.quad) })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({
    opacity: p.value < 0.85 ? 1 : (1 - p.value) / 0.15,
    transform: [
      { translateX: x + drift * Math.sin(p.value * Math.PI * 2) },
      { translateY: -40 + p.value * (H + 80) },
      { rotate: `${spin * p.value}deg` },
    ],
  }));
  return <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: w, height: h, borderRadius: 2, backgroundColor: color, borderWidth: color === '#FFFFFF' ? 0.5 : 0, borderColor: '#C7C7CC' }, st]} />;
}

export default function Confetti({ count = 46 }) {
  const { width, height } = useWindowDimensions();
  const bits = useMemo(() => Array.from({ length: count }).map((_, i) => ({
    k: i, x: Math.random() * width, w: 6 + Math.random() * 6, h: 9 + Math.random() * 8,
    color: COLORS[i % COLORS.length], delay: Math.random() * 500, dur: 2200 + Math.random() * 1200,
    drift: 20 + Math.random() * 40, spin: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540),
  })), [count, width]);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {bits.map((b) => <Bit key={b.k} {...b} H={height} />)}
    </View>
  );
}
