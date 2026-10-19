// components/games/boards/VelhaBoard.js — [jogos 2026-10-18] Jogo da Velha 3×3 (X = 1º assento).
import React, { useEffect } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, withDelay } from 'react-native-reanimated';
import Svg, { Line, Circle } from 'react-native-svg';
import { hTap } from '../fx';

function Mark({ mark, size, color, fresh }) {
  const s = useSharedValue(fresh ? 0.3 : 1);
  const o = useSharedValue(fresh ? 0 : 1);
  useEffect(() => { s.value = withSpring(1, { damping: 12, stiffness: 220 }); o.value = withTiming(1, { duration: 160 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ scale: s.value }] }));
  const p = size * 0.24;
  return (
    <Animated.View style={st}>
      <Svg width={size} height={size}>
        {mark === 'X' ? (
          <>
            <Line x1={p} y1={p} x2={size - p} y2={size - p} stroke={color} strokeWidth={size * 0.09} strokeLinecap="round" />
            <Line x1={size - p} y1={p} x2={p} y2={size - p} stroke={color} strokeWidth={size * 0.09} strokeLinecap="round" />
          </>
        ) : (
          <Circle cx={size / 2} cy={size / 2} r={size / 2 - p} stroke={color} strokeWidth={size * 0.09} fill="none" />
        )}
      </Svg>
    </Animated.View>
  );
}

function WinLine({ line, cell, color }) {
  const o = useSharedValue(0);
  useEffect(() => { o.value = withDelay(180, withTiming(1, { duration: 260 })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  const c = (i) => [(i % 3) * cell + cell / 2, Math.floor(i / 3) * cell + cell / 2];
  const [x1, y1] = c(line[0]); const [x2, y2] = c(line[2]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      <Svg width={cell * 3} height={cell * 3}>
        <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={cell * 0.07} strokeLinecap="round" opacity={0.85} />
      </Svg>
    </Animated.View>
  );
}

export default function VelhaBoard({ view, onMove, pal, busy }) {
  const { width } = useWindowDimensions();
  const S = view.state || {};
  const b = Array.isArray(S.b) ? S.b : Array(9).fill('');
  const legal = new Set(Array.isArray(S.legal) ? S.legal : []);
  const size = Math.min(width - 48, 360);
  const cell = size / 3;
  const last = S.last && Number.isInteger(S.last.cell) ? S.last.cell : -1;
  return (
    <View style={{ alignItems: 'center', marginTop: 8 }}>
      <View style={{ width: size, height: size, borderRadius: 22, backgroundColor: pal.card, overflow: 'hidden' }}>
        {b.map((m, i) => {
          const r = Math.floor(i / 3); const c = i % 3;
          const can = legal.has(i) && !busy;
          return (
            <Pressable key={i} disabled={!can} onPress={() => { hTap(); onMove({ cell: i }); }}
              accessibilityRole="button" accessibilityLabel={`${r + 1}-${c + 1} ${m || ''}`}
              style={({ pressed }) => [{
                position: 'absolute', left: c * cell, top: r * cell, width: cell, height: cell, alignItems: 'center', justifyContent: 'center',
                backgroundColor: i === last ? pal.hl : (pressed && can ? pal.card2 : 'transparent'),
              }]}>
              {m ? <Mark key={m + i} mark={m} size={cell * 0.86} color={pal.ink} fresh={i === last} /> : (can ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.line }} /> : null)}
            </Pressable>
          );
        })}
        {[1, 2].map((k) => <View key={'v' + k} pointerEvents="none" style={{ position: 'absolute', left: k * cell - 1.5, top: 14, bottom: 14, width: 3, borderRadius: 2, backgroundColor: pal.ink, opacity: 0.85 }} />)}
        {[1, 2].map((k) => <View key={'h' + k} pointerEvents="none" style={{ position: 'absolute', top: k * cell - 1.5, left: 14, right: 14, height: 3, borderRadius: 2, backgroundColor: pal.ink, opacity: 0.85 }} />)}
        {Array.isArray(S.line) ? <WinLine line={S.line} cell={cell} color={pal.ink} /> : null}
      </View>
    </View>
  );
}
