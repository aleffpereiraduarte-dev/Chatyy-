// components/games/boards/MemoriaBoard.js — [jogos2 2026-10-21] Jogo da Memória (8 pares, 4×4, 2 jogadores).
// O tabuleiro fica OCULTO no servidor (api/games_engine_memoria.php): a visão só traz a figura das cartas
// já formadas em par e da carta virada agora. O par errado vem no `last` (os dois viram na hora): o app mostra
// as duas por ~1,1 s e desvira. Acertou = joga de novo (o servidor mantém a vez).
// Virar = rotação 3D em Y (Reanimated, UI thread); Reduzir Movimento = troca direta. Figuras em SVG (sem emoji).
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, Easing, interpolate } from 'react-native-reanimated';
import Svg, { Path, Circle, Rect, G } from 'react-native-svg';
import { hTap, hCard, hOk, hNope } from '../fx';
import { useRM } from '../motion';
import { tr, nameOf } from '../../../services/games';

// 16 figuras (viewBox 48). Cor própria de cada uma (cartas coloridas sobre a face clara).
const ART = {
  sun: ['#F0A500', (c) => (<G><Circle cx="24" cy="24" r="9" fill={c} />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <Rect key={a} x="22.5" y="5" width="3" height="7" rx="1.5" fill={c} transform={`rotate(${a} 24 24)`} />)}</G>)],
  moon: ['#5B6CFF', (c) => <Path d="M30 8a16 16 0 1 0 10 26A13 13 0 0 1 30 8z" fill={c} />],
  star: ['#F5B700', (c) => <Path d="M24 6l5.3 11 12 1.6-8.8 8.3 2.2 11.9L24 33l-10.7 5.8 2.2-11.9-8.8-8.3 12-1.6z" fill={c} />],
  heart: ['#E5484D', (c) => <Path d="M24 40S8 30 8 18.5A8.5 8.5 0 0 1 24 14a8.5 8.5 0 0 1 16 4.5C40 30 24 40 24 40z" fill={c} />],
  leaf: ['#22A55B', (c) => <G><Path d="M10 38C10 18 22 9 40 8c0 18-10 30-30 30z" fill={c} /><Path d="M12 36L30 18" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" opacity="0.7" /></G>],
  fish: ['#1E9BD7', (c) => <G><Path d="M6 24c6-9 18-12 28-4l8-6v20l-8-6C24 36 12 33 6 24z" fill={c} /><Circle cx="15" cy="22" r="2.2" fill="#FFFFFF" /></G>],
  bolt: ['#F08C00', (c) => <Path d="M27 4L10 27h11l-3 17 18-24H25z" fill={c} />],
  drop: ['#2F80ED', (c) => <Path d="M24 6s13 15 13 24a13 13 0 0 1-26 0C11 21 24 6 24 6z" fill={c} />],
  anchor: ['#34343A', (c) => <G fill="none" stroke={c} strokeWidth="3.6" strokeLinecap="round"><Circle cx="24" cy="10" r="4" /><Path d="M24 14v26M16 21h16M9 28c2 8 8 12 15 12s13-4 15-12" /></G>],
  bell: ['#C98A00', (c) => <G><Path d="M24 7a12 12 0 0 1 12 12v8l4 7H8l4-7v-8A12 12 0 0 1 24 7z" fill={c} /><Circle cx="24" cy="38" r="4" fill={c} /></G>],
  key: ['#B7791F', (c) => <G><Circle cx="15" cy="24" r="8" fill="none" stroke={c} strokeWidth="4" /><Path d="M23 24h18M35 24v6M41 24v5" stroke={c} strokeWidth="4" strokeLinecap="round" /></G>],
  cloud: ['#6AA9D8', (c) => <Path d="M14 36a9 9 0 0 1-1-18 12 12 0 0 1 23 3 7.5 7.5 0 0 1-1 15z" fill={c} />],
  flower: ['#D9488F', (c) => (<G>{[0, 72, 144, 216, 288].map((a) => <Circle key={a} cx="24" cy="14" r="7" fill={c} transform={`rotate(${a} 24 24)`} />)}<Circle cx="24" cy="24" r="5.5" fill="#F5B700" /></G>)],
  crown: ['#E0A800', (c) => <G><Path d="M8 34l-2-20 10 8 8-13 8 13 10-8-2 20z" fill={c} /><Rect x="8" y="36" width="32" height="5" rx="2" fill={c} /></G>],
  note: ['#8B5CF6', (c) => <G><Path d="M20 34V10l18-4v24" fill="none" stroke={c} strokeWidth="4" strokeLinejoin="round" /><Circle cx="15" cy="34" r="6" fill={c} /><Circle cx="33" cy="30" r="6" fill={c} /></G>],
  gift: ['#E5484D', (c) => <G><Rect x="8" y="18" width="32" height="22" rx="3" fill={c} /><Rect x="6" y="13" width="36" height="7" rx="2" fill={c} /><Rect x="22" y="13" width="4" height="27" fill="#FFFFFF" opacity="0.85" /><Path d="M24 13c-3-6-10-6-10-2s7 2 10 2zm0 0c3-6 10-6 10-2s-7 2-10 2z" fill="none" stroke={c} strokeWidth="2.6" /></G>],
};
export function MemoriaArt({ k, size }) {
  const a = ART[k];
  if (!a) return null;
  return <Svg width={size} height={size} viewBox="0 0 48 48">{a[1](a[0])}</Svg>;
}

const Back = memo(function Back({ w, h, dark }) {
  const base = dark ? '#2A2A2E' : '#34343A';
  const line = dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.10)';
  const step = 9;
  const n = Math.ceil((w + h) / step);
  return (
    <Svg width={w} height={h}>
      <Rect x="0" y="0" width={w} height={h} rx="10" fill={base} />
      {Array.from({ length: n }).map((_, i) => <Path key={i} d={`M${i * step - h} ${h}L${i * step} 0`} stroke={line} strokeWidth="1.2" />)}
      <Rect x="4" y="4" width={w - 8} height={h - 8} rx="7" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
      <Circle cx={w / 2} cy={h / 2} r={Math.min(w, h) * 0.12} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.6" />
    </Svg>
  );
});

function Card({ i, w, h, face, up, owner, meSeat, can, onPress, rm, pal, t, gone }) {
  const f = useSharedValue(up ? 1 : 0);
  const pop = useSharedValue(1);
  useEffect(() => {
    if (rm) { f.value = up ? 1 : 0; return; }
    f.value = withTiming(up ? 1 : 0, { duration: 300, easing: Easing.out(Easing.cubic) });
  }, [up, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (owner !== null && owner !== undefined && !rm) pop.value = withSequence(withTiming(1.1, { duration: 140 }), withSpring(1, { damping: 10, stiffness: 220 }));
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const backSt = useAnimatedStyle(() => ({
    opacity: f.value < 0.5 ? 1 : 0,
    transform: [{ perspective: 600 }, { rotateY: `${interpolate(f.value, [0, 1], [0, 180])}deg` }, { scale: pop.value }],
  }));
  const faceSt = useAnimatedStyle(() => ({
    opacity: f.value >= 0.5 ? 1 : 0,
    transform: [{ perspective: 600 }, { rotateY: `${interpolate(f.value, [0, 1], [-180, 0])}deg` }, { scale: pop.value }],
  }));
  const mine = owner !== null && owner !== undefined && owner === meSeat;
  const ring = owner === null || owner === undefined ? null : (mine ? pal.ink : pal.accent);
  return (
    <Pressable disabled={!can} onPress={onPress} style={{ width: w, height: h }}
      accessibilityRole="button" accessibilityState={{ disabled: !can }}
      accessibilityLabel={up && face ? tr(t, 'games.memoria.card.' + face, face) : tr(t, 'games.memoria.cardN', 'Carta {n}', { n: i + 1 })}>
      <Animated.View style={[StyleSheet.absoluteFill, backSt]}><Back w={w} h={h} dark={pal.dark} /></Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, st.face, { backgroundColor: pal.dark ? '#ECEAE4' : '#FFFFFF', borderColor: ring || pal.line, borderWidth: ring ? 2.5 : StyleSheet.hairlineWidth, opacity: gone ? 0.82 : 1 }, faceSt]}>
        {face ? <MemoriaArt k={face} size={Math.min(w, h) * 0.62} /> : null}
      </Animated.View>
    </Pressable>
  );
}

export default function MemoriaBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const cards = Array.isArray(S.cards) ? S.cards : Array(16).fill(null);
  const cols = S.cols || 4;
  const rows = Math.ceil(cards.length / cols);
  const width = Math.min((maxW || win.width) - 32, 400, Math.round(win.height * 0.46));
  const gap = 8;
  const w = (width - gap * (cols - 1)) / cols;
  const h = Math.min(w * 1.18, w + 16);
  const legal = new Set(Array.isArray(S.legal) ? S.legal : []);
  const meSeat = view.me !== null && view.me !== undefined ? view.me : null;
  const oppSeat = meSeat === null ? 1 : 1 - meSeat;
  const myTurn = view.status === 'active' && meSeat !== null && S.turn === meSeat;
  const sc = Array.isArray(S.sc) ? S.sc : [0, 0];
  const seats = view.seats || [];
  // espiada do par errado (veio no `last`): mostra por ~1,1 s e desvira
  const [peek, setPeek] = useState(null); // {p:[i,j], k:[a,b]}
  const ready = useRef(false);
  const lastMv = useRef(S.moves || 0);
  useEffect(() => { ready.current = true; }, []);
  useEffect(() => {
    const mv = S.moves || 0;
    if (!ready.current || mv === lastMv.current) { lastMv.current = mv; return undefined; }
    lastMv.current = mv;
    const L = S.last;
    if (!L) return undefined;
    if (L.a === 'flip1') { hCard(); return undefined; }
    if (L.a === 'pair' && L.match) { hOk(); setPeek(null); return undefined; }
    if (L.a === 'pair' && !L.match && Array.isArray(L.p)) {
      hCard();
      setPeek({ p: L.p, k: L.k || [] });
      const t1 = setTimeout(() => hNope(), 520);
      const t2 = setTimeout(() => setPeek(null), 1150);
      return () => { clearTimeout(t1); clearTimeout(t2); setPeek(null); };
    }
    return undefined;
  }, [S.moves]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (seat) => (seats[seat] ? nameOf(view, seats[seat], me, t) : '');
  let headline = '';
  if (view.status === 'active') {
    if (peek) headline = tr(t, 'games.memoria.miss', 'Não formou par');
    else if (myTurn) headline = (S.up || []).length ? tr(t, 'games.memoria.pickSecond', 'Agora vire a segunda carta') : tr(t, 'games.memoria.yourTurn', 'Sua vez: vire duas cartas');
    else headline = tr(t, 'games.status.turnOf', 'Vez de {name}', { name: name(S.turn) });
  }
  return (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      <View style={[st.score, { backgroundColor: pal.card, borderColor: pal.line }]}>
        {[meSeat === null ? 0 : meSeat, oppSeat].map((seat, k) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, justifyContent: k ? 'flex-end' : 'flex-start' }}>
            {k ? null : <View style={[st.dot, { backgroundColor: pal.ink }]} />}
            <Text style={{ color: pal.ink, fontWeight: S.turn === seat && view.status === 'active' ? '800' : '600', fontSize: 13.5 }} numberOfLines={1}>{name(seat)}</Text>
            <Text style={{ color: pal.ink, fontWeight: '900', fontSize: 17, fontVariant: ['tabular-nums'] }}>{sc[seat] || 0}</Text>
            {k ? <View style={[st.dot, { backgroundColor: pal.accent }]} /> : null}
          </View>
        ))}
      </View>
      <Text style={{ color: pal.sub, fontSize: 12, fontWeight: '600', marginBottom: 8 }}>{tr(t, 'games.memoria.left', 'Faltam {n} pares', { n: S.pairs_left ?? 8 })}</Text>
      <View style={{ width, height: rows * h + (rows - 1) * gap }}>
        {cards.map((c, i) => {
          const pk = peek && peek.p.indexOf(i);
          const peeking = peek && pk >= 0;
          const face = c ? c.k : (peeking ? peek.k[pk] : null);
          const up = !!c || !!peeking;
          return (
            <View key={i} style={{ position: 'absolute', left: (i % cols) * (w + gap), top: Math.floor(i / cols) * (h + gap) }}>
              <Card i={i} w={w} h={h} face={face} up={up} owner={c && c.by !== undefined ? c.by : null} meSeat={meSeat} rm={rm} pal={pal} t={t} gone={!!(c && c.by !== undefined)}
                can={myTurn && !busy && !peek && legal.has(i)} onPress={() => { hTap(); onMove({ a: 'flip', i }); }} />
            </View>
          );
        })}
      </View>
      {headline ? <Text style={[st.head, { color: myTurn && !peek ? pal.ink : pal.sub }]}>{headline}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  score: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 9, marginBottom: 6, width: '92%', maxWidth: 400 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  face: { borderRadius: 10, alignItems: 'center', justifyContent: 'center', backfaceVisibility: 'hidden' },
  head: { fontSize: 14.5, fontWeight: '800', textAlign: 'center', marginTop: 12 },
});
