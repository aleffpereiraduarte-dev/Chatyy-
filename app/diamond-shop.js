// /diamond-shop — full-screen diamond purchase store.
//
// Surfaces the same DIAMOND_PACKS ladder as DiamondTopUpSheet but as a
// proper page (deep-linkable, swipe-back, hero card, featured pack glow).
// Reached from:
//   • /wallet "Comprar diamantes" CTA
//   • SendDiamondSheet insufficient-balance state
//   • LivePaidGiftSheet "Comprar mais" link
//   • AppDrawer "Loja de Diamantes" tile

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  Platform, StatusBar, Alert, Linking, Animated, Easing, AppState,
} from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { getBaseUrl } from '../services/api';
import { IconArrowLeft, IconDiamond } from '../components/Icons';
import { formatInt } from '../utils/dateFormat';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, initIAP, purchaseDiamonds,
} from '../services/iap';

function formatBrl(v) {
  const n = Number(v) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

export default function DiamondShopScreen() {
  // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag.
  // Diamond purchases paused; bounce visitors back to /chat. Backend
  // IAP code and DIAMOND_PACKS catalog stay intact so flipping the flag
  // restores the shop instantly.
  if (!DIAMONDS_ENABLED) {
    return <Redirect href="/chat" />;
  }
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  // Featured pack pulse — gentle radial glow scaling 1.0→1.04 every 1.6s.
  // Native driver only animates `transform`; we use opacity loop on the
  // ribbon since it's child of an Animated.View.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1, duration: 800,
          easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0, duration: 800,
          easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);
  const pulseScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] });

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

  // Refresh balance helper — used on mount and on AppState resume
  // (so coming back from the Stripe web checkout reflects the credit).
  const refreshBalance = useCallback(async () => {
    try {
      const r = await api.walletBalance?.();
      if (r?.success && r.data) {
        setBalance(Number(r.data.diamond_balance) || 0);
      }
    } catch {}
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await refreshBalance();
      if (alive) setLoadingBal(false);
    })();
    return () => { alive = false; };
  }, [refreshBalance]);

  // WAVE 43E (2026-05-21) — when the user returns from the Stripe web
  // checkout (in Safari/Chrome), re-poll the wallet so the new balance
  // shows up without needing a manual pull-to-refresh.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshBalance();
    });
    return () => { try { sub.remove(); } catch {} };
  }, [refreshBalance]);

  const openWebCheckout = useCallback((sku) => {
    // chatyy.com.br/comprar-diamantes hosts the Stripe Elements page.
    // iOS App Store 3.1.1 forbids charging digital goods via card
    // INSIDE the app — but a web link is fine. Android tags along on
    // the same flow for now (a native Stripe Payment Sheet integration
    // can ship later — Phase 2 from WAVE 43E plan).
    const base = (typeof getBaseUrl === 'function' && getBaseUrl()) || 'https://chatyy.com.br';
    const url = `${base.replace(/\/$/, '')}/comprar-diamantes${sku ? `?sku=${encodeURIComponent(sku)}` : ''}`;
    try { Linking.openURL(url); } catch {}
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
        // [WAVE 36 2026-05-20] Android: surface web-checkout fallback instead
        // of dead-ending. See DiamondTopUpSheet for matching logic.
        if (Platform.OS === 'android') {
          const base = (typeof getBaseUrl === 'function' ? getBaseUrl() : 'https://chatyy.com.br').replace(/\/$/, '');
          const buyUrl = `${base}/diamantes${pack?.sku ? `?sku=${encodeURIComponent(pack.sku)}` : ''}`;
          Alert.alert(
            t('wallet.topupUnavailableTitle') || 'Compra indisponível',
            t('wallet.androidWebBuyBody') || 'A compra direta no Android chega em breve. Quer abrir a loja no navegador para comprar agora?',
            [
              { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
              { text: t('wallet.openWebStore') || 'Abrir loja web', onPress: () => { try { Linking.openURL(buyUrl); } catch {} } },
            ],
          );
        } else {
          Alert.alert(
            t('wallet.topupUnavailableTitle') || 'Compra indisponível',
            t('wallet.topupUnavailableBody') || 'Não conseguimos iniciar a compra. Tente novamente em alguns minutos.',
          );
        }
      } else if (r?.message === 'sku_not_in_catalog') {
        // [WAVE 39 2026-05-20] BUG 3 — friendly message instead of showing
        // raw "sku_not_in_catalog" string. Diamond SKUs (chatyy_diamond_*) may
        // still be pending approval in App Store Connect / Play Console.
        // TODO: pedir ao founder pra finalizar registro dos SKUs no ASC/Play.
        if (Platform.OS === 'android') {
          // Android: offer web checkout fallback since the SKU isn't live in Play.
          const base = (typeof getBaseUrl === 'function' ? getBaseUrl() : 'https://chatyy.com.br').replace(/\/$/, '');
          const buyUrl = `${base}/diamantes${pack?.sku ? `?sku=${encodeURIComponent(pack.sku)}` : ''}`;
          Alert.alert(
            t('wallet.topupUnavailableTitle') || 'Pacote indisponível',
            t('wallet.androidWebBuyBody') || 'Este pacote ainda não está disponível na Play Store. Quer abrir a loja no navegador para comprar agora?',
            [
              { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
              { text: t('wallet.openWebStore') || 'Abrir loja web', onPress: () => { try { Linking.openURL(buyUrl); } catch {} } },
            ],
          );
        } else {
          Alert.alert(
            t('wallet.topupUnavailableTitle') || 'Pacote indisponível',
            t('wallet.topupSkuPending') || 'Este pacote ainda está em aprovação na App Store. Tente outro pacote por enquanto.',
          );
        }
      } else {
        // [WAVE 39 2026-05-20] Never surface raw internal error codes to the
        // user. Map any other unknown error code to a friendly message.
        const friendly = (typeof r?.message === 'string' && /^[a-z_]+$/.test(r.message))
          ? (t('wallet.topupFailed') || 'Falha na compra. Tente novamente.')
          : (r?.message || t('wallet.topupFailed') || 'Falha na compra.');
        Alert.alert(t('common.error') || 'Erro', friendly);
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
          <View style={styles.diamondBig}>
            <IconDiamond size={44} color="#fff" />
          </View>
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
              <View style={styles.balPillValRow}>
                <IconDiamond size={14} color="#A855F7" />
                <Text style={styles.balPillVal}>{formatInt(balance, language)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* WAVE 43E (2026-05-21) — credit card via web (Stripe).
            Sits between hero and packs so it's discoverable but not
            forced on users who prefer in-app IAP. iOS opens Safari
            (App Review 3.1.1 compliance); Android can do the same
            until native Payment Sheet ships. */}
        <TouchableOpacity
          onPress={() => openWebCheckout(null)}
          style={[styles.ccCta, {
            borderColor: isDark ? 'rgba(168,85,247,0.45)' : 'rgba(168,85,247,0.35)',
            backgroundColor: isDark ? 'rgba(168,85,247,0.10)' : 'rgba(168,85,247,0.06)',
          }]}
          accessibilityRole="button"
          accessibilityLabel={t('diamondShop.payWithCard') || 'Comprar com cartão de crédito'}
        >
          <View style={styles.ccCtaIcon}>
            <Text style={styles.ccCtaIconText}>💳</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.ccCtaTitle, { color: colors.text }]}>
              {t('diamondShop.payWithCard') || 'Comprar com cartão de crédito'}
            </Text>
            <Text style={[styles.ccCtaSub, { color: colors.textSecondary }]}>
              {t('diamondShop.payWithCardSub') || 'Pagamento seguro via web. Cartão fica salvo para próximas compras.'}
            </Text>
          </View>
          <Text style={{ color: '#A855F7', fontSize: 22, fontWeight: '700' }}>›</Text>
        </TouchableOpacity>

        {/* Packs */}
        {packs.map(p => {
          const localized = getDiamondLocalizedPrice(p.sku);
          const priceLabel = localized || formatBrl(p.priceBrl);
          const isLoading = pendingSku === p.sku;
          const featured = p.sku === featuredSku;
          const bonusBadge = p.bonusPct > 0
            ? (t('wallet.topupBonus') || 'Bônus +{p}%').replace('{p}', p.bonusPct)
            : null;
          const PackWrapper = featured ? Animated.createAnimatedComponent(TouchableOpacity) : TouchableOpacity;
          return (
            <PackWrapper
              key={p.sku}
              onPress={() => onBuy(p)}
              disabled={!!pendingSku}
              activeOpacity={0.85}
              style={[
                styles.packCard,
                featured ? { transform: [{ scale: pulseScale }] } : null,
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
                    {(t('diamondShop.featuredPulse') || t('diamondShop.bestValue') || 'MELHOR OFERTA').toUpperCase()}
                  </Text>
                </View>
              ) : null}

              <View style={styles.packLeftCol}>
                <View style={styles.packAmountRow}>
                  <IconDiamond size={22} color="#A855F7" />
                  <Text style={[styles.packDiamonds, { color: colors.text }]}>
                    {formatInt(p.diamonds, language)}
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
            </PackWrapper>
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
  balPillValRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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

  // WAVE 43E (2026-05-21) — credit card CTA card.
  ccCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 14, borderWidth: 1.5,
    marginBottom: 16,
  },
  ccCtaIcon: {
    width: 42, height: 42, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(168,85,247,0.20)',
  },
  ccCtaIconText: { fontSize: 22 },
  ccCtaTitle: { fontSize: 15, fontWeight: '700' },
  ccCtaSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
});
