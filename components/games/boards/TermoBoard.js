// components/games/boards/TermoBoard.js — [jogos2b 2026-10-21] Termo em dupla.
// Mesma palavra secreta para os dois, 6 tentativas cada, cada um no seu ritmo (simultâneo, sem vez).
// O SERVIDOR valida a palavra (lista pt-BR, sem acento) e devolve as cores; a palavra e as tentativas do
// outro nunca chegam aqui antes do fim (só "Ana: 3/6"). Teclado próprio na tela (como a Forca): o teclado
// do sistema não abre, o composer da conversa fica onde está.
// Animações (Reanimated, UI thread): letra digitada "pula", linha enviada vira peça por peça, palavra
// recusada treme; Reduzir Movimento = sem animação.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming, Easing } from 'react-native-reanimated';
import { tr, nameOf } from '../../../services/games';
import { hOk, hErr, hReveal } from '../fx';
import { useRM, shake, pop } from '../motion';
import { GameKeys, TERMO_GREEN, TERMO_YELLOW } from './novosKit';

const LEN = 5;

function tileColors(p, pal) {
  if (p === 'g') return [TERMO_GREEN, '#FFFFFF', TERMO_GREEN];
  if (p === 'y') return [TERMO_YELLOW, '#FFFFFF', TERMO_YELLOW];
  if (p === 'x') return [pal.dark ? '#3A3A3F' : '#8E8E93', '#FFFFFF', pal.dark ? '#3A3A3F' : '#8E8E93'];
  return [pal.card, pal.ink, pal.line];
}

function Tile({ ch, p, size, pal, rm, flipDelay, flipKey, typed }) {
  const f = useSharedValue(1);
  const s = useSharedValue(1);
  const firstKey = useRef(flipKey);
  useEffect(() => {
    if (flipKey === firstKey.current || rm) return;
    f.value = 0;
    f.value = withDelay(flipDelay, withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) }));
  }, [flipKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (typed && ch) pop(s, 1.1, rm); }, [ch]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ perspective: 500 }, { rotateX: `${(1 - f.value) * 90}deg` }, { scale: s.value }] }));
  const [bg, fg, bc] = tileColors(p, pal);
  return (
    <Animated.View style={[sx.tile, { width: size, height: size, borderRadius: Math.round(size * 0.18), backgroundColor: bg, borderColor: typed && ch ? pal.sub : bc, borderWidth: p ? 0 : 1.5 }, st]}>
      <Text style={{ color: fg, fontSize: size * 0.5, fontWeight: '900' }}>{ch || ''}</Text>
    </Animated.View>
  );
}

function Grid({ rows, cur, max, size, pal, rm, shakeX, active }) {
  const shSt = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX ? shakeX.value : 0 }] }));
  const out = [];
  for (let r = 0; r < max; r++) {
    const row = rows[r];
    const isCur = active && r === rows.length;
    const letters = row ? row.w.split('') : (isCur ? cur.padEnd(LEN, ' ').split('').map((c) => (c === ' ' ? '' : c)) : Array(LEN).fill(''));
    const tiles = letters.map((ch, i) => (
      <Tile key={i} ch={ch} p={row ? row.p[i] : null} size={size} pal={pal} rm={rm} flipDelay={i * 110} flipKey={row ? 'done' : 'open'} typed={isCur} />
    ));
    // mesmo tipo de nó sempre (linha digitada → enviada mantém as peças montadas = a virada anima)
    out.push(<Animated.View key={r} style={isCur ? [sx.row, shSt] : sx.row}>{tiles}</Animated.View>);
  }
  return <View style={{ gap: 5, alignItems: 'center' }}>{out}</View>;
}

/** Placar do adversário durante a partida: só bolinhas de tentativas (sem letras, sem cores). */
function OppDots({ n, max, done, pal }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {Array.from({ length: max }).map((_, i) => (
        <View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i < n ? (done ? pal.ink : pal.sub) : pal.card2 }} />
      ))}
    </View>
  );
}

export default function TermoBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const W = Math.min(maxW || win.width, 520) - 24;
  const max = S.max || 6;
  const meSeat = view.me;
  const isPlayer = meSeat !== null && meSeat !== undefined;
  const pl = Array.isArray(S.pl) ? S.pl : [];
  const mine = isPlayer ? (pl[meSeat] || {}) : {};
  const oppSeat = isPlayer ? 1 - meSeat : 1;
  const opp = pl[oppSeat] || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const oppName = seats[oppSeat] ? nameOf(view, seats[oppSeat], me, t) : '';
  const rows = Array.isArray(mine.rows) ? mine.rows : [];
  const finished = view.status === 'finished';
  const canType = view.status === 'active' && isPlayer && !mine.done;
  const [cur, setCur] = useState('');
  const shakeX = useSharedValue(0);
  const nRows = useRef(rows.length);
  useEffect(() => {
    if (rows.length > nRows.current) {
      setCur('');
      const last = rows[rows.length - 1];
      if (last && last.p === 'ggggg') setTimeout(() => hOk(), rm ? 0 : 620);
      else hReveal();
    }
    nRows.current = rows.length;
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // teclas pintadas: verde > amarelo > cinza
  const states = useMemo(() => {
    const m = {};
    const rank = { g: 3, y: 2, x: 1 };
    rows.forEach((r) => r.w.split('').forEach((L, i) => { const p = r.p[i]; if (!m[L] || rank[p] > rank[m[L]]) m[L] = p; }));
    return m;
  }, [rows]);

  // tamanho: cabe 6 linhas + teclado na altura do painel
  const availH = Math.max(300, Math.min(win.height * 0.64, win.height - 300) - 90);
  const keyH = availH < 420 ? 38 : 44;
  const kbH = keyH * 3 + 10;
  const tile = Math.max(28, Math.min(54, Math.floor((W - 4 * 5) / LEN), Math.floor((availH - kbH - 40) / max) - 5));

  const submit = async () => {
    if (!canType || busy) return;
    if (cur.length !== LEN) { hErr(); shake(shakeX, 8, rm); return; }
    const ok = await onMove({ a: 'guess', w: cur });
    if (!ok) shake(shakeX, 9, rm);
  };

  let head;
  if (finished) {
    head = (
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text style={{ color: pal.sub, fontSize: 12.5, fontWeight: '700' }}>{tr(t, 'games.termo.wordWas', 'A palavra era')}</Text>
        <Text style={{ color: pal.ink, fontSize: 24, fontWeight: '900', letterSpacing: 4 }}>{S.word || ''}</Text>
      </View>
    );
  } else if (isPlayer) {
    head = (
      <View style={[sx.opp, { backgroundColor: pal.card }]}>
        <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13 }} numberOfLines={1}>{oppName}</Text>
        <OppDots n={opp.n || 0} max={max} done={!!opp.done} pal={pal} />
        <Text style={{ color: pal.sub, fontSize: 12, fontWeight: '600' }}>
          {opp.done ? tr(t, 'games.termo.oppDone', 'terminou') : tr(t, 'games.termo.oppN', '{n} de {max}', { n: opp.n || 0, max })}
        </Text>
      </View>
    );
  } else {
    head = <Text style={{ color: pal.sub, fontSize: 13, textAlign: 'center' }}>{tr(t, 'games.termo.spect', 'As tentativas aparecem no fim da partida')}</Text>;
  }

  // fim: as duas grades lado a lado (minha + do outro)
  if (finished) {
    const small = Math.max(20, Math.min(34, Math.floor((W - 24) / 2 / LEN) - 5));
    return (
      <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10, alignItems: 'center' }}>
        {head}
        <View style={{ flexDirection: 'row', gap: 16, justifyContent: 'center' }}>
          {[0, 1].map((sIdx) => {
            const P = pl[sIdx] || {};
            const who = seats[sIdx] ? nameOf(view, seats[sIdx], me, t) : '';
            return (
              <View key={sIdx} style={{ alignItems: 'center', gap: 6 }}>
                <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13 }} numberOfLines={1}>{who}</Text>
                <Grid rows={Array.isArray(P.rows) ? P.rows : []} cur="" max={max} size={small} pal={pal} rm active={false} />
                <Text style={{ color: P.solved ? TERMO_GREEN : pal.sub, fontSize: 12, fontWeight: '700' }}>
                  {P.solved ? tr(t, 'games.termo.solvedIn', 'Acertou em {n}', { n: (P.rows || []).length }) : tr(t, 'games.termo.missed', 'Não acertou')}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 10, alignItems: 'center' }}>
      {head}
      <Grid rows={rows} cur={cur} max={max} size={tile} pal={pal} rm={rm} shakeX={shakeX} active={canType} />
      {isPlayer && mine.done && view.status === 'active' ? (
        <Text style={{ color: mine.solved ? TERMO_GREEN : pal.sub, fontWeight: '800', fontSize: 14 }}>
          {mine.solved ? tr(t, 'games.termo.youSolved', 'Você acertou! Aguardando {name}', { name: oppName }) : tr(t, 'games.termo.youMissed', 'Suas tentativas acabaram. Aguardando {name}', { name: oppName })}
        </Text>
      ) : null}
      {canType ? (
        <GameKeys width={W} pal={pal} rm={rm} keyH={keyH} states={states} disabled={busy}
          onKey={(L) => setCur((c) => (c.length < LEN ? c + L : c))}
          onBack={() => setCur((c) => c.slice(0, -1))}
          onEnter={submit} enterLabel={tr(t, 'games.termo.enter', 'Enviar')} enterDisabled={cur.length !== LEN}
          backLabel={tr(t, 'games.keys.back', 'Apagar')} />
      ) : null}
    </View>
  );
}

const sx = StyleSheet.create({
  row: { flexDirection: 'row', gap: 5 },
  tile: { alignItems: 'center', justifyContent: 'center' },
  opp: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7, alignSelf: 'center' },
});
