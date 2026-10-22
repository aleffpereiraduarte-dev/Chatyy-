// app/voar-ranking.js — [voar 2026-10-22] Brisa: ranking da SEMANA (Geral / Amigos / País) + contagem
// regressiva até segunda 00:00 (horário de Brasília). Servidor: chat_game_fly_rank. Amigos = conversas
// diretas + quem você segue; País = do perfil (telefone verificado), nunca IP. Contas de teste ficam fora.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from '../components/AvatarCircle';
import { Buddy } from '../components/flyGame/BuddyArt';
import { IconChevronLeft } from '../components/games/GameIcons';
import { flyRank } from '../services/flyGame/api';

function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k, vars ? { ...vars, defaultValue: fb } : fb) : fb; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}
function fmtLeft(ms, t) {
  if (ms <= 0) return tr(t, 'fly.rank.resetNow', 'reiniciando');
  const s = Math.floor(ms / 1000); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(ss)}` : `${p(h)}:${p(m)}:${p(ss)}`;
}
const MEDAL = ['#E9C46A', '#C9D3DE', '#D69A6A'];

export default function VoarRanking() {
  const router = useRouter();
  const { t } = useLanguage();
  const { user } = useAuth();
  const myEmail = String(user?.email || '').toLowerCase();
  const insets = useSafeAreaInsets();
  const [scope, setScope] = useState('all');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (sc, soft) => {
    if (!soft) setLoading(true);
    setErr('');
    const r = await flyRank(sc);
    if (!alive.current) return;
    if (r && r.success && r.data) { setData((p) => ({ ...p, [sc]: r.data })); if (r.data.now_ms) skew.current = r.data.now_ms - Date.now(); }
    else setErr(tr(t, 'fly.rank.error', 'Não deu para carregar o ranking.'));
    setLoading(false); setRefreshing(false);
  }, [t]);
  useEffect(() => { load(scope, !!data[scope]); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const d = data[scope] || {};
  const items = Array.isArray(d.items) ? d.items : [];
  const meRow = d.me && d.me.rank && !items.some((x) => x.me) ? d.me : null;
  const endsMs = Number(d.ends_ms || (data.all && data.all.ends_ms) || 0);
  const left = endsMs ? endsMs - (now + skew.current) : 0;
  useEffect(() => { if (endsMs && left <= 0 && left > -3000) load(scope, true); }, [endsMs, left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = [['all', tr(t, 'fly.rank.all', 'Geral')], ['friends', tr(t, 'fly.rank.friends', 'Amigos')], ['country', tr(t, 'fly.rank.country', 'País')]];
  const back = () => { try { if (router.canGoBack?.()) router.back(); else router.replace('/voar'); } catch {} };

  const renderRow = ({ item }) => (
    <View style={[st.row, item.me && st.rowMe]}>
      <View style={st.rankBox}>
        {item.rank <= 3 ? <View style={[st.medal, { backgroundColor: MEDAL[item.rank - 1] }]}><Text style={st.medalTxt}>{item.rank}</Text></View>
          : <Text style={st.rankTxt}>{item.rank}</Text>}
      </View>
      <AvatarCircle email={item.email} name={item.name} size={38} />
      <Text style={st.name} numberOfLines={1}>{item.me ? tr(t, 'fly.rank.you', 'Você') : item.name}</Text>
      <Text style={st.sc}>{item.score}</Text>
    </View>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + 6 }]}>
      <View style={st.header}>
        <Pressable onPress={back} hitSlop={10} style={st.hBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}><IconChevronLeft size={20} color="#EAF2FA" /></Pressable>
        <Text style={st.title}>{tr(t, 'fly.rank.title', 'Ranking da semana')}</Text>
        <View style={st.hBtn} />
      </View>
      <View style={st.hero}>
        <Buddy size={64} />
        <View style={{ flex: 1 }}>
          <Text style={st.heroTitle}>{tr(t, 'fly.title', 'Brisa')}</Text>
          <Text style={st.heroSub}>{tr(t, 'fly.rank.resetsIn', 'Reinicia em {t}', { t: fmtLeft(left, t) })}</Text>
          <Text style={st.heroSmall}>{tr(t, 'fly.rank.resetsWhen', 'Toda segunda, 00:00 (Brasília)')}</Text>
        </View>
      </View>
      {d.prizes_on ? <Text style={st.prize}>{tr(t, 'fly.rank.prizes', 'Top 10 da semana ganham diamantes e selo no perfil, depois de uma revisão.')}</Text> : null}
      <View style={st.tabs} accessibilityRole="tablist">
        {tabs.map(([k, label]) => (
          <Pressable key={k} onPress={() => setScope(k)} style={[st.tab, scope === k && st.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: scope === k }}>
            <Text style={[st.tabTxt, scope === k && st.tabTxtOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {loading && !data[scope] ? <ActivityIndicator style={{ marginTop: 30 }} color="#8FD3FF" /> : (
        <FlatList
          data={items}
          keyExtractor={(x) => `${x.rank}-${x.email}`}
          renderItem={renderRow}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + (meRow ? 90 : 24) }}
          refreshControl={Platform.OS === 'web' ? undefined : <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(scope, true); }} tintColor="#8FD3FF" />}
          ListEmptyComponent={
            <Text style={st.empty}>
              {err || (scope === 'country' && !d.country ? tr(t, 'fly.rank.noCountry', 'Não identificamos seu país pelo perfil. Verifique seu telefone nas configurações.')
                : scope === 'friends' ? tr(t, 'fly.rank.emptyFriends', 'Nenhum amigo jogou nesta semana. Desafie alguém!')
                  : tr(t, 'fly.rank.empty', 'Ninguém jogou nesta semana ainda. Seja o primeiro!'))}
            </Text>
          }
        />
      )}
      {meRow ? (
        <View style={[st.meBar, { paddingBottom: insets.bottom + 10 }]}>
          {renderRow({ item: { rank: meRow.rank, email: myEmail, name: '', score: meRow.score, me: true } })}
        </View>
      ) : null}
      {d.ranked === false ? <Text style={[st.empty, { marginTop: 0 }]}>{tr(t, 'fly.qaNote', 'Conta de teste: fora do ranking')}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#11161E' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 44 },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', color: '#EEF3F8', fontSize: 17, fontWeight: '800' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 8, padding: 16, borderRadius: 24, backgroundColor: '#1A212C' },
  heroTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '800' },
  heroSub: { color: '#BFE6FF', fontSize: 15, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  heroSmall: { color: '#8E9AAB', fontSize: 12, fontWeight: '600', marginTop: 2 },
  prize: { color: '#9AA6B6', fontSize: 12.5, marginHorizontal: 20, marginTop: 10 },
  tabs: { flexDirection: 'row', margin: 16, marginBottom: 8, padding: 4, borderRadius: 16, backgroundColor: '#1A212C' },
  tab: { flex: 1, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: '#F3F7FB' },
  tabTxt: { color: '#AAB6C5', fontWeight: '700', fontSize: 14 },
  tabTxtOn: { color: '#121821' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 16 },
  rowMe: { backgroundColor: 'rgba(143,211,255,0.12)' },
  rankBox: { width: 30, alignItems: 'center' },
  rankTxt: { color: '#8E9AAB', fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
  medal: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  medalTxt: { color: '#141A24', fontWeight: '900', fontSize: 13 },
  name: { flex: 1, color: '#EEF3F8', fontSize: 15.5, fontWeight: '600' },
  sc: { color: '#FFFFFF', fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  empty: { color: '#8E9AAB', textAlign: 'center', marginTop: 40, marginHorizontal: 30, lineHeight: 20 },
  meBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 8, backgroundColor: 'rgba(17,22,30,0.97)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.1)' },
});
