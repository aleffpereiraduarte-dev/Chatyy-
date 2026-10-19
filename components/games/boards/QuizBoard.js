// components/games/boards/QuizBoard.js — [jogos 2026-10-18] Quiz: todos respondem ao mesmo tempo.
// O relógio é o do SERVIDOR (view.now → offset); a resposta certa só chega na revelação (ph 'r').
// Quando o prazo/revelação vence, o app pede o avanço (onTick) — o servidor confere o horário.
// Polish 2: pergunta entra deslizando (e as opções em cascata), anel de contagem regressiva (fica
// vermelho nos últimos segundos), opções com afundar no toque, revelação animada (certa acende e
// pulsa, errada treme), mini-placar ao vivo que REORDENA animado (setas de quem subiu) + "+pts".
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedProps, withTiming, withSpring, withDelay, withSequence, Easing, cancelAnimation } from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import { hTap, hOk, hErr, hReveal } from '../fx';
import { tr, nameOf } from '../../../services/games';
import { PressScale, ACircle, shake, pop, useRM, useEnter, IS_WEB } from '../motion';

const LETTERS = ['A', 'B', 'C', 'D'];
const RING = 46;
const ROW_H = 34;

function CountdownRing({ t0, dl, offset, pal, running, secs }) {
  const r = RING / 2 - 4;
  const C = 2 * Math.PI * r;
  const f = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(f);
    const now = Date.now() + offset;
    const total = Math.max(1, dl - t0);
    const left = Math.max(0, dl - now);
    f.value = running ? left / total : 0;
    if (running && left > 0) f.value = withTiming(0, { duration: left, easing: Easing.linear });
  }, [t0, dl, running]); // eslint-disable-line react-hooks/exhaustive-deps
  const inkP = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - f.value) }));
  const badP = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - f.value), opacity: f.value < 0.3 && f.value > 0 ? Math.min(1, (0.3 - f.value) * 10) : 0 }));
  const total = Math.max(1, (dl - t0) / 1000);
  const webFrac = running ? Math.max(0, Math.min(1, secs / total)) : 0;
  const low = running && secs <= 3;
  return (
    <View style={{ width: RING, height: RING, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="timer" accessibilityLabel={`${secs}s`}>
      <Svg width={RING} height={RING} style={StyleSheet.absoluteFill}>
        <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={pal.card2} strokeWidth={4} fill="none" />
        {IS_WEB ? (
          <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={low ? pal.bad : pal.strong} strokeWidth={4} fill="none" strokeLinecap="round"
            strokeDasharray={[C, C]} strokeDashoffset={C * (1 - webFrac)} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} />
        ) : (
          <>
            <ACircle cx={RING / 2} cy={RING / 2} r={r} stroke={pal.strong} strokeWidth={4} fill="none" strokeLinecap="round"
              strokeDasharray={[C, C]} animatedProps={inkP} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} />
            <ACircle cx={RING / 2} cy={RING / 2} r={r} stroke={pal.bad} strokeWidth={4} fill="none" strokeLinecap="round"
              strokeDasharray={[C, C]} animatedProps={badP} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} />
          </>
        )}
      </Svg>
      <Text style={{ color: low ? pal.bad : pal.ink, fontWeight: '900', fontSize: 15, fontVariant: ['tabular-nums'] }}>{running ? secs : ''}</Text>
    </View>
  );
}

function Option({ i, text, qi, ph, chosen, right, mineWrong, dim, count, disabled, onPress, pal, rm }) {
  const enter = useSharedValue(rm ? 1 : 0);
  const glow = useSharedValue(0);
  const sx = useSharedValue(0);
  const sc = useSharedValue(1);
  useEffect(() => {
    glow.value = 0;
    if (rm) { enter.value = 1; return; }
    enter.value = 0;
    enter.value = withDelay(80 + i * 60, withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) }));
  }, [qi]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ph === 'q') { glow.value = withTiming(0, { duration: 120 }); return; }
    if (right) { glow.value = rm ? 1 : withDelay(120, withTiming(1, { duration: 240 })); if (!rm) sc.value = withDelay(120, withSequence(withTiming(1.035, { duration: 140 }), withSpring(1, { damping: 10, stiffness: 200 }))); }
    if (mineWrong) setTimeout(() => shake(sx, 7, rm), 140);
  }, [ph, right, mineWrong]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (chosen && ph === 'q') pop(sc, 1.03, rm); }, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({
    opacity: enter.value * (dim ? 0.5 : 1),
    transform: [{ translateY: (1 - enter.value) * 16 }, { translateX: sx.value }, { scale: sc.value }],
  }));
  const glowSt = useAnimatedStyle(() => ({ opacity: glow.value }));
  const fg = right && ph !== 'q' ? '#FFFFFF' : (chosen && ph === 'q' ? pal.onStrong : pal.ink);
  const bg = chosen && ph === 'q' ? pal.strong : pal.card;
  return (
    <Animated.View style={st}>
      <PressScale onPress={onPress} disabled={disabled} rm={rm} scaleTo={0.97}
        style={[q.opt, { backgroundColor: bg, borderColor: mineWrong ? pal.bad : (right && ph !== 'q' ? pal.good : pal.line), borderWidth: mineWrong ? 2 : 1 }]}
        accessibilityRole="button" accessibilityLabel={`${LETTERS[i]}. ${text}`} accessibilityState={{ disabled, selected: chosen }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, backgroundColor: pal.good }, glowSt]} />
        <View style={[q.letter, { backgroundColor: right && ph !== 'q' ? 'rgba(255,255,255,0.22)' : (chosen && ph === 'q' ? 'rgba(127,127,127,0.25)' : pal.card2) }]}>
          <Text style={{ color: fg, fontWeight: '900' }}>{LETTERS[i]}</Text>
        </View>
        <Text style={{ flex: 1, color: fg, fontSize: 15.5, fontWeight: '600' }}>{text}</Text>
        {right && ph !== 'q' ? <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12.5l4.5 4.5L19 7.5" /></Svg> : null}
        {mineWrong ? <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={pal.bad} strokeWidth={3} strokeLinecap="round"><Path d="M6 6l12 12M18 6L6 18" /></Svg> : null}
        {count ? <View style={[q.count, { backgroundColor: right ? 'rgba(255,255,255,0.25)' : pal.card2 }]}><Text style={{ color: right ? '#fff' : pal.sub, fontSize: 11, fontWeight: '800' }}>{count}</Text></View> : null}
      </PressScale>
    </Animated.View>
  );
}

function RankRow({ r, rank, name, mine, answered, pts, ph, pal, rm, qi }) {
  const y = useSharedValue(rank * ROW_H);
  const prevRank = useRef(rank);
  const [moved, setMoved] = useState(0); // >0 subiu, <0 caiu (só muda quando a posição muda)
  const chip = useSharedValue(0);
  const score = useSharedValue(1);
  useEffect(() => {
    if (rank !== prevRank.current) {
      setMoved(prevRank.current - rank);
      y.value = rm ? rank * ROW_H : withSpring(rank * ROW_H, { damping: 16, stiffness: 140 });
      prevRank.current = rank;
    }
  }, [rank]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ph === 'q') setMoved(0); }, [qi, ph]);
  useEffect(() => {
    if (ph !== 'q' && pts > 0) {
      if (rm) { chip.value = 1; return; }
      chip.value = 0;
      chip.value = withDelay(260, withSpring(1, { damping: 9, stiffness: 200 }));
      pop(score, 1.2, rm);
    } else chip.value = withTiming(0, { duration: 150 });
  }, [ph, pts, qi]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const chipSt = useAnimatedStyle(() => ({ opacity: chip.value, transform: [{ scale: 0.6 + 0.4 * chip.value }, { translateY: (1 - chip.value) * 6 }] }));
  const scoreSt = useAnimatedStyle(() => ({ transform: [{ scale: score.value }] }));
  const medal = rank === 0 ? pal.accent : null;
  return (
    <Animated.View style={[q.rankRow, { backgroundColor: mine ? pal.hl : 'transparent' }, st]}>
      <View style={[q.rankN, { backgroundColor: medal || 'transparent', borderColor: medal || pal.line }]}>
        <Text style={{ color: medal ? '#111' : pal.sub, fontWeight: '900', fontSize: 11.5 }}>{rank + 1}</Text>
      </View>
      <Text style={{ color: pal.ink, flex: 1, fontWeight: mine ? '800' : '600' }} numberOfLines={1}>{name}</Text>
      {moved && ph !== 'q' ? (
        <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={moved > 0 ? pal.good : pal.bad} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
          <Path d={moved > 0 ? 'M6 14l6-6 6 6' : 'M6 10l6 6 6-6'} />
        </Svg>
      ) : null}
      {ph === 'q' && answered ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.strong, marginRight: 8 }} /> : null}
      <Animated.View style={[{ marginRight: 8 }, chipSt]}>
        {pts > 0 ? <Text style={{ color: pal.good, fontWeight: '900', fontSize: 12.5 }}>+{pts}</Text> : null}
      </Animated.View>
      <Animated.Text style={[{ color: pal.ink, fontWeight: '900', minWidth: 34, textAlign: 'right', fontVariant: ['tabular-nums'] }, scoreSt]}>{r.sc}</Animated.Text>
    </Animated.View>
  );
}

export default function QuizBoard({ view, onMove, pal, t, me, offset, onTick }) {
  const rm = useRM();
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const isPlayer = view.me !== null && view.me !== undefined && !(S.out && S.out[view.me]);
  const [pending, setPending] = useState(null);
  const [secs, setSecs] = useState(() => (S.ph === 'q' ? Math.max(0, Math.ceil((S.dl - (Date.now() + offset)) / 1000)) : 0));
  const lastTickAsk = useRef(0);
  const qKey = `${S.i}-${S.ph}`;
  useEffect(() => { setPending(null); }, [S.i]);
  const revealHapticDone = useRef('');
  useEffect(() => {
    if (S.ph === 'r' && revealHapticDone.current !== qKey) {
      revealHapticDone.current = qKey;
      if (S.my) { if (S.my.c === S.a) hOk(); else hErr(); } else if (isPlayer) hErr(); else hReveal();
    }
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const myChoice = S.my ? S.my.c : pending;
  const answeredMine = myChoice !== null && myChoice !== undefined;
  // relógio local alinhado ao servidor + pedido de avanço quando o prazo vence (setSecs só muda 1×/s)
  const lastSec = useRef(-1);
  useEffect(() => {
    if (view.status !== 'active') return undefined;
    const iv = setInterval(() => {
      const now = Date.now() + offset;
      if (S.ph === 'q') {
        const s = Math.max(0, Math.ceil((S.dl - now) / 1000));
        if (s !== lastSec.current) {
          lastSec.current = s;
          setSecs(s);
          if (s > 0 && s <= 3 && isPlayer && !answeredMine) hReveal(); // tique nos últimos segundos
        }
      }
      const due = (S.ph === 'q' && now > S.dl + 250) || (S.ph === 'r' && now > S.rv + 150);
      if (due && Date.now() - lastTickAsk.current > 1500) { lastTickAsk.current = Date.now(); try { onTick && onTick(); } catch {} }
    }, 200);
    return () => clearInterval(iv);
  }, [view.status, S.ph, S.dl, S.rv, offset, answeredMine]); // eslint-disable-line react-hooks/exhaustive-deps

  const answeredN = Array.isArray(S.answered) ? S.answered.filter(Boolean).length : 0;
  const activeN = seats.filter((_, i) => !(S.out && S.out[i])).length;
  const answer = async (c) => {
    if (!isPlayer || S.ph !== 'q' || answeredMine) return;
    hTap(); setPending(c);
    const ok = await onMove({ a: 'answer', q: S.i, c });
    if (!ok) setPending(null);
  };
  const ranking = useMemo(() => seats.map((e, i) => ({ e, i, sc: (S.sc || [])[i] || 0 })).sort((a, b) => b.sc - a.sc || a.i - b.i), [seats.join('|'), (S.sc || []).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const rankOf = {}; ranking.forEach((r, k) => { rankOf[r.e] = k; });
  const qSt = useEnter(S.i, rm, { dx: 36, dy: 0, duration: 300 });
  const hintSt = useEnter(qKey + ':' + (answeredMine ? 1 : 0), rm, { dy: 6, duration: 200 });
  const count = S.count || 10;
  const reveal = S.ph !== 'q';

  return (
    <View style={{ paddingHorizontal: 16, flex: 1, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <View style={q.topRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 12.5 }}>{tr(t, 'games.quiz.progress', 'Pergunta {i} de {n}', { i: (S.i || 0) + 1, n: count })}</Text>
          <View style={q.dots}>
            {Array.from({ length: count }).map((_, k) => (
              <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: k < (S.i || 0) || (k === S.i && reveal) ? pal.strong : (k === S.i ? pal.sub : pal.card2) }} />
            ))}
          </View>
        </View>
        {S.cat ? <View style={[q.cat, { borderColor: pal.line }]}><Text style={{ color: pal.ink, fontSize: 11.5, fontWeight: '700' }} numberOfLines={1}>{S.cat}</Text></View> : null}
        <CountdownRing t0={S.t0} dl={S.dl} offset={offset} pal={pal} running={S.ph === 'q'} secs={secs} />
      </View>
      <Animated.View style={qSt}>
        <Text style={[q.q, { color: pal.ink }]}>{S.q}</Text>
        {(S.o || []).map((o, i) => {
          const right = reveal && i === S.a;
          const mineWrong = reveal && myChoice === i && i !== S.a;
          const who = reveal && Array.isArray(S.res) ? S.res.filter((x) => x && x.c === i).length : 0;
          return (
            <Option key={i} i={i} text={o} qi={S.i} ph={S.ph} pal={pal} rm={rm}
              chosen={myChoice === i} right={right} mineWrong={mineWrong} dim={reveal && !right && myChoice !== i} count={who}
              disabled={!isPlayer || S.ph !== 'q' || answeredMine} onPress={() => answer(i)} />
          );
        })}
      </Animated.View>
      <Animated.Text style={[q.hint, { color: reveal && S.my && S.my.pts > 0 ? pal.good : pal.sub, fontWeight: reveal ? '800' : '500' }, hintSt]}>
        {S.ph === 'q'
          ? (answeredMine ? tr(t, 'games.quiz.waiting', 'Resposta enviada. {a} de {n} já responderam', { a: answeredN, n: activeN }) : (isPlayer ? tr(t, 'games.quiz.answerFast', 'Responda rápido: vale mais pontos') : tr(t, 'games.spectating', 'Você está assistindo')))
          : (S.my && S.my.pts !== undefined ? (S.my.pts > 0 ? tr(t, 'games.quiz.gotPts', 'Certa! +{n} pontos', { n: S.my.pts }) : tr(t, 'games.quiz.wrong', 'Não foi desta vez')) : tr(t, 'games.quiz.next', 'Próxima pergunta já vem'))}
      </Animated.Text>
      <View style={[q.board, { borderColor: pal.line, backgroundColor: pal.card }]}>
        <Text style={{ color: pal.sub, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.6, marginBottom: 4 }}>{tr(t, 'games.quiz.live', 'PLACAR AO VIVO')}</Text>
        <View style={{ height: ranking.length * ROW_H }}>
          {ranking.map((r) => {
            const res = reveal && Array.isArray(S.res) ? S.res[r.i] : null;
            return (
              <RankRow key={r.e} r={r} rank={rankOf[r.e]} name={nameOf(view, r.e, me, t)} mine={r.i === view.me} pal={pal} rm={rm} qi={S.i} ph={S.ph}
                answered={Array.isArray(S.answered) && !!S.answered[r.i]} pts={res && res.pts > 0 ? res.pts : 0} />
            );
          })}
        </View>
      </View>
    </View>
  );
}

const q = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 4 },
  dots: { flexDirection: 'row', gap: 3, marginTop: 6 },
  cat: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, maxWidth: 130 },
  q: { fontSize: 20, fontWeight: '800', lineHeight: 26, marginTop: 14, marginBottom: 14 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 9, overflow: 'hidden' },
  letter: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  count: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  hint: { textAlign: 'center', marginTop: 6, fontSize: 13 },
  board: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, marginTop: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  rankRow: { position: 'absolute', left: 0, right: 0, top: 0, height: ROW_H, flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 4 },
  rankN: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
});
