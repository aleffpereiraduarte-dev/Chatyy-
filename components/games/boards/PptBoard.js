// components/games/boards/PptBoard.js — [jogos2b 2026-10-21] Pedra, papel e tesoura, melhor de 3.
// Jogada SECRETA: o servidor só manda "o outro já escolheu" (nunca o quê) até os dois escolherem; aí
// revela as duas juntas. Revelação animada (Reanimated, UI thread): as duas mãos entram dos lados e
// "viram"; vencedor da rodada pulsa. Reduzir Movimento = revelação direta.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence, withSpring, Easing } from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import { tr, nameOf } from '../../../services/games';
import { hTap, hWin, hErr, hReveal } from '../fx';
import { PressScale, useRM } from '../motion';

const CHOICES = ['r', 'p', 's'];

/** Glifo de cada jogada (traço). */
export function HandGlyph({ c, size = 48, color }) {
  const sw = 2.2;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {c === 'r' ? (
        <>
          <Path d="M12 24c0-6 4-10 9-10h7c6 0 10 4 10 10v3c0 6-5 11-11 11h-4c-6 0-11-5-11-11z" />
          <Path d="M17 19c1.5-1.5 3.5-2 5-1.5M24 17c1.5-1 3.5-1 5 0M30 18c1.5-.5 3 0 4 1.5" />
          <Path d="M16 30c2 2 5 3 8 3" />
        </>
      ) : c === 'p' ? (
        <>
          <Path d="M13 10h17l6 6v22H13z" />
          <Path d="M30 10v6h6" />
          <Path d="M18 21h13M18 26h13M18 31h9" />
        </>
      ) : (
        <>
          <Circle cx="15" cy="34" r="5" />
          <Circle cx="29" cy="36" r="5" />
          <Path d="M18.5 30.5L36 9M25.5 32L20 10" />
        </>
      )}
    </Svg>
  );
}

function Choice({ c, label, onPress, chosen, dim, disabled, pal, rm, size }) {
  return (
    <PressScale disabled={disabled} onPress={onPress} rm={rm} scaleTo={0.92}
      style={[sx.choice, { width: size, backgroundColor: chosen ? pal.strong : pal.card, borderColor: chosen ? pal.strong : pal.line, opacity: dim ? 0.4 : 1 }]}
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!chosen, disabled: !!disabled }}>
      <HandGlyph c={c} size={Math.round(size * 0.52)} color={chosen ? pal.onStrong : pal.ink} />
      <Text style={{ color: chosen ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 13.5, marginTop: 4 }}>{label}</Text>
    </PressScale>
  );
}

/** Revelação: as duas jogadas entram dos lados, viram e o vencedor pulsa. */
function Reveal({ rev, meSeat, pal, rm, t, oppName }) {
  const a = useSharedValue(rm ? 1 : 0);
  const w = useSharedValue(1);
  useEffect(() => {
    if (rm) { a.value = 1; return; }
    a.value = 0;
    a.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.back(1.4)) });
    w.value = withDelay(560, withSequence(withTiming(1.16, { duration: 160 }), withSpring(1, { damping: 9, stiffness: 180 })));
  }, [rev.k]); // eslint-disable-line react-hooks/exhaustive-deps
  const L = useAnimatedStyle(() => ({ opacity: a.value, transform: [{ translateX: -60 * (1 - a.value) }, { perspective: 400 }, { rotateY: `${(1 - a.value) * 90}deg` }] }));
  const R = useAnimatedStyle(() => ({ opacity: a.value, transform: [{ translateX: 60 * (1 - a.value) }, { perspective: 400 }, { rotateY: `${(a.value - 1) * 90}deg` }] }));
  const winSt = useAnimatedStyle(() => ({ transform: [{ scale: w.value }] }));
  const mineC = rev.c[meSeat === 1 ? 1 : 0]; const theirC = rev.c[meSeat === 1 ? 0 : 1];
  const myWin = rev.w !== null && rev.w === (meSeat === 1 ? 1 : 0);
  const theirWin = rev.w !== null && !myWin;
  const box = (c, won, st, who) => (
    <Animated.View style={[sx.revBox, { backgroundColor: won ? pal.strong : pal.card, borderColor: won ? pal.strong : pal.line }, st]}>
      <Animated.View style={won ? winSt : null}><HandGlyph c={c} size={54} color={won ? pal.onStrong : pal.ink} /></Animated.View>
      <Text style={{ color: won ? pal.onStrong : pal.sub, fontWeight: '700', fontSize: 12, marginTop: 4 }} numberOfLines={1}>{who}</Text>
    </Animated.View>
  );
  const msg = rev.w === null ? tr(t, 'games.ppt.tie', 'Empate na rodada: joga de novo')
    : myWin ? tr(t, 'games.ppt.youWonRound', 'Você levou a rodada') : tr(t, 'games.ppt.theyWonRound', '{name} levou a rodada', { name: oppName });
  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        {box(mineC, myWin, L, tr(t, 'games.you', 'Você'))}
        <Text style={{ color: pal.sub, fontWeight: '900', fontSize: 12, letterSpacing: 1 }}>VS</Text>
        {box(theirC, theirWin, R, oppName)}
      </View>
      <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 15 }}>{msg}</Text>
    </View>
  );
}

export default function PptBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const W = Math.min(maxW || win.width, 520) - 24;
  const meSeat = view.me;
  const isPlayer = meSeat !== null && meSeat !== undefined;
  const oSeat = isPlayer ? 1 - meSeat : 1;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const oppName = seats[oSeat] ? nameOf(view, seats[oSeat], me, t) : '';
  const sc = Array.isArray(S.sc) ? S.sc : [0, 0];
  const hist = Array.isArray(S.hist) ? S.hist : [];
  const picked = Array.isArray(S.picked) ? S.picked : [false, false];
  const active = view.status === 'active';
  const [optimistic, setOptimistic] = useState(null);
  const my = S.my || optimistic;
  // revelação: mostra a última rodada por ~2,2 s quando chega uma nova
  const [rev, setRev] = useState(null);
  const nHist = useRef(hist.length);
  useEffect(() => {
    if (hist.length > nHist.current) {
      const h = hist[hist.length - 1];
      setOptimistic(null);
      setRev({ ...h, k: hist.length });
      hReveal();
      const mine = isPlayer ? meSeat : 0;
      setTimeout(() => { if (h.w === null) hTap(); else if (h.w === mine) hWin(); else hErr(); }, rm ? 0 : 560);
      const tm = setTimeout(() => setRev(null), 2400);
      nHist.current = hist.length;
      return () => clearTimeout(tm);
    }
    nHist.current = hist.length;
    return undefined;
  }, [hist.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = { r: tr(t, 'games.ppt.rock', 'Pedra'), p: tr(t, 'games.ppt.paper', 'Papel'), s: tr(t, 'games.ppt.scissors', 'Tesoura') };
  const pick = async (c) => {
    if (!isPlayer || !active || my || busy) return;
    hTap();
    setOptimistic(c);
    const ok = await onMove({ a: 'pick', r: S.r, c });
    if (!ok) setOptimistic(null);
  };
  const size = Math.min(110, Math.floor((W - 20) / 3));
  const a = isPlayer ? sc[meSeat] : sc[0]; const b = isPlayer ? sc[oSeat] : sc[1];
  const lastRev = !active && hist.length ? { ...hist[hist.length - 1], k: 'end' } : null;

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 14, alignItems: 'center' }}>
      <View style={[sx.score, { backgroundColor: pal.card }]}>
        <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13.5 }}>{isPlayer ? tr(t, 'games.you', 'Você') : (seats[0] ? nameOf(view, seats[0], me, t) : '')}</Text>
        <Text style={{ color: pal.ink, fontWeight: '900', fontSize: 24, fontVariant: ['tabular-nums'] }}>{a}<Text style={{ color: pal.sub, fontWeight: '600' }}> x </Text>{b}</Text>
        <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13.5 }} numberOfLines={1}>{oppName}</Text>
      </View>
      <Text style={{ color: pal.sub, fontSize: 12.5, fontWeight: '700' }}>
        {tr(t, 'games.ppt.round', 'Rodada {r} · melhor de 3', { r: (S.r || 0) + (active ? 1 : 0) })}
      </Text>
      {rev || lastRev ? <Reveal rev={rev || lastRev} meSeat={meSeat} pal={pal} rm={rm} t={t} oppName={oppName} /> : null}
      {active && !rev ? (
        <>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {CHOICES.map((c) => (
              <Choice key={c} c={c} label={label[c]} size={size} pal={pal} rm={rm} chosen={my === c} dim={!!my && my !== c}
                disabled={!isPlayer || !!my || busy} onPress={() => pick(c)} />
            ))}
          </View>
          <Text style={{ color: pal.sub, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>
            {!isPlayer ? tr(t, 'games.spectating', 'Você está assistindo')
              : my ? (picked[oSeat] ? tr(t, 'games.ppt.revealing', 'Revelando...') : tr(t, 'games.ppt.waitOther', 'Escolha feita. Aguardando {name}', { name: oppName }))
                : (picked[oSeat] ? tr(t, 'games.ppt.otherPicked', '{name} já escolheu. Sua vez!', { name: oppName }) : tr(t, 'games.ppt.pickSecret', 'Escolha em segredo'))}
          </Text>
        </>
      ) : null}
      {hist.length ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          {hist.map((h, i) => {
            const mine = isPlayer ? meSeat : 0;
            const res = h.w === null ? '=' : (h.w === mine ? '+' : '−');
            return (
              <View key={i} style={[sx.chip, { backgroundColor: h.w === null ? pal.card2 : (h.w === mine ? 'rgba(47,179,107,0.16)' : 'rgba(229,72,77,0.13)') }]}>
                <HandGlyph c={h.c[mine]} size={16} color={pal.ink} />
                <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 12 }}>{res}</Text>
                <HandGlyph c={h.c[1 - mine]} size={16} color={pal.sub} />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const sx = StyleSheet.create({
  score: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8, minWidth: 240 },
  choice: { borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
  revBox: { width: 104, borderRadius: 20, borderWidth: 1, alignItems: 'center', paddingVertical: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 4 },
});
