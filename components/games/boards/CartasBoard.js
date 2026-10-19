// components/games/boards/CartasBoard.js — [jogos 2026-10-18] "Cartas Coloridas" (descarte por cor ou número).
// Arte e nome ORIGINAIS. Mão em leque embaixo (jogáveis sobem), monte para comprar, mesa com a cor atual.
// O servidor manda só a MINHA mão (`hand`), as jogáveis (`playable`) e a contagem dos outros (`counts`).
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, withSequence, withDelay } from 'react-native-reanimated';
import Svg, { Path, Circle, Rect, G } from 'react-native-svg';
import { CARD_COLORS, hTap, hCard, hDraw } from '../fx';
import { tr, nameOf } from '../../../services/games';

const COLOR_NAME_FB = { r: 'Vermelho', y: 'Amarelo', g: 'Verde', b: 'Azul' };
export function colorName(t, c) { return tr(t, 'games.cartas.color.' + c, COLOR_NAME_FB[c] || c); }
export function cardLabel(t, code) {
  if (!code) return '';
  if (code === 'WW') return tr(t, 'games.cartas.wild', 'Coringa');
  if (code === 'W4') return tr(t, 'games.cartas.wild4', 'Coringa +4');
  const v = code.slice(1);
  const vl = v === 'S' ? tr(t, 'games.cartas.skip', 'Pular') : v === 'R' ? tr(t, 'games.cartas.reverse', 'Inverter') : v === 'D' ? '+2' : v;
  return `${vl} ${colorName(t, code[0]).toLowerCase()}`;
}

function Glyph({ v, size, color }) {
  if (v === 'S') {
    return (<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round"><Circle cx="12" cy="12" r="8" /><Path d="M6.5 17.5l11-11" /></Svg>);
  }
  if (v === 'R') {
    return (<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 9h11l-3-3" /><Path d="M19 15H8l3 3" /></Svg>);
  }
  if (v === 'W' || v === '4') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <G>
          <Path d="M12 12V3a9 9 0 0 1 9 9z" fill={CARD_COLORS.r} />
          <Path d="M12 12h9a9 9 0 0 1-9 9z" fill={CARD_COLORS.b} />
          <Path d="M12 12v9a9 9 0 0 1-9-9z" fill={CARD_COLORS.g} />
          <Path d="M12 12H3a9 9 0 0 1 9-9z" fill={CARD_COLORS.y} />
        </G>
        <Circle cx="12" cy="12" r="9" fill="none" stroke="#FFFFFF" strokeWidth={1.4} />
      </Svg>
    );
  }
  return null;
}

export function CardFace({ code, w = 62, h = 92, dim }) {
  const wild = code && code[0] === 'W';
  const v = code ? code.slice(1) : '';
  const bg = wild ? '#0A0A0A' : (CARD_COLORS[code && code[0]] || '#777');
  const center = v === 'D' ? '+2' : (/^\d$/.test(v) ? v : null);
  const corner = v === 'D' ? '+2' : v === '4' ? '+4' : v === 'W' ? '' : v === 'S' ? '' : v === 'R' ? '' : v;
  return (
    <View style={{ width: w, height: h, borderRadius: w * 0.14, backgroundColor: '#FFFFFF', padding: 3, opacity: dim ? 0.5 : 1,
      shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 }}>
      <View style={{ flex: 1, borderRadius: w * 0.11, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: w * 0.16, right: w * 0.16, top: h * 0.2, bottom: h * 0.2, borderRadius: w * 0.12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)' }} />
        {center ? <Text style={{ color: '#FFFFFF', fontSize: w * 0.46, fontWeight: '900' }}>{center}</Text> : <Glyph v={v} size={w * 0.52} color="#FFFFFF" />}
        {v === '4' ? <Text style={{ position: 'absolute', bottom: h * 0.24, color: '#FFFFFF', fontSize: w * 0.2, fontWeight: '900' }}>+4</Text> : null}
        {corner ? <Text style={{ position: 'absolute', top: 3, left: 5, color: '#FFFFFF', fontSize: w * 0.17, fontWeight: '900' }}>{corner}</Text> : null}
        {corner ? <Text style={{ position: 'absolute', bottom: 3, right: 5, color: '#FFFFFF', fontSize: w * 0.17, fontWeight: '900', transform: [{ rotate: '180deg' }] }}>{corner}</Text> : null}
      </View>
    </View>
  );
}
export function CardBack({ w = 62, h = 92 }) {
  return (
    <View style={{ width: w, height: h, borderRadius: w * 0.14, backgroundColor: '#FFFFFF', padding: 3,
      shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 3 }}>
      <View style={{ flex: 1, borderRadius: w * 0.11, backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={w * 0.7} height={h * 0.62} viewBox="0 0 40 56">
          <Rect x="6" y="8" width="28" height="40" rx="6" fill="none" stroke="#FFFFFF" strokeWidth="1.6" opacity="0.8" />
          <Path d="M20 14l9 14-9 14-9-14z" fill="none" stroke="#FFFFFF" strokeWidth="1.6" />
          <Circle cx="20" cy="28" r="3.2" fill="#FFFFFF" />
        </Svg>
      </View>
    </View>
  );
}

function HandCard({ code, x, y, rot, playable, myTurn, onPress, w, h, drawn, delay }) {
  const lift = useSharedValue(0);
  const enter = useSharedValue(0);
  useEffect(() => { enter.value = withDelay(delay || 0, withSpring(1, { damping: 16, stiffness: 140 })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lift.value = withSpring(playable ? -18 : 0, { damping: 15, stiffness: 180 }); }, [playable]); // eslint-disable-line react-hooks/exhaustive-deps
  // entra "voando" do monte (distribuição / compra) e sobe quando é jogável
  const st = useAnimatedStyle(() => ({ opacity: enter.value, transform: [{ translateY: lift.value - (1 - enter.value) * 220 }, { scale: 0.7 + 0.3 * enter.value }] }));
  return (
    <View style={{ position: 'absolute', left: x, bottom: 8 - y, transform: [{ rotate: `${rot}deg` }] }}>
      <Animated.View style={st}>
        <Pressable disabled={!playable} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled: !playable }}>
          <CardFace code={code} w={w} h={h} dim={myTurn && !playable} />
          {drawn ? <View style={{ position: 'absolute', left: -3, right: -3, top: -3, bottom: -3, borderRadius: w * 0.16, borderWidth: 2.5, borderColor: '#FFD60A' }} /> : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

function Pile({ top, color, k, pal, othersPlayed }) {
  const sc = useSharedValue(1);
  const rot = useSharedValue(0);
  const first = React.useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (othersPlayed) { try { require('../sound').playSfx('card'); } catch {} }
    rot.value = withSequence(withTiming((Math.random() - 0.5) * 16, { duration: 1 }), withSpring(0, { damping: 11 }));
    sc.value = withSequence(withTiming(1.16, { duration: 110 }), withSpring(1, { damping: 12 }));
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }, { rotate: `${rot.value}deg` }] }));
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ padding: 5, borderRadius: 16, borderWidth: 3, borderColor: CARD_COLORS[color] || pal.line }}>
        <Animated.View style={st}><CardFace code={top} w={74} h={110} /></Animated.View>
      </View>
    </View>
  );
}

export default function CartasBoard({ view, onMove, pal, busy, t, me }) {
  const { width } = useWindowDimensions();
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const hand = Array.isArray(S.hand) ? S.hand : [];
  const playable = new Set(Array.isArray(S.playable) ? S.playable : []);
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const [wildFor, setWildFor] = useState(null);
  const dealtRef = React.useRef(false);
  useEffect(() => { const tm = setTimeout(() => { dealtRef.current = true; }, 900); return () => clearTimeout(tm); }, []);
  const counts = Array.isArray(S.counts) ? S.counts : [];

  const play = (code) => {
    if (busy) return;
    if (code === 'WW' || code === 'W4') { hTap(); setWildFor(code); return; }
    hCard(); onMove({ a: 'play', card: code });
  };
  const chooseColor = (c) => { const code = wildFor; setWildFor(null); hCard(); onMove({ a: 'play', card: code, color: c }); };

  // leque
  const W = Math.min(width - 16, 520);
  const cw = 62; const ch = 92;
  const n = hand.length;
  const step = n > 1 ? Math.min(44, (W - cw) / (n - 1)) : 0;
  const total = cw + step * Math.max(0, n - 1);
  const x0 = (W - total) / 2;
  const angle = Math.min(5, 36 / Math.max(1, n));

  // último lance em texto
  let lastTx = '';
  const L = S.last;
  if (L && L.by !== undefined && seats[L.by]) {
    const who = nameOf(view, seats[L.by], me, t);
    if (L.a === 'play') lastTx = tr(t, 'games.cartas.lastPlay', '{name} jogou {card}', { name: who, card: cardLabel(t, L.card) });
    else if (L.a === 'draw') lastTx = tr(t, 'games.cartas.lastDraw', '{name} comprou', { name: who });
    else if (L.a === 'pass') lastTx = tr(t, 'games.cartas.lastPass', '{name} passou', { name: who });
    else if (L.a === 'resign') lastTx = tr(t, 'games.lastResign', '{name} saiu da partida', { name: who });
    else if (L.a === 'afk') lastTx = tr(t, 'games.lastAfk', '{name} demorou e a vez passou', { name: who });
    else if (L.a === 'afk_out') lastTx = tr(t, 'games.lastAfkOut', '{name} saiu por ausência', { name: who });
    if (L.victim !== undefined && seats[L.victim] && L.drew) lastTx += ' · ' + tr(t, 'games.cartas.victim', '{name} comprou {n}', { name: nameOf(view, seats[L.victim], me, t), n: L.drew });
    if ((L.card === 'WW' || L.card === 'W4') && L.color) lastTx += ' · ' + colorName(t, L.color);
  }

  return (
    <View style={{ flex: 1 }}>
      {/* adversários */}
      <View style={st.opps}>
        {seats.map((e, i) => {
          if (i === view.me) return null;
          const turn = view.status === 'active' && S.turn === i;
          const out = Array.isArray(S.out) && S.out[i];
          return (
            <View key={e} style={[st.opp, { borderColor: turn ? pal.strong : pal.line, backgroundColor: pal.card, opacity: out ? 0.4 : 1 }]}>
              <View style={{ flexDirection: 'row', height: 30, width: 18 + Math.min(counts[i] || 0, 6) * 5 }}>
                {Array.from({ length: Math.min(counts[i] || 0, 6) }).map((_, k) => (
                  <View key={k} style={{ position: 'absolute', left: k * 5 }}><CardBack w={18} h={27} /></View>
                ))}
              </View>
              <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 12.5, maxWidth: 90 }} numberOfLines={1}>{nameOf(view, e, me, t)}</Text>
              <Text style={{ color: pal.sub, fontSize: 11.5 }}>{tr(t, 'games.cartas.nCards', '{n} cartas', { n: counts[i] || 0 })}</Text>
            </View>
          );
        })}
      </View>

      {/* mesa */}
      <View style={st.table}>
        <Pressable disabled={!S.can_draw || busy} onPress={() => { hDraw(); onMove({ a: 'draw' }); }} accessibilityRole="button"
          accessibilityLabel={tr(t, 'games.cartas.draw', 'Comprar')} style={{ alignItems: 'center' }}>
          <View>
            <View style={{ position: 'absolute', left: 4, top: 4 }}><CardBack w={74} h={110} /></View>
            <View style={{ position: 'absolute', left: 2, top: 2 }}><CardBack w={74} h={110} /></View>
            <CardBack w={74} h={110} />
          </View>
          <Text style={{ color: S.can_draw ? pal.ink : pal.sub, fontWeight: '800', marginTop: 8, fontSize: 13 }}>
            {S.can_draw ? tr(t, 'games.cartas.draw', 'Comprar') : tr(t, 'games.cartas.deck', 'Monte ({n})', { n: S.deck || 0 })}
          </Text>
        </Pressable>
        <View style={{ alignItems: 'center' }}>
          {S.top ? <Pile top={S.top} color={S.color} k={`${S.top}-${S.moves}`} pal={pal} othersPlayed={!!(S.last && S.last.a === 'play' && S.last.by !== view.me)} /> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: CARD_COLORS[S.color] || pal.sub }} />
            <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13 }}>{colorName(t, S.color)}</Text>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={pal.sub} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: [{ scaleX: S.dir === -1 ? -1 : 1 }] }}>
              <Path d="M20 12a8 8 0 1 1-2.3-5.7" /><Path d="M20 4v4h-4" />
            </Svg>
          </View>
        </View>
      </View>
      {lastTx ? <Text style={[st.last, { color: pal.sub }]} numberOfLines={2}>{lastTx}</Text> : null}
      {S.can_pass ? (
        <Pressable onPress={() => { hTap(); onMove({ a: 'pass' }); }} disabled={busy} style={[st.passBtn, { borderColor: pal.strong }]} accessibilityRole="button">
          <Text style={{ color: pal.ink, fontWeight: '800' }}>{tr(t, 'games.cartas.pass', 'Passar a vez')}</Text>
        </Pressable>
      ) : null}

      {/* mão */}
      {view.me !== null && view.me !== undefined ? (
        <View style={{ height: ch + 44, width: W, alignSelf: 'center', marginTop: 'auto' }}>
          {hand.map((code, i) => {
            const off = i - (n - 1) / 2;
            const occ = hand.slice(0, i).filter((c) => c === code).length; // chave estável por exemplar
            return (
              <HandCard key={code + '#' + occ} code={code} w={cw} h={ch} delay={dealtRef.current ? 0 : i * 70}
                x={x0 + i * step} y={Math.abs(off) * Math.abs(off) * 0.9} rot={off * angle}
                playable={myTurn && playable.has(code)} myTurn={myTurn} drawn={S.drawn === code && i === hand.lastIndexOf(code)}
                onPress={() => play(code)} />
            );
          })}
        </View>
      ) : (
        <Text style={[st.last, { color: pal.sub, marginTop: 'auto', marginBottom: 20 }]}>{tr(t, 'games.spectating', 'Você está assistindo')}</Text>
      )}

      <Modal visible={!!wildFor} transparent animationType="fade" onRequestClose={() => setWildFor(null)}>
        <Pressable style={st.backdrop} onPress={() => setWildFor(null)}>
          <View style={[st.colorBox, { backgroundColor: pal.bg }]}>
            <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 16, marginBottom: 14 }}>{tr(t, 'games.cartas.pickColor', 'Escolha a cor')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'center' }}>
              {['r', 'y', 'g', 'b'].map((c) => (
                <Pressable key={c} onPress={() => chooseColor(c)} style={{ alignItems: 'center', width: 70 }} accessibilityRole="button" accessibilityLabel={colorName(t, c)}>
                  <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: CARD_COLORS[c], borderWidth: 3, borderColor: '#fff' }} />
                  <Text style={{ color: pal.ink, marginTop: 6, fontWeight: '600' }}>{colorName(t, c)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  opps: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 6 },
  opp: { alignItems: 'center', borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, minWidth: 86 },
  table: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 34, marginTop: 18 },
  last: { textAlign: 'center', marginTop: 12, fontSize: 13, paddingHorizontal: 20 },
  passBtn: { alignSelf: 'center', marginTop: 10, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  colorBox: { borderRadius: 20, padding: 20, width: 320, alignItems: 'center' },
});
