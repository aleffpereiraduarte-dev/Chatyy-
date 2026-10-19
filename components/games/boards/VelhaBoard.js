// components/games/boards/VelhaBoard.js — [jogos 2026-10-18] Jogo da Velha 3×3 (X = 1º assento).
// Polish 2: X e O se DESENHAM (traço animado, X em dois riscos), linha vencedora risca de ponta a
// ponta com brilho dourado e as 3 casas pulsam; toque com afundar; movimento reduzido = sem animação.
import React, { useEffect } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence, withSpring, withRepeat } from 'react-native-reanimated';
import Svg from 'react-native-svg';
import { hTap } from '../fx';
import { PressScale, DrawLine, DrawCircle, useRM, IS_WEB } from '../motion';

function Mark({ mark, size, color, fresh, win, rm }) {
  const s = useSharedValue(fresh && IS_WEB && !rm ? 0.4 : 1);
  useEffect(() => { if (fresh && IS_WEB && !rm) s.value = withSpring(1, { damping: 12, stiffness: 220 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (win && !rm) s.value = withDelay(420, withSequence(withTiming(1.14, { duration: 160 }), withSpring(1, { damping: 9, stiffness: 180 })));
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const p = size * 0.24;
  const sw = size * 0.095;
  const anim = !!fresh;
  return (
    <Animated.View style={st}>
      <Svg width={size} height={size}>
        {mark === 'X' ? (
          <>
            <DrawLine x1={p} y1={p} x2={size - p} y2={size - p} stroke={color} strokeWidth={sw} strokeLinecap="round" animate={anim} duration={170} rm={rm} />
            <DrawLine x1={size - p} y1={p} x2={p} y2={size - p} stroke={color} strokeWidth={sw} strokeLinecap="round" animate={anim} delay={150} duration={170} rm={rm} />
          </>
        ) : (
          <DrawCircle cx={size / 2} cy={size / 2} r={size / 2 - p} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" animate={anim} duration={360} rm={rm}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </Svg>
    </Animated.View>
  );
}

function WinLine({ line, cell, color, glow, rm }) {
  const o = useSharedValue(rm ? 1 : 0);
  useEffect(() => {
    if (rm) return;
    o.value = withDelay(120, withTiming(1, { duration: 200 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  const c = (i) => [(i % 3) * cell + cell / 2, Math.floor(i / 3) * cell + cell / 2];
  let [x1, y1] = c(line[0]); let [x2, y2] = c(line[2]);
  // estende um pouco além do centro das casas das pontas
  const dx = x2 - x1; const dy = y2 - y1; const L = Math.hypot(dx, dy) || 1; const ext = cell * 0.32;
  x1 -= (dx / L) * ext; y1 -= (dy / L) * ext; x2 += (dx / L) * ext; y2 += (dy / L) * ext;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      <Svg width={cell * 3} height={cell * 3}>
        <DrawLine x1={x1} y1={y1} x2={x2} y2={y2} stroke={glow} strokeWidth={cell * 0.2} strokeLinecap="round" opacity={0.35} delay={120} duration={380} rm={rm} />
        <DrawLine x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={cell * 0.075} strokeLinecap="round" delay={120} duration={380} rm={rm} />
      </Svg>
    </Animated.View>
  );
}

function Cell({ i, m, cell, can, last, win, pal, onPress, rm }) {
  const r = Math.floor(i / 3); const c = i % 3;
  const hl = useSharedValue(0);
  useEffect(() => {
    if (win && !rm) hl.value = withDelay(380, withRepeat(withSequence(withTiming(1, { duration: 520 }), withTiming(0.45, { duration: 520 })), 3, false));
    else hl.value = win ? 1 : 0;
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps
  const hlSt = useAnimatedStyle(() => ({ opacity: hl.value }));
  return (
    <PressScale disabled={!can} onPress={onPress} rm={rm} scaleTo={0.9}
      accessibilityRole="button" accessibilityLabel={`${r + 1}-${c + 1} ${m || ''}`} accessibilityState={{ disabled: !can }}
      style={{ position: 'absolute', left: c * cell, top: r * cell, width: cell, height: cell, alignItems: 'center', justifyContent: 'center', backgroundColor: last && !win ? pal.hl : 'transparent' }}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { margin: 6, borderRadius: 14, backgroundColor: pal.accentSoft }, hlSt]} />
      {m ? <Mark key={m + i} mark={m} size={cell * 0.86} color={pal.ink} fresh={last} win={win} rm={rm} />
        : (can ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.line }} /> : null)}
    </PressScale>
  );
}

export default function VelhaBoard({ view, onMove, pal, busy, maxW }) {
  const win = useWindowDimensions();
  const width = maxW || win.width;
  const rm = useRM();
  const S = view.state || {};
  const b = Array.isArray(S.b) ? S.b : Array(9).fill('');
  const legal = new Set(Array.isArray(S.legal) ? S.legal : []);
  const size = Math.min(width - 48, maxW ? 520 : 380);
  const cell = size / 3;
  const last = S.last && Number.isInteger(S.last.cell) ? S.last.cell : -1;
  const line = Array.isArray(S.line) ? S.line : null;
  const winSet = new Set(line || []);
  const lineKey = line ? line.join('-') : '';
  return (
    <View style={{ alignItems: 'center', marginTop: 8 }}>
      <View style={{ width: size, height: size, borderRadius: 24, backgroundColor: pal.card, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: pal.line }}>
        {[1, 2].map((k) => <View key={'v' + k} pointerEvents="none" style={{ position: 'absolute', left: k * cell - 1.5, top: 14, bottom: 14, width: 3, borderRadius: 2, backgroundColor: pal.ink, opacity: 0.85 }} />)}
        {[1, 2].map((k) => <View key={'h' + k} pointerEvents="none" style={{ position: 'absolute', top: k * cell - 1.5, left: 14, right: 14, height: 3, borderRadius: 2, backgroundColor: pal.ink, opacity: 0.85 }} />)}
        {b.map((m, i) => (
          <Cell key={i} i={i} m={m} cell={cell} pal={pal} rm={rm}
            can={legal.has(i) && !busy} last={i === last} win={winSet.has(i)}
            onPress={() => { hTap(); onMove({ cell: i }); }} />
        ))}
        {line ? <WinLine key={lineKey} line={line} cell={cell} color={pal.ink} glow={pal.accent} rm={rm} /> : null}
      </View>
    </View>
  );
}
