// /creator-earnings — "Meus Ganhos" creator dashboard.
//
// Renders:
//   • Hero card: saldo disponível pra saque em R$ (pending_payout_cents/100),
//     plus a "Solicitar saque" CTA (greyed se < R$ 50,00).
//   • Stat grid (3 cards): total ganho, ganho 30d, # gifts 30d.
//   • Top fans 30d (top 5 com avatar + total).
//   • Timeline de gifts recebidos (de quem + de onde — live/reel/feed + qtd).
//   • Botão pra "Saques anteriores" (abre /wallet-cashout que já lista).
//
// All data via creator_earnings_summary single round-trip. SVG-only icons
// (sem emoji em UI). pt-BR / en / es via i18n.
//
// Conversion math note: backend mantém pending_payout_cents direto em BRL,
// alimentado pelos handlers feed_post_tip / live_gift_send (split 70/30).
// O wallet_history mostra os movimentos em DIAMANTES; aqui usamos centavos
// pra falar do saldo de saque (única unidade que vira dinheiro real).

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  RefreshControl, StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import {
  IconArrowLeft, IconGiftBox, IconHeart, IconChevronRight, IconStar,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

const MIN_CASHOUT_CENTS = 5000;
const BRAND_GREEN = '#10B981';
const BRAND_PURPLE = '#A855F7';
const BRAND_AMBER = '#F59E0B';

function fmtBrl(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2).replace('.', ',');
}

function fmtCount(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

function shortHandle(email) {
  const s = String(email || '');
  if (!s) return '';
  return s.split('@')[0] || s;
}

function StatCard({ label, value, sub, accent, colors, isDark }) {
  return (
    <View style={[styles.statCard, {
      backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.04)',
      borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
    }]}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, { color: accent || colors.text }]} numberOfLines={1}>
        {value}
      </Text>
      {sub ? (
        <Text style={[styles.statSub, { color: colors.textTertiary }]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function TopFanRow({ fan, rank, colors, isDark, t }) {
  const handle = shortHandle(fan.email);
  return (
    <View style={[styles.fanRow, {
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
    }]}>
      <View style={[styles.fanRank, {
        backgroundColor: rank === 1 ? BRAND_AMBER : (rank === 2 ? '#A1A1AA' : (rank === 3 ? '#B45309' : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.08)'))),
      }]}>
        <Text style={styles.fanRankText}>{rank}</Text>
      </View>
      <AvatarCircle email={fan.email} size={36} />
      <View style={styles.fanInfo}>
        <Text style={[styles.fanName, { color: colors.text }]} numberOfLines={1}>
          {handle}
        </Text>
        <Text style={[styles.fanSub, { color: colors.textSecondary }]} numberOfLines={1}>
          {fmtCount(fan.gift_count)} {t('creatorEarnings.gifts') || 'presentes'}
        </Text>
      </View>
      <View style={styles.fanAmount}>
        <IconGiftBox size={14} color={BRAND_PURPLE} />
        <Text style={[styles.fanAmountText, { color: BRAND_PURPLE }]}>
          {fmtCount(fan.total_amount)}
        </Text>
      </View>
    </View>
  );
}

function TimelineRow({ item, colors, isDark, t }) {
  const handle = shortHandle(item.counterparty);
  const refKind = String(item.ref_kind || '');
  const sourceLabel = (() => {
    if (refKind === 'live_gift') return t('creatorEarnings.source.live') || 'Ao vivo';
    if (refKind === 'reel_tip')  return t('creatorEarnings.source.reel') || 'Reel';
    if (refKind === 'feed_tip')  return t('creatorEarnings.source.feed') || 'Post';
    return t('creatorEarnings.source.other') || 'Direto';
  })();
  const when = (() => {
    const ts = Number(item.created_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
  })();
  return (
    <View style={[styles.tlRow, {
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
    }]}>
      <AvatarCircle email={item.counterparty} size={36} />
      <View style={styles.tlInfo}>
        <Text style={[styles.tlName, { color: colors.text }]} numberOfLines={1}>
          {handle || (t('creatorEarnings.someone') || 'Alguém')}
        </Text>
        <Text style={[styles.tlSub, { color: colors.textSecondary }]} numberOfLines={1}>
          {sourceLabel}{when ? ' · ' + when : ''}
        </Text>
      </View>
      <View style={styles.tlAmount}>
        <IconGiftBox size={14} color={BRAND_PURPLE} />
        <Text style={[styles.tlAmountText, { color: BRAND_PURPLE }]}>
          +{fmtCount(item.amount)}
        </Text>
      </View>
    </View>
  );
}

export default function CreatorEarningsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({
    pending_payout_cents: 0,
    lifetime_payout_cents: 0,
    month_payout_cents: 0,
    gifts_count_30d: 0,
    gifts_count_lifetime: 0,
    top_fans: [],
    timeline: [],
  });

  const load = useCallback(async () => {
    try {
      const r = await api.creatorEarningsSummary({ limit: 50 });
      if (r?.success && r?.data) {
        setData({
          pending_payout_cents: Number(r.data.pending_payout_cents) || 0,
          lifetime_payout_cents: Number(r.data.lifetime_payout_cents) || 0,
          month_payout_cents: Number(r.data.month_payout_cents) || 0,
          gifts_count_30d: Number(r.data.gifts_count_30d) || 0,
          gifts_count_lifetime: Number(r.data.gifts_count_lifetime) || 0,
          top_fans: Array.isArray(r.data.top_fans) ? r.data.top_fans : [],
          timeline: Array.isArray(r.data.timeline) ? r.data.timeline : [],
        });
      }
    } catch (_) {
      // Silent — empty state covers it.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const canCashout = data.pending_payout_cents >= MIN_CASHOUT_CENTS;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: (insets.top || 0) + 8 }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={styles.headBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headTitle, { color: colors.text }]} numberOfLines={1}>
          {t('creatorEarnings.title') || 'Meus Ganhos'}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={{ paddingTop: 80, alignItems: 'center' }}>
          <ActivityIndicator color={BRAND_GREEN} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND_GREEN} />}
        >
          {/* Hero — Saldo disponível pra saque */}
          <View style={[styles.hero, {
            backgroundColor: isDark ? 'rgba(16,185,129,0.16)' : 'rgba(16,185,129,0.10)',
            borderColor: isDark ? 'rgba(16,185,129,0.40)' : 'rgba(16,185,129,0.28)',
          }]}>
            <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>
              {t('creatorEarnings.availableLabel') || 'Disponível para saque'}
            </Text>
            <Text style={[styles.heroValue, { color: BRAND_GREEN }]}>
              R$ {fmtBrl(data.pending_payout_cents)}
            </Text>
            <Text style={[styles.heroSub, { color: colors.textTertiary }]} numberOfLines={2}>
              {t('creatorEarnings.heroSub') || 'Receba via PIX em até 48h úteis. Mínimo R$ 50,00.'}
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/wallet-cashout')}
              disabled={!canCashout}
              style={[styles.cashoutCta, {
                backgroundColor: canCashout ? BRAND_GREEN : (isDark ? 'rgba(16,185,129,0.30)' : 'rgba(16,185,129,0.40)'),
              }]}
              accessibilityRole="button"
              accessibilityLabel={t('creatorEarnings.cashoutCta') || 'Solicitar saque'}
            >
              <Text style={styles.cashoutCtaText}>
                {t('creatorEarnings.cashoutCta') || 'Solicitar saque'}
              </Text>
            </TouchableOpacity>
            {!canCashout && data.pending_payout_cents > 0 ? (
              <Text style={[styles.cashoutHint, { color: colors.textTertiary }]} numberOfLines={2}>
                {(t('creatorEarnings.cashoutHint') || 'Faltam R$ {missing} para sacar.')
                  .replace('{missing}', fmtBrl(MIN_CASHOUT_CENTS - data.pending_payout_cents))}
              </Text>
            ) : null}
          </View>

          {/* Stat grid */}
          <View style={styles.statRow}>
            <StatCard
              colors={colors} isDark={isDark}
              label={t('creatorEarnings.stat.lifetime') || 'Total ganho'}
              value={`R$ ${fmtBrl(data.lifetime_payout_cents)}`}
              accent={colors.text}
            />
            <StatCard
              colors={colors} isDark={isDark}
              label={t('creatorEarnings.stat.month') || '30 dias'}
              value={`R$ ${fmtBrl(data.month_payout_cents)}`}
              accent={BRAND_GREEN}
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              colors={colors} isDark={isDark}
              label={t('creatorEarnings.stat.giftsMonth') || 'Presentes 30d'}
              value={fmtCount(data.gifts_count_30d)}
              accent={BRAND_PURPLE}
              sub={(t('creatorEarnings.stat.giftsLifetime') || '{n} no total').replace('{n}', fmtCount(data.gifts_count_lifetime))}
            />
            <StatCard
              colors={colors} isDark={isDark}
              label={t('creatorEarnings.stat.history') || 'Saques anteriores'}
              value={t('creatorEarnings.stat.view') || 'Ver'}
              sub={t('creatorEarnings.stat.tap') || 'tocar para abrir'}
            />
          </View>
          <TouchableOpacity
            onPress={() => router.push('/wallet-cashout')}
            accessibilityRole="button"
            style={[styles.linkRow, {
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
              backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(15,23,42,0.03)',
            }]}
          >
            <Text style={[styles.linkRowText, { color: colors.text }]}>
              {t('creatorEarnings.openCashout') || 'Saques + histórico de pagamento'}
            </Text>
            <IconChevronRight size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          {/* Top fans */}
          <View style={styles.sectionHead}>
            <IconHeart size={16} color={'#EF4444'} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('creatorEarnings.topFans') || 'Top fãs (30 dias)'}
            </Text>
          </View>
          {data.top_fans.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('creatorEarnings.emptyFans') || 'Ainda sem fãs. Compartilhe seus reels e lives para receber presentes!'}
            </Text>
          ) : (
            data.top_fans.map((fan, idx) => (
              <TopFanRow
                key={String(fan.email) + idx}
                fan={fan}
                rank={idx + 1}
                colors={colors}
                isDark={isDark}
                t={t}
              />
            ))
          )}

          {/* Timeline */}
          <View style={styles.sectionHead}>
            <IconStar size={16} color={BRAND_AMBER} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('creatorEarnings.timeline') || 'Presentes recebidos'}
            </Text>
          </View>
          {data.timeline.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('creatorEarnings.emptyTimeline') || 'Você ainda não recebeu presentes. Quando alguém te enviar diamantes ao vivo, num reel ou post, eles aparecem aqui.'}
            </Text>
          ) : (
            data.timeline.map(item => (
              <TimelineRow
                key={String(item.id)}
                item={item}
                colors={colors}
                isDark={isDark}
                t={t}
              />
            ))
          )}

          <Text style={[styles.tos, { color: colors.textTertiary }]}>
            {t('creatorEarnings.tos') || 'Você recebe 70% do valor de cada presente. Os 30% restantes cobrem taxas de plataforma e processamento de IAP.'}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, marginBottom: 8,
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },

  hero: {
    borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 22, paddingHorizontal: 18,
    marginBottom: 14, alignItems: 'center',
  },
  heroLabel: { fontSize: 13, fontWeight: '600' },
  heroValue: { fontSize: 38, fontWeight: '900', marginTop: 4, letterSpacing: -0.5 },
  heroSub: { fontSize: 12, marginTop: 6, textAlign: 'center', lineHeight: 17 },
  cashoutCta: {
    marginTop: 16, alignSelf: 'stretch',
    paddingVertical: 14, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  cashoutCtaText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  cashoutHint: { fontSize: 11, marginTop: 8, textAlign: 'center' },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  statCard: {
    flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14, paddingHorizontal: 12,
  },
  statLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 18, fontWeight: '900', marginTop: 4, letterSpacing: -0.2 },
  statSub: { fontSize: 11, marginTop: 2 },

  linkRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4, marginBottom: 6,
  },
  linkRowText: { fontSize: 14, fontWeight: '700' },

  sectionHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 22, marginBottom: 8, paddingHorizontal: 4,
  },
  sectionTitle: { fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },

  fanRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fanRank: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  fanRankText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  fanInfo: { flex: 1, minWidth: 0 },
  fanName: { fontSize: 14, fontWeight: '700' },
  fanSub: { fontSize: 11, marginTop: 2 },
  fanAmount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  fanAmountText: { fontSize: 14, fontWeight: '800' },

  tlRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tlInfo: { flex: 1, minWidth: 0 },
  tlName: { fontSize: 14, fontWeight: '700' },
  tlSub: { fontSize: 11, marginTop: 2 },
  tlAmount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tlAmountText: { fontSize: 14, fontWeight: '800' },

  empty: { textAlign: 'center', fontSize: 13, paddingVertical: 22, paddingHorizontal: 12, lineHeight: 18 },
  tos: { fontSize: 11, marginTop: 24, marginBottom: 8, textAlign: 'center', paddingHorizontal: 18, lineHeight: 15 },
});
