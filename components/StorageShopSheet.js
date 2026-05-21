// StorageShopSheet — WAVE 75 (2026-05-21) cloud-storage upgrade modal.
//
// Pops over /storage (and the chat-conversation 507 toast) with a 4-tier
// grid (100GB / 500GB / 1TB / 5TB). User toggles Monthly/Annual at the
// top; the price labels and SKU resolved by services/iap.purchaseStorage()
// match. Web users get a Linking.openURL to chatyy.com.br/storage (Stripe
// will eventually land there, mirroring /comprar-diamantes).

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Platform,
  ActivityIndicator, ScrollView, Alert, Linking,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { STORAGE_TIERS, purchaseStorage, getStorageLocalizedPrice } from '../services/iap';
import { getBaseUrl } from '../services/api';
import { IconX, IconCloud } from './Icons';

function formatBrl(v) {
  const n = Number(v) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

const TIER_BADGES = {
  '100gb': null,
  '500gb': 'Popular',
  '1tb': 'Recomendado',
  '5tb': 'Pro',
};

export default function StorageShopSheet({ visible, onClose, currentTier = 'free' }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [cycle, setCycle] = useState('monthly'); // monthly|annual
  const [pendingTier, setPendingTier] = useState(null);

  const onBuy = useCallback(async (tier) => {
    if (pendingTier) return;
    if (Platform.OS === 'web') {
      const base = (typeof getBaseUrl === 'function' && getBaseUrl()) || 'https://chatyy.com.br';
      Linking.openURL(`${base.replace(/\/$/, '')}/storage?tier=${tier.id}&cycle=${cycle}`).catch(() => {});
      return;
    }
    setPendingTier(tier.id);
    try {
      const r = await purchaseStorage(tier.id, cycle);
      if (r?.success) {
        Alert.alert(
          t('storage.upgradedTitle') || 'Plano ativado',
          (t('storage.upgradedBody') || 'Seu armazenamento agora é {tier}.').replace('{tier}', tier.gb >= 1024 ? `${tier.gb/1024}TB` : `${tier.gb}GB`),
          [{ text: 'OK', onPress: onClose }],
        );
      } else if (r?.message === 'cancelled') {
        // silent
      } else if (r?.message === 'web_fallback' || r?.message === 'iap_unavailable') {
        if (Platform.OS === 'android') {
          const base = (typeof getBaseUrl === 'function' ? getBaseUrl() : 'https://chatyy.com.br').replace(/\/$/, '');
          Alert.alert(
            t('storage.unavailableTitle') || 'Indisponível',
            t('storage.androidWebBuyBody') || 'A compra direta no Android chega em breve. Quer abrir no navegador?',
            [
              { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
              { text: t('storage.openWeb') || 'Abrir loja web', onPress: () => Linking.openURL(`${base}/storage?tier=${tier.id}&cycle=${cycle}`).catch(() => {}) },
            ],
          );
        } else {
          Alert.alert(t('storage.unavailableTitle') || 'Indisponível', t('storage.tryLater') || 'Não foi possível iniciar a compra. Tente novamente em alguns minutos.');
        }
      } else if (r?.message === 'sku_not_in_catalog') {
        Alert.alert(
          t('storage.skuPendingTitle') || 'Plano em aprovação',
          t('storage.skuPendingBody') || 'Esta opção ainda está sendo finalizada na loja. Tente outro tamanho ou volte em alguns dias.',
        );
      } else {
        const friendly = (typeof r?.message === 'string' && /^[a-z_]+$/.test(r.message))
          ? (t('storage.upgradeFailed') || 'Falha na compra. Tente novamente.')
          : (r?.message || t('storage.upgradeFailed') || 'Falha na compra.');
        Alert.alert(t('common.error') || 'Erro', friendly);
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Falha na compra');
    } finally {
      setPendingTier(null);
    }
  }, [pendingTier, cycle, t, onClose]);

  const tiers = useMemo(() => STORAGE_TIERS, []);

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          {/* Header */}
          <View style={styles.head}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 }}>
              <IconCloud size={22} color={colors.tint || '#0a84ff'} />
              <Text style={[styles.title, { color: colors.text }]}>
                {t('storage.shopTitle') || 'Mais armazenamento'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <IconX size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>

          {/* Cycle toggle */}
          <View style={[styles.toggleWrap, { backgroundColor: isDark ? '#1f2937' : '#f1f5f9' }]}>
            {(['monthly','annual']).map((c) => {
              const active = cycle === c;
              return (
                <TouchableOpacity
                  key={c}
                  onPress={() => setCycle(c)}
                  style={[styles.toggleBtn, active && { backgroundColor: colors.tint || '#0a84ff' }]}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.toggleText, { color: active ? '#fff' : colors.text }]}>
                    {c === 'monthly' ? (t('storage.cycle.monthly') || 'Mensal') : (t('storage.cycle.annual') || 'Anual')}
                  </Text>
                  {c === 'annual' && (
                    <Text style={[styles.toggleBadge, { color: active ? '#fff' : '#16a34a' }]}>
                      {t('storage.saveTag') || '· 17% off'}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <ScrollView
            style={{ maxHeight: 480 }}
            contentContainerStyle={{ paddingBottom: 16 }}
            showsVerticalScrollIndicator={false}
          >
            {tiers.map((tier) => {
              const isCurrent = currentTier === tier.id;
              const sku = Platform.OS === 'ios'
                ? (cycle === 'annual' ? tier.skuAnnualApple : tier.skuMonthlyApple)
                : (cycle === 'annual' ? tier.skuAnnualGoogle : tier.skuMonthlyGoogle);
              const localized = getStorageLocalizedPrice(sku);
              const price = localized || formatBrl(cycle === 'annual' ? tier.priceAnnual : tier.priceMonthly);
              const badge = TIER_BADGES[tier.id];
              const pending = pendingTier === tier.id;

              return (
                <TouchableOpacity
                  key={tier.id}
                  onPress={() => !isCurrent && onBuy(tier)}
                  activeOpacity={isCurrent ? 1 : 0.85}
                  disabled={pending || isCurrent}
                  style={[
                    styles.tierCard,
                    { borderColor: isCurrent ? (colors.tint || '#0a84ff') : (colors.border || '#e5e7eb'),
                      backgroundColor: colors.cardBackground || colors.surface || '#fff',
                      opacity: pending ? 0.6 : 1 },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.tierTitleRow}>
                      <Text style={[styles.tierName, { color: colors.text }]}>
                        {tier.gb >= 1024 ? `${tier.gb/1024}TB` : `${tier.gb}GB`}
                      </Text>
                      {badge && (
                        <View style={[styles.badge, { backgroundColor: colors.tint || '#0a84ff' }]}>
                          <Text style={styles.badgeText}>{badge}</Text>
                        </View>
                      )}
                      {isCurrent && (
                        <View style={[styles.badge, { backgroundColor: '#16a34a' }]}>
                          <Text style={styles.badgeText}>{t('storage.current') || 'Atual'}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.tierMeta, { color: colors.muted }]}>
                      {cycle === 'annual'
                        ? `${price} / ${t('storage.perYear') || 'ano'}`
                        : `${price} / ${t('storage.perMonth') || 'mês'}`}
                    </Text>
                  </View>
                  {pending ? (
                    <ActivityIndicator color={colors.tint} />
                  ) : !isCurrent ? (
                    <View style={[styles.buyBtn, { backgroundColor: colors.tint || '#0a84ff' }]}>
                      <Text style={styles.buyBtnText}>{t('storage.choose') || 'Escolher'}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <Text style={[styles.foot, { color: colors.muted }]}>
            {t('storage.cancelAnytime') || 'Cancele quando quiser. Assinatura renova automaticamente.'}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', paddingBottom: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  toggleWrap: {
    flexDirection: 'row', borderRadius: 10, padding: 3, marginBottom: 12,
  },
  toggleBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  toggleText: { fontSize: 14, fontWeight: '600' },
  toggleBadge: { fontSize: 12, fontWeight: '600' },
  tierCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, marginBottom: 8,
    borderRadius: 14, borderWidth: 1.5,
  },
  tierTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tierName: { fontSize: 18, fontWeight: '700' },
  tierMeta: { fontSize: 13, marginTop: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  buyBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  buyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  foot: { fontSize: 12, textAlign: 'center', marginTop: 8 },
});
