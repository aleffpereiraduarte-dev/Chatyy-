// components/games/boards/Ligue4Board.js — [jogos2 2026-10-21] Ligue 4 (grade 7×6, fichas que caem).
// O servidor valida tudo (api/games_engine_ligue4.php): o app manda {col} e redesenha com a visão.
// - toque em qualquer ponto da coluna = soltar a ficha (só nas colunas de `legal`);
// - a ficha nova CAI do topo até a casa (Reanimated, UI thread) com um quique curto; Reduzir Movimento = aparece;
// - 4 em linha: as fichas da linha pulsam com anel dourado.
// Grade azul com furos (cores do mockup preview-2026/jogos2.html), fichas vermelha (1º) e amarela (2º).
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, withRepeat, withDelay, Easing } from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { hTap, hMove } from '../fx';
import { useRM } from '../motion';
import { tr, nameOf } from '../../../services/games';

const COLS = 7;
const ROWS = 6;
export const L4_COLORS = { R: '#E5484D', Y: '#F0B400' };

const DiscFace = memo(function DiscFace({ d, mark }) {
  const k = mark === 'R' ? 'r' : 'y';
  const base = L4_COLORS[mark] || '#999';
  return (
    <Svg width={d} height={d} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={'l4d' + k} cx="38%" cy="32%" r="75%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.45" />
          <Stop offset="0.45" stopColor={base} stopOpacity="1" />
          <Stop offset="1" stopColor={base} stopOpacity="1" />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="48" fill={`url(#l4d${k})`} />
      <Circle cx="50" cy="50" r="33" fill="none" stroke="#000000" strokeOpacity="0.14" strokeWidth="4" />
      <Circle cx="50" cy="50" r="47" fill="none" stroke="#000000" strokeOpacity="0.12" strokeWidth="2" />
    </Svg>
  );
});

function Disc({ mark, row, col, cell, fresh, win, rm, accent }) {
  const d = cell * 0.8;
  const y = useSharedValue(fresh && !rm ? -(row + 1) * cell : 0);
  const s = useSharedValue(1);
  useEffect(() => {
    if (fresh && !rm) {
      const dur = 140 + row * 45;
      y.value = withSequence(
        withTiming(0, { duration: dur, easing: Easing.in(Easing.quad) }),
        withTiming(-cell * 0.14, { duration: 90, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 90, easing: Easing.in(Easing.quad) }),
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (win && !rm) s.value = withDelay(260, withRepeat(withSequence(withTiming(1.12, { duration: 380 }), withTiming(1, { duration: 380 })), 3, false));
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { scale: s.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: col * cell + (cell - d) / 2, top: row * cell + (cell - d) / 2, width: d, height: d }, st]}>
      <DiscFace d={d} mark={mark} />
      {win ? <View style={{ position: 'absolute', left: -3, top: -3, right: -3, bottom: -3, borderRadius: d, borderWidth: 3, borderColor: accent }} /> : null}
    </Animated.View>
  );
}

export default function Ligue4Board({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const b = typeof S.b === 'string' && S.b.length === COLS * ROWS ? S.b : '.'.repeat(COLS * ROWS);
  const legal = new Set(Array.isArray(S.legal) ? S.legal : []);
  const width = Math.min((maxW || win.width) - 24, 440);
  const pad = Math.max(6, Math.round(width * 0.025));
  const cell = (width - pad * 2) / COLS;
  const H = cell * ROWS + pad * 2;
  const lastCell = S.last && Number.isInteger(S.last.cell) ? S.last.cell : -1;
  const line = new Set(Array.isArray(S.line) ? S.line : []);
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const myMark = view.me === 1 ? 'Y' : 'R';
  const [hover, setHover] = useState(-1);
  // ficha nova só "cai" se a grade já estava montada (abrir a partida não anima a última jogada)
  const ready = useRef(false);
  const lastSeen = useRef(lastCell);
  useEffect(() => { ready.current = true; }, []);
  useEffect(() => {
    if (lastCell >= 0 && lastCell !== lastSeen.current && ready.current) { const tm = setTimeout(() => hMove(), 150 + Math.floor(lastCell / COLS) * 45); lastSeen.current = lastCell; return () => clearTimeout(tm); }
    lastSeen.current = lastCell;
    return undefined;
  }, [lastCell]);
  const frame = pal.dark ? '#2442B5' : '#3B5BDB';
  const hole = pal.dark ? '#0E0E10' : '#F2F2EF';
  const discs = [];
  for (let i = 0; i < b.length; i++) {
    const m = b[i];
    if (m !== 'R' && m !== 'Y') continue;
    discs.push(<Disc key={'d' + i} mark={m} row={Math.floor(i / COLS)} col={i % COLS} cell={cell} fresh={ready.current && i === lastCell} win={line.has(i)} rm={rm} accent={pal.accent} />);
  }
  const drop = (c) => {
    if (!myTurn || busy || !legal.has(c)) return;
    hTap();
    onMove({ col: c });
  };
  const oppE = (view.seats || [])[view.me === 0 ? 1 : 0];
  let hint = '';
  if (view.status === 'active') hint = myTurn ? tr(t, 'games.ligue4.yourTurn', 'Sua vez: toque numa coluna') : tr(t, 'games.status.turnOf', 'Vez de {name}', { name: nameOf(view, view.turn || oppE, me, t) });
  return (
    <View style={{ alignItems: 'center', marginTop: 8 }}>
      {/* fila de cima: ficha da vez sobre a coluna escolhida */}
      <View style={{ width, height: cell * 0.9, paddingHorizontal: pad }} pointerEvents="none">
        {myTurn && hover >= 0 ? (
          <View style={{ position: 'absolute', left: pad + hover * cell + cell * 0.12, top: cell * 0.05, opacity: 0.85 }}><DiscFace d={cell * 0.76} mark={myMark} /></View>
        ) : null}
      </View>
      <View style={{ width, height: H, borderRadius: 18, backgroundColor: frame, padding: pad,
        shadowColor: '#000', shadowOpacity: pal.dark ? 0.4 : 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }}
        accessibilityLabel={tr(t, 'games.title.ligue4', 'Ligue 4')}>
        <View style={{ width: cell * COLS, height: cell * ROWS }}>
          {Array.from({ length: COLS * ROWS }).map((_, i) => (
            <View key={'h' + i} pointerEvents="none" style={{ position: 'absolute', left: (i % COLS) * cell + cell * 0.1, top: Math.floor(i / COLS) * cell + cell * 0.1, width: cell * 0.8, height: cell * 0.8, borderRadius: cell, backgroundColor: hole, opacity: pal.dark ? 0.9 : 1 }} />
          ))}
          {discs}
          {Array.from({ length: COLS }).map((_, c) => {
            const can = myTurn && !busy && legal.has(c);
            return (
              <Pressable key={'c' + c} disabled={!can} onPress={() => drop(c)} onPressIn={() => setHover(c)} onPressOut={() => setHover(-1)}
                accessibilityRole="button" accessibilityLabel={tr(t, 'games.ligue4.column', 'Coluna {n}', { n: c + 1 })} accessibilityState={{ disabled: !can }}
                style={{ position: 'absolute', left: c * cell, top: 0, width: cell, height: cell * ROWS, borderRadius: 10, backgroundColor: hover === c && can ? 'rgba(255,255,255,0.12)' : 'transparent' }} />
            );
          })}
        </View>
      </View>
      {hint ? (
        <View style={st.hintRow}>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: L4_COLORS[myTurn ? myMark : (myMark === 'R' ? 'Y' : 'R')] }} />
          <Text style={{ color: myTurn ? pal.ink : pal.sub, fontWeight: myTurn ? '800' : '600', fontSize: 14 }}>{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
});
