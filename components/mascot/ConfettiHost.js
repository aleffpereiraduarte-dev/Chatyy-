// components/mascot/ConfettiHost.js — [2026-10-16 mascote] Confete leve de
// comemoração (1ª mensagem numa conversa nova, grupo criado).
//
//   import { celebrate } from '../components/mascot/ConfettiHost';
//   celebrate();                     // rajada de baixo p/ cima (perto do compositor)
//   celebrate({ x: 0.5, y: 0.35 });  // origem em fração da tela
//
// <ConfettiHost /> fica UMA vez no app/_layout.js (overlay sem toque).
// ~22 pedacinhos, 1 Animated.Value cada, driver nativo, ~1.3 s e some.
// Reduzir movimento → não mostra nada. Anti-spam: 1 rajada a cada 1.5 s.
import React, { useEffect, useRef, useState } from 'react';
import { View, Animated, Easing, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { isReduceMotionEnabled } from '../reducedMotion';
import { MASCOT_COLORS } from './mascotArt';

const ND = Platform.OS !== 'web';
const subs = new Set();
let _last = 0;

export function celebrate(opts) {
  const now = Date.now();
  if (now - _last < 1500) return;
  if (isReduceMotionEnabled()) return;
  _last = now;
  subs.forEach((fn) => { try { fn(opts || {}); } catch {} });
}

const COLORS = [...MASCOT_COLORS.confetti, '#111111', '#C9B6FF'];
const N = 22;

function makePieces(seed) {
  let s = seed % 2147483647 || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  return Array.from({ length: N }, (_, i) => {
    const ang = (-90 + (rnd() - 0.5) * 110) * Math.PI / 180; // leque p/ cima
    const sp = 260 + rnd() * 260;
    return {
      key: `${seed}_${i}`,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      g: 620 + rnd() * 260,
      spin: (rnd() > 0.5 ? 1 : -1) * (360 + rnd() * 540),
      w: 5 + rnd() * 4,
      h: 8 + rnd() * 6,
      round: rnd() > 0.65,
      c: COLORS[i % COLORS.length],
      delay: Math.floor(rnd() * 90),
    };
  });
}

function Piece({ p, ox, oy }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 1300, delay: p.delay, easing: Easing.linear, useNativeDriver: ND }).start();
  }, [v, p.delay]);
  // trajetória balística amostrada (t em s = v*1.3)
  const S = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1];
  const T = 1.3;
  const tx = v.interpolate({ inputRange: S, outputRange: S.map((q) => p.vx * q * T * 0.55) });
  const ty = v.interpolate({ inputRange: S, outputRange: S.map((q) => p.vy * q * T + 0.5 * p.g * (q * T) ** 2) });
  const rot = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${p.spin}deg`] });
  const op = v.interpolate({ inputRange: [0, 0.05, 0.75, 1], outputRange: [0, 1, 1, 0] });
  return (
    <Animated.View
      style={{
        position: 'absolute', left: ox - p.w / 2, top: oy - p.h / 2,
        width: p.w, height: p.round ? p.w : p.h,
        borderRadius: p.round ? p.w / 2 : 1.5, backgroundColor: p.c,
        opacity: op, transform: [{ translateX: tx }, { translateY: ty }, { rotate: rot }],
      }}
    />
  );
}

export default function ConfettiHost() {
  const { width, height } = useWindowDimensions();
  const [burst, setBurst] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    const fn = (o) => {
      const seed = Date.now();
      setBurst({ seed, x: o.x == null ? 0.5 : o.x, y: o.y == null ? 0.8 : o.y, pieces: makePieces(seed) });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setBurst(null), 1600);
    };
    subs.add(fn);
    return () => { subs.delete(fn); if (timer.current) clearTimeout(timer.current); };
  }, []);
  if (!burst) return null;
  const ox = burst.x * width; const oy = burst.y * height;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 99999, elevation: 99 }]}>
      {burst.pieces.map((p) => <Piece key={p.key} p={p} ox={ox} oy={oy} />)}
    </View>
  );
}
