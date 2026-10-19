// components/games/GameScoreboard.js — [jogos 2026-10-18] "Placar do grupo": vitórias por membro e por jogo
// (chat_game_scoreboard). Usado dentro do seletor de jogos e como folha própria (dados do grupo).
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
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
});
