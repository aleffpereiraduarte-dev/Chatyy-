// components/games/boards/ConheceBoard.js — [jogos3 2026-10-22] "Quem me conhece mais?" (2 a 8, simultâneo).
// Servidor: api/games_engine_conhece.php — sorteia o NÚMERO da pergunta e guarda só o índice da opção; o texto
// vem do banco local (components/games/conheceBank.js, pt/en/es). A cada rodada um ALVO (revezando) marca a
// resposta verdadeira e os outros chutam o que ele marcou; tudo em segredo até a revelação (o servidor só conta
// quem já respondeu). Acertou = +10. Prazo da pergunta 60 s; a revelação fecha quando todos tocam "Próxima"
// ou em 9 s. Relógio = servidor (offset); o app pede o avanço (onTick) quando o prazo vence.
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence, withSpring, Easing } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from '../../AvatarCircle';
import { tr, nameOf } from '../../../services/games';
import { hTap, hOk, hErr, hReveal } from '../fx';
import { PressScale, useRM, pop } from '../motion';
import { useSecsLeft, useDeadlineTick, TimePill } from './novosKit';
import { conheceQuestion } from '../conheceBank';

const LETTERS = ['A', 'B', 'C', 'D'];
const NET_MS = 1200;
const OK_GREEN = '#22A55B';

function Check({ color, size = 18 }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
}

function Option({ i, text, ph, chosen, truth, dim, disabled, onPress, guessers, pal, rm, qk }) {
  const enter = useSharedValue(rm ? 1 : 0);
  const glow = useSharedValue(0);
  const sc = useSharedValue(1);
  useEffect(() => {
    glow.value = 0;
    if (rm) { enter.value = 1; return; }
    enter.value = 0;
    enter.value = withDelay(60 + i * 55, withTiming(1, { duration: 240, easing: Easing.out(Easing.cubic) }));
  }, [qk]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ph !== 'rev') { glow.value = withTiming(0, { duration: 120 }); return; }
    if (truth) {
      glow.value = rm ? 1 : withDelay(120, withTiming(1, { duration: 240 }));
      if (!rm) sc.value = withDelay(120, withSequence(withTiming(1.03, { duration: 140 }), withSpring(1, { damping: 10, stiffness: 200 })));
    }
  }, [ph, truth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (chosen && ph === 'q') pop(sc, 1.03, rm); }, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: enter.value * (dim ? 0.5 : 1), transform: [{ translateY: (1 - enter.value) * 14 }, { scale: sc.value }] }));
  const glowSt = useAnimatedStyle(() => ({ opacity: glow.value }));
  const rev = ph === 'rev';
  const fg = truth && rev ? '#FFFFFF' : (chosen && !rev ? pal.onStrong : pal.ink);
  const bg = chosen && !rev ? pal.strong : pal.card;
  return (
    <Animated.View style={st}>
      <PressScale onPress={onPress} disabled={disabled} rm={rm} scaleTo={0.97}
        style={[c.opt, { backgroundColor: bg, borderColor: truth && rev ? OK_GREEN : (chosen && rev ? pal.strong : pal.line), borderWidth: chosen && rev && !truth ? 2 : 1 }]}
        accessibilityRole="button" accessibilityLabel={`${LETTERS[i]}. ${text}`} accessibilityState={{ disabled, selected: chosen }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, backgroundColor: OK_GREEN }, glowSt]} />
        <View style={[c.letter, { backgroundColor: truth && rev ? 'rgba(255,255,255,0.22)' : (chosen && !rev ? 'rgba(127,127,127,0.25)' : pal.card2) }]}>
          <Text style={{ color: fg, fontWeight: '900' }}>{LETTERS[i]}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: fg, fontSize: 15.5, fontWeight: '600' }}>{text}</Text>
          {rev && guessers && guessers.length ? (
            <Text style={{ color: truth ? 'rgba(255,255,255,0.88)' : pal.sub, fontSize: 12, fontWeight: '700', marginTop: 2 }} numberOfLines={2}>{guessers.join(', ')}</Text>
          ) : null}
        </View>
        {truth && rev ? <Check color="#FFFFFF" size={20} /> : null}
      </PressScale>
    </Animated.View>
  );
}

export default function ConheceBoard({ view, onMove, pal, busy, t, me, maxW, offset, onTick }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const W = Math.min(maxW || win.width, 560) - 24;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const out = Array.isArray(S.out) ? S.out : [];
  const meSeat = view.me !== null && view.me !== undefined ? view.me : null;
  const isPlayer = meSeat !== null && !out[meSeat];
  const active = view.status === 'active';
  const ph = S.ph || 'q';
  const lng = tr(t, 'games.conhece.lang', 'pt');
  const nm = (p) => (seats[p] ? nameOf(view, seats[p], me, t) : '');

  // prazos do servidor (pergunta = dl + folga de rede; revelação = dl)
  const due = active ? (ph === 'q' ? Number(S.dl) + NET_MS : Number(S.dl)) : 0;
  const secs = useSecsLeft(S.dl, offset, active && (ph === 'q' || ph === 'rev'));
  useDeadlineTick(due, offset, active, onTick);

  // revelação: háptico de acerto/erro para quem chutou
  const prevPh = useRef(ph);
  const rev = S.rev || null;
  useEffect(() => {
    if (ph === 'rev' && prevPh.current === 'q' && rev && isPlayer) {
      if (rev.al === meSeat) hReveal();
      else if (Array.isArray(rev.hits) && rev.hits.includes(meSeat)) hOk();
      else hErr();
    }
    prevPh.current = ph;
  }, [ph]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── fim: resumo das rodadas ──────────────────────────────────────────────
  if (!active) {
    const log = Array.isArray(S.log) ? S.log : [];
    if (!log.length) return null;
    return (
      <View style={{ alignSelf: 'center', width: W, marginTop: 8, gap: 6 }}>
        <Text style={[c.kicker, { color: pal.sub }]}>{tr(t, 'games.conhece.summary', 'Rodadas')}</Text>
        {log.map((r, k) => {
          const q = conheceQuestion(r.q, lng);
          const qt = q ? q.about.split('{name}').join(nm(r.al)) : tr(t, 'games.conhece.qN', 'Pergunta {n}', { n: k + 1 });
          const ans = q && r.a !== null && r.a !== undefined ? q.opts[r.a] : null;
          const hits = Array.isArray(r.hits) ? r.hits.length : 0;
          return (
            <View key={k} style={[c.logRow, { backgroundColor: pal.card }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13.5 }} numberOfLines={2}>{qt}</Text>
                <Text style={{ color: pal.sub, fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>
                  {r.void ? tr(t, 'games.conhece.noAnswer', '{name} não respondeu a tempo', { name: nm(r.al) }) : ans}
                </Text>
              </View>
              {!r.void ? <Text style={{ color: hits ? OK_GREEN : pal.sub, fontWeight: '800', fontSize: 12.5 }}>{tr(t, 'games.conhece.hitsN', '{n} acertos', { n: hits })}</Text> : null}
            </View>
          );
        })}
      </View>
    );
  }

  const al = Number.isInteger(S.al) ? S.al : 0;
  const amAlvo = isPlayer && al === meSeat;
  const q = conheceQuestion(S.q, lng);
  const qText = q ? (amAlvo ? q.mine : q.about.split('{name}').join(nm(al))) : tr(t, 'games.conhece.qN', 'Pergunta {n}', { n: (S.i || 0) + 1 });
  const opts = q ? q.opts : LETTERS;
  const answered = Array.isArray(S.answered) ? S.answered : [];
  const mine = S.mine;
  const canPick = active && ph === 'q' && isPlayer && (mine === null || mine === undefined) && !busy;
  const pick = (o) => { if (!canPick) return; hTap(); onMove({ a: 'pick', i: S.i, o }); };
  const rdy = Array.isArray(S.rdy) ? S.rdy : [];
  const iAmReady = isPlayer && !!rdy[meSeat];
  const next = () => { if (!isPlayer || iAmReady || busy) return; hTap(); onMove({ a: 'next', i: S.i }); };

  // quem chutou cada opção (na revelação)
  const guessBy = [[], [], [], []];
  if (ph === 'rev' && rev && Array.isArray(rev.g)) rev.g.forEach((o, p) => { if (p !== rev.al && o !== null && o !== undefined && guessBy[o]) guessBy[o].push(nm(p)); });
  const waiting = seats.map((_, p) => p).filter((p) => !out[p] && !answered[p]);
  let line = '';
  if (ph === 'q') {
    if (!isPlayer) line = tr(t, 'games.conhece.spect', 'Respondendo: {n} de {m}', { n: answered.filter(Boolean).length, m: seats.length - out.filter(Boolean).length });
    else if (mine === null || mine === undefined) line = amAlvo ? tr(t, 'games.conhece.youAlvo', 'É sobre você: marque a resposta verdadeira') : tr(t, 'games.conhece.guess', 'O que {name} vai responder?', { name: nm(al) });
    else line = waiting.length ? tr(t, 'games.conhece.waiting', 'Esperando {names}', { names: waiting.map(nm).join(', ') }) : '';
  } else if (rev) {
    if (rev.void) line = tr(t, 'games.conhece.noAnswer', '{name} não respondeu a tempo', { name: nm(rev.al) });
    else if (rev.al === meSeat) line = tr(t, 'games.conhece.hitsYou', '{n} acertaram sobre você', { n: (rev.hits || []).length });
    else if (isPlayer) line = (rev.hits || []).includes(meSeat) ? tr(t, 'games.conhece.youHit', 'Você acertou! +10') : tr(t, 'games.conhece.youMissed', 'Não foi dessa vez');
    else line = tr(t, 'games.conhece.hitsN', '{n} acertos', { n: (rev.hits || []).length });
  }

  return (
    <View style={{ alignSelf: 'center', width: W, marginTop: 6 }}>
      <View style={c.top}>
        <Text style={[c.kicker, { color: pal.sub, flex: 1 }]}>{tr(t, 'games.conhece.round', 'Pergunta {i} de {n}', { i: (S.i || 0) + 1, n: S.count || 0 })}</Text>
        <TimePill secs={secs} pal={pal} warnAt={ph === 'q' ? 10 : 0} />
      </View>
      <View style={[c.alvo, { backgroundColor: pal.card }]}>
        <AvatarCircle email={seats[al]} name={nameOf(view, seats[al], '', t)} size={34} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: pal.sub, fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 }}>{amAlvo ? tr(t, 'games.conhece.aboutYou', 'Sobre você') : tr(t, 'games.conhece.about', 'Sobre {name}', { name: nm(al) })}</Text>
          <Text style={{ color: pal.ink, fontSize: 17, fontWeight: '800', marginTop: 1 }}>{qText}</Text>
        </View>
      </View>
      <View style={{ gap: 8, marginTop: 10 }}>
        {opts.map((tx, i) => (
          <Option key={i} i={i} qk={S.i} text={String(tx)} ph={ph} pal={pal} rm={rm}
            chosen={mine === i} truth={ph === 'rev' && rev && rev.a === i}
            dim={(ph === 'q' && mine !== null && mine !== undefined && mine !== i) || (ph === 'rev' && rev && rev.a !== i && mine !== i)}
            disabled={!canPick} onPress={() => pick(i)} guessers={guessBy[i]} />
        ))}
      </View>
      {line ? <Text style={{ color: ph === 'rev' && rev && (rev.hits || []).includes(meSeat) ? OK_GREEN : pal.sub, fontWeight: '700', fontSize: 13.5, textAlign: 'center', marginTop: 10 }}>{line}</Text> : null}
      {ph === 'q' ? (
        <View style={c.dots}>
          {seats.map((e, p) => (out[p] ? null : (
            <View key={e} style={[c.dot, { backgroundColor: answered[p] ? pal.strong : pal.card2 }]} accessibilityLabel={`${nm(p)}: ${answered[p] ? tr(t, 'games.conhece.answered', 'respondeu') : tr(t, 'games.conhece.thinking', 'pensando')}`}>
              {answered[p] ? <Check color={pal.onStrong} size={11} /> : null}
            </View>
          )))}
        </View>
      ) : null}
      {ph === 'rev' && isPlayer ? (
        <PressScale onPress={next} disabled={iAmReady || busy} rm={rm} style={[c.next, { backgroundColor: iAmReady ? pal.card2 : pal.strong }]} accessibilityRole="button">
          <Text style={{ color: iAmReady ? pal.sub : pal.onStrong, fontWeight: '800', fontSize: 15 }}>
            {iAmReady ? tr(t, 'games.conhece.waitNext', 'Esperando os outros') : ((S.i || 0) + 1 >= (S.count || 0) ? tr(t, 'games.conhece.seeScore', 'Ver placar') : tr(t, 'games.conhece.next', 'Próxima'))}
          </Text>
        </PressScale>
      ) : null}
    </View>
  );
}

const c = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  kicker: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  alvo: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, padding: 12 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 12, overflow: 'hidden' },
  letter: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  dot: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  next: { marginTop: 12, borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12 },
});
