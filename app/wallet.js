// /wallet — Carteira de diamantes.
//
// [2026-10-13 diamantes-religados] Reescrita P&B (o diamante é a única cor):
//   • Saldo de diamantes (pode ficar negativo após estorno de compra → aviso)
//     + Recarregar (sheet da loja) + Loja.
//   • Ganhos de criador: disponível p/ saque (R$) + em liberação → Meus ganhos.
//   • Histórico de transações (wallet_history, paginado): recargas, presentes
//     enviados/recebidos, estornos, saques. `amount` = diamantes nas linhas
//     novas; presentes recebidos mostram também o ganho em R$ (payout_cents).
// Sem "Enviar saldo"/"Receber": transferência P2P foi desligada no servidor —
// presente para uma pessoa é pelo chat 1:1 (bolha de presente).

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { formatMoneyActive } from '../services/currencyService';
import * as api from '../services/api';
import { WALLET_ENABLED } from '../constants/featureFlags';
import { IconDiamond, IconGiftBox, IconArrowRight, IconRotateCcw, IconChevronRight, IconPlus } from '../components/Icons';
import { Card, SectionHeader, TopBar, useSurface, Skeleton, ScreenEmptyState, Type, Space, Radius, Layout } from '../components/ui';
import { formatInt } from '../utils/dateFormat';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import { useWallet, refreshWallet, isMinorAccount } from '../services/diamonds';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
function money(cents) { return formatMoneyActive(Number(cents) || 0); }
function handleOf(email) { const s = String(email || ''); return s.split('@')[0] || s; }

const KIND = {
  topup: ['wallet.kind.topup', 'Recarga'],
  topup_refund: ['wallet.kind.topupRefund', 'Estorno de compra'],
  gift_send: ['wallet.kind.giftSend', 'Presente enviado'],
  gift_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  live_gift_send: ['wallet.kind.giftSend', 'Presente enviado'],
  live_gift_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  tip_send: ['wallet.kind.giftSend', 'Presente enviado'],
  tip_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  live_react: ['wallet.kind.giftSend', 'Presente enviado'],
  send: ['wallet.kind.send', 'Enviado'],
  receive: ['wallet.kind.receive', 'Recebido'],
  promote: ['wallet.kind.promote', 'Promoção'],
  cashout: ['wallet.kind.cashout', 'Saque'],
  cashout_reversal: ['wallet.kind.cashoutReversal', 'Saque devolvido'],
  legacy_convert: ['wallet.kind.legacyConvert', 'Ajuste de saldo'],
};
const SOURCE = { live_gift: 'creatorEarnings.source.live', live: 'creatorEarnings.source.live', feed_post: 'creatorEarnings.source.feed', post: 'creatorEarnings.source.feed', reel: 'creatorEarnings.source.reel', chat: 'gifts.sourceChat', chat_gift: 'gifts.sourceChat' };

function KindIcon({ kind, color }) {
  if (/gift|tip|react/.test(kind)) return <IconGiftBox size={18} color={color} />;
  if (kind === 'cashout') return <IconArrowRight size={18} color={color} />;
  if (/refund|reversal/.test(kind)) return <IconRotateCcw size={18} color={color} />;
  return <IconDiamond size={18} />;
}

function Row({ item, s, t, language, last }) {
  const kind = String(item.kind || '');
  const credit = item.direction === 'credit';
  const [k, fb] = KIND[kind] || (credit ? KIND.receive : KIND.send);
  const isCashout = kind === 'cashout' || kind === 'cashout_reversal';
  // Linhas legadas de ganho (tip_recv/live_gift_recv antigos) gravavam centavos em `amount`.
  const legacyEarn = (kind === 'tip_recv' || kind === 'live_gift_recv') && item.diamonds == null;
  const diamonds = item.diamonds != null ? Number(item.diamonds) : (legacyEarn || isCashout ? null : Number(item.amount) || 0);
  const payout = item.payout_cents != null ? Number(item.payout_cents) : (legacyEarn ? Number(item.amount) || 0 : null);
  const when = (() => { const n = Number(item.created_at_ts) * 1000; if (!n) return ''; try { return new Date(n).toLocaleDateString(language || undefined, { day: '2-digit', month: 'short' }); } catch { return ''; } })();
  const src = SOURCE[String(item.ref_kind || '')];
  const subParts = [];
  if (item.counterparty) subParts.push(handleOf(item.counterparty));
  if (src) subParts.push(tr(t, src, ''));
  if (when) subParts.push(when);
  const sign = credit ? '+' : '-';
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}
      accessibilityLabel={`${tr(t, k, fb)}, ${diamonds != null ? sign + diamonds : ''} ${payout != null ? money(payout) : ''}`}>
      <View style={[styles.rowIcon, { backgroundColor: s.fill }]}><KindIcon kind={kind} color={s.text} /></View>
      <View style={{ flex: 1, minWidth: 0, marginLeft: Space.md }}>
        <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>{tr(t, k, fb)}</Text>
        {subParts.length ? <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>{subParts.filter(Boolean).join(' · ')}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', marginLeft: Space.sm }}>
        {diamonds != null ? (
          <View style={styles.amt}>
            <Text style={[Type.callout, { color: s.text, fontWeight: '700' }]}>{`${sign}${formatInt(Math.abs(diamonds), language)}`}</Text>
            <IconDiamond size={12} />
          </View>
        ) : null}
        {payout != null && (kind.endsWith('_recv') || isCashout || kind === 'legacy_convert') ? (
          <Text style={[Type.caption, { color: s.textSecondary, fontWeight: '600' }]}>{(isCashout && !credit ? '-' : '+') + money(payout)}</Text>
        ) : null}
      </View>
    </View>
  );
}

function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  useCurrency();
  const wallet = useWallet();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  const load = useCallback(async () => {
    const [h] = await Promise.allSettled([api.walletHistory({ limit: 30, offset: 0 }), refreshWallet()]);
    const r = h.status === 'fulfilled' ? h.value : null;
    if (r?.success && r.data) { setItems(Array.isArray(r.data.items) ? r.data.items : []); setMore(!!r.data.has_more); }
    setLoading(false); setRefreshing(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);
  const loadMore = useCallback(async () => {
    if (!more || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.walletHistory({ limit: 30, offset: items.length });
      if (r?.success && r.data) { setItems(prev => prev.concat(Array.isArray(r.data.items) ? r.data.items : [])); setMore(!!r.data.has_more); }
    } catch {}
    setLoadingMore(false);
  }, [more, loadingMore, items.length]);

  const title = tr(t, 'wallet.title', 'Carteira');
  const minor = isMinorAccount();
  const negative = typeof wallet.diamonds === 'number' && wallet.diamonds < 0;
  const off = wallet.loaded && !wallet.enabled;

  const body = (
    <>
      <Card elevated padding={Space.xl}>
        <Text style={[Type.footnote, { color: s.textSecondary, fontWeight: '600' }]}>{tr(t, 'wallet.diamondBalance', 'Saldo de diamantes')}</Text>
        <View style={styles.balRow}>
          <IconDiamond size={30} />
          <Text style={[Type.largeTitle, { color: negative ? s.danger : s.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {wallet.diamonds == null ? '—' : formatInt(wallet.diamonds, language)}
          </Text>
        </View>
        {negative ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>
            {tr(t, 'gifts.negativeBalance', 'Seu saldo está negativo por causa de um reembolso. Recarregue para voltar a enviar.')}
          </Text>
        ) : null}
        {minor ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>{tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.')}</Text>
        ) : off ? (
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>{tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.')}</Text>
        ) : (
          <View style={styles.actions}>
            <TouchableOpacity onPress={() => setTopupOpen(true)} style={[styles.primary, { backgroundColor: s.ink }]} accessibilityRole="button">
              <IconPlus size={18} color={isDark ? '#000' : '#fff'} />
              <Text style={[styles.primaryText, { color: isDark ? '#000' : '#fff' }]}>{tr(t, 'gifts.topUp', 'Recarregar')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/diamond-shop')} style={[styles.secondary, { borderColor: s.separator }]} accessibilityRole="button">
              <Text style={[styles.secondaryText, { color: s.text }]}>{tr(t, 'diamondShop.title', 'Loja de Diamantes')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </Card>

      <Card padding={0}>
        <TouchableOpacity onPress={() => router.push('/creator-earnings')} style={styles.earnRow} accessibilityRole="button">
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[Type.footnote, { color: s.textSecondary, fontWeight: '600' }]}>{tr(t, 'creatorEarnings.title', 'Meus Ganhos')}</Text>
            <Text style={[Type.title3, { color: s.text, marginTop: 2 }]}>{money(wallet.availableCents)}</Text>
            <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
              {wallet.onHoldCents > 0
                ? tr(t, 'earn.onHoldShort', '{amount} em liberação').replace('{amount}', money(wallet.onHoldCents))
                : tr(t, 'creatorEarnings.availableLabel', 'Disponível para saque')}
            </Text>
          </View>
          <IconChevronRight size={18} color={s.textTertiary} />
        </TouchableOpacity>
      </Card>

      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'wallet.history', 'Histórico')} />
      <Card padding={0}>
        {items.length ? items.map((it, i) => (
          <Row key={String(it.id ?? i)} item={it} s={s} t={t} language={language} last={i === items.length - 1} />
        )) : (
          <ScreenEmptyState compact kind="lives"
            title={tr(t, 'wallet.historyEmptyTitle', 'Nenhuma transação ainda')}
            subtitle={tr(t, 'wallet.historyEmptySub', 'Recargas, presentes e saques aparecem aqui.')} />
        )}
      </Card>
      {more ? (
        <TouchableOpacity onPress={loadMore} style={styles.more} accessibilityRole="button">
          {loadingMore ? <ActivityIndicator color={s.text} /> : <Text style={[Type.subhead, { color: s.text, fontWeight: '700' }]}>{tr(t, 'common.loadMore', 'Carregar mais')}</Text>}
        </TouchableOpacity>
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
        <View style={[styles.scrollBody, { gap: Space.md }]}>
          <Skeleton height={168} radius={Radius.card} />
          <Skeleton height={84} radius={Radius.card} delay={60} />
          <Skeleton height={220} radius={Radius.card} delay={120} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scrollBody, { paddingBottom: Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
        >
          <View style={{ gap: Space.md }}>{body}</View>
        </ScrollView>
      )}
      <DiamondTopUpSheet visible={topupOpen} onClose={() => { setTopupOpen(false); load(); }} />
    </View>
  );
}

export default function WalletRoute() {
  if (!WALLET_ENABLED) return <Redirect href="/chat" />;
  return <WalletScreen />;
}

const styles = StyleSheet.create({
  scrollBody: { padding: Layout.gutter, width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center' },
  balRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.xs },
  actions: { flexDirection: 'row', gap: Space.sm, marginTop: Space.lg },
  primary: { flex: 1, height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  primaryText: { fontSize: 15, fontWeight: '800' },
  secondary: { flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  secondaryText: { fontSize: 15, fontWeight: '700' },
  earnRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md, minHeight: 64 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  amt: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  more: { alignItems: 'center', justifyContent: 'center', minHeight: 48 },
});
