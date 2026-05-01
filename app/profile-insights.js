// Profile Insights — IG-style creator analytics for the logged-in user.
// Three cards (last 7 days): profile views, posts reach, total engagement.
// Each card has a tiny 7-point sparkline rendered with react-native-svg.
//
// Backend: profile_insights endpoint. Best-effort — if a metric isn't
// available yet (e.g. profile_views table not yet wired) the backend
// returns zero, and this screen still renders without errors.
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft } from '../components/Icons';

// Compact 7-point sparkline. Pure SVG — works on web + native, no native
// chart lib needed. Falls back to a dashed baseline when all values are 0
// so an empty state still reads as "we have a graph slot here" rather
// than a blank box.
function Sparkline({ data, color = '#7C3AED', width = 220, height = 60 }) {
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
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i][0]} ${points[i][1]}`;
    }
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

export default function ProfileInsightsScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({
    profile_views_count: 0,
    posts_reach: 0,
    engagement_total: 0,
    spark_views: [0, 0, 0, 0, 0, 0, 0],
    spark_reach: [0, 0, 0, 0, 0, 0, 0],
    spark_engagement: [0, 0, 0, 0, 0, 0, 0],
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.profileInsights?.();
      if (r?.success && r.data) {
        setData({
          profile_views_count: Number(r.data.profile_views_count || 0),
          posts_reach: Number(r.data.posts_reach || 0),
          engagement_total: Number(r.data.engagement_total || 0),
          spark_views: Array.isArray(r.data.spark_views) ? r.data.spark_views : [],
          spark_reach: Array.isArray(r.data.spark_reach) ? r.data.spark_reach : [],
          spark_engagement: Array.isArray(r.data.spark_engagement) ? r.data.spark_engagement : [],
        });
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const cardBg = isDark ? '#1a1625' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const accent = '#7C3AED';

  const Card = ({ title, value, spark, color = accent }) => (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
      <Text style={[styles.cardTitle, { color: colors.textSecondary }]}>{title}</Text>
      <Text style={[styles.cardValue, { color: colors.text }]}>{value.toLocaleString()}</Text>
      <View style={styles.sparkWrap}>
        <Sparkline data={spark} color={color} />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: cardBorder }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Voltar">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t?.('profile.insights') || 'Estatisticas'}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
          <Card
            title={t?.('profile.viewsLast7d') || 'Visualizações do perfil (7d)'}
            value={data.profile_views_count}
            spark={data.spark_views}
            color="#7C3AED"
          />
          <Card
            title={t?.('profile.reachLast7d') || 'Alcance dos posts (7d)'}
            value={data.posts_reach}
            spark={data.spark_reach}
            color="#22C55E"
          />
          <Card
            title={t?.('profile.engagementTotal') || 'Curtidas + comentários (7d)'}
            value={data.engagement_total}
            spark={data.spark_engagement}
            color="#F59E0B"
          />
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
  backBtn: { padding: 6, marginRight: 6 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollBody: { padding: 16, gap: 14 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  cardValue: { fontSize: 32, fontWeight: '800', marginTop: 6, marginBottom: 8 },
  sparkWrap: { alignItems: 'flex-start' },
});
