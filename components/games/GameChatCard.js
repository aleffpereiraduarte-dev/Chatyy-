// components/games/GameChatCard.js — [jogos 2026-10-18] cartão do jogo na conversa (render JS).
// O mesmo desenho existe na lista NATIVA (components/chat/nativeRowCards.js buildGame).
// content = JSON público do servidor ({kind:'game'|'result', g, type, status, players, turn, winners...}).
import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { GameTypeIcon, IconTrophy } from './GameIcons';
import {
  parseGameContent, gameTitle, gameStatusLine, resultHeadline, gameCardActions, gameActionLabel,
  nameOf, playerStatusLabel, isMyTurn, tr, gameEndBadge,
} from '../../services/games';
import GameInlineBoard, { useInlineView, inlineHasBoard } from './GameInlineBoard';
import { gamesInlineOn, isInlineType } from '../../services/gamesInline';

const PRIMARY = new Set(['accept', 'join', 'start', 'play', 'rematch']);

function Initials({ name, size = 22, dark, bg }) {
  const s = String(name || '?').trim();
  const ini = (s.split(/\s+/).map((x) => x[0]).join('').slice(0, 2) || '?').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: bg || (dark ? '#3A3A3C' : '#E5E5EA') }}>
      <Text style={{ fontSize: size * 0.4, fontWeight: '700', color: dark ? '#F2F2F7' : '#1C1C1E' }}>{ini}</Text>
    </View>
  );
}

// [jogos 2026-10-19 inline] revanche no cartão = "Jogar de novo" (a outra pessoa ainda aceita)
export function _actLabel(t, a, g, me, inlineOn) {
  if (inlineOn && a === 'rematch' && !(g && g.rematch_st === 'pending' && g.rematch_by && String(g.rematch_by).toLowerCase() !== String(me || '').toLowerCase())) return tr(t, 'games.act.playAgain', 'Jogar de novo');
  return gameActionLabel(t, a, g, me);
}

function GameChatCard({ msg, isOwn, currentEmail, colors, isDark, t, onAction }) {
  const g = parseGameContent(msg && msg.content);
  // [jogos 2026-10-19 inline] Velha/Forca/Quiz jogáveis no cartão; Damas/Cartas = miniatura (toque abre a folha)
  const inlineOn = gamesInlineOn();
  const liveId = inlineOn && g && g.kind === 'game' && (g.status === 'active' || g.status === 'finished') ? g.g : null;
  const iv = useInlineView(liveId, g && g.status, g && g.v);
  const hasBoard = !!liveId && inlineHasBoard(iv);
  if (!g) return <Text style={{ color: isOwn ? '#fff' : colors.text }}>{tr(t, 'games.preview', 'Jogo')}</Text>;
  const ink = isOwn ? '#FFFFFF' : (colors.text || '#111');
  const sub = isOwn ? 'rgba(255,255,255,0.72)' : (colors.textSecondary || '#6b7280');
  const line = isOwn ? 'rgba(255,255,255,0.18)' : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)');
  let acts = gameCardActions(g, currentEmail);
  // tabuleiro já no cartão → "Jogar"/"Assistir" sobram (tocar o cabeçalho abre a partida completa)
  if (hasBoard && isInlineType(g.type)) acts = acts.filter((a) => a !== 'play' && a !== 'watch');
  const press = (a) => { try { onAction && onAction(msg, a, g); } catch {} };
  const isResult = g.kind === 'result';
  const myTurn = isMyTurn(g, currentEmail);
  // [jogos 2026-10-19] estado final sempre visível: Cancelado · Expirado · Recusado · Empate · Venceu · Perdeu · Abandonou
  const badge = gameEndBadge(t, g, currentEmail);
  const BADGE_BG = { won: '#16A34A', resigned_other: '#16A34A', lost: 'rgba(255,255,255,0.16)', draw: 'rgba(255,255,255,0.22)', abandoned: '#B45309', expired: 'rgba(255,255,255,0.16)', cancelled: 'rgba(255,255,255,0.16)', declined: 'rgba(255,255,255,0.16)' };

  const header = (
    <View style={[st.head, { backgroundColor: isResult ? '#000' : '#111' }]}>
      <View style={st.headIcon}>
        {isResult ? <IconTrophy size={18} color="#fff" /> : <GameTypeIcon type={g.type} size={18} color="#fff" />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={st.headTitle} numberOfLines={1}>{gameTitle(t, g.type)}</Text>
        <Text style={st.headSub} numberOfLines={1}>{isResult ? tr(t, 'games.resultLabel', 'Resultado') : tr(t, 'games.cardLabel', 'Jogo na conversa')}</Text>
      </View>
      {myTurn ? <View style={st.turnPill}><Text style={st.turnPillTx}>{tr(t, 'games.status.yourTurn', 'Sua vez')}</Text></View> : null}
      {!myTurn && badge ? <View style={[st.endPill, { backgroundColor: BADGE_BG[badge.kind] || 'rgba(255,255,255,0.16)' }]}><Text style={st.endPillTx}>{badge.label}</Text></View> : null}
    </View>
  );

  let body;
  if (isResult) {
    const rk = Array.isArray(g.ranking) ? g.ranking.slice(0, 3) : [];
    const showScore = g.type === 'quiz' || g.type === 'forca';
    body = (
      <View style={st.body}>
        <Text style={[st.headline, { color: ink }]}>{resultHeadline(t, g, currentEmail)}</Text>
        {g.type === 'forca' && g.word ? <Text style={[st.small, { color: sub }]}>{tr(t, 'games.forca.wordWas', 'A palavra era {w}', { w: g.word })}</Text> : null}
        {rk.length > 1 ? rk.map((r, i) => (
          <View key={r.e} style={[st.rankRow, { borderTopColor: line }]}>
            <Text style={[st.rankN, { color: i === 0 ? ink : sub }]}>{i + 1}</Text>
            <Initials name={r.n} dark={isOwn || isDark} />
            <Text style={[st.rankName, { color: ink, fontWeight: i === 0 ? '700' : '500' }]} numberOfLines={1}>{nameOf(g, r.e, currentEmail, t)}</Text>
            {showScore ? <Text style={[st.rankSc, { color: sub }]}>{tr(t, 'games.points', '{n} pts', { n: r.sc })}</Text> : null}
          </View>
        )) : null}
      </View>
    );
  } else {
    const pls = hasBoard ? [] : Array.isArray(g.players) ? g.players.filter((p) => g.status === 'pending' || p.s === 'accepted' || p.s === 'left') : [];
    body = (
      <View style={st.body}>
        {pls.length ? <View style={st.players}>
          {pls.slice(0, 6).map((p) => {
            const turn = g.status === 'active' && String(g.turn || '').toLowerCase() === String(p.e).toLowerCase();
            const win = Array.isArray(g.winners) && g.winners.some((w) => String(w).toLowerCase() === String(p.e).toLowerCase());
            return (
              <View key={p.e} style={st.pl}>
                <View style={turn || win ? { borderWidth: 2, borderColor: ink, borderRadius: 14, padding: 1 } : { padding: 3 }}>
                  <Initials name={p.n} dark={isOwn || isDark} />
                </View>
                <Text style={[st.plName, { color: ink }]} numberOfLines={1}>{nameOf(g, p.e, currentEmail, t)}</Text>
                {g.status === 'pending' ? <Text style={[st.plSt, { color: sub }]} numberOfLines={1}>{playerStatusLabel(t, p.s)}</Text> : null}
              </View>
            );
          })}
          {pls.length > 6 ? <Text style={[st.small, { color: sub, alignSelf: 'center' }]}>+{pls.length - 6}</Text> : null}
        </View> : null}
        <Text style={[st.status, { color: ink }]} numberOfLines={2}>{gameStatusLine(t, g, currentEmail)}</Text>
      </View>
    );
  }

  return (
    <View style={[st.card, { borderColor: line }]}>
      <Pressable onPress={() => press(acts.includes('play') ? 'play' : (acts.includes('watch') ? 'watch' : 'open'))} accessibilityRole="button"
        accessibilityLabel={`${gameTitle(t, g.type)}. ${isResult ? resultHeadline(t, g, currentEmail) : gameStatusLine(t, g, currentEmail)}`}>
        {header}
        {hasBoard ? null : body}
      </Pressable>
      {hasBoard ? (
        <>
          <GameInlineBoard g={g} currentEmail={currentEmail} colors={colors} isDark={isDark} t={t} onOpen={() => press('play')} />
          <Pressable onPress={() => press(acts.includes('play') ? 'play' : (acts.includes('watch') ? 'watch' : 'open'))} accessibilityRole="button">{body}</Pressable>
        </>
      ) : null}
      {acts.length ? (
        <View style={[st.acts, { borderTopColor: line }]}>
          {acts.slice(0, 3).map((a) => {
            const prim = PRIMARY.has(a);
            return (
              <Pressable key={a} onPress={() => press(a)} style={({ pressed }) => [st.btn, prim ? { backgroundColor: isOwn ? '#fff' : (isDark ? '#fff' : '#111') } : { borderWidth: 1, borderColor: line }, pressed && { opacity: 0.7 }]}
                accessibilityRole="button" accessibilityLabel={_actLabel(t, a, g, currentEmail, inlineOn)}>
                <Text style={[st.btnTx, { color: prim ? (isOwn || isDark ? '#111' : '#fff') : ink }]}>{_actLabel(t, a, g, currentEmail, inlineOn)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { width: 268, borderRadius: 14, overflow: 'hidden', marginVertical: 1 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, gap: 9 },
  headIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  headTitle: { color: '#fff', fontWeight: '700', fontSize: 14.5 },
  headSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 },
  turnPill: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  turnPillTx: { color: '#000', fontSize: 11, fontWeight: '800' },
  endPill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  endPillTx: { color: '#fff', fontSize: 11, fontWeight: '800' },
  body: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  players: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  pl: { alignItems: 'center', width: 54 },
  plName: { fontSize: 11, marginTop: 3, fontWeight: '600', maxWidth: 54 },
  plSt: { fontSize: 9.5, marginTop: 1 },
  status: { fontSize: 14.5, fontWeight: '700' },
  headline: { fontSize: 15, fontWeight: '800', lineHeight: 20, marginBottom: 6 },
  small: { fontSize: 12 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  rankN: { width: 14, fontSize: 13, fontWeight: '800', textAlign: 'center' },
  rankName: { flex: 1, fontSize: 13.5 },
  rankSc: { fontSize: 12, fontWeight: '600' },
  acts: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  btnTx: { fontSize: 13.5, fontWeight: '700' },
});

export default memo(GameChatCard);
