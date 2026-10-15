// [2026-10-14 motion] Partículas leves (Telegram) ao "pipocar" uma reação nova:
// 6 pontinhos saem do centro do chip em leque, encolhem e somem (~380 ms).
// Sobreposição absoluta, pointerEvents none, native driver, sem layout.
// Sem motion (flag/Reduzir movimento) = não renderiza.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { MOTION_ND, motionOn } from './motionFlag';

const N = 6;
const DIST = 18;

export default function ReactionSparks({ color = '#888', size = 4 }) {
  const on = useRef(motionOn()).current;
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) return undefined;
    const a = Animated.timing(p, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: MOTION_ND });
    a.start();
    return () => a.stop();
  }, [on, p]);
  if (!on) return null;
  const dots = [];
  for (let i = 0; i < N; i++) {
    const ang = (Math.PI * 2 * i) / N - Math.PI / 2 + 0.3;
    const dx = Math.cos(ang) * DIST; const dy = Math.sin(ang) * DIST;
    dots.push(
      <Animated.View key={i} style={[styles.dot, {
        width: size, height: size, borderRadius: size / 2, backgroundColor: color,
        marginLeft: -size / 2, marginTop: -size / 2,
        opacity: p.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.9, 0] }),
        transform: [
          { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
          { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
          { scale: p.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 1, 0.2] }) },
        ],
      }]} />
    );
  }
  return <View pointerEvents="none" style={styles.wrap}>{dots}</View>;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'visible' },
  dot: { position: 'absolute', left: '50%', top: '50%' },
});
