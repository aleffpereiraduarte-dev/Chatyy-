// [2026-10-13 tarefas] Círculo de concluir (estilo Lembretes) com animação:
// anel → disco de tinta que "pulsa" + check desenhado. P&B, sem emoji.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, StyleSheet } from 'react-native';
import { IconCheck } from '../Icons';

export default function TaskCheck({ done, g, size = 22, priority = 0 }) {
  const v = useRef(new Animated.Value(done ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; v.setValue(done ? 1 : 0); return; }
    Animated.parallel([
      Animated.timing(v, { toValue: done ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      done
        ? Animated.sequence([
            Animated.timing(pop, { toValue: 1.22, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.spring(pop, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }),
          ])
        : Animated.timing(pop, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();
  }, [done, v, pop]);
  const ring = priority >= 3 ? g.ink : g.tertiary;
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale: pop }] }}>
      <View style={[s.ring, { width: size, height: size, borderRadius: size / 2, borderColor: ring, borderWidth: priority >= 3 ? 2 : 1.6 }]} />
      <Animated.View style={[s.fill, { width: size, height: size, borderRadius: size / 2, backgroundColor: g.ink, opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }]}>
        <IconCheck size={Math.round(size * 0.64)} color={g.onInk} strokeWidth={3} />
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  ring: { position: 'absolute', left: 0, top: 0 },
  fill: { position: 'absolute', left: 0, top: 0, alignItems: 'center', justifyContent: 'center' },
});
