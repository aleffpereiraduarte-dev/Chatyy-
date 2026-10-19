// components/games/GameScoreboard.js — [jogos 2026-10-18] "Placar do grupo": vitórias por membro e por jogo
// (chat_game_scoreboard). Usado dentro do seletor de jogos e como folha própria (dados do grupo).
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, Pressable, Modal, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

export default function GameScoreboardSheet({ visible, onClose, conversationId, currentEmail, t, colors, isDark, title }) {
  const ins = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { backgroundColor: colors.background || (isDark ? '#000' : '#fff'), paddingBottom: Math.max(ins.bottom, 16) }]}>
        <View style={s.grab} />
        <Text style={[s.title, { color: colors.text }]}>{title || tr(t, 'games.score.title', 'Placar do grupo')}</Text>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 16 }}>
          <ScoreboardList conversationId={conversationId} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8 },
  grab: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 8 },
  title: { fontSize: 18, fontWeight: '800', paddingHorizontal: 16, marginBottom: 6 },
  empty: { textAlign: 'center', marginTop: 10, fontSize: 14, paddingHorizontal: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
});
