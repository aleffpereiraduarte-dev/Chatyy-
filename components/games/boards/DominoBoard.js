// components/games/boards/DominoBoard.js — [jogos2 2026-10-21] Dominó de 2 (duplo-seis, 7 pedras cada).
// Servidor autoritativo com MÃO OCULTA (api/games_engine_domino.php): a visão traz só a minha mão, quantas
// pedras o outro tem e o tamanho do monte. Mesa = linha rolável (buchas atravessadas, como na mesa de verdade)
// que acompanha a ponta onde a última pedra entrou. Mão embaixo: as que encaixam sobem; tocar joga (se
// encaixa nas duas pontas, escolhe Esquerda/Direita). Sem jogada: "Comprar" (monte) ou "Passar" (monte vazio).
// Pedra nova entra com mola (UI thread); Reduzir Movimento = aparece pronta.
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Rect, Circle, Line } from 'react-native-svg';
import { hTap, hCard, hDraw, hNope } from '../fx';
import { useRM, PressScale } from '../motion';
import { tr, nameOf } from '../../../services/games';

// posições das pintas num meio de pedra (0..1)
const PIPS = {
  0: [], 1: [[0.5, 0.5]], 2: [[0.27, 0.27], [0.73, 0.73]], 3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]], 5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.24], [0.73, 0.24], [0.27, 0.5], [0.73, 0.5], [0.27, 0.76], [0.73, 0.76]],
};

/** Pedra em SVG. vertical = a em cima / b embaixo; horizontal = a esquerda / b direita. */
export const Tile = memo(function Tile({ a, b, u, vertical, dark, back, hl }) {
  const w = vertical ? u : u * 2; const h = vertical ? u * 2 : u;
  const face = dark ? '#E9E6DE' : '#FBFAF6';
  const edge = dark ? '#8C887E' : '#C9C5BA';
  const pip = '#17171A';
  const half = (v, ox, oy) => (PIPS[v] || []).map(([x, y], k) => {
    // pintas giradas na pedra horizontal (6 fica em 2 linhas de 3)
    const px = vertical ? x : y; const py = vertical ? y : x;
    return <Circle key={`${ox}-${oy}-${k}`} cx={ox + px * u} cy={oy + py * u} r={u * 0.085} fill={pip} />;
  });
  if (back) {
    return (
      <Svg width={w} height={h}>
        <Rect x={0.75} y={0.75} width={w - 1.5} height={h - 1.5} rx={u * 0.18} fill={dark ? '#2A2A2E' : '#34343A'} stroke={dark ? '#45454B' : '#1E1E21'} strokeWidth={1.5} />
        <Circle cx={w / 2} cy={h / 2} r={u * 0.1} fill={dark ? '#5A5A60' : '#55555C'} />
      </Svg>
    );
  }
  return (
    <Svg width={w} height={h}>
      <Rect x={0.75} y={0.75} width={w - 1.5} height={h - 1.5} rx={u * 0.18} fill={face} stroke={hl || edge} strokeWidth={hl ? 2.5 : 1.5} />
      {vertical
        ? <Line x1={u * 0.18} y1={u} x2={u * 0.82} y2={u} stroke={edge} strokeWidth={1.4} />
        : <Line x1={u} y1={u * 0.18} x2={u} y2={u * 0.82} stroke={edge} strokeWidth={1.4} />}
      {half(a, 0, 0)}
      {vertical ? half(b, 0, u) : half(b, u, 0)}
    </Svg>
  );
});

function Enter({ children, fresh, rm, from = 18 }) {
  const p = useSharedValue(fresh && !rm ? 0 : 1);
  useEffect(() => { if (fresh && !rm) p.value = withSpring(1, { damping: 13, stiffness: 190 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: from * (1 - p.value) }, { scale: 0.7 + 0.3 * p.value }] }));
  return <Animated.View style={s}>{children}</Animated.View>;
}

export default function DominoBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const width = Math.min((maxW || win.width) - 16, 560);
  const chain = Array.isArray(S.chain) ? S.chain : [];
  const hand = Array.isArray(S.hand) ? S.hand : [];
  const playable = Array.isArray(S.playable) ? S.playable : [];
  const playMap = new Map(playable.map((p) => [p.t, p.s]));
  const meSeat = view.me !== null && view.me !== undefined ? view.me : null;
  const oppSeat = meSeat === null ? 1 : 1 - meSeat;
  const oppE = (view.seats || [])[oppSeat];
  const oppName = oppE ? nameOf(view, oppE, me, t) : '';
  const counts = Array.isArray(S.counts) ? S.counts : [0, 0];
  const myTurn = view.status === 'active' && meSeat !== null && S.turn === meSeat;
  const [pick, setPick] = useState(null);
  const scRef = useRef(null);
  const ready = useRef(false);
  const lastMoves = useRef(S.moves || 0);
  useEffect(() => { ready.current = true; }, []);
  const L = S.last;
  useEffect(() => {
    const mv = S.moves || 0;
    if (mv !== lastMoves.current && ready.current && L) { if (L.a === 'play') hCard(); else if (L.a === 'draw') hDraw(); }
    lastMoves.current = mv;
    // acompanha a ponta da jogada
    const tm = setTimeout(() => { try { if (L && L.side === 'L') scRef.current.scrollTo({ x: 0, animated: !rm }); else scRef.current.scrollToEnd({ animated: !rm }); } catch {} }, 60);
    return () => clearTimeout(tm);
  }, [S.moves]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!myTurn) setPick(null); }, [myTurn]);

  const u = Math.max(18, Math.min(26, Math.floor(width / 15)));
  const hu = Math.max(20, Math.min(30, Math.floor((width - 24) / (Math.max(7, hand.length) * 1.25))));
  const freshTile = L && L.a === 'play' ? L.tile : null;
  const play = (tile) => {
    if (!myTurn || busy) return;
    const sides = playMap.get(tile);
    if (!sides) { hNope(); return; }
    const ends = Array.isArray(S.ends) ? S.ends : null;
    if (sides.length === 2 && !(ends && ends[0] === ends[1])) { hTap(); setPick(tile); return; }
    hTap();
    setPick(null);
    onMove({ a: 'play', tile, side: sides[0] === '*' ? '' : sides[sides.length - 1] });
  };
  const ends = Array.isArray(S.ends) ? S.ends : null;
  let headline = '';
  if (view.status === 'active') {
    if (myTurn) headline = playable.length ? tr(t, 'games.domino.yourTurn', 'Sua vez: escolha uma pedra') : (S.can_draw ? tr(t, 'games.domino.mustDraw', 'Nenhuma pedra encaixa: compre do monte') : tr(t, 'games.domino.mustPass', 'Nenhuma pedra encaixa e o monte acabou: passe'));
    else headline = tr(t, 'games.status.turnOf', 'Vez de {name}', { name: oppName });
  } else if (S.blocked) headline = tr(t, 'games.domino.blocked', 'Jogo trancado: vence quem tem menos pontos');
  let lastLine = '';
  if (L && view.status === 'active') {
    const mine = L.by === meSeat;
    if (L.a === 'draw') lastLine = mine ? tr(t, 'games.domino.youDrew', 'Você comprou uma pedra') : tr(t, 'games.domino.theyDrew', '{name} comprou do monte', { name: oppName });
    else if (L.a === 'pass') lastLine = mine ? tr(t, 'games.domino.youPassed', 'Você passou') : tr(t, 'games.domino.theyPassed', '{name} passou', { name: oppName });
  }
  return (
    <View style={{ marginTop: 6 }}>
      {/* adversário: pedras viradas + monte */}
      <View style={st.oppRow}>
        <View style={{ flexDirection: 'row', gap: 3, flex: 1, flexWrap: 'wrap' }}>
          {Array.from({ length: Math.min(counts[oppSeat] || 0, 14) }).map((_, k) => <Tile key={k} u={11} vertical back dark={pal.dark} />)}
        </View>
        <View style={[st.pile, { backgroundColor: pal.card, borderColor: pal.line }]}>
          <Text style={{ color: pal.sub, fontSize: 11, fontWeight: '700' }}>{tr(t, 'games.domino.pile', 'Monte')}</Text>
          <Text style={{ color: pal.ink, fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{S.pile ?? 0}</Text>
        </View>
      </View>
      {/* mesa */}
      <View style={[st.table, { backgroundColor: pal.dark ? '#14301F' : '#2F6B47', minHeight: u * 2 + 28 }]}>
        {chain.length ? (
          <ScrollView ref={scRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 12, gap: 2, minWidth: width - 16, justifyContent: 'center' }}>
            {chain.map((pr, i) => {
              const dbl = pr[0] === pr[1];
              const key = Math.min(pr[0], pr[1]) + '' + Math.max(pr[0], pr[1]);
              return <Enter key={key} fresh={ready.current && key === freshTile} rm={rm}><Tile a={pr[0]} b={pr[1]} u={u} vertical={dbl} dark={pal.dark} /></Enter>;
            })}
          </ScrollView>
        ) : (
          <Text style={{ color: 'rgba(255,255,255,0.75)', fontWeight: '700', textAlign: 'center' }}>{myTurn ? tr(t, 'games.domino.first', 'Você começa: jogue qualquer pedra') : tr(t, 'games.domino.waitFirst', 'Aguardando a primeira pedra')}</Text>
        )}
        {ends ? <Text style={st.ends}>{tr(t, 'games.domino.ends', 'Pontas {a} e {b}', { a: ends[0], b: ends[1] })}</Text> : null}
      </View>
      {headline ? <Text style={[st.head, { color: myTurn ? pal.ink : pal.sub }]}>{headline}</Text> : null}
      {lastLine ? <Text style={[st.sub, { color: pal.sub }]}>{lastLine}</Text> : null}
      {pick ? (
        <View style={st.sideRow}>
          <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13.5 }}>{tr(t, 'games.domino.whichEnd', 'Em qual ponta?')}</Text>
          {['L', 'R'].map((sd) => (
            <PressScale key={sd} rm={rm} disabled={busy} onPress={() => { hTap(); const tl = pick; setPick(null); onMove({ a: 'play', tile: tl, side: sd }); }}
              style={[st.sideBtn, { backgroundColor: pal.strong }]} accessibilityRole="button">
              <Text style={{ color: pal.onStrong, fontWeight: '800' }}>{sd === 'L' ? tr(t, 'games.domino.left', 'Esquerda ({n})', { n: ends ? ends[0] : '' }) : tr(t, 'games.domino.right', 'Direita ({n})', { n: ends ? ends[1] : '' })}</Text>
            </PressScale>
          ))}
        </View>
      ) : null}
      {/* minha mão */}
      {meSeat !== null && view.status === 'active' ? (
        <View style={st.hand}>
          {hand.map((tl) => {
            const can = myTurn && playMap.has(tl);
            const a = Number(tl[0]); const b = Number(tl[1]);
            return (
              <PressScale key={tl} rm={rm} disabled={!myTurn || busy} onPress={() => play(tl)} scaleTo={0.92}
                style={{ marginTop: can ? 0 : 6, marginBottom: can ? 6 : 0, opacity: myTurn && !can ? 0.45 : 1 }}
                accessibilityRole="button" accessibilityLabel={`${a} ${tr(t, 'games.domino.and', 'e')} ${b}`} accessibilityState={{ disabled: !can }}>
                <Enter fresh={ready.current && L && L.a === 'draw' && L.by === meSeat && tl === hand[hand.length - 1]} rm={rm} from={-12}>
                  <Tile a={a} b={b} u={hu} vertical dark={pal.dark} hl={pick === tl ? pal.accent : (can ? (pal.dark ? '#FFFFFF' : '#0A0A0A') : null)} />
                </Enter>
              </PressScale>
            );
          })}
        </View>
      ) : null}
      {myTurn && (S.can_draw || S.can_pass) ? (
        <View style={{ alignItems: 'center', marginTop: 10 }}>
          <PressScale rm={rm} disabled={busy} onPress={() => { hTap(); onMove({ a: S.can_draw ? 'draw' : 'pass' }); }} style={[st.cta, { backgroundColor: pal.strong }]} accessibilityRole="button">
            <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{S.can_draw ? tr(t, 'games.domino.draw', 'Comprar do monte') : tr(t, 'games.domino.pass', 'Passar a vez')}</Text>
          </PressScale>
        </View>
      ) : null}
      {view.status === 'finished' && Array.isArray(S.hands) ? (
        <View style={{ gap: 8, marginTop: 10, paddingHorizontal: 14 }}>
          {S.hands.map((h, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: pal.ink, fontWeight: '700', width: 92 }} numberOfLines={1}>{nameOf(view, (view.seats || [])[i], me, t)}</Text>
              <View style={{ flexDirection: 'row', gap: 3, flex: 1, flexWrap: 'wrap' }}>
                {h.length ? h.map((tl) => <Tile key={tl} a={Number(tl[0])} b={Number(tl[1])} u={12} vertical dark={pal.dark} />) : <Text style={{ color: pal.sub }}>{tr(t, 'games.domino.out', 'Bateu')}</Text>}
              </View>
              {Array.isArray(S.pips) ? <Text style={{ color: pal.sub, fontWeight: '700' }}>{tr(t, 'games.points', '{n} pts', { n: S.pips[i] })}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  oppRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, marginBottom: 8 },
  pile: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center' },
  table: { marginHorizontal: 8, borderRadius: 18, paddingVertical: 12, justifyContent: 'center' },
  ends: { color: 'rgba(255,255,255,0.7)', fontSize: 11.5, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  head: { fontSize: 14.5, fontWeight: '800', textAlign: 'center', marginTop: 10 },
  sub: { fontSize: 12.5, fontWeight: '600', textAlign: 'center', marginTop: 2 },
  sideRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  sideBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  hand: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 16, paddingHorizontal: 10 },
  cta: { borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12 },
});
