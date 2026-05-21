// WalletAddSheet — full-screen "Adicionar saldo" sheet.
//
// WAVE 57 (2026-05-21) — wallet redesign: single-currency "saldo".
// Replaces the old DiamondTopUpSheet popup with a premium, breathing
// pack picker. Each pack shows BRL price as the primary number with
// the credit equivalent as the secondary label. Tap → IAP flow.
//
// Backend stays untouched: same DIAMOND_PACKS ladder + same purchaseDiamonds
// call. We just rename the UI surface from "diamantes" → "saldo" so the
// user doesn't see two currencies. Bonuses (extra coins on bigger packs)
// surface as a green ribbon on the pack card.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
  ScrollView, Platform, Alert, Linking, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconSparkles, IconCreditCard, IconChevronRight } from '../Icons';
import { formatInt } from '../../utils/dateFormat';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, initIAP, isDiamondSkuAvailable,
  purchaseDiamonds,
} from '../../services/iap';
import { getBaseUrl } from '../../services/api';
import * as api from '../../services/api';

const PURPLE      = '#A855F7';
const PURPLE_DEEP = '#7C3AED';
const GREEN       = '#10B981';
const GOLD        = '#F59E0B';

function formatBrl(value) {
  const n = Number(value) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

export default function WalletAddSheet({ visible, onClose, onBalanceChange }) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  const [pendingSku, setPendingSku] = useState(null);
  const [iapReady, setIapReady] = useState(false);
  const [balance, setBalance] = useState(null);

  // Lazy IAP init on first open.
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      initIAP().then(ok => setIapReady(!!ok)).catch(() => setIapReady(false));
    } else {
      setIapReady(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      try {
        const r = await api.walletBalance?.();
        if (alive && r?.success && r.data) {
          const b = Number(r.data.diamond_balance) || 0;
          setBalance(b);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [visible]);

  const packs = useMemo(() => {
    if (Platform.OS === 'web') return DIAMOND_PACKS;
    if (!iapReady) return DIAMOND_PACKS;
    const filtered = DIAMOND_PACKS.filter(p => isDiamondSkuAvailable(p.sku));
    return filtered.length ? filtered : DIAMOND_PACKS;
  }, [iapReady]);

  const onBuy = useCallback(async (pack) => {
    if (pendingSku) return;
    if (Platform.OS === 'web') {
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
          t('wallet.addedTitle') || 'Saldo adicionado',
          (t('wallet.addedBody') || '+{n} de saldo creditado na sua carteira.').replace('{n}', formatInt(r.diamondsAdded ?? pack.diamonds, language)),
        );
        onClose?.();
      } else if (r?.message === 'cancelled') {
        // silent
      } else if (r?.message === 'web_fallback' || r?.message === 'iap_unavailable') {
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
  }, [pendingSku, t, language, onBalanceChange, onClose]);

  const surface = isDark ? '#0B0B0F' : '#F7F7FB';
  const cardBg  = isDark ? '#16161E' : '#FFFFFF';
  const border  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)';
  const subtle  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)';

  // We mark the middle pack as featured (most popular).
  const featuredIdx = Math.floor((packs?.length || 0) / 2);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.scrim]}>
        <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: Math.max(insets.bottom, 18) }]}>
          {/* Drag handle */}
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.18)' }]} />
          </View>

          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: subtle }]}>{t('wallet.addEyebrow') || 'ADICIONAR'}</Text>
              <Text style={[styles.title, { color: colors.text }]}>{t('wallet.addTitle') || 'Recarregar saldo'}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' }]} accessibilityRole="button">
              <IconX size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 12 }}>
            {packs.map((p, i) => {
              const localizedFromStore = getDiamondLocalizedPrice(p.sku);
              const priceLabel = localizedFromStore || formatBrl(p.priceBrl);
              const isLoading  = pendingSku === p.sku;
              const featured   = i === featuredIdx;
              const baseAmt    = Math.round(p.diamonds / (1 + (p.bonusPct || 0) / 100));
              const bonusAmt   = Math.max(0, p.diamonds - baseAmt);
              return (
                <TouchableOpacity
                  key={p.sku}
                  onPress={() => onBuy(p)}
                  disabled={!!pendingSku}
                  activeOpacity={0.88}
                  style={[styles.packCard, {
                    backgroundColor: cardBg,
                    borderColor: featured ? PURPLE : border,
                    borderWidth: featured ? 1.5 : StyleSheet.hairlineWidth,
                    opacity: pendingSku && !isLoading ? 0.5 : 1,
                  }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${priceLabel}`}
                >
                  {featured ? (
                    <View style={styles.popularRibbon}>
                      <IconSparkles size={10} color="#fff" style={{ marginRight: 4 }} />
                      <Text style={styles.popularRibbonText}>
                        {t('wallet.mostPopular') || 'MAIS POPULAR'}
                      </Text>
                    </View>
                  ) : null}

                  <View style={styles.packLeft}>
                    <Text style={[styles.packPrice, { color: colors.text }]} numberOfLines={1}>
                      {priceLabel}
                    </Text>
                    <Text style={[styles.packCredits, { color: subtle }]} numberOfLines={1}>
                      {formatInt(p.diamonds, language)} {t('wallet.creditsWord') || 'créditos'}
                    </Text>
                    {bonusAmt > 0 ? (
                      <View style={[styles.bonusPill, { backgroundColor: GREEN + '22' }]}>
                        <Text style={[styles.bonusPillText, { color: GREEN }]}>
                          {(t('wallet.bonusPlus') || '+{n} bônus').replace('{n}', formatInt(bonusAmt, language))}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.packRight}>
                    {isLoading ? (
                      <ActivityIndicator color={PURPLE} />
                    ) : (
                      <IconChevronRight size={20} color={subtle} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {Platform.OS === 'android' ? (
            <Text style={[styles.hint, { color: subtle }]}>
              {t('wallet.androidComingSoon') || 'Compra in-app no Android em breve.'}
            </Text>
          ) : null}

          <Text style={[styles.tos, { color: subtle }]}>
            {t('wallet.tosShort') || 'Pagamento processado pela App Store / Google Play. Saldo não reembolsável.'}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 18, paddingTop: 8,
    maxHeight: '92%',
  },
  handleRow: { alignItems: 'center', paddingVertical: 6 },
  handle: { width: 38, height: 4, borderRadius: 2 },

  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, paddingTop: 4 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { fontSize: 22, fontWeight: '800', marginTop: 2 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  packCard: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 18, paddingHorizontal: 16,
    borderRadius: 20, marginBottom: 12,
    position: 'relative',
  },
  packLeft: { flex: 1, gap: 4 },
  packRight: { paddingLeft: 8 },
  packPrice: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  packCredits: { fontSize: 13, fontWeight: '500' },
  bonusPill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, marginTop: 4 },
  bonusPillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },

  popularRibbon: {
    position: 'absolute',
    top: -10, right: 14,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: PURPLE,
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 10,
    shadowColor: PURPLE, shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  popularRibbonText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  hint: { fontSize: 11, textAlign: 'center', marginTop: 4 },
  tos:  { fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 15 },
});
