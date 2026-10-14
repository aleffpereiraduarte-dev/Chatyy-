// /creator-earnings — "Meus Ganhos".
//
// [2026-10-13 earnings-v2] Repaginada no padrão P&B do Painel de criador
// (app/profile-creator-dashboard.js): saldo disponível em destaque + "Sacar"
// (preto; desabilitado com motivo + barra até o mínimo), métricas em grade
// compacta, "Saques anteriores" como linha com chevron, Top fãs e Presentes
// como listas (vazio compacto via ScreenEmptyState), ícones SVG P&B, skeleton,
// pull-to-refresh, escuro e coluna limitada no web desktop.
//
// MOEDA: o servidor manda centavos de BRL (pending_payout_cents, amount_cents,
// e `amount` dos créditos tip_recv/live_gift_recv do ledger). Tudo passa por
// formatMoneyActive (converte p/ a moeda de exibição) — nada de "R$" fixo.
//
// API: api.creatorEarningsSummary — se o servidor não rotear a action
// (email.php hoje responde "Unknown action"), o próprio api.js monta o mesmo
// formato via wallet_history + wallet_cashout_list (só leitura).
// Saque: WALLET_ENABLED=false (e o servidor responde 410 feature_disabled em
// wallet_cashout_request) → botão desabilitado com o motivo, sem cair no
// redirect para /chat.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { MONETIZATION_ENABLED, WALLET_ENABLED } from '../constants/featureFlags';
import * as api from '../services/api';
import { formatMoneyActive } from '../services/currencyService';
import { useCurrency } from '../context/CurrencyContext';
import AvatarCircle from '../components/AvatarCircle';
import { IconReceipt, IconDiamond } from '../components/Icons';
import {
  Button, Card, ListRow, SectionHeader, TopBar, useSurface, Skeleton, SkeletonFadeIn,
  ScreenEmptyState, Type, Space, Radius, Layout,
} from '../components/ui';
import { formatInt } from '../utils/dateFormat';

// Espelha chat.php wallet_cashout_request (amount_cents < 5000 → min_cashout).
const MIN_CASHOUT_CENTS = 5000;

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
function money(cents) { return formatMoneyActive(Number(cents) || 0); }
function handleOf(email) { const s = String(email || ''); return s.split('@')[0] || s; }

// Presente (caixa) em traço fino P&B.
function GiftGlyph({ size = 16, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 9h18v4H3zM5 13v8h14v-8M12 9v12" />
      <Path d="M12 9c-1.5-3-5-3.5-5-1.25C7 9 9.5 9 12 9Zm0 0c1.5-3 5-3.5 5-1.25C17 9 14.5 9 12 9Z" />
    </Svg>
  );
}

function sourceLabel(t, refKind) {
  const k = String(refKind || '');
  if (k === 'live_gift' || k === 'live' || k === 'live_react') return tr(t, 'creatorEarnings.source.live', 'Ao vivo');
  if (k === 'reel_tip' || k === 'reel') return tr(t, 'creatorEarnings.source.reel', 'Reel');
  if (k === 'feed_tip' || k === 'feed_post' || k === 'post' || k === 'post_gift') return tr(t, 'creatorEarnings.source.feed', 'Post');
  if (k === 'chat' || k === 'chat_gift') return tr(t, 'gifts.sourceChat', 'Chat');
  return tr(t, 'creatorEarnings.source.other', 'Direto');
}

function MetricTile({ label, value, sub, s }) {
  return (
    <View style={[styles.tile, { backgroundColor: s.surface, borderColor: s.border, borderWidth: s.isDark ? 0 : StyleSheet.hairlineWidth }]}>
      <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={2}>{label}</Text>
      <Text style={[Type.headline, { color: s.text, marginTop: Space.xs }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{value}</Text>
      {sub ? <Text style={[Type.caption2, { color: s.textTertiary, marginTop: 2 }]} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function EarningsSkeleton() {
  return (
    <View style={[styles.scrollBody, { gap: Space.md }]}>
      <Skeleton height={196} radius={Radius.card} />
      <View style={styles.grid}>
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={40} />
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={60} />
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={80} />
      </View>
      <Skeleton height={56} radius={Radius.card} delay={100} />
      <Skeleton height={140} radius={Radius.card} delay={120} />
    </View>
  );
}

function CreatorEarnings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  useCurrency(); // re-render quando a moeda de exibição muda

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState({
    pending_payout_cents: 0, lifetime_payout_cents: 0, month_payout_cents: 0,
    gifts_count_30d: 0, gifts_count_lifetime: 0, top_fans: [], timeline: [],
    min_cashout_cents: MIN_CASHOUT_CENTS,
    available_cents: null, on_hold_cents: 0, hold_days: 0, cashout_eligible: null, cashout_block_reason: null,
    payout_per_diamond_millicents: 0, account_min_age_days: 0, daily_limit_cents: 0,
  });
  const [cashouts, setCashouts] = useState(null); // null = desconhecido

  const load = useCallback(async () => {
    const [sum, list] = await Promise.allSettled([
      api.creatorEarningsSummary({ limit: 50 }),
      api.walletCashoutList?.(),
    ]);
    const r = sum.status === 'fulfilled' ? sum.value : null;
    if (r?.success && r.data) {
      const d = r.data;
      setData({
        pending_payout_cents: Number(d.pending_payout_cents) || 0,
        lifetime_payout_cents: Number(d.lifetime_payout_cents) || 0,
        month_payout_cents: Number(d.month_payout_cents) || 0,
        gifts_count_30d: Number(d.gifts_count_30d) || 0,
        gifts_count_lifetime: Number(d.gifts_count_lifetime) || 0,
        top_fans: Array.isArray(d.top_fans) ? d.top_fans : [],
        timeline: Array.isArray(d.timeline) ? d.timeline : [],
        min_cashout_cents: Number(d.min_cashout_cents) || MIN_CASHOUT_CENTS,
        // [2026-10-13 diamantes-religados] resumo novo do servidor (BRL, sem ×5 no cliente).
        available_cents: d.available_cents != null ? Number(d.available_cents) || 0 : null,
        on_hold_cents: Number(d.on_hold_cents) || 0,
        hold_days: Number(d.hold_days) || 0,
        cashout_eligible: typeof d.cashout_eligible === 'boolean' ? d.cashout_eligible : null,
        cashout_block_reason: d.cashout_block_reason || null,
        payout_per_diamond_millicents: Number(d.payout_per_diamond_millicents) || 0,
        account_min_age_days: Number(d.account_min_age_days) || 0,
        daily_limit_cents: Number(d.daily_limit_cents) || 0,
      });
      setFailed(false);
    } else {
      setFailed(true);
    }
    const l = list.status === 'fulfilled' ? list.value : null;
    if (l?.success && Array.isArray(l.data?.items)) setCashouts(l.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const min = data.min_cashout_cents || MIN_CASHOUT_CENTS;
  // Disponível = já liberado (fora do prazo de liberação). Servidor antigo → pending.
  const pending = data.available_cents != null ? data.available_cents : data.pending_payout_cents;
  const reachedMin = pending >= min;
  const canCashout = WALLET_ENABLED && (data.cashout_eligible != null ? data.cashout_eligible : reachedMin);
  const blockReason = (() => {
    const r = data.cashout_block_reason;
    if (!WALLET_ENABLED || r === 'disabled') return tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.');
    if (r === 'account_too_new') return tr(t, 'earn.blockAccountNew', 'Sua conta precisa ter pelo menos {n} dias para sacar.').replace('{n}', String(data.account_min_age_days || 30));
    if (r === 'minor') return tr(t, 'earn.blockMinor', 'Saques não estão disponíveis para contas supervisionadas.');
    if (r === 'negative_balance') return tr(t, 'earn.blockNegative', 'Há um estorno pendente na sua carteira. Regularize para sacar.');
    if (r === 'pending_exists') return tr(t, 'earn.blockPending', 'Você já tem um saque em análise.');
    return '';
  })();
  const perDiamond = data.payout_per_diamond_millicents > 0 ? data.payout_per_diamond_millicents / 1000 : 0; // centavos por diamante
  const progress = Math.max(0, Math.min(1, pending / min));
  const go = (path) => () => { try { router.push(path); } catch {} };
  const title = tr(t, 'creatorEarnings.title', 'Meus Ganhos');

  const fmtDate = (ts) => {
    const n = Number(ts) * 1000;
    if (!n) return '';
    try { return new Date(n).toLocaleDateString(language || undefined, { day: '2-digit', month: 'short' }); } catch { return ''; }
  };

  // Subtítulo da linha "Saques anteriores".
  const historySub = (() => {
    if (!Array.isArray(cashouts)) return tr(t, 'creatorEarnings.historySub', 'Status e comprovantes dos seus saques');
    if (cashouts.length === 0) return tr(t, 'wallet.cashoutHistoryEmpty', 'Nenhum saque ainda.');
    const last = cashouts[0];
    const st = String(last.status || 'pending');
    const stLabel = tr(t, `wallet.cashoutStatus.${st}`, st === 'paid' ? 'Pago' : st === 'rejected' ? 'Rejeitado' : 'Em análise');
    return tr(t, 'creatorEarnings.historyLast', 'Último: {amount} · {status}')
      .replace('{amount}', money(last.amount_cents)).replace('{status}', stLabel);
  })();

  const body = (
    <>
      {/* ── Saldo disponível + Sacar ─────────────────────────── */}
      <Card elevated padding={Space.xl}>
        <Text style={[Type.footnote, { color: s.textSecondary, fontWeight: '600' }]}>
          {tr(t, 'creatorEarnings.availableLabel', 'Disponível para saque')}
        </Text>
        <Text style={[Type.largeTitle, { color: s.text, marginTop: Space.xs }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}
          accessibilityLabel={`${tr(t, 'creatorEarnings.availableLabel', 'Disponível para saque')}: ${money(pending)}`}>
          {money(pending)}
        </Text>
        {data.on_hold_cents > 0 ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>
            {tr(t, 'earn.onHold', '{amount} em liberação (presentes dos últimos {days} dias)')
              .replace('{amount}', money(data.on_hold_cents)).replace('{days}', String(data.hold_days || 7))}
          </Text>
        ) : null}
        {!reachedMin ? (
          <View style={{ marginTop: Space.md }}>
            <View style={[styles.track, { backgroundColor: s.fill }]}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}>
              <View style={[styles.trackFill, { width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%`, backgroundColor: s.ink }]} />
            </View>
            <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm }]}>
              {tr(t, 'creatorDash.missing', 'Faltam {missing} para o saque mínimo de {min}')
                .replace('{missing}', money(min - pending))
                .replace('{min}', money(min))}
            </Text>
          </View>
        ) : (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>
            {tr(t, 'creatorEarnings.pixEta', 'Via Pix, em até 48h úteis.')}
          </Text>
        )}
        <Button
          title={tr(t, 'creatorDash.withdraw', 'Sacar')}
          size="lg"
          fullWidth
          disabled={!canCashout}
          onPress={go('/wallet-cashout')}
          style={{ marginTop: Space.lg }}
          accessibilityLabel={!canCashout
            ? `${tr(t, 'creatorDash.withdraw', 'Sacar')}. ${blockReason || tr(t, 'creatorEarnings.belowMin', 'Abaixo do mínimo para saque.')}`
            : undefined}
        />
        {blockReason ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm, textAlign: 'center' }]}>
            {blockReason}
          </Text>
        ) : null}
      </Card>

      {/* ── Métricas ────────────────────────────────────────── */}
      <View style={styles.grid}>
        <MetricTile s={s} label={tr(t, 'creatorEarnings.stat.lifetime', 'Total ganho')} value={money(data.lifetime_payout_cents)} />
        <MetricTile s={s} label={tr(t, 'creatorDash.chart30', 'Últimos 30 dias')} value={money(data.month_payout_cents)} />
        <MetricTile s={s}
          label={tr(t, 'creatorDash.gifts30d', 'Presentes · 30 dias')}
          value={formatInt(data.gifts_count_30d, language)}
          sub={tr(t, 'creatorEarnings.stat.giftsLifetime', '{n} no total').replace('{n}', formatInt(data.gifts_count_lifetime, language))}
        />
      </View>

      {/* ── Saques anteriores ───────────────────────────────── */}
      <Card padding={0}>
        <ListRow
          icon={IconReceipt}
          iconTile
          title={tr(t, 'creatorEarnings.stat.history', 'Saques anteriores')}
          subtitle={historySub}
          chevron
          onPress={go('/wallet-cashout')}
        />
      </Card>

      {/* ── Top fãs ─────────────────────────────────────────── */}
      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'creatorEarnings.topFans30', 'Top fãs · 30 dias')} />
      <Card padding={0}>
        {data.top_fans.length > 0 ? data.top_fans.map((fan, idx) => (
          <View key={String(fan.email) + idx}
            style={[styles.personRow, idx < data.top_fans.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
            <Text style={[Type.footnote, styles.rank, { color: idx < 3 ? s.text : s.textTertiary }]}>{idx + 1}</Text>
            <AvatarCircle email={fan.email} size={36} colors={colors} />
            <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
              <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>{handleOf(fan.email)}</Text>
              <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                {tr(t, 'creatorEarnings.giftCount', '{n} presentes').replace('{n}', formatInt(fan.gift_count || 0, language))}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]}>{money(fan.payout_cents != null ? fan.payout_cents : fan.total_amount)}</Text>
              {fan.total_diamonds != null ? (
                <View style={styles.amount}>
                  <IconDiamond size={10} />
                  <Text style={[Type.caption2, { color: s.textSecondary }]}>{formatInt(fan.total_diamonds, language)}</Text>
                </View>
              ) : null}
            </View>
          </View>
        )) : (
          <ScreenEmptyState compact kind="contacts"
            title={tr(t, 'creatorDash.noSupporters', 'Ainda sem apoiadores')}
            subtitle={tr(t, 'creatorEarnings.emptyFansShort', 'Quem mandar presentes nos seus reels e lives aparece aqui.')} />
        )}
      </Card>

      {/* ── Presentes recebidos ─────────────────────────────── */}
      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'creatorEarnings.timeline', 'Presentes recebidos')} />
      <Card padding={0}>
        {data.timeline.length > 0 ? data.timeline.map((item, idx) => {
          const when = fmtDate(item.created_at_ts);
          // Novo: payout_cents + diamonds; legado (tip_recv/live_gift_recv antigos): amount = centavos.
          const isMoney = item.payout_cents != null || item.kind === 'tip_recv' || item.kind === 'live_gift_recv';
          const earned = item.payout_cents != null ? item.payout_cents : item.amount;
          return (
            <View key={String(item.id ?? idx)}
              style={[styles.personRow, idx < data.timeline.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
              <AvatarCircle email={item.counterparty} size={36} colors={colors} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>
                  {item.counterparty_name || handleOf(item.counterparty) || tr(t, 'creatorEarnings.someone', 'Alguém')}
                </Text>
                <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                  {sourceLabel(t, item.ref_kind)}{item.diamonds ? ' · ' + formatInt(item.diamonds, language) + ' ' + tr(t, 'wallet.diamondsLabel', 'diamantes') : ''}{when ? ' · ' + when : ''}
                </Text>
              </View>
              <View style={styles.amount}>
                <GiftGlyph size={14} color={s.textSecondary} />
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]}>
                  +{isMoney ? money(earned) : formatInt(item.amount || 0, language)}
                </Text>
              </View>
            </View>
          );
        }) : (
          <ScreenEmptyState compact kind="lives"
            title={tr(t, 'creatorEarnings.emptyTimelineTitle', 'Nenhum presente ainda')}
            subtitle={tr(t, 'creatorEarnings.emptyTimelineShort', 'Presentes de lives, reels e posts aparecem aqui.')} />
        )}
      </Card>

      {failed ? (
        <Text style={[Type.footnote, { color: s.textSecondary, textAlign: 'center', marginTop: Space.sm }]}>
          {tr(t, 'creatorDash.loadError', 'Não foi possível atualizar. Puxe para tentar de novo.')}
        </Text>
      ) : null}

      <Text style={[Type.caption, { color: s.textTertiary, textAlign: 'center', marginTop: Space.sm, paddingHorizontal: Space.lg }]}>
        {perDiamond > 0
          ? tr(t, 'earn.tosPerDiamond', 'Cada diamante recebido vale {value} para você. Presentes ficam {days} dias em liberação (prazo de reembolso das lojas) antes de entrar no saldo de saque. Saques via Pix passam por análise manual.')
            .replace('{value}', formatMoneyActive(perDiamond)).replace('{days}', String(data.hold_days || 7))
          : tr(t, 'creatorEarnings.tos', 'Você recebe 70% do valor de cada presente. Os 30% restantes cobrem taxas de plataforma e processamento de IAP.')}
      </Text>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: s.bgGrouped }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title })} />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} maxWidth={Layout.contentMaxWidth} />
      )}
      {loading ? (
        <EarningsSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scrollBody, { paddingBottom: Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
        >
          <SkeletonFadeIn style={{ gap: Space.md }}>{body}</SkeletonFadeIn>
        </ScrollView>
      )}
    </View>
  );
}

export default function CreatorEarningsScreen() {
  // [2026-05-22 monetization-pause] Ganhos vêm de presentes pagos — com a
  // monetização pausada a tela não faz sentido.
  if (!MONETIZATION_ENABLED) return <Redirect href="/chat" />;
  return <CreatorEarnings />;
}

const styles = StyleSheet.create({
  scrollBody: {
    padding: Layout.gutter, gap: Space.md,
    width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center',
  },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  grid: { flexDirection: 'row', gap: Space.sm },
  tile: { flex: 1, minWidth: 0, borderRadius: Radius.card, padding: Space.md, minHeight: 84 },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md },
  rank: { width: 22, fontWeight: '700' },
  amount: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: Space.sm },
});
