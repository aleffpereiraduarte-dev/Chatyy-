// Painel de criador — Pro tier creator monetization dashboard.
// Backend: creator_dashboard (email.php) + wallet_balance + creator_earnings_summary.
//
// [2026-10-13 creator-dash-v2] Redesenho P&B (Instagram/TikTok Creator/YouTube
// Studio): saldo "A receber" em destaque + botão "Sacar" (desabilitado abaixo
// do mínimo, com barra de progresso e "Faltam X"), diamantes como linha
// secundária com "Comprar", grade compacta de métricas, gráfico de barras só
// quando há dados, maiores apoiadores (lista ou vazio compacto + como ganhar),
// atividade recente (→ /creator-earnings). Skeleton, pull-to-refresh, escuro.
//
// MOEDA: o servidor guarda TUDO em centavos de BRL (chat_wallet_balances,
// chat_feed_tips.creator_payout_cents, chat_creator_subscriptions). A tela
// formata tudo pela moeda de exibição do usuário (formatMoneyActive converte
// BRL→moeda ativa) — inclusive o mínimo de saque (R$ 50,00 = 5000 centavos,
// validado em chat.php wallet_cashout_request). Antes o mínimo era um texto
// fixo "R$ 50,00" ao lado de valores em US$.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Pressable,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import Svg, { Path } from 'react-native-svg';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { MONETIZATION_ENABLED, WALLET_ENABLED } from '../constants/featureFlags';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';
import { formatMoney } from '../services/currencyService';
import { useWallet } from '../services/diamonds';
import { useCurrency } from '../context/CurrencyContext';
import { IconChevronRight } from '../components/Icons';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import {
  Button, Card, SectionHeader, TopBar, useSurface, PressableRow, Skeleton, SkeletonFadeIn,
  Type, Space, Radius, Layout,
} from '../components/ui';
import { formatInt } from '../utils/dateFormat';

// Mínimo de saque em centavos BRL — espelha chat.php wallet_cashout_request
// (amount_cents < 5000 → 'min_cashout') e app/wallet-cashout.js MIN_CENTS.
const MIN_CASHOUT_CENTS = 5000;

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
// [2026-10-16 carteira-clara] ganhos = valor EXATO em R$ (sem conversão aproximada).
function money(cents) { return formatMoney(Number(cents) || 0, 'BRL', 'pt-BR'); }

// Losango P&B (substitui o glifo de texto e o IconDiamond azul).
function DiamondGlyph({ size = 16, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill={color} />
    </Svg>
  );
}

// Variação percentual vs período anterior — só quando o servidor mandar o
// valor anterior (prev_*). Sem base → nada (não inventa variação).
function Delta({ cur, prev, s }) {
  if (prev == null || !isFinite(Number(prev))) return null;
  const p = Number(prev) || 0; const c = Number(cur) || 0;
  if (p <= 0 && c <= 0) return null;
  const pct = p > 0 ? Math.round(((c - p) / p) * 100) : 100;
  const up = pct >= 0;
  return (
    <Text style={[Type.caption, { color: up ? s.success : s.danger, fontWeight: '600', marginTop: 2 }]} numberOfLines={1}>
      {(up ? '+' : '') + pct + '%'}
    </Text>
  );
}

function MetricTile({ label, value, sub, delta, s }) {
  return (
    <View style={[styles.tile, { backgroundColor: s.surface, borderColor: s.border, borderWidth: s.isDark ? 0 : StyleSheet.hairlineWidth }]}>
      <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>{label}</Text>
      <Text style={[Type.title3, { color: s.text, marginTop: Space.xs }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{value}</Text>
      {delta}
      {sub ? <Text style={[Type.caption, { color: s.textTertiary, marginTop: 2 }]} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

// Barras dos últimos 7 dias. Série única → sem legenda (o título nomeia).
// Toque numa barra mostra o valor do dia (equivalente ao hover).
function WeekBars({ series, s, language }) {
  const vals = series.map(x => Number(x.tip_cents) || 0);
  const max = Math.max(1, ...vals);
  const peak = vals.indexOf(Math.max(...vals));
  const [sel, setSel] = useState(peak);
  const label = (d) => {
    try {
      const dt = new Date(String(d) + 'T12:00:00');
      const w = dt.toLocaleDateString(language || undefined, { weekday: 'short' });
      return String(w).replace('.', '').slice(0, 3);
    } catch { return String(d).slice(8, 10); }
  };
  const H = 96;
  return (
    <View>
      <Text style={[Type.footnote, { color: s.textSecondary }]} numberOfLines={1}>
        {series[sel] ? `${label(series[sel].date)} · ${money(vals[sel])}` : ''}
      </Text>
      <View style={[styles.bars, { height: H, borderBottomColor: s.separator }]}>
        {vals.map((v, i) => {
          const h = v > 0 ? Math.max(4, Math.round((v / max) * (H - 8))) : 2;
          const on = i === sel;
          return (
            <Pressable key={i} onPress={() => setSel(i)} style={styles.barHit} accessibilityRole="button"
              accessibilityLabel={`${label(series[i]?.date)} ${money(v)}`}>
              <View style={{
                height: h, width: '100%', borderTopLeftRadius: 4, borderTopRightRadius: 4,
                backgroundColor: v > 0 ? s.ink : s.fill, opacity: v > 0 && !on ? 0.55 : 1,
              }} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.barLabels}>
        {series.map((x, i) => (
          <Text key={i} style={[Type.caption2, styles.barLabel, { color: i === sel ? s.text : s.textTertiary }]} numberOfLines={1}>
            {label(x.date)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function DashboardSkeleton() {
  return (
    <View style={{ padding: Layout.gutter, gap: Space.md }}>
      <Skeleton height={176} radius={Radius.card} />
      <Skeleton height={64} radius={Radius.card} delay={40} />
      <View style={{ flexDirection: 'row', gap: Space.md }}>
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={60} />
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={80} />
      </View>
      <View style={{ flexDirection: 'row', gap: Space.md }}>
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={100} />
        <Skeleton height={84} radius={Radius.card} style={{ flex: 1 }} delay={120} />
      </View>
      <Skeleton height={140} radius={Radius.card} delay={140} />
    </View>
  );
}

function sourceLabel(t, refKind) {
  const k = String(refKind || '');
  if (k === 'live_gift') return tr(t, 'creatorEarnings.source.live', 'Ao vivo');
  if (k === 'reel_tip') return tr(t, 'creatorEarnings.source.reel', 'Reel');
  if (k === 'feed_tip' || k === 'feed_post') return tr(t, 'creatorEarnings.source.feed', 'Post'); // ledger grava 'feed_post'
  return tr(t, 'creatorEarnings.source.other', 'Direto');
}

function CreatorDashboard() {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const wallet = useWallet();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const s = useSurface();
  // Re-render quando o usuário troca a moeda de exibição.
  useCurrency();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState({
    subscriber_count: 0, monthly_revenue_cents: 0, weekly_tip_cents: 0, monthly_tip_cents: 0,
    pending_payout_cents: 0, top_tippers: [], tip_series_7d: [],
  });
  const [diamondBalance, setDiamondBalance] = useState(0);
  const [recent, setRecent] = useState([]);
  const [topupOpen, setTopupOpen] = useState(false);

  const load = useCallback(async () => {
    const [dash, wallet, earn] = await Promise.allSettled([
      api.creatorDashboard?.(),
      api.walletBalance?.(),
      api.creatorEarningsSummary?.({ limit: 5 }),
    ]);
    const d = dash.status === 'fulfilled' ? dash.value : null;
    if (d?.success && d.data) { setData(d.data); setFailed(false); } else { setFailed(true); }
    const w = wallet.status === 'fulfilled' ? wallet.value : null;
    if (w?.success && w.data) setDiamondBalance(Number(w.data.diamond_balance) || 0);
    const e = earn.status === 'fulfilled' ? earn.value : null;
    if (e?.success && e.data && Array.isArray(e.data.timeline)) setRecent(e.data.timeline.slice(0, 5));
    // [2026-10-13 diamantes-religados] "A receber" = disponível p/ saque do resumo novo (BRL).
    if (e?.success && e.data && e.data.available_cents != null) {
      const av = Number(e.data.available_cents) || 0;
      setData(prev => ({ ...prev, pending_payout_cents: av }));
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const pending = Number(data.pending_payout_cents) || 0;
  const minC = Number(wallet.minCashoutCents) || MIN_CASHOUT_CENTS; // servidor > constante
  const canCashout = pending >= minC;
  const progress = Math.max(0, Math.min(1, pending / minC));
  const series = useMemo(() => (Array.isArray(data.tip_series_7d) ? data.tip_series_7d : []), [data.tip_series_7d]);
  const hasSeries = series.some(x => (Number(x.tip_cents) || 0) > 0);
  const tippers = Array.isArray(data.top_tippers) ? data.top_tippers : [];
  const go = (path) => () => { try { router.push(path); } catch {} };

  const title = tr(t, 'profile.creatorDashboard', 'Painel de criador');

  const body = (
    <>
      {/* ── Saldo a receber + Sacar ───────────────────────────── */}
      <Card elevated padding={Space.xl}>
        <Text style={[Type.footnote, { color: s.textSecondary, fontWeight: '600' }]}>
          {tr(t, 'creatorDash.available', 'A receber')}
        </Text>
        <Text style={[Type.largeTitle, { color: s.text, marginTop: Space.xs }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {money(pending)}
        </Text>
        {canCashout ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>
            {tr(t, 'creatorDash.availableSub', 'Disponível para saque via Pix')}
          </Text>
        ) : (
          <View style={{ marginTop: Space.md }}>
            <View style={[styles.track, { backgroundColor: s.fill }]}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}>
              <View style={[styles.trackFill, { width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%`, backgroundColor: s.ink }]} />
            </View>
            <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm }]}>
              {tr(t, 'creatorDash.missing', 'Faltam {missing} para o saque mínimo de {min}')
                .replace('{missing}', money(minC - pending))
                .replace('{min}', money(minC))}
            </Text>
          </View>
        )}
        <Button
          title={tr(t, 'creatorDash.withdraw', 'Sacar')}
          size="lg"
          fullWidth
          // [2026-10-16 polish] desabilitado = cinza suave (como em Meus ganhos), não um bloco preto a 40%
          variant={canCashout && WALLET_ENABLED ? 'primary' : 'secondary'}
          disabled={!canCashout || !WALLET_ENABLED}
          onPress={go('/wallet-cashout')}
          style={{ marginTop: Space.lg }}
        />
        {/* [2026-10-13 earnings-v2] WALLET_ENABLED=false → /wallet-cashout só
            mostra o aviso; o botão explica em vez de abrir uma tela morta. */}
        {!WALLET_ENABLED ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm, textAlign: 'center' }]}>
            {tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.')}
          </Text>
        ) : null}
      </Card>

      {/* ── Diamantes (linha secundária) ──────────────────────── */}
      <Card padding={0}>
        <PressableRow onPress={() => setTopupOpen(true)} style={styles.diamondRow} accessibilityRole="button">
          <View style={[styles.diamondTile, { backgroundColor: s.fill }]}>
            <DiamondGlyph size={18} color={s.text} />
          </View>
          <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
            <Text style={[Type.headline, { color: s.text }]} numberOfLines={1}>
              {tr(t, 'creatorDash.diamonds', '{n} diamantes').replace('{n}', formatInt(diamondBalance, language))}
            </Text>
            <Text style={[Type.footnote, { color: s.textSecondary }]} numberOfLines={1}>
              {tr(t, 'creatorDash.diamondsSub', 'Seu saldo para enviar presentes')}
            </Text>
          </View>
          <Button title={tr(t, 'creatorDash.buy', 'Comprar')} variant="secondary" size="sm" onPress={() => setTopupOpen(true)} />
        </PressableRow>
      </Card>

      {/* ── Métricas ──────────────────────────────────────────── */}
      <View style={styles.grid}>
        <MetricTile s={s}
          label={tr(t, 'creatorDash.monthRevenue', 'Receita do mês')}
          value={money(data.monthly_revenue_cents)}
          delta={<Delta s={s} cur={data.monthly_revenue_cents} prev={data.prev_monthly_revenue_cents} />}
        />
        <MetricTile s={s}
          label={tr(t, 'creatorDash.subscribers', 'Assinantes')}
          value={formatInt(data.subscriber_count || 0, language)}
          delta={<Delta s={s} cur={data.subscriber_count} prev={data.prev_subscriber_count} />}
        />
      </View>
      <View style={styles.grid}>
        <MetricTile s={s}
          label={tr(t, 'creatorDash.gifts7d', 'Presentes · 7 dias')}
          value={money(data.weekly_tip_cents)}
          delta={<Delta s={s} cur={data.weekly_tip_cents} prev={data.prev_weekly_tip_cents} />}
        />
        <MetricTile s={s}
          label={tr(t, 'creatorDash.gifts30d', 'Presentes · 30 dias')}
          value={money(data.monthly_tip_cents)}
          delta={<Delta s={s} cur={data.monthly_tip_cents} prev={data.prev_monthly_tip_cents} />}
        />
      </View>

      {/* ── Gráfico (só com dados) ────────────────────────────── */}
      <Card>
        <Text style={[Type.headline, { color: s.text, marginBottom: Space.xs }]}>
          {tr(t, 'creatorDash.chartTitle', 'Últimos 7 dias')}
        </Text>
        {hasSeries ? (
          <WeekBars series={series} s={s} language={language} />
        ) : (
          <Text style={[Type.footnote, { color: s.textSecondary }]}>
            {tr(t, 'creatorDash.chartEmpty', 'Sem presentes nos últimos 7 dias.')}
          </Text>
        )}
      </Card>

      {/* ── Maiores apoiadores ───────────────────────────────── */}
      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'creatorDash.topSupporters', 'Maiores apoiadores · 30 dias')} />
      {tippers.length > 0 ? (
        <Card padding={0}>
          {tippers.map((tp, idx) => (
            <View key={(tp.email || '') + idx}
              style={[styles.personRow, idx < tippers.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
              <Text style={[Type.footnote, styles.rank, { color: idx < 3 ? s.text : s.textTertiary }]}>{idx + 1}</Text>
              <AvatarCircle email={tp.email} name={tp.name} size={36} colors={colors} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>
                  {tp.name || (tp.email || '').split('@')[0]}
                </Text>
                <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                  {tr(t, 'creatorDash.supporterLine', '{d} diamantes · {n} presentes')
                    .replace('{d}', formatInt(tp.total_diamonds || 0, language))
                    .replace('{n}', formatInt(tp.tip_count || 0, language))}
                </Text>
              </View>
              <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]}>{money(tp.total_cents)}</Text>
            </View>
          ))}
        </Card>
      ) : (
        <Card padding={0}>
          <View style={{ paddingHorizontal: Space.lg, paddingTop: Space.lg, paddingBottom: Space.sm }}>
            <Text style={[Type.headline, { color: s.text }]}>{tr(t, 'creatorDash.noSupporters', 'Ainda sem apoiadores')}</Text>
            <Text style={[Type.footnote, { color: s.textSecondary, marginTop: 2 }]}>
              {tr(t, 'creatorDash.noSupportersSub', 'Quem mandar diamantes para você aparece aqui. Formas de ganhar:')}
            </Text>
          </View>
          <EarnRow s={s} title={tr(t, 'creatorDash.earnLive', 'Fazer uma live')} sub={tr(t, 'creatorDash.earnLiveSub', 'Receba presentes ao vivo')} onPress={go('/live-broadcast')} separator />
          <EarnRow s={s} title={tr(t, 'creatorDash.earnReel', 'Publicar um reel')} sub={tr(t, 'creatorDash.earnReelSub', 'Fãs podem mandar diamantes no reel')} onPress={go('/reels-compose')} />
        </Card>
      )}

      {/* ── Atividade recente / Ver ganhos ───────────────────── */}
      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'creatorDash.recent', 'Atividade recente')} />
      <Card padding={0}>
        {recent.map((item, idx) => {
          const who = String(item.counterparty || '').split('@')[0] || tr(t, 'creatorEarnings.someone', 'Alguém');
          let when = '';
          try { const ts = Number(item.created_at_ts) * 1000; if (ts) when = new Date(ts).toLocaleDateString(language || undefined); } catch {}
          return (
            <View key={String(item.id || idx)} style={[styles.personRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
              <AvatarCircle email={item.counterparty} size={36} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>{who}</Text>
                <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                  {sourceLabel(t, item.ref_kind)}{when ? ' · ' + when : ''}
                </Text>
              </View>
              {/* [2026-10-13 earnings-v2] tip_recv/live_gift_recv: `amount` = centavos de payout (não diamantes) */}
              {(item.kind === 'tip_recv' || item.kind === 'live_gift_recv') ? (
                <Text style={[Type.callout, { color: s.text, fontWeight: '600', marginLeft: Space.sm }]}>+{money(item.amount)}</Text>
              ) : (
                <View style={styles.amount}>
                  <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]}>+{formatInt(item.amount || 0, language)}</Text>
                  <DiamondGlyph size={12} color={s.text} />
                </View>
              )}
            </View>
          );
        })}
        {recent.length === 0 ? (
          <Text style={[Type.footnote, { color: s.textSecondary, paddingHorizontal: Space.lg, paddingTop: Space.md, paddingBottom: Space.xs }]}>
            {tr(t, 'creatorDash.noActivity', 'Nenhum ganho ainda.')}
          </Text>
        ) : null}
        <PressableRow onPress={go('/creator-earnings')} style={styles.linkRow} accessibilityRole="button">
          <Text style={[Type.callout, { color: s.text, fontWeight: '600', flex: 1 }]}>{tr(t, 'creatorEarnings.cta', 'Ver ganhos')}</Text>
          <IconChevronRight size={18} color={s.iconMuted} />
        </PressableRow>
      </Card>

      {failed ? (
        <Text style={[Type.footnote, { color: s.textSecondary, textAlign: 'center', marginTop: Space.sm }]}>
          {tr(t, 'creatorDash.loadError', 'Não foi possível atualizar. Puxe para tentar de novo.')}
        </Text>
      ) : null}
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
        <DashboardSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scrollBody, { paddingBottom: Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
        >
          <SkeletonFadeIn style={{ gap: Space.md }}>{body}</SkeletonFadeIn>
        </ScrollView>
      )}

      <DiamondTopUpSheet
        visible={topupOpen}
        onClose={() => setTopupOpen(false)}
        onBalanceChange={(b) => { if (typeof b === 'number') setDiamondBalance(b); }}
      />
    </View>
  );
}

function EarnRow({ s, title, sub, onPress, separator }) {
  return (
    <PressableRow onPress={onPress} style={styles.earnRow} accessibilityRole="button">
      <View style={[{ flex: 1, minWidth: 0, paddingVertical: Space.md, flexDirection: 'row', alignItems: 'center' },
        separator && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>{title}</Text>
          <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>{sub}</Text>
        </View>
        <IconChevronRight size={18} color={s.iconMuted} />
      </View>
    </PressableRow>
  );
}

// [2026-05-22 monetization-pause] While MONETIZATION_ENABLED is off, a clean
// "em breve" state (re-enable = constants/featureFlags.js, business decision).
function ComingSoon() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const s = useSurface();
  const title = tr(t, 'profile.creatorDashboard', 'Painel de criador');
  return (
    <View style={{ flex: 1, backgroundColor: s.bg }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title })} />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} />
      )}
      <ScrollView contentContainerStyle={styles.gateBody} showsVerticalScrollIndicator={false}>
        <View style={[styles.gateBadge, { backgroundColor: s.ink }]}>
          <DiamondGlyph size={40} color={s.onInk} />
        </View>
        <Text style={[Type.title2, { color: s.text, textAlign: 'center' }]}>
          {tr(t, 'creatorDashboard.comingSoonTitle', 'Recursos de criador em breve')}
        </Text>
        <Text style={[Type.subhead, { color: s.textSecondary, textAlign: 'center', marginTop: Space.sm }]}>
          {tr(t, 'creatorDashboard.comingSoonBody', 'Diamantes, gorjetas, assinaturas e saques ainda não estão disponíveis. Continue postando e crescendo — quando a monetização abrir, seus ganhos vão aparecer aqui.')}
        </Text>
        <View style={[styles.gateList, { borderColor: s.separator }]}>
          {[
            tr(t, 'creatorDashboard.perk1', 'Receba diamantes e gorjetas dos fãs'),
            tr(t, 'creatorDashboard.perk2', 'Assinaturas mensais do seu conteúdo'),
            tr(t, 'creatorDashboard.perk3', 'Saque dos seus ganhos via Pix'),
          ].map((line, i) => (
            <View key={i} style={styles.gateListRow}>
              <View style={[styles.gateDot, { backgroundColor: s.text }]} />
              <Text style={[Type.subhead, { flex: 1, color: s.text, fontWeight: '600' }]}>{line}</Text>
            </View>
          ))}
        </View>
        <Button title={tr(t, 'creatorDashboard.backToApp', 'Voltar')} size="lg" fullWidth
          onPress={() => { try { router.back(); } catch {} }} style={{ marginTop: Space.xxl }} />
      </ScrollView>
    </View>
  );
}

export default function CreatorDashboardScreen() {
  return MONETIZATION_ENABLED ? <CreatorDashboard /> : <ComingSoon />;
}

const styles = StyleSheet.create({
  scrollBody: {
    padding: Layout.gutter, gap: Space.md,
    width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center',
  },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  diamondRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md, minHeight: Layout.rowMinHeightTall },
  diamondTile: { width: 36, height: 36, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', gap: Space.md },
  tile: { flex: 1, borderRadius: Radius.card, padding: Space.lg, minHeight: 84 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: Space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  barHit: { flex: 1, height: '100%', justifyContent: 'flex-end', paddingHorizontal: 4 },
  barLabels: { flexDirection: 'row', gap: 2, marginTop: Space.xs },
  barLabel: { flex: 1, textAlign: 'center' },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md },
  rank: { width: 22, fontWeight: '700' },
  amount: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: Space.sm },
  earnRow: { paddingLeft: Space.lg, paddingRight: Space.md },
  linkRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, minHeight: Layout.rowMinHeight },
  gateBody: { paddingHorizontal: Space.xxl, paddingTop: Space.huge, paddingBottom: Space.xxxl, alignItems: 'center' },
  gateBadge: { width: 88, height: 88, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: Space.xxl },
  gateList: { alignSelf: 'stretch', marginTop: Space.xxl, borderRadius: Radius.card, borderWidth: StyleSheet.hairlineWidth, paddingVertical: Space.xs, paddingHorizontal: Space.lg },
  gateListRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Space.md },
  gateDot: { width: 6, height: 6, borderRadius: 3, marginRight: Space.md },
});
