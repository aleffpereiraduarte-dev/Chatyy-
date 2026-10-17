// components/status/StoryReactionPop.js — [2026-10-17 status-reacoes]
//
// Fallback JS do estouro de reação (o nativo tem SVReactionBurst): o emoji
// escolhido sobe grande com mola 'bouncy' (constants/motion.js), estoura
// (escala + fade) e solta mini cópias. Reduzir Movimento → só fade no centro.
// O emoji é CONTEÚDO (a reação enviada), não ícone de UI.
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { springTo, timingTo, useMotion, feedback } from '../../constants/motion';

const SPARKS = 7;

export default function StoryReactionPop({ emoji, popKey, onDone }) {
  const { width, height } = useWindowDimensions();
  const { reduce } = useMotion();
  const rise = useRef(new Animated.Value(0)).current;  // 0 = embaixo/pequeno, 1 = centro
  const pop = useRef(new Animated.Value(0)).current;   // 0 → 1 = estouro
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const sparks = useMemo(() => Array.from({ length: SPARKS }).map((_, i) => {
    const ang = (i / SPARKS) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 110 + Math.random() * 50;
    return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist - 30, size: 26 + Math.random() * 16, rot: (Math.random() - 0.5) * 70 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [popKey]);

  useEffect(() => {
    if (!emoji) return undefined;
    rise.setValue(0);
    pop.setValue(0);
    let alive = true;
    const finish = () => { if (alive) { try { doneRef.current?.(); } catch {} } };
    let anim;
    if (reduce) {
      anim = Animated.sequence([
        timingTo(rise, 1, 'fast', { useNativeDriver: true }),
        Animated.delay(600),
        timingTo(pop, 1, 'base', { useNativeDriver: true }),
      ]);
    } else {
      anim = Animated.sequence([
        springTo(rise, 1, 'bouncy', { useNativeDriver: true }),
        Animated.delay(260),
        timingTo(pop, 1, 700, { useNativeDriver: true }),
      ]);
      setTimeout(() => { if (alive) feedback.light(); }, 420);
    }
    anim.start(finish);
    return () => { alive = false; try { anim.stop(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emoji, popKey, reduce]);

  if (!emoji) return null;
  const side = Math.min(180, Math.max(120, width * 0.42));
  const cy = height * 0.42;
  const startY = height * 0.8;
  const big = reduce
    ? { opacity: Animated.multiply(rise, Animated.subtract(1, pop)), transform: [{ translateY: cy - side / 2 }] }
    : {
        opacity: pop.interpolate({ inputRange: [0, 0.35, 0.6, 1], outputRange: [1, 1, 0, 0] }),
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [startY - side / 2, cy - side / 2] }) },
          { scale: Animated.add(rise.interpolate({ inputRange: [0, 1], outputRange: [0.22, 1] }), pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.45, 0.45] })) },
        ],
      };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 30 }]}>
      <Animated.View style={[{ position: 'absolute', left: (width - side) / 2, top: 0, width: side, height: side, alignItems: 'center', justifyContent: 'center' }, big]}>
        <Text style={{ fontSize: side * 0.8, lineHeight: side * 0.98 }} allowFontScaling={false}>{emoji}</Text>
      </Animated.View>
      {!reduce && sparks.map((s, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute', left: width / 2 - s.size / 2, top: cy - s.size / 2,
            opacity: pop.interpolate({ inputRange: [0, 0.05, 0.75, 1], outputRange: [0, 1, 1, 0] }),
            transform: [
              { translateX: pop.interpolate({ inputRange: [0, 1], outputRange: [0, s.dx] }) },
              { translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [0, s.dy] }) },
              { rotate: pop.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${s.rot}deg`] }) },
              { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }) },
            ],
          }}
        >
          <Text style={{ fontSize: s.size * 0.85 }} allowFontScaling={false}>{emoji}</Text>
        </Animated.View>
      ))}
    </View>
  );
}
