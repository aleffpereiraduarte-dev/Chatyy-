// DiamondTopUpSheet — bottom sheet that lets the user buy diamond packs
// via real StoreKit IAP. Used from Live, Feed, Reels, and the creator
// dashboard. Pure JS UI — the heavy lifting (initConnection, request,
// listener, receipt verify) lives in services/iap.js.
//
// Pricing ladder (2026-05-18 — must match server + ASC SKUs):
//   chatyy_diamond_100    R$  4,99 →    100 ◆
//   chatyy_diamond_500    R$ 19,99 →    550 ◆  (+10 % bonus)
//   chatyy_diamond_1500   R$ 49,99 →  1 700 ◆  (+13 %)
//   chatyy_diamond_5000   R$149,99 →  6 000 ◆  (+20 %)
//   chatyy_diamond_15000  R$399,99 → 19 500 ◆  (+30 %)
//
// Apple expects these registered as Consumable products in App Store Connect.
// Google Play needs the same SKU IDs as Managed/Consumable products. Until
// the SKUs propagate (24-48h post-create), purchases will fail with
// USER_CANCELLED / product_not_found; the sheet shows a friendly hint.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
  ScrollView, Platform, Alert,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconX, IconDiamond } from './Icons';
import { formatInt } from '../utils/dateFormat';
import { Linking } from 'react-native';
import * as api from '../services/api';
import { getBaseUrl } from '../services/api';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, initIAP, isDiamondSkuAvailable,
  purchaseDiamonds,
} from '../services/iap';

function formatBrl(value) {
  const n = Number(value) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

export default function DiamondTopUpSheet({ visible, onClose, onBalanceChange }) {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  const [balance, setBalance] = useState(0);
  const [loadingBal, setLoadingBal] = useState(false);
  const [pendingSku, setPendingSku] = useState(null);
  const [iapReady, setIapReady] = useState(false);

  // Lazy IAP init: fires on first open, not on app boot, so the
  // StoreKit/Play Billing observer doesn't grab cycles before the user
  // has any intent. 2026-05-19 — Android Play Billing wired via the
  // same expo-iap surface as iOS (#1203). Web still bails.
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      initIAP().then(ok => setIapReady(!!ok)).catch(() => setIapReady(false));
    } else {
      setIapReady(false);
    }
  }, [visible]);

  // Refresh balance whenever the sheet opens — server is source of truth.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoadingBal(true);
    (async () => {
      try {
        const r = await api.walletBalance?.();
        if (alive && r?.success && r.data) {
          const b = Number(r.data.diamond_balance) || 0;
          setBalance(b);
          onBalanceChange?.(b);
        }
      } catch {}
      if (alive) setLoadingBal(false);
    })();
    return () => { alive = false; };
  }, [visible, onBalanceChange]);

  // Filter packs to what the billing client actually returned. If a SKU
  // was never registered in App Store Connect / Play Console (or is still
  // propagating after a create), `requestPurchase` throws "SKU not found"
  // — we'd rather hide the tile than render a button that always errors.
  // `iapReady` triggers the re-eval once fetchProducts resolves. Web
  // keeps every pack visible (clicking deep-links to web checkout).
  const packs = useMemo(() => {
    if (Platform.OS === 'web') return DIAMOND_PACKS;
    if (!iapReady) return DIAMOND_PACKS; // show grid while loading; rows just disabled
    const filtered = DIAMOND_PACKS.filter(p => isDiamondSkuAvailable(p.sku));
    return filtered.length ? filtered : DIAMOND_PACKS;
  }, [iapReady]);

  const onBuy = useCallback(async (pack) => {
    if (pendingSku) return;
    if (Platform.OS === 'web') {
      // Web has no billing client; deep-link to web checkout. Same backend
      // wallet_topup_verify lands the balance.
      const base = (typeof getBaseUrl === 'function' && getBaseUrl()) || 'https://chatyy.com.br';
      const webUrl = `${base}/#/diamond-shop?sku=${encodeURIComponent(pack.sku)}`;
      try { Linking.openURL(webUrl); } catch {}
      return;
    }
    setPendingSku(pack.sku);
    try {
      const r = await purchaseDiamonds(pack.sku);
      if (r?.success) {
        if (typeof r.diamondBalance === 'number') {
          setBalance(r.diamondBalance);
          onBalanceChange?.(r.diamondBalance);
        }
        Alert.alert(
          t('wallet.topupSuccessTitle') || 'Diamantes creditados',
          (t('wallet.topupSuccessBody') || 'Você ganhou {d} diamantes.').replace('{d}', r.diamondsAdded ?? pack.diamonds),
        );
      } else if (r?.message === 'cancelled') {
        // User dismissed StoreKit — silent.
      } else if (r?.message === 'web_fallback' || r?.message === 'iap_unavailable') {
        // [WAVE 36 2026-05-20] On Android — IAP is still rolling out via Play
        // Billing. Instead of dead-ending the user with "try again later", offer
        // a deeplink to chatyy.com.br/diamantes where Stripe handles checkout.
        // iOS doesn't get this branch — App Store policy bans steering off-platform.
        if (Platform.OS === 'android') {
          const buyUrl = `${(typeof getBaseUrl === 'function' ? getBaseUrl() : 'https://chatyy.com.br').replace(/\/$/, '')}/diamantes${pack?.sku ? `?sku=${encodeURIComponent(pack.sku)}` : ''}`;
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
        // SKU exists in our ladder but App Store Connect hasn't activated it
        // (or it's still propagating). Show a friendly note instead of the raw
        // "SKU not found" error that StoreKit would have thrown.
        Alert.alert(
          t('wallet.topupUnavailableTitle') || 'Pacote indisponível',
          t('wallet.topupSkuPending') || 'Este pacote ainda está em aprovação na App Store. Tente outro pacote por enquanto.',
        );
      } else {
        Alert.alert(
          t('common.error') || 'Erro',
          r?.message || t('wallet.topupFailed') || 'Falha na compra. Tente novamente.',
        );
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Falha na compra');
    } finally {
      setPendingSku(null);
    }
  }, [pendingSku, t, onBalanceChange]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('wallet.topup') || 'Comprar diamantes'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
              <IconX size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.balanceRow}>
            <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
              {t('wallet.currentBalance') || 'Saldo atual'}:
            </Text>
            {loadingBal ? (
              <ActivityIndicator size="small" color="#A855F7" />
            ) : (
              <View style={styles.balValRow}>
                <IconDiamond size={14} color="#A855F7" />
                <Text style={[styles.balanceVal, { color: colors.text }]}>{formatInt(balance, language)}</Text>
              </View>
            )}
          </View>

          <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ paddingBottom: 8 }}>
            {packs.map(p => {
              const localizedFromStore = getDiamondLocalizedPrice(p.sku);
              const priceLabel = localizedFromStore || formatBrl(p.priceBrl);
              const isLoading = pendingSku === p.sku;
              const bonusBadge = p.bonusPct > 0
                ? (t('wallet.topupBonus') || 'Bônus +{p}%').replace('{p}', p.bonusPct)
                : null;
              return (
                <TouchableOpacity
                  key={p.sku}
                  onPress={() => onBuy(p)}
                  disabled={!!pendingSku}
                  style={[styles.packRow, { borderColor: isDark ? 'rgba(168,85,247,0.25)' : 'rgba(168,85,247,0.18)', backgroundColor: isDark ? 'rgba(168,85,247,0.08)' : 'rgba(168,85,247,0.04)', opacity: pendingSku && !isLoading ? 0.5 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${p.diamonds} ${t('wallet.diamondsLabel') || 'diamantes'} ${priceLabel}`}
                >
                  <View style={styles.packLeft}>
                    <IconDiamond size={18} color="#A855F7" />
                    <Text style={[styles.packDiamonds, { color: colors.text }]}>
                      {formatInt(p.diamonds, language)}
                    </Text>
                    {bonusBadge ? (
                      <View style={styles.bonusBadge}>
                        <Text style={styles.bonusBadgeText}>{bonusBadge}</Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.packRight}>
                    {isLoading ? (
                      <ActivityIndicator color="#A855F7" />
                    ) : (
                      <Text style={[styles.packPrice, { color: colors.text }]}>{priceLabel}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {!iapReady && (Platform.OS === 'ios' || Platform.OS === 'android') ? (
            <Text style={[styles.iapHint, { color: colors.textTertiary }]}>
              {Platform.OS === 'ios'
                ? (t('wallet.topupConnecting') || 'Conectando à App Store…')
                : (t('wallet.topupConnectingAndroid') || 'Conectando ao Google Play…')}
            </Text>
          ) : null}

          <Text style={[styles.tosNote, { color: colors.textTertiary }]}>
            {t('wallet.topupTos') || 'Diamantes não são reembolsáveis e não podem ser convertidos em dinheiro.'}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30,
    minHeight: 420,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 17, fontWeight: '700' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  balanceLabel: { fontSize: 13 },
  balValRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  balanceVal: { fontSize: 16, fontWeight: '800' },
  packRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  packLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  packRight: { minWidth: 90, alignItems: 'flex-end' },
  packDiamonds: { fontSize: 17, fontWeight: '800' },
  packPrice: { fontSize: 16, fontWeight: '700' },
  bonusBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: '#10B981',
  },
  bonusBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  iapHint: { fontSize: 11, marginTop: 6, textAlign: 'center' },
  tosNote: { fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 14 },
});
