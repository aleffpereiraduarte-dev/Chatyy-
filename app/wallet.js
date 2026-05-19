// /wallet — diamond wallet hub.
//
// Renders:
//   • Big balance header with "Comprar diamantes" CTA (opens DiamondTopUpSheet).
//   • Pending creator payout pill (only visible if > 0).
//   • Quick-actions row: Enviar diamantes (placeholder picker — for now we
//     surface the action only from a profile peek; here it points at chat).
//   • Paginated ledger feed:
//       credit  → green +N ◆     (topup, receive, tip_recv)
//       debit   → red    -N ◆    (send, tip_send, promote)
//
// All data comes from wallet_history (server returns balance + items in one
// shot so the header paints without a second round-trip).

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  RefreshControl, Platform, StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft } from '../components/Icons';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';

function LedgerRow({ item, colors, isDark, t }) {
  const isCredit = item.direction === 'credit';
  const sign = isCredit ? '+' : '-';
  const color = isCredit ? '#10B981' : '#EF4444';
  const kindLabel = (() => {
    const map = {
      topup:     t('wallet.kind.topup')    || 'Compra',
      send:      t('wallet.kind.send')     || 'Enviado',
      receive:   t('wallet.kind.receive')  || 'Recebido',
      tip_send:  t('wallet.kind.tipSend')  || 'Gorjeta enviada',
      tip_recv:  t('wallet.kind.tipRecv')  || 'Gorjeta recebida',
      promote:   t('wallet.kind.promote')  || 'Promoção',
    };
    return map[item.kind] || item.kind;
  })();
  const when = (() => {
    const ts = Number(item.created_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  })();
  return (
    <View style={[styles.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}>
      <View style={styles.rowLeft}>
        <Text style={[styles.rowKind, { color: colors.text }]} numberOfLines={1}>{kindLabel}</Text>
        {item.counterparty ? (
          <Text style={[styles.rowCp, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.counterparty}
          </Text>
        ) : null}
        <Text style={[styles.rowWhen, { color: colors.textTertiary }]}>{when}</Text>
      </View>
      <Text style={[styles.rowAmount, { color }]}>
        {sign}{Number(item.amount).toLocaleString('pt-BR')} ◆
      </Text>
    </View>
  );
}

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [items, setItems] = useState([]);
  const [balance, setBalance] = useState(0);
  const [pendingPayout, setPendingPayout] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);

  const load = useCallback(async ({ append = false } = {}) => {
    try {
      const offset = append ? items.length : 0;
      const r = await api.walletHistory({ limit: 50, offset });
      if (r?.success && r.data) {
        const next = Array.isArray(r.data.items) ? r.data.items : [];
        setItems(prev => append ? [...prev, ...next] : next);
        setBalance(Number(r.data.diamond_balance) || 0);
        setPendingPayout(Number(r.data.pending_payout_cents) || 0);
        setHasMore(!!r.data.has_more);
      }
    } catch (e) {
      // Silent — empty state will render.
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [items.length]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const onEndReached = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    load({ append: true });
  }, [hasMore, load, loadingMore]);

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
        <Text style={[styles.headTitle, { color: colors.text }]}>
          {t('wallet.myDiamonds') || 'Meus diamantes'}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      {/* Balance card */}
      <View style={[styles.balanceCard, {
        backgroundColor: isDark ? 'rgba(168,85,247,0.18)' : 'rgba(168,85,247,0.10)',
        borderColor: isDark ? 'rgba(168,85,247,0.40)' : 'rgba(168,85,247,0.25)',
      }]}>
        <Text style={[styles.balLabel, { color: colors.textSecondary }]}>
          {t('wallet.currentBalance') || 'Saldo atual'}
        </Text>
        <Text style={[styles.balVal, { color: colors.text }]}>
          {balance.toLocaleString('pt-BR')} <Text style={styles.balDiamond}>◆</Text>
        </Text>
        {pendingPayout > 0 ? (
          <TouchableOpacity
            onPress={() => router.push('/wallet-cashout')}
            accessibilityRole="button"
            accessibilityLabel={t('wallet.cashoutOpen') || 'Sacar'}
            style={styles.payoutPillRow}
          >
            <Text style={[styles.payoutPill, { color: '#10B981' }]}>
              {t('wallet.pendingPayout') || 'Saque pendente'}: R$ {(pendingPayout / 100).toFixed(2).replace('.', ',')}
            </Text>
            <View style={styles.payoutCta}>
              <Text style={styles.payoutCtaText}>
                {t('wallet.cashoutOpen') || 'Sacar'}
              </Text>
            </View>
          </TouchableOpacity>
        ) : null}

        <View style={styles.ctaRow}>
          <TouchableOpacity
            onPress={() => router.push('/diamond-shop')}
            style={[styles.ctaBtn, { backgroundColor: '#A855F7' }]}
            accessibilityRole="button"
          >
            <Text style={styles.ctaBtnText}>{t('wallet.topup') || 'Comprar diamantes'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/chat')}
            style={[styles.ctaBtn, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#A855F7' }]}
            accessibilityRole="button"
          >
            <Text style={[styles.ctaBtnText, { color: '#A855F7' }]}>
              {t('walletSend.openChat') || 'Enviar para alguém'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={[styles.histTitle, { color: colors.textSecondary }]}>
        {t('wallet.history') || 'Histórico'}
      </Text>

      {loading ? (
        <View style={{ paddingTop: 30 }}>
          <ActivityIndicator color="#A855F7" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <LedgerRow item={item} colors={colors} isDark={isDark} t={t} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A855F7" />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={(
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('wallet.historyEmpty') || 'Nenhuma transação ainda. Compre diamantes para começar.'}
            </Text>
          )}
          ListFooterComponent={loadingMore ? (
            <View style={{ paddingVertical: 12 }}>
              <ActivityIndicator color="#A855F7" size="small" />
            </View>
          ) : null}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}

      <DiamondTopUpSheet
        visible={topUpOpen}
        onClose={() => { setTopUpOpen(false); load(); }}
        onBalanceChange={(b) => { if (typeof b === 'number') setBalance(b); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 14 },
  headBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '700' },
  balanceCard: {
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    padding: 18, marginBottom: 16,
  },
  balLabel: { fontSize: 13 },
  balVal: { fontSize: 36, fontWeight: '900', marginTop: 4 },
  balDiamond: { fontSize: 28, color: '#A855F7' },
  payoutPill: { fontSize: 12, fontWeight: '700' },
  payoutPillRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 6, gap: 10,
  },
  payoutCta: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: '#10B981',
  },
  payoutCtaText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  ctaRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  ctaBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  ctaBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  histTitle: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flex: 1, paddingRight: 12 },
  rowKind: { fontSize: 14, fontWeight: '700' },
  rowCp: { fontSize: 12, marginTop: 2 },
  rowWhen: { fontSize: 11, marginTop: 2 },
  rowAmount: { fontSize: 16, fontWeight: '800' },
  empty: { textAlign: 'center', fontSize: 13, paddingVertical: 40 },
});
