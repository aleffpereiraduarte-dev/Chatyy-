// /diamond-shop — full-screen diamond purchase store.
//
// Surfaces the same DIAMOND_PACKS ladder as DiamondTopUpSheet but as a
// proper page (deep-linkable, swipe-back, hero card, featured pack glow).
// Reached from:
//   • /wallet "Comprar diamantes" CTA
//   • SendDiamondSheet insufficient-balance state
//   • LivePaidGiftSheet "Comprar mais" link
//   • AppDrawer "Loja de Diamantes" tile

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  Platform, StatusBar, Alert, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { getBaseUrl } from '../services/api';
import { IconArrowLeft } from '../components/Icons';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, initIAP, purchaseDiamonds,
} from '../services/iap';

function formatBrl(v) {
  const n = Number(v) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

export default function DiamondShopScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [balance, setBalance] = useState(0);
  const [loadingBal, setLoadingBal] = useState(true);
  const [pendingSku, setPendingSku] = useState(null);
  const [iapReady, setIapReady] = useState(false);

  useEffect(() => {
    // 2026-05-19 (#1203) — Android Play Billing wired via same expo-iap
    // surface; init both stores. Web has no billing client.
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      initIAP().then(ok => setIapReady(!!ok)).catch(() => setIapReady(false));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.walletBalance?.();
        if (alive && r?.success && r.data) {
          setBalance(Number(r.data.diamond_balance) || 0);
        }
      } catch {}
      if (alive) setLoadingBal(false);
    })();
    return () => { alive = false; };
  }, []);

  const packs = useMemo(() => DIAMOND_PACKS, []);

  const onBuy = useCallback(async (pack) => {
    if (pendingSku) return;
    if (Platform.OS === 'web') {
      // Web has no billing client; deep-link to /diamond-shop on the
      // public site (same backend wallet_topup_verify credits the wallet).
      const base = (typeof getBaseUrl === 'function' && getBaseUrl()) || 'https://chatyy.com.br';
      const webUrl = `${base}/#/diamond-shop?sku=${encodeURIComponent(pack.sku)}`;
      try { Linking.openURL(webUrl); } catch {}
      return;
    }
    setPendingSku(pack.sku);
    try {
      const r = await purchaseDiamonds(pack.sku);
      if (r?.success) {
        if (typeof r.diamondBalance === 'number') setBalance(r.diamondBalance);
        Alert.alert(
          t('wallet.topupSuccessTitle') || 'Diamantes creditados',
          (t('wallet.topupSuccessBody') || 'Você ganhou {d} diamantes.').replace('{d}', r.diamondsAdded ?? pack.diamonds),
        );
      } else if (r?.message === 'cancelled') {
        // silent
      } else if (r?.message === 'web_fallback' || r?.message === 'iap_unavailable') {
        Alert.alert(
          t('wallet.topupUnavailableTitle') || 'Compra indisponível',
          t('wallet.topupUnavailableBody') || 'Não conseguimos iniciar a compra. Tente novamente em alguns minutos.',
        );
      } else {
        Alert.alert(t('common.error') || 'Erro', r?.message || (t('wallet.topupFailed') || 'Falha na compra.'));
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Falha na compra');
    } finally {
      setPendingSku(null);
    }
  }, [pendingSku, t]);

  const featuredSku = 'chatyy_diamond_5000';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: (insets.top || 0) + 6 }]}>
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
          {t('diamondShop.title') || 'Loja de Diamantes'}
        </Text>
        <TouchableOpacity
          onPress={() => router.push('/wallet')}
          style={styles.headerLinkBtn}
          accessibilityRole="button"
        >
          <Text style={[styles.headerLinkText, { color: '#A855F7' }]}>
            {t('diamondShop.wallet') || 'Carteira'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={[styles.hero, {
          backgroundColor: isDark ? 'rgba(168,85,247,0.18)' : 'rgba(168,85,247,0.10)',
          borderColor: isDark ? 'rgba(168,85,247,0.40)' : 'rgba(168,85,247,0.25)',
        }]}>
          <View style={styles.diamondBig}><Text style={styles.diamondGlyph}>◆</Text></View>
          <Text style={[styles.heroSubtitle, { color: colors.textSecondary }]}>
            {t('diamondShop.heroSubtitle') || 'Compre diamantes para enviar a amigos, presentear criadores e desbloquear conteúdo.'}
          </Text>
          <View style={styles.balPill}>
            <Text style={styles.balPillLabel}>
              {t('wallet.currentBalance') || 'Saldo atual'}:
            </Text>
            {loadingBal ? (
              <ActivityIndicator size="small" color="#A855F7" />
            ) : (
              <Text style={styles.balPillVal}>{balance.toLocaleString('pt-BR')} ◆</Text>
            )}
          </View>
        </View>

        {/* Packs */}
        {packs.map(p => {
          const localized = getDiamondLocalizedPrice(p.sku);
          const priceLabel = localized || formatBrl(p.priceBrl);
          const isLoading = pendingSku === p.sku;
          const featured = p.sku === featuredSku;
          const bonusBadge = p.bonusPct > 0
            ? (t('wallet.topupBonus') || 'Bônus +{p}%').replace('{p}', p.bonusPct)
            : null;
          return (
            <TouchableOpacity
              key={p.sku}
              onPress={() => onBuy(p)}
              disabled={!!pendingSku}
              activeOpacity={0.85}
              style={[
                styles.packCard,
                {
                  borderColor: featured
                    ? '#A855F7'
                    : (isDark ? 'rgba(168,85,247,0.25)' : 'rgba(168,85,247,0.18)'),
                  backgroundColor: featured
                    ? (isDark ? 'rgba(168,85,247,0.16)' : 'rgba(168,85,247,0.08)')
                    : (isDark ? 'rgba(168,85,247,0.06)' : 'rgba(168,85,247,0.03)'),
                  opacity: pendingSku && !isLoading ? 0.45 : 1,
                  shadowColor: featured ? '#A855F7' : 'transparent',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: featured ? 0.35 : 0,
                  shadowRadius: featured ? 14 : 0,
                  elevation: featured ? 6 : 0,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${p.diamonds} ${t('wallet.diamondsLabel') || 'diamantes'} ${priceLabel}`}
            >
              {featured ? (
                <View style={styles.featuredRibbon}>
                  <Text style={styles.featuredRibbonText}>
                    {(t('diamondShop.bestValue') || 'MELHOR CUSTO').toUpperCase()}
                  </Text>
                </View>
              ) : null}

              <View style={styles.packLeftCol}>
                <View style={styles.packAmountRow}>
                  <Text style={styles.packDiamondGlyph}>◆</Text>
                  <Text style={[styles.packDiamonds, { color: colors.text }]}>
                    {p.diamonds.toLocaleString('pt-BR')}
                  </Text>
                </View>
                {bonusBadge ? (
                  <View style={styles.bonusBadge}>
                    <Text style={styles.bonusBadgeText}>{bonusBadge}</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.packRightCol}>
                {isLoading ? (
                  <ActivityIndicator color="#A855F7" />
                ) : (
                  <View style={[styles.buyBtn, { backgroundColor: featured ? '#A855F7' : (isDark ? 'rgba(168,85,247,0.20)' : 'rgba(168,85,247,0.12)') }]}>
                    <Text style={[styles.buyBtnText, { color: featured ? '#fff' : '#A855F7' }]}>
                      {priceLabel}
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}

        {!iapReady && Platform.OS === 'ios' ? (
          <Text style={[styles.iapHint, { color: colors.textTertiary }]}>
            {t('wallet.topupConnecting') || 'Conectando à App Store…'}
          </Text>
        ) : null}
        {Platform.OS === 'android' ? (
          <Text style={[styles.iapHint, { color: colors.textTertiary }]}>
            {t('wallet.androidComingSoon') || 'Em breve no Android. Use o iOS por enquanto.'}
          </Text>
        ) : null}

        <Text style={[styles.tosNote, { color: colors.textTertiary }]}>
          {t('wallet.topupTos') || 'Diamantes não são reembolsáveis e não podem ser convertidos em dinheiro.'}
        </Text>

        <TouchableOpacity
          onPress={() => router.push('/wallet')}
          style={styles.historyLink}
          accessibilityRole="button"
        >
          <Text style={[styles.historyLinkText, { color: '#A855F7' }]}>
            {t('diamondShop.viewHistory') || 'Ver histórico e enviar diamantes'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, marginBottom: 10,
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '800' },
  headerLinkBtn: { paddingHorizontal: 8, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerLinkText: { fontSize: 13, fontWeight: '700' },

  hero: {
    borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center',
    marginBottom: 18,
  },
  diamondBig: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: '#A855F7', alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
    shadowColor: '#A855F7', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  diamondGlyph: { color: '#fff', fontSize: 38, fontWeight: '900', lineHeight: 44 },
  heroSubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18, marginBottom: 12 },
  balPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: 'rgba(168,85,247,0.18)',
  },
  balPillLabel: { fontSize: 12, color: '#A855F7', fontWeight: '700' },
  balPillVal: { fontSize: 14, color: '#A855F7', fontWeight: '900' },

  packCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 16, paddingHorizontal: 16,
    borderRadius: 18, borderWidth: 1,
    marginBottom: 12, position: 'relative',
  },
  featuredRibbon: {
    position: 'absolute', top: -10, left: 16,
    backgroundColor: '#A855F7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  featuredRibbonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },

  packLeftCol: { flex: 1, gap: 6 },
  packAmountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  packDiamondGlyph: { color: '#A855F7', fontSize: 22, fontWeight: '900' },
  packDiamonds: { fontSize: 22, fontWeight: '900' },
  bonusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: '#10B981',
  },
  bonusBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  packRightCol: { minWidth: 100, alignItems: 'flex-end' },
  buyBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 },
  buyBtnText: { fontSize: 15, fontWeight: '800' },

  iapHint: { fontSize: 11, marginTop: 8, textAlign: 'center' },
  tosNote: { fontSize: 11, marginTop: 14, textAlign: 'center', lineHeight: 14 },

  historyLink: { marginTop: 18, paddingVertical: 12, alignItems: 'center' },
  historyLinkText: { fontSize: 14, fontWeight: '700' },
});
