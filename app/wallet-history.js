// /wallet-history — Histórico completo da Carteira. [2026-10-21 carteira-pro]
//
// Aberto pelo botão redondo "Histórico" e por "Ver todos" da /wallet. Nível
// Revolut/Apple Wallet: filtros (Tudo/Compras/Presentes/Ganhos/Saques),
// transações agrupadas por dia com o saldo do dia alinhado à direita, ícone por
// tipo, valores tabulares, paginação infinita, puxar p/ atualizar, skeleton no
// 1º carregamento (sem cache), estado vazio por filtro e detalhe com recibo.
// Só LEITURA (wallet_history) — nenhuma chamada de compra/IAP/saque aqui.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, IOS_NATIVE_INSET } from '../components/nativeHeader';
import UIRefreshControl from '../components/ui/RefreshControl';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { WALLET_ENABLED } from '../constants/featureFlags';
import { TopBar, useSurface, Skeleton, Type, Space, Layout } from '../components/ui';
import { haptic } from '../constants/theme';
import { peekCached, putCached } from '../hooks/useCachedAction';
import { WALLET_SCREEN, fetchWalletScreen } from '../services/screenData';
import { isMinorAccount, useWallet } from '../services/diamonds';
import { tr, FilterChips } from '../components/wallet/WalletKit';
import {
  WALLET_PAGE, filterOf, buildActivityRows, walletFilters,
  TxRow, TxDetailSheet, EmptyActivity, DayHeader,
} from '../components/wallet/WalletActivity';

function HistorySkeleton() {
  return (
    <View style={{ gap: Space.sm, paddingTop: Space.md }}>
      <Skeleton height={14} width={90} radius={6} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: 8 }}>
          <Skeleton height={40} width={40} radius={20} delay={i * 30} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton height={13} width="55%" radius={6} delay={i * 30 + 10} />
            <Skeleton height={11} width="35%" radius={6} delay={i * 30 + 20} />
          </View>
          <Skeleton height={14} width={56} radius={6} delay={i * 30 + 30} />
        </View>
      ))}
    </View>
  );
}

function WalletHistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  const wallet = useWallet();
  // Mesma 1ª página que a /wallet guarda no aparelho → abre já preenchido.
  const _seed = useMemo(() => peekCached(WALLET_SCREEN.key), []);
  const [items, setItems] = useState(() => (Array.isArray(_seed?.items) ? _seed.items : []));
  const [loading, setLoading] = useState(() => !_seed);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(() => !!_seed?.has_more);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const v = await fetchWalletScreen();
    if (v) { setItems(v.items); setMore(v.has_more); putCached(WALLET_SCREEN.key, v); }
    setLoading(false); setRefreshing(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); try { haptic.light(); } catch {} load(); }, [load]);
  const loadMore = useCallback(async () => {
    if (!more || busyRef.current) return;
    busyRef.current = true; setLoadingMore(true);
    try {
      const r = await api.walletHistory({ limit: WALLET_PAGE, offset: items.length });
      if (r?.success && r.data) {
        const next = Array.isArray(r.data.items) ? r.data.items : [];
        setItems((prev) => {
          const seen = new Set(prev.map((x) => String(x.id)));
          return prev.concat(next.filter((x) => !seen.has(String(x.id))));
        });
        setMore(!!r.data.has_more && next.length > 0);
      } else setMore(false);
    } catch {}
    busyRef.current = false; setLoadingMore(false);
  }, [more, items.length]);

  const filtered = useMemo(() => (filter === 'all' ? items : items.filter((it) => filterOf(it) === filter)), [items, filter]);
  // Filtro com poucos itens carregados → busca mais páginas sozinho.
  useEffect(() => { if (!loading && filter !== 'all' && filtered.length < 12 && more && !loadingMore) loadMore(); }, [filter, filtered.length, more, loadingMore, loading, loadMore]);
  const rows = useMemo(() => buildActivityRows(filtered, t, language), [filtered, t, language]);

  const canPurchase = !isMinorAccount() && !(wallet.loaded && !wallet.enabled) && wallet.purchaseEnabled !== false;
  const title = tr(t, 'walletPro.historyTitle', 'Histórico');

  const renderItem = useCallback(({ item: r }) => {
    if (r.type === 'day') return <DayHeader row={r} s={s} language={language} />;
    return <TxRow item={r.item} s={s} t={t} language={language} first={r.first} last={r.last} onPress={() => setDetail(r.item)} />;
  }, [s, t, language]);

  const header = (
    <View style={styles.chipsBleed}>
      <FilterChips options={walletFilters(t)} value={filter} onChange={setFilter} s={s} inset={Layout.gutter} fadeColor={s.bgGrouped} />
    </View>
  );
  const footer = loadingMore ? (
    <View style={styles.more}><ActivityIndicator color={s.textSecondary} /></View>
  ) : (!more && filtered.length > 8 ? (
    <Text style={[Type.caption, { color: s.textTertiary, textAlign: 'center', marginTop: Space.lg }]}>{tr(t, 'walletV3.endOfList', 'Isso é tudo por aqui')}</Text>
  ) : null);

  return (
    <View style={{ flex: 1, backgroundColor: s.bgGrouped }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title, headerLargeStyle: { backgroundColor: s.bgGrouped } })} />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} maxWidth={Layout.contentMaxWidth} />
      )}
      <FlatList
        data={loading && !items.length ? [] : rows}
        keyExtractor={(r) => r.key}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={loading
          ? <HistorySkeleton />
          : more || loadingMore
            ? <View style={styles.more}><ActivityIndicator color={s.textSecondary} /></View>
            : <View style={{ marginTop: Space.lg }}><EmptyActivity s={s} t={t} filter={filter} onBuy={canPurchase ? () => router.push('/diamond-shop') : null} /></View>}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        {...nativeScrollInsetProps()}
        contentContainerStyle={[styles.body, { paddingBottom: IOS_NATIVE_INSET ? Space.xxxl : Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
        showsVerticalScrollIndicator={false}
        initialNumToRender={16}
        windowSize={9}
        refreshControl={<UIRefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
      />
      <TxDetailSheet item={detail} onClose={() => setDetail(null)} s={s} t={t} language={language} />
    </View>
  );
}

export default function WalletHistoryRoute() {
  if (!WALLET_ENABLED) return <Redirect href="/chat" />;
  return <WalletHistoryScreen />;
}

const styles = StyleSheet.create({
  body: { padding: Layout.gutter, paddingTop: Space.md, width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center' },
  chipsBleed: { marginHorizontal: -Layout.gutter },
  more: { alignItems: 'center', justifyContent: 'center', minHeight: 56 },
});
