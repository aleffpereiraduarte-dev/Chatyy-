// Painel de criador — Pro tier creator monetization dashboard.
// Surfaces, for the logged-in creator:
//   • subscriber_count + monthly_revenue_cents (chat_creator_subscriptions)
//   • weekly_tip_cents + monthly_tip_cents (chat_feed_tips payouts)
//   • pending_payout_cents (chat_wallet_balances)
//   • top tippers (last 30d)
//   • 7-day daily tip sparkline
//
// Backend: creator_dashboard action in email.php.

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Platform, StyleSheet, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';
import { IconArrowLeft } from '../components/Icons';

const ACCENT = '#7C3AED';

function formatCents(cents) {
  const v = (Number(cents) || 0) / 100;
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

// Same Sparkline shape as profile-insights — pure SVG, 7-point curve.
function Sparkline({ data, color = ACCENT, width = 260, height = 64 }) {
  const arr = Array.isArray(data) && data.length > 0 ? data : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...arr);
  const stepX = arr.length > 1 ? width / (arr.length - 1) : 0;
  const points = arr.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 4) - 2;
    return [x, y];
  });
  let d = '';
  if (points.length > 0) {
    d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
  }
  const allZero = arr.every(v => v === 0);
  return (
    <Svg width={width} height={height}>
      {allZero ? (
        <Path d={`M 0 ${height - 4} L ${width} ${height - 4}`} stroke={color} strokeOpacity={0.25} strokeWidth={1.5} strokeDasharray="4,4" />
      ) : (
        <>
          <Path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {points.map(([x, y], i) => (
            <Circle key={i} cx={x} cy={y} r={i === points.length - 1 ? 3.5 : 2} fill={color} />
          ))}
        </>
      )}
    </Svg>
  );
}

export default function CreatorDashboardScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({
    subscriber_count: 0,
    monthly_revenue_cents: 0,
    weekly_tip_cents: 0,
    monthly_tip_cents: 0,
    pending_payout_cents: 0,
    top_tippers: [],
    tip_series_7d: [],
  });

  const load = useCallback(async () => {
    try {
      const r = await api.creatorDashboard?.();
      if (r?.success && r.data) setData(r.data);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const cardBg = isDark ? '#1a1625' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const sparkData = (data.tip_series_7d || []).map(s => Number(s.tip_cents) || 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: cardBorder }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel={t?.('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t?.('profile.creatorDashboard') || 'Painel de criador'}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={ACCENT} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollBody}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
        >
          {/* Top-line revenue cards */}
          <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
            <Text style={[styles.cardTitle, { color: colors.textSecondary }]}>
              {t?.('profile.monthlyRevenue') || 'Receita mensal'}
            </Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>{formatCents(data.monthly_revenue_cents)}</Text>
            <Text style={[styles.cardSub, { color: colors.textTertiary }]}>
              {(t?.('profile.subscriberCountLine') || '{n} assinantes ativos').replace('{n}', data.subscriber_count || 0)}
            </Text>
          </View>

          <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
            <Text style={[styles.cardTitle, { color: colors.textSecondary }]}>
              {t?.('profile.tipsLast7d') || 'Diamantes recebidos (7d)'}
            </Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>{formatCents(data.weekly_tip_cents)}</Text>
            <View style={styles.sparkWrap}>
              <Sparkline data={sparkData} color="#F59E0B" />
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
            <Text style={[styles.cardTitle, { color: colors.textSecondary }]}>
              {t?.('profile.tipsLast30d') || 'Diamantes recebidos (30d)'}
            </Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>{formatCents(data.monthly_tip_cents)}</Text>
          </View>

          <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
            <Text style={[styles.cardTitle, { color: colors.textSecondary }]}>
              {t?.('profile.pendingPayout') || 'A receber'}
            </Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>{formatCents(data.pending_payout_cents)}</Text>
          </View>

          {/* Top tippers list */}
          <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
            <Text style={[styles.cardTitle, { color: colors.textSecondary, marginBottom: 12 }]}>
              {t?.('profile.topTippers') || 'Maiores apoiadores (30d)'}
            </Text>
            {(data.top_tippers || []).length === 0 ? (
              <Text style={[styles.cardSub, { color: colors.textTertiary }]}>
                {t?.('profile.noTippersYet') || 'Ninguém mandou diamantes ainda.'}
              </Text>
            ) : (
              (data.top_tippers || []).map((tp, idx) => (
                <View key={tp.email + idx} style={styles.tipperRow}>
                  <Text style={[styles.tipperRank, { color: colors.textTertiary }]}>#{idx + 1}</Text>
                  <AvatarCircle email={tp.email} name={tp.name} size={32} colors={colors} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={[styles.tipperName, { color: colors.text }]} numberOfLines={1}>
                      {tp.name || tp.email?.split('@')[0]}
                    </Text>
                    <Text style={[styles.tipperSub, { color: colors.textSecondary }]} numberOfLines={1}>
                      {(t?.('profile.tipperLine') || '{d} ◆ · {n} presentes')
                        .replace('{d}', tp.total_diamonds || 0)
                        .replace('{n}', tp.tip_count || 0)}
                    </Text>
                  </View>
                  <Text style={[styles.tipperAmount, { color: '#FBBF24' }]}>
                    {formatCents(tp.total_cents)}
                  </Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 50 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  scrollBody: { padding: 14, gap: 12, paddingBottom: 40 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 4,
  },
  cardTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  cardValue: { fontSize: 22, fontWeight: '800', marginTop: 6 },
  cardSub: { fontSize: 12 },
  sparkWrap: { marginTop: 6 },
  tipperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  tipperRank: { width: 28, fontSize: 12, fontWeight: '700' },
  tipperName: { fontSize: 14, fontWeight: '700' },
  tipperSub: { fontSize: 12 },
  tipperAmount: { fontSize: 14, fontWeight: '800' },
});
