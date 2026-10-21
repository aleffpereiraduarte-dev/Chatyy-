// components/games/GameScoreboard.js — [jogos 2026-10-18] "Placar do grupo": vitórias por membro e por jogo
// (chat_game_scoreboard). Usado dentro do seletor de jogos e como folha própria (dados do grupo).
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { grafite, cardShadow } from '../../constants/theme';
import GameSheet, { sheetScrollFill } from './GameSheet';
import AvatarCircle from '../AvatarCircle';
import { gameScoreboard, gameTitle, tr, GAME_TYPES } from '../../services/games';
import { GameTypeIcon, IconPodium } from './GameIcons';

export function ScoreboardList({ conversationId, currentEmail, t, colors, isDark }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await gameScoreboard(conversationId);
      if (!alive) return;
      if (r && r.success) setRows(Array.isArray(r.data && r.data.rows) ? r.data.rows : []);
      else setErr(true);
    })();
    return () => { alive = false; };
  }, [conversationId]);
  const ink = colors.text || '#111';
  const sub = colors.textSecondary || '#6b7280';
  const line = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  if (err) return <Text style={[s.empty, { color: sub }]}>{tr(t, 'games.score.failed', 'Não foi possível carregar o placar.')}</Text>;
  if (!rows) return <ActivityIndicator style={{ marginVertical: 24 }} color={ink} />;
  if (!rows.length) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 26 }}>
        <IconPodium size={34} color={sub} />
        <Text style={[s.empty, { color: sub }]}>{tr(t, 'games.score.empty', 'Ninguém jogou ainda. A primeira vitória entra aqui.')}</Text>
      </View>
    );
  }
  const me = String(currentEmail || '').toLowerCase();
  return (
    <View>
      {rows.map((r, i) => (
        <View key={r.e} style={[s.row, { borderBottomColor: line }]}>
          <View style={[s.rank, { backgroundColor: i === 0 ? ink : 'transparent', borderColor: i === 0 ? ink : line }]}>
            <Text style={{ color: i === 0 ? (isDark ? '#000' : '#fff') : ink, fontWeight: '800', fontSize: 13 }}>{i + 1}</Text>
          </View>
          <AvatarCircle email={r.e} name={r.n || r.e} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: ink, fontWeight: r.e === me ? '800' : '600', fontSize: 15 }} numberOfLines={1}>
              {r.e === me ? tr(t, 'games.you', 'Você') : (r.n || r.e.split('@')[0])}
            </Text>
            <View style={s.chips}>
              {GAME_TYPES.filter((ty) => r.games && r.games[ty]).map((ty) => (
                <View key={ty} style={[s.chip, { borderColor: line }]}>
                  <GameTypeIcon type={ty} size={12} color={sub} />
                  <Text style={{ color: sub, fontSize: 11 }}>{gameTitle(t, ty)} {r.games[ty].wins}/{r.games[ty].played}</Text>
                </View>
              ))}
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: ink, fontWeight: '800', fontSize: 18 }}>{r.wins}</Text>
            <Text style={{ color: sub, fontSize: 10.5 }}>{tr(t, 'games.score.wins', 'vitórias')}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// [jogos 2026-10-21 painel] placar dos dois no topo do painel (mockup jogos2): "Você 4 x 3 Thalissa", sequência de
// vitórias e total de partidas (chat_game_scoreboard: rows + total + streak). Em grupo: eu x o líder (ou o 2º, se
// o líder sou eu). Tocar abre o placar completo (onPress). Sem dados ainda = 0 x 0.
function _first(n) { return String(n || '').split(' ')[0]; }
export function ScoreStrip({ conversationId, conversationType, members, currentEmail, t, isDark, onPress, refreshKey = 0 }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await gameScoreboard(conversationId);
      if (alive && r && r.success && r.data) setData(r.data);
    })();
    return () => { alive = false; };
  }, [conversationId, refreshKey]);
  const G = grafite(!!isDark);
  const me = String(currentEmail || '').toLowerCase();
  const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
  const mine = rows.find((r) => r.e === me) || { e: me, wins: 0 };
  let other = null;
  if (conversationType === 'group') other = rows.find((r) => r.e !== me) || null;
  else {
    const m = (Array.isArray(members) ? members : []).find((x) => x && x.email && String(x.email).toLowerCase() !== me);
    const oe = m ? String(m.email).toLowerCase() : null;
    other = rows.find((r) => r.e !== me && (!oe || r.e === oe)) || (oe ? { e: oe, n: m.name || m.display_name || oe.split('@')[0], wins: 0 } : null);
  }
  const total = data ? Number(data.total || 0) : 0;
  const streak = data && data.streak && data.streak.count >= 2 ? data.streak : null;
  const streakTx = (n) => tr(t, 'games.panel.streak', '{n} vitórias seguidas', { n });
  const totalTx = total === 1 ? tr(t, 'games.panel.matches1', '1 partida') : tr(t, 'games.panel.matches', '{n} partidas', { n: total });
  const otherName = other ? _first(other.n || other.e.split('@')[0]) : tr(t, 'games.panel.nobody', 'Ninguém ainda');
  const leftSmall = streak && streak.e === me ? streakTx(streak.count) : (other && streak && streak.e === other.e ? totalTx : null);
  const rightSmall = other && streak && streak.e === other.e ? streakTx(streak.count) : totalTx;
  const groupRank = conversationType === 'group' && other ? tr(t, 'games.panel.rank', '{n}º lugar', { n: rows.indexOf(other) + 1 }) : null;
  const a11y = tr(t, 'games.panel.scoreA11y', 'Placar: você {a}, {name} {b}. {total}', { a: mine.wins || 0, b: other ? (other.wins || 0) : 0, name: otherName, total: totalTx });
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.vs, { backgroundColor: G.surface }, cardShadow(!!isDark), pressed && { opacity: 0.85 }]}
      accessibilityRole="button" accessibilityLabel={a11y} accessibilityHint={tr(t, 'games.panel.scoreHint', 'Abre o placar completo')}>
      <View style={s.vsSide}>
        <AvatarCircle email={me} name={tr(t, 'games.you', 'Você')} size={34} />
        <View style={{ flexShrink: 1 }}>
          <Text style={[s.vsName, { color: G.text }]} numberOfLines={1}>{tr(t, 'games.you', 'Você')}</Text>
          {leftSmall ? <Text style={[s.vsSmall, { color: G.muted }]} numberOfLines={1}>{leftSmall}</Text> : null}
        </View>
      </View>
      <Text style={[s.vsScore, { color: G.text }]}>
        {mine.wins || 0}<Text style={[s.vsX, { color: G.muted }]}>{'  x  '}</Text>{other ? (other.wins || 0) : 0}
      </Text>
      <View style={[s.vsSide, { justifyContent: 'flex-end' }]}>
        <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>
          <Text style={[s.vsName, { color: G.text }]} numberOfLines={1}>{otherName}</Text>
          <Text style={[s.vsSmall, { color: G.muted }]} numberOfLines={1}>{groupRank && !(streak && other && streak.e === other.e) ? groupRank : rightSmall}</Text>
        </View>
        {other ? <AvatarCircle email={other.e} name={other.n || other.e} size={34} /> : null}
      </View>
    </Pressable>
  );
}

// [jogos 2026-10-19] folha NATIVA (detents 60%/95% + grabber do sistema; web = folha deslizante)
export default function GameScoreboardSheet({ visible, onClose, conversationId, currentEmail, t, colors, isDark, title }) {
  if (!visible) return null;
  const bg = colors.background || (isDark ? '#000' : '#fff');
  return (
    <GameSheet visible onClose={onClose} bg={bg} detents={[0.6, 0.95]}>
      <View style={s.titleRow}>
        <IconPodium size={20} color={colors.text} />
        <Text style={[s.title, { color: colors.text }]}>{title || tr(t, 'games.score.title', 'Placar do grupo')}</Text>
      </View>
      <ScrollView style={sheetScrollFill} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <ScoreboardList conversationId={conversationId} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark} />
      </ScrollView>
    </GameSheet>
  );
}

const s = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', flex: 1 },
  empty: { textAlign: 'center', marginTop: 10, fontSize: 14, paddingHorizontal: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  vs: { flexDirection: 'row', alignItems: 'center', borderRadius: 22, paddingVertical: 12, paddingHorizontal: 14, gap: 10, marginBottom: 4 },
  vsSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  vsName: { fontSize: 13.5, fontWeight: '700' },
  vsSmall: { fontSize: 11, fontWeight: '600', marginTop: 1 },
  vsScore: { fontSize: 26, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  vsX: { fontSize: 18, fontWeight: '600', letterSpacing: 0 },
});
