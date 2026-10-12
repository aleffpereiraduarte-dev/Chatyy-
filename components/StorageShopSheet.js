// StorageShopSheet — WAVE 75 (2026-05-21) cloud-storage upgrade modal.
//
// Pops over /storage (and the chat-conversation 507 toast) with a 4-tier
// grid (100GB / 500GB / 1TB / 5TB). User toggles Monthly/Annual at the
// top; the price labels and SKU resolved by services/iap.purchaseStorage()
// match. Web users get a Linking.openURL to chatyy.com.br/storage (Stripe
// will eventually land there, mirroring /comprar-diamantes).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Platform,
  ActivityIndicator, ScrollView, Alert, Linking, useWindowDimensions,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { STORAGE_TIERS, purchaseStorage, getStorageLocalizedPrice } from '../services/iap';
import { getOriginBase, storageUsage } from '../services/api'; // [2026-10-10] loja web = host canônico
import { startStripeCheckout, openStripePortal, isStripeCardAvailable, isStripeStorageCheckoutAvailable } from '../services/stripeCheckout';
import { IconX, IconCloud, IconCheck, IconCheckCircle, IconUsers, IconImage, IconShield, IconZap } from './Icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function formatBrl(v) {
  const n = Number(v) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

const RECOMMENDED_TIER = '1tb';
const FREE_GB_FALLBACK = 20;
const AMBER = '#f59e0b';
const RED = '#ef4444';
const GREEN = '#16a34a';

function gbLabel(gb) {
  return gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`;
}
function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2).replace('.', ',') + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(v / 1024) + ' KB';
}

// [2026-10-09 native-sheets] native=false quando o dono é um <Modal> RN (ProfileSettingsSheet):
// apresentar o formSheet por cima faria o react-native-screens fechar o Modal.
export default function StorageShopSheet({ visible, onClose, currentTier = 'free', usedBytes, limitBytes, native = true }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { height: winH, width: winW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [cycle, setCycle] = useState('annual'); // monthly|annual (anual = default vendedor)
  const [pendingTier, setPendingTier] = useState(null);
  const [selectedId, setSelectedId] = useState(currentTier === RECOMMENDED_TIER ? '5tb' : RECOMMENDED_TIER);
  const [usage, setUsage] = useState(null);

  // Barra de uso: usa props se vierem; senao busca (mesmo endpoint de /storage).
  useEffect(() => {
    if (!visible || usedBytes != null) return;
    let alive = true;
    (async () => {
      try {
        const r = await storageUsage();
        if (alive && r?.success && r.data) setUsage(r.data);
      } catch (e) { /* silencioso: barra some */ }
    })();
    return () => { alive = false; };
  }, [visible, usedBytes]);
  const used = usedBytes != null ? Number(usedBytes) : Number(usage?.used_bytes);
  const limit = (limitBytes != null ? Number(limitBytes) : Number(usage?.limit_bytes)) || FREE_GB_FALLBACK * 1024 ** 3;
  const hasUsage = Number.isFinite(used);
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const nearFull = pct >= 80;
  const barColor = pct >= 95 ? RED : pct >= 80 ? AMBER : colors.text;

  const onBuy = useCallback(async (tier) => {
    if (pendingTier) return;
    if (Platform.OS === 'web') {
      const base = (typeof getOriginBase === 'function' && getOriginBase()) || 'https://chatyy.com.br';
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
          const base = (typeof getOriginBase === 'function' ? getOriginBase() : 'https://chatyy.com.br').replace(/\/$/, '');
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

  // Cartao via Stripe hospedado: SO Android/web (iOS = IAP, regra da Apple).
  const onPayCard = useCallback(async (tier) => {
    if (pendingTier) return;
    setPendingTier(tier.id);
    try {
      const r = await startStripeCheckout(tier.id, cycle);
      if (!r?.success) {
        Alert.alert(t('common.error') || 'Erro', t('storage.cardFailed') || 'Não foi possível abrir o pagamento com cartão. Tente novamente em instantes.');
      }
    } finally {
      setPendingTier(null);
    }
  }, [pendingTier, cycle, t]);

  const onManageCard = useCallback(async () => {
    const r = await openStripePortal();
    if (!r?.success) {
      Alert.alert(t('common.error') || 'Erro', t('storage.portalFailed') || 'Nenhuma assinatura com cartão encontrada.');
    }
  }, [t]);

  const showCard = isStripeStorageCheckoutAvailable();
  const showPortal = isStripeCardAvailable();

  const tiers = useMemo(() => STORAGE_TIERS, []);
  // [2026-10-12] Repaginado P&B premium: destaque = cor do texto; sobre ele, cor do fundo.
  const tint = colors.text;
  const onTint = colors.background;
  const line = colors.border || (isDark ? '#2c2c2e' : '#e5e5ea');
  const cardBg = colors.cardBackground || colors.surface || (isDark ? '#0b0b0b' : '#fff');
  const soft = isDark ? '#1c1c1e' : '#f2f2f7';
  const selected = tiers.find((x) => x.id === selectedId) || tiers[0];
  const selectedIsCurrent = currentTier === selected.id;
  const selectedPending = pendingTier === selected.id;

  const perks = [
    { Icon: IconCloud, text: t('storage.perk.backup') || 'Backup automático das suas conversas e mídia' },
    { Icon: IconUsers, text: t('storage.perk.family') || 'Compartilhe o espaço com a família' },
    { Icon: IconImage, text: t('storage.perk.original') || 'Fotos e vídeos em qualidade original' },
    { Icon: IconZap, text: t('storage.perk.noAds') || 'Sem anúncios' },
    { Icon: IconShield, text: t('storage.perk.cancel') || 'Cancele quando quiser' },
  ];

  // Corpo compartilhado: sheet do sistema (iOS/Android) ou Modal (web / dono em Modal).
  const body = (
        <>
          {/* Header */}
          <View style={[styles.head, { backgroundColor: colors.background, borderBottomColor: line }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 }}>
              <IconCloud size={22} color={colors.text} />
              <Text style={[styles.title, { color: colors.text }]}>
                {t('storage.shopTitle') || 'Mais armazenamento'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <IconX size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: 16, paddingBottom: 16 }}
            showsVerticalScrollIndicator={false}
          >
            {/* Barra de uso */}
            {hasUsage && (
              <View style={[styles.usageCard, { backgroundColor: cardBg, borderColor: nearFull ? barColor : (colors.border || '#e5e7eb') }]}>
                <View style={styles.usageRow}>
                  <Text style={[styles.usageTitle, { color: colors.text }]}>
                    {(t('storage.usageOf') || '{used} de {limit} usados').replace('{used}', fmtBytes(used)).replace('{limit}', fmtBytes(limit))}
                  </Text>
                  <Text style={[styles.usagePct, { color: nearFull ? barColor : colors.muted }]}>{Math.round(pct)}%</Text>
                </View>
                <View style={[styles.usageTrack, { backgroundColor: soft }]}>
                  <View style={[styles.usageFill, { width: `${Math.max(pct, 1.5)}%`, backgroundColor: barColor }]} />
                </View>
                {nearFull && (
                  <Text style={[styles.usageWarn, { color: barColor }]}>
                    {pct >= 95
                      ? (t('storage.usage.full') || 'Seu espaço está quase cheio. Faça upgrade para continuar enviando fotos, vídeos e arquivos.')
                      : (t('storage.usage.near') || 'Seu espaço está acabando. Garanta mais antes que encha.')}
                  </Text>
                )}
              </View>
            )}

            {/* Propaganda */}
            <Text style={[styles.hero, { color: colors.text }]}>
              {t('storage.heroTitle') || 'Nunca mais fique sem espaço'}
            </Text>
            <Text style={[styles.heroSub, { color: colors.muted }]}>
              {t('storage.heroSub') || 'Guarde tudo com segurança na nuvem do Chatyy, do chat ao e-mail.'}
            </Text>
            <View style={styles.perks}>
              {perks.map(({ Icon, text }) => (
                <View key={text} style={styles.perkRow}>
                  <View style={[styles.perkIcon, { backgroundColor: soft }]}>
                    <Icon size={16} color={colors.text} />
                  </View>
                  <Text style={[styles.perkText, { color: colors.text }]}>{text}</Text>
                </View>
              ))}
            </View>

            {/* Cycle toggle */}
            <View style={[styles.toggleWrap, { backgroundColor: soft }]}>
              {(['monthly', 'annual']).map((c) => {
                const active = cycle === c;
                return (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setCycle(c)}
                    style={[styles.toggleBtn, active && { backgroundColor: colors.background, shadowColor: '#000', shadowOpacity: isDark ? 0 : 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }]}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.toggleText, { color: active ? colors.text : colors.muted }]}>
                      {c === 'monthly' ? (t('storage.cycle.monthly') || 'Mensal') : (t('storage.cycle.annual') || 'Anual')}
                    </Text>
                    {c === 'annual' && (
                      <View style={[styles.togglePill, { backgroundColor: tint }]}>
                        <Text style={[styles.togglePillText, { color: onTint }]}>{t('storage.monthsFree') || '2 meses grátis'}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Tiers */}
            {tiers.map((tier) => {
              const isCurrent = currentTier === tier.id;
              const isSel = selectedId === tier.id;
              const isRec = tier.id === RECOMMENDED_TIER;
              const sku = Platform.OS === 'ios'
                ? (cycle === 'annual' ? tier.skuAnnualApple : tier.skuMonthlyApple)
                : (cycle === 'annual' ? tier.skuAnnualGoogle : tier.skuMonthlyGoogle);
              const localized = getStorageLocalizedPrice(sku);
              const price = localized || formatBrl(cycle === 'annual' ? tier.priceAnnual : tier.priceMonthly);
              const perMonthEq = cycle === 'annual' ? formatBrl(tier.priceAnnual / 12) : null;
              const saved = cycle === 'annual' ? Math.max(0, tier.priceMonthly * 12 - tier.priceAnnual) : 0;
              const pending = pendingTier === tier.id;
              const accent = line;

              return (
                <TouchableOpacity
                  key={tier.id}
                  onPress={() => setSelectedId(tier.id)}
                  activeOpacity={0.9}
                  disabled={!!pendingTier}
                  style={[
                    styles.tierCard,
                    { borderColor: isSel ? tint : accent, backgroundColor: cardBg,
                      borderWidth: isSel ? 2 : 1, opacity: pending ? 0.6 : 1 },
                  ]}
                >
                  {isRec && (
                    <View style={[styles.recRibbon, { backgroundColor: tint }]}>
                      <Text style={[styles.badgeText, { color: onTint }]}>{t('storage.recommended') || 'Recomendado'}</Text>
                    </View>
                  )}
                  <View style={[styles.radio, { borderColor: isSel ? tint : (colors.muted || '#9ca3af'), backgroundColor: isSel ? tint : 'transparent' }]}>
                    {isSel && <IconCheck size={12} color={onTint} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.tierTitleRow}>
                      <Text style={[styles.tierName, { color: colors.text }]}>{gbLabel(tier.gb)}</Text>
                      {isCurrent && (
                        <View style={[styles.badge, { backgroundColor: soft }]}>
                          <Text style={[styles.badgeText, { color: colors.text }]}>{t('storage.currentPlan') || 'Seu plano atual'}</Text>
                        </View>
                      )}
                    </View>
                    {saved > 0 && (
                      <Text style={[styles.tierSave, { color: colors.muted }]}>
                        {(t('storage.youSave') || 'Você economiza {amount} por ano').replace('{amount}', formatBrl(saved))}
                      </Text>
                    )}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {pending ? (
                      <ActivityIndicator color={colors.text} />
                    ) : (
                      <>
                        <Text style={[styles.tierPrice, { color: colors.text }]}>
                          {cycle === 'annual' ? perMonthEq : price}
                          <Text style={[styles.tierPer, { color: colors.muted }]}> /{t('storage.perMonth') || 'mês'}</Text>
                        </Text>
                        {cycle === 'annual' && (
                          <Text style={[styles.tierPer, { color: colors.muted }]}>
                            {`${price} / ${t('storage.perYear') || 'ano'}`}
                          </Text>
                        )}
                      </>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}

            <Text style={[styles.freeNote, { color: colors.muted }]}>
              {t('storage.freeNote') || 'Todo mundo começa com 20 GB grátis. Faça upgrade quando precisar.'}
            </Text>
          </ScrollView>

          {/* CTA fixo */}
          <View style={[styles.ctaWrap, { backgroundColor: colors.background, borderTopColor: line }]}>
            {selectedIsCurrent ? (
              <View style={[styles.cta, { backgroundColor: soft }]}>
                <IconCheckCircle size={18} color={colors.text} />
                <Text style={[styles.ctaText, { color: colors.text }]}>{t('storage.currentPlan') || 'Seu plano atual'}</Text>
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => onBuy(selected)}
                disabled={!!pendingTier}
                activeOpacity={0.85}
                style={[styles.cta, { backgroundColor: tint, opacity: pendingTier ? 0.6 : 1 }]}
              >
                {selectedPending ? <ActivityIndicator color={onTint} /> : (
                  <Text style={[styles.ctaText, { color: onTint }]}>
                    {(t('storage.ctaUpgrade') || 'Fazer upgrade para {size}').replace('{size}', gbLabel(selected.gb))}
                  </Text>
                )}
              </TouchableOpacity>
            )}
            {showCard && !selectedIsCurrent && !selectedPending && (
              <TouchableOpacity
                onPress={() => onPayCard(selected)}
                disabled={!!pendingTier}
                style={[styles.cardBtn, { borderColor: colors.text }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.cardBtnText, { color: colors.text }]}>
                  {t('storage.payCard') || 'Pagar com cartão'}
                </Text>
              </TouchableOpacity>
            )}
            {showPortal && (
              <TouchableOpacity onPress={onManageCard} style={{ alignSelf: 'center', paddingVertical: 6 }}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' }}>
                  {t('storage.manageCard') || 'Gerenciar cartão / assinatura'}
                </Text>
              </TouchableOpacity>
            )}
            {Platform.OS === 'ios' && (
              <Text style={[styles.foot, { color: colors.muted }]}>
                {t('storage.manageSite') || 'Gerencie sua assinatura pelo site chatyy.com.br'}
              </Text>
            )}
            <Text style={[styles.foot, { color: colors.muted }]}>
              {t('storage.cancelAnytime') || 'Cancele quando quiser. Assinatura renova automaticamente.'}
            </Text>
          </View>
        </>
  );

  // [2026-10-12] Refeito: o formSheet nativo não dava altura ao conteúdo e cortava a
  // tela. Agora é TELA CHEIA (título fixo · planos rolando · botão fixo) no celular,
  // respeitando entalhe e barra; no computador, cartão central de 560px.
  const wide = Platform.OS === 'web' && winW >= 700;
  if (wide) {
    return (
      <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
        <View style={[styles.backdrop, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
          <View style={[styles.sheet, styles.card, { backgroundColor: colors.background, height: Math.min(winH * 0.9, 860) }]}>
            {body}
          </View>
        </View>
      </Modal>
    );
  }
  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'fullScreen' : undefined}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: Math.max(insets.top, 12) + 4, paddingBottom: Math.max(insets.bottom, 12), paddingHorizontal: 18 }}>
        {body}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  card: { width: '100%', maxWidth: 560, borderRadius: 20, overflow: 'hidden' },
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: '700' },
  usageCard: { borderRadius: 14, borderWidth: 1.5, padding: 12, marginBottom: 14 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  usageTitle: { fontSize: 14, fontWeight: '700', flex: 1 },
  usagePct: { fontSize: 13, fontWeight: '700' },
  usageTrack: { height: 10, borderRadius: 6, marginTop: 10, overflow: 'hidden' },
  usageFill: { height: '100%', borderRadius: 6 },
  usageWarn: { fontSize: 13, fontWeight: '600', marginTop: 10, lineHeight: 18 },
  hero: { fontSize: 26, fontWeight: '800', marginTop: 2, letterSpacing: -0.4, lineHeight: 31 },
  heroSub: { fontSize: 15, lineHeight: 21, marginTop: 6 },
  perks: { marginTop: 18, marginBottom: 22, gap: 12 },
  perkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perkIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  perkText: { fontSize: 15, fontWeight: '500', flex: 1 },
  toggleWrap: { flexDirection: 'row', borderRadius: 12, padding: 3, marginBottom: 18 },
  toggleBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  toggleText: { fontSize: 14, fontWeight: '700' },
  togglePill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  togglePillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  tierCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 16, marginBottom: 10, marginTop: 6,
    borderRadius: 16,
  },
  recRibbon: { position: 'absolute', top: -10, left: 14, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tierTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tierName: { fontSize: 20, fontWeight: '800' },
  tierSave: { fontSize: 12.5, fontWeight: '500', marginTop: 3 },
  tierPrice: { fontSize: 17, fontWeight: '800' },
  tierPer: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  freeNote: { fontSize: 13, textAlign: 'center', marginTop: 10, marginBottom: 4, lineHeight: 18 },
  ctaWrap: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  cta: {
    minHeight: 52, borderRadius: 26, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaText: { fontSize: 16, fontWeight: '700' },
  cardBtn: { marginTop: 8, paddingVertical: 13, borderRadius: 26, borderWidth: 1.5, alignItems: 'center' },
  cardBtnText: { fontSize: 15, fontWeight: '700' },
  foot: { fontSize: 12, textAlign: 'center', marginTop: 8 },
});
