// components/games/boards/QuizBoard.js — [jogos 2026-10-18] Quiz: todos respondem ao mesmo tempo.
// O relógio é o do SERVIDOR (view.now → offset); a resposta certa só chega na revelação (ph 'r').
// Quando o prazo/revelação vence, o app pede o avanço (onTick) — o servidor confere o horário.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing, cancelAnimation } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { hTap, hOk, hErr } from '../fx';
import { tr, nameOf } from '../../../services/games';

const LETTERS = ['A', 'B', 'C', 'D'];

function TimerBar({ t0, dl, offset, pal, running }) {
  const w = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(w);
    const now = Date.now() + offset;
    const total = Math.max(1, dl - t0);
    const left = Math.max(0, dl - now);
    w.value = left / total;
    if (running && left > 0) w.value = withTiming(0, { duration: left, easing: Easing.linear });
  }, [t0, dl, running]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ width: `${Math.max(0, Math.min(1, w.value)) * 100}%` }));
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: pal.card2, overflow: 'hidden' }}>
      <Animated.View style={[{ height: 6, borderRadius: 3, backgroundColor: pal.strong }, st]} />
    </View>
  );
}

export default function QuizBoard({ view, onMove, pal, t, me, offset, onTick }) {
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const isPlayer = view.me !== null && view.me !== undefined && !(S.out && S.out[view.me]);
  const [pending, setPending] = useState(null);
  const [secs, setSecs] = useState(0);
  const lastTickAsk = useRef(0);
  const qKey = `${S.i}-${S.ph}`;
  useEffect(() => { setPending(null); }, [S.i]);
  const revealHapticDone = useRef('');
  useEffect(() => {
    if (S.ph === 'r' && S.my && revealHapticDone.current !== qKey) {
      revealHapticDone.current = qKey;
      if (S.my.c === S.a) hOk(); else hErr();
    }
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // relógio local alinhado ao servidor + pedido de avanço quando o prazo vence
  useEffect(() => {
    if (view.status !== 'active') return undefined;
    const iv = setInterval(() => {
      const now = Date.now() + offset;
      if (S.ph === 'q') setSecs(Math.max(0, Math.ceil((S.dl - now) / 1000)));
      const due = (S.ph === 'q' && now > S.dl + 250) || (S.ph === 'r' && now > S.rv + 150);
      if (due && Date.now() - lastTickAsk.current > 1500) { lastTickAsk.current = Date.now(); try { onTick && onTick(); } catch {} }
    }, 250);
    return () => clearInterval(iv);
  }, [view.status, S.ph, S.dl, S.rv, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const myChoice = S.my ? S.my.c : pending;
  const answeredN = Array.isArray(S.answered) ? S.answered.filter(Boolean).length : 0;
  const activeN = seats.filter((_, i) => !(S.out && S.out[i])).length;
  const answer = async (c) => {
    if (!isPlayer || S.ph !== 'q' || myChoice !== null && myChoice !== undefined) return;
    hTap(); setPending(c);
    const ok = await onMove({ a: 'answer', q: S.i, c });
    if (!ok) setPending(null);
  };
  const ranking = seats.map((e, i) => ({ e, i, sc: (S.sc || [])[i] || 0 })).sort((a, b) => b.sc - a.sc);

  return (
    <View style={{ paddingHorizontal: 16, flex: 1 }}>
      <View style={st.topRow}>
        <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 12.5 }}>{tr(t, 'games.quiz.progress', 'Pergunta {i} de {n}', { i: (S.i || 0) + 1, n: S.count || 10 })}</Text>
        <View style={[st.cat, { borderColor: pal.line }]}><Text style={{ color: pal.ink, fontSize: 11.5, fontWeight: '700' }}>{S.cat}</Text></View>
        <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 14, minWidth: 30, textAlign: 'right' }}>{S.ph === 'q' ? `${secs}s` : ''}</Text>
      </View>
      <TimerBar t0={S.t0} dl={S.dl} offset={offset} pal={pal} running={S.ph === 'q'} />
      <Text style={[st.q, { color: pal.ink }]}>{S.q}</Text>
      {(S.o || []).map((o, i) => {
        const reveal = S.ph !== 'q';
        const right = reveal && i === S.a;
        const mineWrong = reveal && myChoice === i && i !== S.a;
        const chosen = myChoice === i;
        const bg = right ? pal.good : (chosen && !reveal ? pal.strong : pal.card);
        const fg = right ? '#FFFFFF' : (chosen && !reveal ? pal.onStrong : pal.ink);
        const who = reveal && Array.isArray(S.res) ? S.res.map((x, k) => (x && x.c === i ? k : -1)).filter((k) => k >= 0) : [];
        return (
          <Pressable key={i} onPress={() => answer(i)} disabled={!isPlayer || S.ph !== 'q' || (myChoice !== null && myChoice !== undefined)}
            style={({ pressed }) => [st.opt, { backgroundColor: bg, borderColor: mineWrong ? pal.bad : (right ? pal.good : pal.line), borderWidth: mineWrong ? 2 : 1 }, pressed && { opacity: 0.8 }]}
            accessibilityRole="button" accessibilityLabel={`${LETTERS[i]}. ${o}`}>
            <View style={[st.letter, { backgroundColor: right ? 'rgba(255,255,255,0.22)' : (chosen && !reveal ? 'rgba(127,127,127,0.25)' : pal.card2) }]}>
              <Text style={{ color: fg, fontWeight: '900' }}>{LETTERS[i]}</Text>
            </View>
            <Text style={{ flex: 1, color: fg, fontSize: 15.5, fontWeight: '600' }}>{o}</Text>
            {right ? <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12.5l4.5 4.5L19 7.5" /></Svg> : null}
            {mineWrong ? <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={pal.bad} strokeWidth={3} strokeLinecap="round"><Path d="M6 6l12 12M18 6L6 18" /></Svg> : null}
            {who.length ? <Text style={{ color: right ? '#fff' : pal.sub, fontSize: 11, fontWeight: '700' }}>{who.length}</Text> : null}
          </Pressable>
        );
      })}
      <Text style={[st.hint, { color: pal.sub }]}>
        {S.ph === 'q'
          ? (myChoice !== null && myChoice !== undefined ? tr(t, 'games.quiz.waiting', 'Resposta enviada. {a} de {n} já responderam', { a: answeredN, n: activeN }) : (isPlayer ? tr(t, 'games.quiz.answerFast', 'Responda rápido: vale mais pontos') : tr(t, 'games.spectating', 'Você está assistindo')))
          : (S.my && S.my.pts !== undefined ? (S.my.pts > 0 ? tr(t, 'games.quiz.gotPts', 'Certa! +{n} pontos', { n: S.my.pts }) : tr(t, 'games.quiz.wrong', 'Não foi desta vez')) : tr(t, 'games.quiz.next', 'Próxima pergunta já vem'))}
      </Text>
      <View style={[st.board, { borderColor: pal.line }]}>
        {ranking.map((r, k) => {
          const res = S.ph !== 'q' && Array.isArray(S.res) ? S.res[r.i] : null;
          return (
            <View key={r.e} style={st.rankRow}>
              <Text style={{ color: pal.sub, width: 18, fontWeight: '800' }}>{k + 1}</Text>
              <Text style={{ color: pal.ink, flex: 1, fontWeight: r.i === view.me ? '800' : '600' }} numberOfLines={1}>{nameOf(view, r.e, me, t)}</Text>
              {S.ph === 'q' && Array.isArray(S.answered) && S.answered[r.i] ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.strong, marginRight: 8 }} /> : null}
              {res && res.pts > 0 ? <Text style={{ color: pal.good, fontWeight: '800', marginRight: 8, fontSize: 12.5 }}>+{res.pts}</Text> : null}
              <Text style={{ color: pal.ink, fontWeight: '800' }}>{r.sc}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8 },
  cat: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 'auto' },
  q: { fontSize: 20, fontWeight: '800', lineHeight: 26, marginTop: 16, marginBottom: 14 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 9 },
  letter: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  hint: { textAlign: 'center', marginTop: 6, fontSize: 13 },
  board: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 14, paddingTop: 8 },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
});
