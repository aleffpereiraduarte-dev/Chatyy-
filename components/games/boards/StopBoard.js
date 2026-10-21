// components/games/boards/StopBoard.js — [jogos2b 2026-10-21] Stop / Adedonha.
// Letra sorteada pelo servidor; Nome, Cidade/País, Fruta, Animal, Cor e Objeto. Os dois preenchem ao mesmo
// tempo (rascunho salvo sozinho no servidor); quem completou pede STOP → o outro tem 10 s. Revisão: as
// respostas abrem, cada um pode contestar as do outro e confirmar; o servidor dá o placar (10 única,
// 5 repetida, 0 vazia/letra errada/contestada). Antes da revisão o servidor só conta quantas o outro preencheu.
// Teclado PRÓPRIO na tela (nada de TextInput: o teclado do sistema recolheria o painel e esconderia o campo).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming, cancelAnimation } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { tr, nameOf, gameMove, getGameView } from '../../../services/games';
import { hTap, hOk, hErr, hTurn } from '../fx';
import { PressScale, useRM, shake } from '../motion';
import { GameKeys, useSecsLeft, useDeadlineTick, TimePill } from './novosKit';

const CATS = ['nome', 'cidade', 'fruta', 'animal', 'cor', 'objeto'];
const CAT_FB = { nome: 'Nome', cidade: 'Cidade/País', fruta: 'Fruta', animal: 'Animal', cor: 'Cor', objeto: 'Objeto' };
const MAXLEN = 32;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

function FlagIcon({ color, on }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill={on ? color : 'none'} stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 21V4.5M5 4.5h11l-2 4 2 4H5" />
    </Svg>
  );
}

function LetterBadge({ letter, pal, rm, alarm }) {
  const s = useSharedValue(rm ? 1 : 0.3);
  const p = useSharedValue(1);
  useEffect(() => { if (!rm) { s.value = 0.3; s.value = withSequence(withTiming(1.2, { duration: 260 }), withTiming(1, { duration: 160 })); } }, [letter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (alarm && !rm) p.value = withRepeat(withSequence(withTiming(1.08, { duration: 300 }), withTiming(1, { duration: 300 })), -1, false);
    else { cancelAnimation(p); p.value = 1; }
    return () => cancelAnimation(p);
  }, [alarm, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value * p.value }] }));
  return (
    <Animated.View style={[sx.letter, { backgroundColor: alarm ? pal.bad : pal.strong }, st]} accessibilityLabel={`Letra ${letter}`}>
      <Text style={{ color: alarm ? '#FFFFFF' : pal.onStrong, fontSize: 26, fontWeight: '900' }}>{letter}</Text>
    </Animated.View>
  );
}

export default function StopBoard({ view, onMove, pal, busy, t, me, maxW, offset, onTick }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const W = Math.min(maxW || win.width, 560) - 24;
  const meSeat = view.me;
  const isPlayer = meSeat !== null && meSeat !== undefined;
  const oSeat = isPlayer ? 1 - meSeat : 1;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const oppName = seats[oSeat] ? nameOf(view, seats[oSeat], me, t) : '';
  const ph = S.ph || 'play';
  const L = S.letter || '';
  const active = view.status === 'active';
  const editing = active && isPlayer && (ph === 'play' || ph === 'grace');
  const catLabel = (c) => tr(t, 'games.stop.cat.' + c, CAT_FB[c]);

  // rascunho local (o eco do servidor não sobrescreve o que estou digitando)
  const serverMine = isPlayer && Array.isArray(S.ans) ? (S.ans[meSeat] || {}) : {};
  const [draft, setDraft] = useState(() => ({ ...serverMine }));
  const [sel, setSel] = useState(() => CATS.find((c) => !String(serverMine[c] || '').trim()) || 'nome');
  const gidRef = useRef(view.g);
  useEffect(() => { if (gidRef.current !== view.g) { gidRef.current = view.g; setDraft({ ...serverMine }); } }, [view.g]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useRef(false);
  const saveTm = useRef(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const flush = useCallback(() => {
    if (saveTm.current) { clearTimeout(saveTm.current); saveTm.current = null; }
    if (!dirty.current) return;
    dirty.current = false;
    const v = getGameView(view.g);
    if (!v || v.status !== 'active') return;
    gameMove(view.g, v.v, { a: 'fill', ans: draftRef.current }).catch(() => {});
  }, [view.g]);
  useEffect(() => () => flush(), [flush]);
  const edit = (fn) => {
    if (!editing) return;
    setDraft((d) => {
      const cur = String(d[sel] || '');
      const next = fn(cur).slice(0, MAXLEN);
      return next === cur ? d : { ...d, [sel]: next };
    });
    dirty.current = true;
    if (saveTm.current) clearTimeout(saveTm.current);
    saveTm.current = setTimeout(flush, ph === 'grace' ? 450 : 1100);
  };
  const filledAll = CATS.every((c) => String(draft[c] || '').trim().length > 0);

  // prazos do servidor
  const due = ph === 'play' ? S.pdl : ph === 'grace' ? Number(S.gdl) + 1500 : ph === 'review' ? S.rdl : 0;
  const shown = ph === 'play' ? S.pdl : ph === 'grace' ? S.gdl : S.rdl;
  const secs = useSecsLeft(shown, offset, active && ph !== 'done');
  useDeadlineTick(due, offset, active, onTick);
  // STOP do outro → aviso + salva já o que tenho
  const prevPh = useRef(ph);
  useEffect(() => {
    if (ph === 'grace' && prevPh.current === 'play') { if (S.stop_by !== meSeat) hTurn(); flush(); }
    if (ph === 'review' && prevPh.current !== 'review') { flush(); hOk(); }
    prevPh.current = ph;
  }, [ph]); // eslint-disable-line react-hooks/exhaustive-deps
  // grace: manda o rascunho 2 s antes de fechar
  useEffect(() => {
    if (ph !== 'grace' || !S.gdl) return undefined;
    const left = Number(S.gdl) - (Date.now() + (offset || 0)) - 2000;
    const tm = setTimeout(flush, Math.max(0, left));
    return () => clearTimeout(tm);
  }, [ph, S.gdl, offset, flush]);

  const shakeX = useSharedValue(0);
  const stopSt = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }));
  const doStop = async () => {
    if (!filledAll) { hErr(); shake(shakeX, 8, rm); return; }
    if (saveTm.current) { clearTimeout(saveTm.current); saveTm.current = null; }
    dirty.current = false;
    const ok = await onMove({ a: 'stop', ans: draft });
    if (ok) hOk();
  };

  // ── revisão / fim ────────────────────────────────────────────────────────
  if (ph === 'review' || ph === 'done' || view.status === 'finished') {
    const ans = Array.isArray(S.ans) ? S.ans : [{}, {}];
    const pts = Array.isArray(S.pts) ? S.pts : [{}, {}];
    const ok = Array.isArray(S.ok) ? S.ok : [{}, {}];
    const ch = Array.isArray(S.ch) ? S.ch : [[], []];
    const tot = Array.isArray(S.tot) ? S.tot : (S.sc || [0, 0]);
    const a = isPlayer ? meSeat : 0; const b = 1 - a;
    const review = active && ph === 'review';
    const ready = Array.isArray(S.ready) ? S.ready : [false, false];
    const contest = (c, on) => { hTap(); onMove({ a: 'contest', cat: c, on: on ? 1 : 0 }); };
    const cell = (p, c, mine) => {
      const txt = String((ans[p] || {})[c] || '');
      const valid = !!(ok[p] || {})[c];
      const pt = (pts[p] || {})[c] || 0;
      const contested = (ch[1 - p] || []).includes(c);
      return (
        <View style={[sx.cell, { backgroundColor: pal.card }]}>
          <Text style={{ color: txt ? (valid ? pal.ink : pal.sub) : pal.sub, fontWeight: '700', fontSize: 14, textDecorationLine: contested ? 'line-through' : 'none', flex: 1 }} numberOfLines={1}>
            {txt || '—'}
          </Text>
          <Text style={{ color: pt === 10 ? pal.good : (pt === 5 ? pal.ink : pal.sub), fontWeight: '900', fontSize: 13, fontVariant: ['tabular-nums'] }}>{pt}</Text>
          {review && !mine && isPlayer && txt ? (
            <Pressable onPress={() => contest(c, !contested)} hitSlop={8} style={{ marginLeft: 6 }} accessibilityRole="button"
              accessibilityLabel={contested ? tr(t, 'games.stop.uncontest', 'Retirar contestação') : tr(t, 'games.stop.contest', 'Contestar')}>
              <FlagIcon color={contested ? pal.bad : pal.sub} on={contested} />
            </Pressable>
          ) : null}
        </View>
      );
    };
    return (
      <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <LetterBadge letter={L} pal={pal} rm={rm} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 15 }}>{review ? tr(t, 'games.stop.reviewTitle', 'Revisão das respostas') : tr(t, 'games.stop.final', 'Placar final')}</Text>
            <Text style={{ color: pal.sub, fontSize: 12.5 }}>{review ? tr(t, 'games.stop.reviewHint', 'Toque na bandeira para contestar uma resposta do outro') : tr(t, 'games.stop.pointsHint', '10 única · 5 repetida · 0 inválida')}</Text>
          </View>
          {review ? <TimePill secs={secs} pal={pal} /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 6, paddingLeft: 78 }}>
          <Text style={[sx.colHead, { color: pal.ink }]} numberOfLines={1}>{isPlayer ? tr(t, 'games.you', 'Você') : (seats[0] ? nameOf(view, seats[0], me, t) : '')} · {tot[a] || 0}</Text>
          <Text style={[sx.colHead, { color: pal.ink }]} numberOfLines={1}>{oppName} · {tot[b] || 0}</Text>
        </View>
        {CATS.map((c) => (
          <View key={c} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ width: 72, color: pal.sub, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{catLabel(c)}</Text>
            {cell(a, c, true)}
            {cell(b, c, false)}
          </View>
        ))}
        {review && isPlayer ? (
          <PressScale disabled={busy || ready[meSeat]} rm={rm} onPress={() => { hTap(); onMove({ a: 'ready' }); }}
            style={[sx.cta, { backgroundColor: ready[meSeat] ? pal.card2 : pal.strong }]} accessibilityRole="button">
            <Text style={{ color: ready[meSeat] ? pal.ink : pal.onStrong, fontWeight: '800', fontSize: 15 }}>
              {ready[meSeat] ? (ready[oSeat] ? tr(t, 'games.stop.closing', 'Fechando placar...') : tr(t, 'games.stop.waitConfirm', 'Aguardando {name} confirmar', { name: oppName })) : tr(t, 'games.stop.confirm', 'Confirmar placar')}
            </Text>
          </PressScale>
        ) : null}
      </View>
    );
  }

  // ── preenchendo ──────────────────────────────────────────────────────────
  const filled = Array.isArray(S.filled) ? S.filled : [0, 0];
  const grace = ph === 'grace';
  const stopByOther = grace && S.stop_by !== null && S.stop_by !== undefined && S.stop_by !== meSeat;
  const availH = Math.max(300, Math.min(win.height * 0.64, win.height - 300) - 90);
  const keyH = availH < 520 ? 34 : 40;
  const rowH = availH < 520 ? 31 : 36;
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <LetterBadge letter={L} pal={pal} rm={rm} alarm={grace} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: grace ? pal.bad : pal.ink, fontWeight: '800', fontSize: 14.5 }} numberOfLines={1}>
            {grace ? (stopByOther ? tr(t, 'games.stop.otherStopped', '{name} pediu STOP!', { name: oppName }) : (S.stop_by === meSeat ? tr(t, 'games.stop.youStopped', 'Você pediu STOP!') : tr(t, 'games.stop.timeStop', 'Tempo esgotado!'))) : tr(t, 'games.stop.fillWith', 'Tudo com a letra {l}', { l: L })}
          </Text>
          <Text style={{ color: pal.sub, fontSize: 12.5 }} numberOfLines={1}>{tr(t, 'games.stop.oppFilled', '{name}: {n} de 6', { name: oppName, n: filled[oSeat] || 0 })}</Text>
        </View>
        <TimePill secs={secs} pal={pal} warnAt={grace ? 99 : 15} />
      </View>
      {CATS.map((c) => {
        const v = String(draft[c] || '');
        const on = sel === c && editing;
        const bad = v.trim() && norm(v)[0] !== L;
        return (
          <Pressable key={c} onPress={() => { if (!editing) return; hTap(); setSel(c); if (!v) setDraft((d) => ({ ...d, [c]: L })); }}
            style={[sx.field, { height: rowH, backgroundColor: pal.card, borderColor: on ? pal.ink : 'transparent' }]}
            accessibilityRole="button" accessibilityLabel={`${catLabel(c)}: ${v || tr(t, 'games.stop.empty', 'vazio')}`}>
            <Text style={{ width: 84, color: pal.sub, fontSize: 12.5, fontWeight: '700' }} numberOfLines={1}>{catLabel(c)}</Text>
            <Text style={{ flex: 1, color: bad ? pal.bad : pal.ink, fontSize: 15.5, fontWeight: '700' }} numberOfLines={1}>{v}{on ? <Text style={{ color: pal.sub }}>|</Text> : null}</Text>
          </Pressable>
        );
      })}
      {editing ? (
        <>
          <GameKeys width={W} pal={pal} rm={rm} keyH={keyH} space disabled={false}
            onKey={(k) => edit((cur) => (k === ' ' ? (cur && !cur.endsWith(' ') ? cur + ' ' : cur) : cur + k))}
            onBack={() => edit((cur) => cur.slice(0, -1))}
            onEnter={() => { const i = CATS.indexOf(sel); const nx = CATS.slice(i + 1).concat(CATS.slice(0, i)).find((c) => !String(draft[c] || '').trim()); if (nx) { setSel(nx); setDraft((d) => ({ ...d, [nx]: d[nx] || L })); } }}
            enterLabel={tr(t, 'games.stop.next', 'Próxima')}
            backLabel={tr(t, 'games.keys.back', 'Apagar')} spaceLabel={tr(t, 'games.keys.space', 'espaço')} />
          {!grace ? (
            <Animated.View style={stopSt}>
              <PressScale disabled={busy} rm={rm} onPress={doStop}
                style={[sx.cta, { backgroundColor: filledAll ? pal.bad : pal.card2 }]} accessibilityRole="button"
                accessibilityLabel={tr(t, 'games.stop.stop', 'STOP')}>
                <Text style={{ color: filledAll ? '#FFFFFF' : pal.sub, fontWeight: '900', fontSize: 16, letterSpacing: 1 }}>
                  {filledAll ? tr(t, 'games.stop.stop', 'STOP') : tr(t, 'games.stop.fillAll', 'Preencha tudo para pedir STOP')}
                </Text>
              </PressScale>
            </Animated.View>
          ) : null}
        </>
      ) : (
        <Text style={{ color: pal.sub, textAlign: 'center', marginTop: 6 }}>{tr(t, 'games.spectating', 'Você está assistindo')}</Text>
      )}
    </View>
  );
}

const sx = StyleSheet.create({
  letter: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  field: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 12 },
  cell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  colHead: { flex: 1, fontWeight: '800', fontSize: 12.5 },
  cta: { borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
});
