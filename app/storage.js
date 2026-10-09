// /storage — WAVE 75 (2026-05-21) cloud storage management screen.
//
// Shows the user's current storage usage as a progress bar, breaks it
// down by source (photos/videos/files/email), surfaces the active paid
// tier (or "Free 50GB"), and routes to StorageShopSheet when the user
// wants to upgrade. Reached from:
//   • Settings → Storage tile
//   • Sidebar Quick Access
//   • In-product upgrade CTAs (chat upload 507, drive header banner)
//   • Storage-full toasts in chat-conversation / drive

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform, Alert, Linking,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton, nativeScrollInsetProps, IOS_NATIVE_INSET } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconCloud, IconDatabase, IconRefresh } from '../components/Icons';
import StorageShopSheet from '../components/StorageShopSheet';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableScale from '../components/PressableScale';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { MONETIZATION_ENABLED } from '../constants/featureFlags';
// [2026-10-09 plans-consistency] plano/cota = fonte única (services/planState).
import { loadPlanState, planDisplayName, formatQuotaBytes } from '../services/planState';

function formatBytes(b) {
  const v = Number(b) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}


export default function StorageScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [usage, setUsage] = useState(null);
  const [planState, setPlanState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showShop, setShowShop] = useState(false);

  const load = useCallback(async () => {
    try {
      const st = await loadPlanState({ force: true });
      if (st) {
        setPlanState(st);
        if (st.usage) setUsage(st.usage);
      }
    } catch (e) {
      if (__DEV__) console.warn('[storage] load failed:', e?.message);
    }
  }, []);

  useEffect(() => {
    (async () => { await load(); setLoading(false); })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const pct = useMemo(() => {
    if (!usage?.limit_bytes) return 0;
    return Math.min(100, Math.max(0, (usage.used_bytes / usage.limit_bytes) * 100));
  }, [usage]);

  const barColor = useMemo(() => {
    if (pct >= 95) return '#ef4444';
    if (pct >= 80) return '#f59e0b';
    return colors.tint || '#0a84ff';
  }, [pct, colors]);

  const isPaid = !!planState?.isPaid;
  const usedLabel = formatBytes(usage?.used_bytes || 0);
  const limitBytes = planState?.limitBytes || usage?.limit_bytes || 0;
  const limitLabel = limitBytes ? formatQuotaBytes(limitBytes) : '—';
  const planLabel = planDisplayName(planState?.planId || 'free', t);
  const cycleLabel = !isPaid ? t('storage.billing.free')
    : (planState?.billingPeriod === 'annual' ? t('storage.billing.annual') : t('storage.billing.monthly'));

  const renewsLabel = useMemo(() => {
    if (!usage?.active_until) return null;
    const d = new Date(usage.active_until * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }, [usage?.active_until]);

  const onManage = useCallback(() => {
    // iOS: deep-link to App Store subs management.
    // Android: deep-link to Play Store subs.
    if (Platform.OS === 'ios') {
      Linking.openURL('https://apps.apple.com/account/subscriptions').catch(() => {});
    } else if (Platform.OS === 'android') {
      Linking.openURL('https://play.google.com/store/account/subscriptions').catch(() => {});
    } else {
      Alert.alert(t('storage.manageWebTitle') || 'Gerenciar', t('storage.manageWebBody') || 'Abra a App Store ou a Play Store no celular para gerenciar a assinatura.');
    }
  }, [t]);

  const onShopOpen = useCallback(() => setShowShop(true), []);
  const onShopClose = useCallback(() => { setShowShop(false); load(); }, [load]);

  const overGrace = usage?.grace_active;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : (insets.top || 0) + 6 }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: t('storage.title'),
          largeTitle: true,
          headerRight: () => (
            <HeaderIconButton onPress={onRefresh} accessibilityLabel={t('common.refresh')}>
              <IconRefresh size={20} color={colors.text} />
            </HeaderIconButton>
          ),
        })} />
      ) : (
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <IconArrowLeft size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {t('storage.title') || 'Armazenamento'}
        </Text>
        <TouchableOpacity onPress={onRefresh} hitSlop={12}>
          <IconRefresh size={22} color={colors.muted} />
        </TouchableOpacity>
      </View>
      )}

      <FadeSlideIn>
      <ScrollView
        {...nativeScrollInsetProps()}
        contentContainerStyle={{ paddingBottom: IOS_NATIVE_INSET ? 24 : (insets.bottom || 0) + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.tint} />}
      >
        {loading ? (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator color={colors.tint} />
          </View>
        ) : (
          <>
            {/* Usage card */}
            <View style={[styles.card, { backgroundColor: colors.cardBackground || colors.surface || '#fff' }]}>
              <View style={styles.cardHead}>
                <IconCloud size={28} color={colors.tint || '#0a84ff'} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>
                    {t('storage.usedOf') || 'Usado'} {usedLabel} / {limitLabel}
                  </Text>
                  <Text style={[styles.cardSubtitle, { color: colors.muted }]}>
                    {pct.toFixed(1)}% · {planLabel} · {cycleLabel}
                  </Text>
                </View>
              </View>

              <View style={[styles.barWrap, { backgroundColor: isDark ? '#1c1c1e' : '#f1f5f9' }]}>
                <View style={[styles.bar, { width: `${pct}%`, backgroundColor: barColor }]} />
              </View>

              {/* Breakdown */}
              <View style={styles.breakdown}>
                {(['drive','email','chat','feed']).map((k) => {
                  const v = usage?.breakdown?.[k] || 0;
                  const labelMap = {
                    drive: t('storage.breakdown.files') || 'Arquivos',
                    email: t('storage.breakdown.email') || 'Email',
                    chat:  t('storage.breakdown.chat')  || 'Chat',
                    feed:  t('storage.breakdown.feed')  || 'Feed',
                  };
                  return (
                    <View key={k} style={styles.breakdownRow}>
                      <Text style={[styles.breakdownLabel, { color: colors.muted }]}>{labelMap[k]}</Text>
                      <Text style={[styles.breakdownValue, { color: colors.text }]}>{formatBytes(v)}</Text>
                    </View>
                  );
                })}
              </View>

              {/* [2026-10-09 plan-expiry] plano vencido: carência (3d) ou já em Grátis */}
              {!!planState?.expiryNotice && (
                <TouchableOpacity
                  onPress={() => router.push('/plans')}
                  style={[styles.warnBanner, { backgroundColor: isDark ? 'rgba(245,158,11,0.10)' : '#fffbeb', borderColor: isDark ? 'rgba(245,158,11,0.35)' : '#fcd34d' }]}
                >
                  <Text style={[styles.warnBody, { color: isDark ? '#fcd34d' : '#92400e' }]}>
                    {planState.expiryNotice.kind === 'grace'
                      ? t('planExpiry.grace', { date: planState.expiryNotice.date })
                      : t('planExpiry.expired')}
                  </Text>
                </TouchableOpacity>
              )}

              {overGrace && (
                <View style={[styles.warnBanner, { backgroundColor: '#fef3c7', borderColor: '#fcd34d' }]}>
                  <Text style={[styles.warnTitle, { color: '#92400e' }]}>
                    {t('storage.graceTitle') || 'Acima do limite gratuito'}
                  </Text>
                  <Text style={[styles.warnBody, { color: '#92400e' }]}>
                    {t('storage.graceBodyAmount', { n: limitLabel })}
                  </Text>
                </View>
              )}
            </View>

            {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
                "Aumentar armazenamento" / "Gerenciar assinatura" / "Mudar plano"
                CTAs + "Cancele quando quiser" disclaimer all hidden. Free 50GB
                stays visible above. */}
            {MONETIZATION_ENABLED && isPaid && (
              <View style={[styles.tierCard, { backgroundColor: colors.cardBackground || colors.surface || '#fff' }]}>
                <Text style={[styles.tierName, { color: colors.text }]}>
                  {planLabel} · {limitLabel} · {cycleLabel}
                </Text>
                {renewsLabel && (
                  <Text style={[styles.tierMeta, { color: colors.muted }]}>
                    {t('storage.renewsOn') || 'Renova em'} {renewsLabel}
                  </Text>
                )}
                <TouchableOpacity onPress={onManage} style={[styles.manageBtn, { borderColor: colors.tint }]}>
                  <Text style={[styles.manageBtnText, { color: colors.tint }]}>
                    {t('storage.manage') || 'Gerenciar assinatura'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {MONETIZATION_ENABLED && !isPaid && (
              <View style={[styles.promo, { backgroundColor: pct >= 80 ? (pct >= 95 ? '#fee2e2' : '#fef3c7') : (isDark ? '#0b2540' : '#f0f7ff') }]}>
                <Text style={[styles.promoTitle, { color: pct >= 80 ? (pct >= 95 ? '#991b1b' : '#92400e') : colors.text }]}>
                  {pct >= 80
                    ? (t('storage.promo.lowTitle') || 'Seu espaço está acabando')
                    : (t('storage.promo.title') || 'Mais espaço, mais tranquilidade')}
                </Text>
                <Text style={[styles.promoBody, { color: pct >= 80 ? (pct >= 95 ? '#991b1b' : '#92400e') : colors.muted }]}>
                  {t('storage.promo.body') || 'Backup automático, fotos e vídeos em qualidade original e espaço para compartilhar com a família. A partir de R$ 5,99/mês.'}
                </Text>
              </View>
            )}

            {MONETIZATION_ENABLED && (
              <PressableScale
                onPress={onShopOpen}
                style={[styles.upgradeBtn, { backgroundColor: colors.tint || '#0a84ff' }]}
                activeOpacity={0.85}
              >
                <IconDatabase size={20} color="#fff" />
                <Text style={styles.upgradeBtnText}>
                  {isPaid
                    ? (t('storage.changeTier') || 'Mudar plano')
                    : (t('storage.upgrade') || 'Aumentar armazenamento')}
                </Text>
              </PressableScale>
            )}

            <TouchableOpacity
              onPress={() => router.push('/files')}
              style={[styles.secondaryBtn, { borderColor: colors.border || '#e5e7eb' }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                {t('storage.freeSpace') || 'Liberar espaço'}
              </Text>
            </TouchableOpacity>

            {MONETIZATION_ENABLED && (
              <Text style={[styles.helpText, { color: colors.muted }]}>
                {t('storage.cancelAnytime') || 'Cancele quando quiser. Assinatura renova automaticamente.'}
              </Text>
            )}
          </>
        )}
      </ScrollView>
      </FadeSlideIn>

      {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag */}
      {MONETIZATION_ENABLED && (
        <StorageShopSheet
          visible={showShop}
          onClose={onShopClose}
          currentTier={usage?.tier || 'free'}
          usedBytes={usage?.used_bytes}
          limitBytes={usage?.limit_bytes}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700' },
  card: {
    marginHorizontal: 14, marginTop: 6, padding: 16,
    borderRadius: 16,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardSubtitle: { fontSize: 13, marginTop: 2 },
  barWrap: { height: 10, borderRadius: 6, marginTop: 14, overflow: 'hidden' },
  bar: { height: '100%', borderRadius: 6 },
  breakdown: { marginTop: 14, gap: 6 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between' },
  breakdownLabel: { fontSize: 13 },
  breakdownValue: { fontSize: 13, fontWeight: '600' },
  warnBanner: {
    marginTop: 14, padding: 12,
    borderRadius: 10, borderWidth: 1,
  },
  warnTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  warnBody: { fontSize: 13, lineHeight: 18 },
  tierCard: {
    marginHorizontal: 14, marginTop: 12, padding: 14,
    borderRadius: 14,
  },
  tierName: { fontSize: 16, fontWeight: '700' },
  tierMeta: { fontSize: 13, marginTop: 4 },
  manageBtn: {
    marginTop: 12, paddingVertical: 10, paddingHorizontal: 14,
    borderWidth: 1, borderRadius: 10, alignSelf: 'flex-start',
  },
  manageBtnText: { fontSize: 14, fontWeight: '600' },
  promo: { marginHorizontal: 14, marginTop: 12, padding: 14, borderRadius: 14 },
  promoTitle: { fontSize: 15, fontWeight: '800' },
  promoBody: { fontSize: 13, lineHeight: 19, marginTop: 4 },
  upgradeBtn: {
    marginHorizontal: 14, marginTop: 14, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: 12,
  },
  upgradeBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryBtn: {
    marginHorizontal: 14, marginTop: 10, paddingVertical: 12,
    borderWidth: 1, borderRadius: 12, alignItems: 'center',
  },
  secondaryBtnText: { fontSize: 15, fontWeight: '600' },
  helpText: {
    marginTop: 14, marginHorizontal: 18, fontSize: 12,
    textAlign: 'center', lineHeight: 18,
  },
});
