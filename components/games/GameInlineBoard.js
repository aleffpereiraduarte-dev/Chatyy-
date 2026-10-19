// components/games/GameInlineBoard.js — [jogos 2026-10-19 inline] tabuleiro DENTRO do cartão da conversa
// (render JS; a lista nativa tem o espelho em components/chat/nativeRowCards.js buildGame).
//   Velha  → o tabuleiro de verdade (VelhaBoard, 220 pt): tocar a casa = lance.
//   Forca  → palavra + vidas + teclado compacto 7 colunas (tocar a letra = lance).
//   Quiz   → pergunta + 4 respostas + segundos (todos respondem ao mesmo tempo).
//   Damas / Cartas → miniatura ao vivo (tabuleiro 8×8 / carta da mesa + mão); tocar abre a folha.
// Cada lance volta pelo game_update do WS → o MESMO cartão se atualiza para todos.
import React, { memo, useEffect, useMemo, useReducer } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { getGameView, subscribeGame, tr, nameOf } from '../../services/games';
import {
  ensureInlineView, onInlineChange, inlineMove, inlineBusy, inlinePending, inlineError, quizSecondsLeft,
} from '../../services/gamesInline';
import { gamePalette, hTap } from './fx';
import { PressScale, useRM } from './motion';
import VelhaBoard from './boards/VelhaBoard';
import { CardFace } from './boards/CartasBoard';

const ROWS = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ'];
const LETTERS = ['A', 'B', 'C', 'D'];
function norm(ch) { return String(ch || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }

/** Visão viva do jogo do cartão (store + busca preguiçosa + re-render nos eventos do inline). */
export function useInlineView(gid, cardStatus) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!gid) return undefined;
    const off1 = subscribeGame(gid, () => force());
    const off2 = onInlineChange((id) => { if (!id || Number(id) === Number(gid)) force(); });
    return () => { off1(); off2(); };
  }, [gid]);
  if (!gid) return null;
  return ensureInlineView(gid, cardStatus) || getGameView(gid);
}

function InlineVelha({ view, pal, t }) {
  const busy = inlineBusy(view.g);
  return (
    <View style={{ alignItems: 'center', marginTop: -2, marginBottom: 2 }}>
      <VelhaBoard view={view} pal={pal} busy={busy} maxW={244} t={t}
        onMove={(mv) => inlineMove(view.g, mv, t, { kind: 'cell', val: mv.cell }, true)} />
    </View>
  );
}

function InlineForca({ view, pal, t, me, rm }) {
  const S = view.state || {};
  const mask = Array.isArray(S.mask) ? S.mask : [];
  const guessed = new Set((S.g || []).map(norm));
  const shown = new Set(mask.filter(Boolean).map(norm));
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const busy = inlineBusy(view.g);
  const pend = inlinePending(view.g);
  const finished = view.status === 'finished';
  const slot = Math.min(22, Math.floor(232 / Math.max(8, mask.length)) - 3);
  const max = S.max || 6; const wrong = S.wrong || 0;
  return (
    <View style={{ marginBottom: 4 }}>
      <View style={st.fRow}>
        {S.cat ? <View style={[st.cat, { borderColor: pal.line }]}><Text style={{ color: pal.ink, fontWeight: '700', fontSize: 11 }} numberOfLines={1}>{S.cat}</Text></View> : <View />}
        <Text style={{ color: wrong >= max - 1 ? pal.bad : pal.sub, fontSize: 11.5, fontWeight: '700' }}>{tr(t, 'games.forca.errors', '{n} de {max} erros', { n: wrong, max })}</Text>
      </View>
      <View style={st.lives}>
        {Array.from({ length: max }).map((_, k) => <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: k < wrong ? pal.bad : pal.card2 }} />)}
      </View>
      <View style={st.word} accessibilityLabel={mask.map((c) => c || '_').join(' ')}>
        {mask.map((ch, i) => {
          if (ch === '-' || ch === ' ') return <View key={i} style={{ width: slot * 0.5 }} />;
          const missed = finished && S.hanged && ch && !guessed.has(norm(ch));
          return (
            <View key={i} style={{ width: slot, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: finished ? (missed ? pal.bad : pal.good) : pal.ink, marginHorizontal: 1.5 }}>
              <Text style={{ color: missed ? pal.bad : pal.ink, fontSize: slot * 0.82, fontWeight: '900', height: slot * 1.15 }}>{ch || ' '}</Text>
            </View>
          );
        })}
      </View>
      {view.status === 'active' ? ROWS.map((row) => (
        <View key={row} style={st.kbRow}>
          {row.split('').map((L) => {
            const used = guessed.has(L);
            const hit = used && shown.has(L);
            const isPend = pend && pend.kind === 'letter' && pend.val === L;
            const can = myTurn && !used && !busy;
            return (
              <PressScale key={L} disabled={!can} rm={rm} scaleTo={0.86}
                onPress={() => { hTap(); inlineMove(view.g, { a: 'letter', l: L }, t, { kind: 'letter', val: L }, true); }}
                style={[st.key, { backgroundColor: hit || isPend ? pal.strong : (used ? 'transparent' : pal.card), borderWidth: used && !hit ? 1 : 0, borderColor: pal.line, opacity: used && !hit ? 0.4 : (myTurn ? 1 : 0.7) }]}
                accessibilityRole="button" accessibilityLabel={L} accessibilityState={{ disabled: !can }}>
                <Text style={{ color: hit || isPend ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 13.5, textDecorationLine: used && !hit ? 'line-through' : 'none' }}>{L}</Text>
              </PressScale>
            );
          })}
        </View>
      )) : null}
      {finished && S.word ? <Text style={{ color: pal.sub, fontSize: 12, textAlign: 'center', marginTop: 2 }}>{tr(t, 'games.forca.wordWas', 'A palavra era {w}', { w: S.word })}</Text> : null}
    </View>
  );
}

function InlineQuiz({ view, pal, t, rm }) {
  const S = view.state || {};
  const isPlayer = view.me !== null && view.me !== undefined && !(S.out && S.out[view.me]);
  const pend = inlinePending(view.g);
  const myChoice = S.my ? S.my.c : (pend && pend.kind === 'answer' && pend.q === S.i ? pend.val : null);
  const answered = myChoice !== null && myChoice !== undefined;
  const reveal = S.ph !== 'q';
  const secs = quizSecondsLeft(view);
  const count = S.count || 10;
  if (view.status !== 'active') return null;
  return (
    <View style={{ marginBottom: 4 }}>
      <View style={st.fRow}>
        <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 11.5 }}>{tr(t, 'games.quiz.progress', 'Pergunta {i} de {n}', { i: (S.i || 0) + 1, n: count })}</Text>
        {!reveal ? <View style={[st.secs, { backgroundColor: secs <= 3 ? pal.bad : pal.strong }]}><Text style={{ color: secs <= 3 ? '#FFFFFF' : pal.onStrong, fontWeight: '900', fontSize: 12, fontVariant: ['tabular-nums'] }}>{secs}s</Text></View> : null}
      </View>
      <Text style={[st.q, { color: pal.ink }]}>{S.q}</Text>
      {(S.o || []).map((o, i) => {
        const right = reveal && i === S.a;
        const mineWrong = reveal && myChoice === i && i !== S.a;
        const chosen = myChoice === i;
        const dis = !isPlayer || reveal || answered;
        const bg = right ? pal.good : (chosen && !reveal ? pal.strong : pal.card);
        const fg = right ? '#FFFFFF' : (chosen && !reveal ? pal.onStrong : pal.ink);
        return (
          <PressScale key={i} disabled={dis} rm={rm} scaleTo={0.97}
            onPress={() => { hTap(); inlineMove(view.g, { a: 'answer', q: S.i, c: i }, t, { kind: 'answer', val: i, q: S.i }, true); }}
            style={[st.opt, { backgroundColor: bg, borderColor: mineWrong ? pal.bad : pal.line, borderWidth: mineWrong ? 2 : StyleSheet.hairlineWidth, opacity: reveal && !right && !chosen ? 0.5 : 1 }]}
            accessibilityRole="button" accessibilityLabel={`${LETTERS[i]}. ${o}`} accessibilityState={{ disabled: dis, selected: chosen }}>
            <Text style={{ color: fg, fontWeight: '900', width: 16 }}>{LETTERS[i]}</Text>
            <Text style={{ color: fg, fontSize: 13.5, fontWeight: '600', flex: 1 }} numberOfLines={2}>{o}</Text>
          </PressScale>
        );
      })}
      <Text style={{ color: reveal && S.my && S.my.pts > 0 ? pal.good : pal.sub, fontSize: 12, textAlign: 'center', marginTop: 2, fontWeight: reveal ? '800' : '500' }}>
        {!reveal
          ? (answered ? tr(t, 'games.inline.answered', 'Resposta enviada') : (isPlayer ? tr(t, 'games.quiz.answerFast', 'Responda rápido: vale mais pontos') : tr(t, 'games.spectating', 'Você está assistindo')))
          : (S.my && S.my.pts > 0 ? tr(t, 'games.quiz.gotPts', 'Certa! +{n} pontos', { n: S.my.pts }) : (S.my ? tr(t, 'games.quiz.wrong', 'Não foi desta vez') : tr(t, 'games.quiz.next', 'Próxima pergunta já vem')))}
      </Text>
    </View>
  );
}

/** Miniatura das Damas (8×8, peças P&B; o último lance em dourado). */
const DamasThumb = memo(function DamasThumb({ bd, flip, last, pal, size = 148 }) {
  const cell = size / 8;
  const lastSet = new Set(last && Array.isArray(last.p) ? [last.p[0], last.p[last.p.length - 1]] : []);
  const cells = [];
  for (let k = 0; k < 64; k++) {
    const sq = flip ? 63 - k : k;
    const r = Math.floor(k / 8); const c = k % 8;
    const dark = (r + c) % 2 === 1;
    const ch = bd[sq];
    cells.push(
      <View key={k} style={{ position: 'absolute', left: c * cell, top: r * cell, width: cell, height: cell, backgroundColor: lastSet.has(sq) ? pal.accentSoft : (dark ? pal.boardDark : pal.boardLight), alignItems: 'center', justifyContent: 'center' }}>
        {ch && ch !== '.' ? (
          <View style={{ width: cell * 0.74, height: cell * 0.74, borderRadius: cell, backgroundColor: ch === 'w' || ch === 'W' ? '#F4F1EA' : '#151517', borderWidth: ch === 'W' || ch === 'B' ? 2 : 1, borderColor: ch === 'W' || ch === 'B' ? pal.accent : (ch === 'w' ? '#B9B4A8' : '#5A5A60') }} />
        ) : null}
      </View>,
    );
  }
  return <View style={{ width: size, height: size, borderRadius: 6, overflow: 'hidden', borderWidth: 3, borderColor: pal.frame }}>{cells}</View>;
});

function SheetThumb({ view, pal, t, me, onOpen }) {
  const S = view.state || {};
  let inner = null;
  if (view.type === 'damas') {
    const bd = typeof S.bd === 'string' && S.bd.length === 64 ? S.bd : '.'.repeat(64);
    inner = <DamasThumb bd={bd} flip={view.me === 1} last={S.last} pal={pal} />;
  } else if (view.type === 'cartas') {
    const hand = Array.isArray(S.hand) ? S.hand.length : null;
    const seats = Array.isArray(view.seats) ? view.seats : [];
    const counts = Array.isArray(S.counts) ? S.counts : [];
    inner = (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {S.top ? <CardFace code={S.top} w={52} h={76} /> : null}
        <View style={{ gap: 3, maxWidth: 150 }}>
          {hand !== null ? <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13.5 }}>{tr(t, 'games.inline.yourCards', 'Você tem {n} cartas', { n: hand })}</Text> : null}
          {seats.map((e, i) => (i === view.me ? null : (
            <Text key={e} style={{ color: pal.sub, fontSize: 12 }} numberOfLines={1}>{nameOf(view, e, me, t)} · {tr(t, 'games.cartas.nShort', '{n} c.', { n: counts[i] ?? 0 })}</Text>
          )))}
        </View>
      </View>
    );
  }
  if (!inner) return null;
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [st.thumb, { backgroundColor: pal.card, borderColor: pal.line, opacity: pressed ? 0.8 : 1 }]}
      accessibilityRole="button" accessibilityLabel={tr(t, 'games.inline.openBoard', 'Abrir o tabuleiro')}>
      {inner}
    </Pressable>
  );
}

/** O cartão tem tabuleiro para desenhar com esta visão? (mesma regra do GameInlineBoard e do nativo) */
export function inlineHasBoard(view) {
  if (!view || !view.state) return false;
  if (view.status === 'active') return ['velha', 'forca', 'quiz', 'damas', 'cartas'].includes(view.type);
  if (view.status === 'finished') return view.type === 'velha' || view.type === 'forca';
  return false;
}

/**
 * Corpo interativo do cartão. Devolve null quando não há o que desenhar (convite, cancelado, sem visão) —
 * o cartão segue com o desenho normal.
 */
function GameInlineBoard({ g, currentEmail, colors, isDark, t, onOpen }) {
  const view = useInlineView(g && g.g, g && g.status);
  const pal = useMemo(() => gamePalette(colors || {}, !!isDark), [colors, isDark]);
  const rm = useRM();
  if (!g || !inlineHasBoard(view)) return null;
  const me = String(currentEmail || '').toLowerCase();
  const err = inlineError(view.g);
  let body = null;
  if (view.type === 'velha') body = <InlineVelha view={view} pal={pal} t={t} />;
  else if (view.type === 'forca') body = <InlineForca view={view} pal={pal} t={t} me={me} rm={rm} />;
  else if (view.type === 'quiz') body = <InlineQuiz view={view} pal={pal} t={t} rm={rm} />;
  else if (view.type === 'damas' || view.type === 'cartas') body = <SheetThumb view={view} pal={pal} t={t} me={me} onOpen={onOpen} />;
  if (!body) return null;
  return (
    <View style={[st.wrap, { backgroundColor: pal.bg }]}>
      {body}
      {err ? <Text style={{ color: pal.bad, fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 4 }}>{err}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  fRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  cat: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 150 },
  lives: { flexDirection: 'row', gap: 3 },
  word: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginVertical: 10 },
  kbRow: { flexDirection: 'row', justifyContent: 'center', gap: 4, marginBottom: 4 },
  key: { width: 30, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  secs: { borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2 },
  q: { fontSize: 15, fontWeight: '800', lineHeight: 20, marginBottom: 8 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 9, marginBottom: 6 },
  thumb: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 10, marginBottom: 2 },
});

export default memo(GameInlineBoard);
