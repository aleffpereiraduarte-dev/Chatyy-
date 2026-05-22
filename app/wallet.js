// /wallet — premium single-currency wallet (WAVE 57 — full rewrite).
//
// 2026-05-21. Replaces the WAVE 50+51 wallet that the user called "site fake".
// Rewritten from scratch with these principles:
//   - ONE balance (saldo). The "diamond" concept is gone from the UI.
//     Backend still uses chat_wallet_balances.diamond_balance internally,
//     but we render it as a unified "saldo" number.
//   - Centerpiece hero: one big balance, soft purple glow, breathing scale.
//     No two tabs, no segmented control, no skeumorphism.
//   - Action quartet: Adicionar / Enviar / Receber / Sacar. Each opens its
//     own dedicated sheet (components/wallet/Wallet*Sheet.js).
//   - Saved Stripe cards: horizontal scroll. Last entry is "+" add card.
//   - Atividade recente: 8 most recent ledger rows, clean lines.
//   - Skipped on purpose (signal-to-noise): sparkline, top senders, stats
//     blocks, ghost-mode toggle. They returned in v50/51 and added clutter.
//
// Data: a single walletOverview() round-trip. Falls back to walletHistory()
// if the aggregator endpoint isn't live yet. Pull-to-refresh always reloads.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  RefreshControl, StatusBar, Alert, ScrollView, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import * as api from '../services/api';
import {
  IconArrowLeft, IconPlus, IconSend, IconArrowRight, IconCreditCard,
  IconChevronRight, IconShare,
} from '../components/Icons';
import WalletAddSheet     from '../components/wallet/WalletAddSheet';
import WalletSendSheet    from '../components/wallet/WalletSendSheet';
import WalletReceiveSheet from '../components/wallet/WalletReceiveSheet';
import WalletCashoutSheet from '../components/wallet/WalletCashoutSheet';
import { formatInt } from '../utils/dateFormat';
import { Redirect } from 'expo-router';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { WALLET_ENABLED } from '../constants/featureFlags';

// ---- Palette -----------------------------------------------------------

const PURPLE_DEEP = '#5B21B6';
const PURPLE      = '#7C3AED';
const PURPLE_SOFT = '#A855F7';
const GREEN       = '#10B981';
const RED         = '#EF4444';

function tap(kind = 'light') {
  try {
    if (kind === 'light')  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (kind === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (kind === 'select') Haptics.selectionAsync();
  } catch {}
}

function fmtBrl(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2).replace('.', ',');
}

// Fake-gradient hero: solid base + two translucent rotated overlays + a
// faint top sheen. Looks like a real gradient without expo-linear-gradient
// (which would require a native rebuild). 2026-05-21 — kept from v50 because
// the gradient itself was fine; the noise around it was the problem.
function HeroGradient({ children, style }) {
  return (
    <View style={[styles.heroBase, { backgroundColor: PURPLE_DEEP }, style]}>
      <View style={[styles.heroOverlay, {
        backgroundColor: '#EC4899', opacity: 0.40,
        transform: [{ translateX: 80 }, { translateY: -60 }, { rotate: '-15deg' }],
      }]} />
      <View style={[styles.heroOverlay, {
        backgroundColor: PURPLE_SOFT, opacity: 0.45,
        transform: [{ translateX: -60 }, { translateY: 40 }, { rotate: '20deg' }],
      }]} />
      <View style={styles.heroSheen} />
      {children}
    </View>
  );
}

// Action quartet button — circle icon, label below. Soft press-in scale.
function QuickAction({ icon: Icon, label, onPress, accent = '#fff' }) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPressIn={() => Animated.timing(scale, { toValue: 0.95, duration: 80, useNativeDriver: true }).start()}
      onPressOut={() => Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start()}
      onPress={() => { tap('light'); onPress?.(); }}
      style={styles.qaWrap}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
        <View style={[styles.qaBubble, { backgroundColor: 'rgba(255,255,255,0.16)' }]}>
          <Icon size={22} color={accent} />
        </View>
        <Text style={styles.qaLabel} numberOfLines={1}>{label}</Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Saved card chip — horizontally scrolled. Brand + last4 + exp.
function CardChip({ card, isDark, colors, onPress }) {
  const brand = String(card.brand || 'card').toUpperCase();
  const last4 = card.last4 || '••••';
  const exp = card.exp_month && card.exp_year
    ? `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`
    : '';
  return (
    <TouchableOpacity
      activeOpacity={0.88}
      onPress={onPress}
      style={[styles.cardChip, {
        backgroundColor: isDark ? '#16161E' : '#FFFFFF',
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)',
      }]}
    >
      <View style={[styles.cardChipIcon, { backgroundColor: PURPLE + '18' }]}>
        <IconCreditCard size={20} color={PURPLE} />
      </View>
      <Text style={[styles.cardChipBrand, { color: colors.text }]} numberOfLines={1}>{brand}</Text>
      <Text style={[styles.cardChipLast, { color: colors.text }]}>•••• {last4}</Text>
      {exp ? (
        <Text style={[styles.cardChipExp, { color: isDark ? 'rgba(255,255,255,0.50)' : 'rgba(15,23,42,0.50)' }]}>
          {exp}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

// "+ Adicionar" card placeholder at the end of the cards row.
function AddCardChip({ isDark, colors, onPress, label }) {
  return (
    <TouchableOpacity
      activeOpacity={0.88}
      onPress={onPress}
      style={[styles.cardChip, styles.cardChipAdd, {
        borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.18)',
      }]}
    >
      <View style={[styles.cardChipIcon, { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: PURPLE }]}>
        <IconPlus size={20} color={PURPLE} />
      </View>
      <Text style={[styles.cardChipBrand, { color: colors.text }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// Ledger row — clean horizontal layout: arrow icon + label + amount.
function LedgerRow({ item, colors, isDark, t, lang }) {
  const isCredit = item.direction === 'credit';
  const sign = isCredit ? '+' : '-';
  const c = isCredit ? GREEN : RED;
  const kindLabel = (() => {
    const map = {
      topup:       t('wallet.kind.topup')    || 'Recarga',
      send:        t('wallet.kind.send')     || 'Enviado',
      receive:     t('wallet.kind.receive')  || 'Recebido',
      tip_send:    t('wallet.kind.tipSend')  || 'Gorjeta enviada',
      tip_recv:    t('wallet.kind.tipRecv')  || 'Gorjeta recebida',
      promote:     t('wallet.kind.promote')  || 'Promoção',
      bonus:       t('wallet.kind.bonus')    || 'Bônus',
      daily_bonus: t('wallet.kind.bonus')    || 'Bônus',
      cashout:     t('wallet.kind.cashout')  || 'Saque',
      payout:      t('wallet.kind.cashout')  || 'Saque',
    };
    return map[item.kind] || (isCredit ? (t('wallet.kind.receive') || 'Recebido') : (t('wallet.kind.send') || 'Enviado'));
  })();
  const when = (() => {
    const ts = Number(item.created_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
  })();
  return (
    <View style={[styles.row, {
      borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.05)',
    }]}>
      <View style={[styles.rowIcon, { backgroundColor: c + '18' }]}>
        <IconArrowRight
          size={14}
          color={c}
          style={{ transform: [{ rotate: isCredit ? '-135deg' : '45deg' }] }}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowKind, { color: colors.text }]} numberOfLines={1}>{kindLabel}</Text>
        {item.counterparty ? (
          <Text style={[styles.rowCp, { color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)' }]} numberOfLines={1}>
            {String(item.counterparty).split('@')[0]}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.rowAmt, { color: c }]}>{sign}{formatInt(item.amount, lang)}</Text>
        {when ? (
          <Text style={[styles.rowWhen, { color: isDark ? 'rgba(255,255,255,0.40)' : 'rgba(15,23,42,0.40)' }]}>{when}</Text>
        ) : null}
      </View>
    </View>
  );
}

// =======================================================================
// Screen
// =======================================================================

export default function WalletScreen() {
  // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag.
  // Keep the route registered (deep-links + back-stack remain valid) but
  // bounce visitors back to /chat so no wallet UI surfaces during the
  // WhatsApp-style free era. Flip the flag in constants/featureFlags.js
  // to bring this screen back instantly without a rebuild.
  if (!WALLET_ENABLED) {
    return <Redirect href="/chat" />;
  }
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  // Display currency (user-configurable in settings). Wallet balance, payouts
  // and ledger rows are all rendered in this currency; centavos stay BRL in
  // state + on the wire. See services/currencyService.js.
  const { format: formatMoney } = useCurrency(language);

  const [items, setItems]               = useState([]);
  const [balance, setBalance]           = useState(0);
  const [pendingPayout, setPendingPayout] = useState(0);
  const [savedCards, setSavedCards]     = useState([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);

  // Sheets state
  const [addOpen, setAddOpen]         = useState(false);
  const [sendOpen, setSendOpen]       = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [cashoutOpen, setCashoutOpen] = useState(false);

  // Hero header fade-in on scroll.
  const scrollY = useRef(new Animated.Value(0)).current;
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 80, 120],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });

  // Subtle breathing on the balance number — amplitude purposefully tiny
  // so it reads as "alive" rather than gimmicky.
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);
  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.015] });

  const load = useCallback(async () => {
    try {
      let r = null;
      try { r = await api.walletOverview?.({ limit: 50, offset: 0 }); } catch { r = null; }
      if (r?.success && r.data) {
        const next = (Array.isArray(r.data.items) ? r.data.items : [])
          .filter(it => Number.isFinite(Number(it?.amount)) && Math.abs(Number(it.amount)) >= 1);
        setItems(next);
        setBalance(Number(r.data.diamond_balance) || 0);
        setPendingPayout(Number(r.data.pending_payout_cents) || 0);
        setSavedCards(Array.isArray(r.data.saved_cards) ? r.data.saved_cards : []);
      } else {
        const h = await api.walletHistory?.({ limit: 50, offset: 0 });
        if (h?.success && h.data) {
          const next = (Array.isArray(h.data.items) ? h.data.items : [])
            .filter(it => Number.isFinite(Number(it?.amount)) && Math.abs(Number(it.amount)) >= 1);
          setItems(next);
          setBalance(Number(h.data.diamond_balance) || 0);
          setPendingPayout(Number(h.data.pending_payout_cents) || 0);
        }
        try {
          const cards = await api.stripeDiamondListCards?.();
          if (cards?.success && Array.isArray(cards.data?.cards)) setSavedCards(cards.data.cards);
        } catch {}
      }
    } catch {
      // silent — empty state will render
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Daily login bonus — fire once per mount.
  const bonusFired = useRef(false);
  useEffect(() => {
    if (bonusFired.current) return;
    bonusFired.current = true;
    (async () => {
      try {
        const r = await api.walletDailyBonus?.();
        if (r?.success && r?.data?.granted) {
          const amt = Number(r.data.amount) || 0;
          const newBal = Number(r.data.diamond_balance);
          if (!isNaN(newBal)) setBalance(newBal);
          Alert.alert(
            t('wallet.dailyBonusTitle') || 'Bem-vindo de volta!',
            (t('wallet.dailyBonusBody') || '+{n} de saldo por entrar hoje.').replace('{n}', formatInt(amt, language)),
          );
        }
      } catch {}
    })();
  }, [t, language]);

  const onRefresh = useCallback(() => {
    tap('select');
    setRefreshing(true);
    load();
  }, [load]);

  const recentItems = useMemo(() => items.slice(0, 8), [items]);

  const onDeleteCard = useCallback((card) => {
    Alert.alert(
      t('wallet.cardRemoveTitle') || 'Remover cartão?',
      t('wallet.cardRemoveBody') || 'O cartão não estará mais disponível para compras automáticas.',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('wallet.cardRemove') || 'Remover',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.stripeDiamondDeleteCard?.(card.id);
              setSavedCards(prev => prev.filter(c => c.id !== card.id));
            } catch {
              Alert.alert(t('common.error') || 'Erro', t('wallet.cardRemoveFail') || 'Falha ao remover cartão.');
            }
          },
        },
      ],
    );
  }, [t]);

  // -------- Render -----------------------------------------------------

  const renderHeroAndContent = () => (
    <View>
      <HeroGradient style={[styles.hero, { paddingTop: (insets.top || 0) + 70 }]}>
        <Text style={styles.heroEyebrow}>
          {t('wallet.balanceLabel') || 'SALDO DISPONÍVEL'}
        </Text>
        <Animated.View style={[styles.heroBalanceRow, { transform: [{ scale: breathScale }] }]}>
          <Text style={styles.heroBalance} numberOfLines={1} adjustsFontSizeToFit>
            {formatInt(balance, language)}
          </Text>
        </Animated.View>
        <Text style={styles.heroSub}>
          {t('wallet.unitLabel') || 'de saldo'}
        </Text>

        {pendingPayout > 0 ? (
          <TouchableOpacity
            onPress={() => { tap('light'); setCashoutOpen(true); }}
            style={styles.payoutPill}
            accessibilityRole="button"
          >
            <Text style={styles.payoutPillLabel}>
              {t('wallet.cashAvailable') || 'Disponível para saque'}:
            </Text>
            <Text style={styles.payoutPillValue}>{formatMoney(pendingPayout)}</Text>
            <IconChevronRight size={14} color="#fff" />
          </TouchableOpacity>
        ) : null}

        {/* Action quartet */}
        <View style={styles.qaRow}>
          <QuickAction icon={IconPlus}        label={t('wallet.actionAdd')     || 'Adicionar'} onPress={() => setAddOpen(true)} />
          <QuickAction icon={IconSend}        label={t('wallet.actionSend')    || 'Enviar'}    onPress={() => setSendOpen(true)} />
          <QuickAction icon={IconShare}       label={t('wallet.actionReceive') || 'Receber'}   onPress={() => setReceiveOpen(true)} />
          <QuickAction icon={IconArrowRight}  label={t('wallet.actionCashout') || 'Sacar'}     onPress={() => setCashoutOpen(true)} />
        </View>
      </HeroGradient>

      {/* Saved cards */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('wallet.cardsTitle') || 'Cartões salvos'}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 4, gap: 10 }}
        >
          {savedCards.map((card) => (
            <CardChip
              key={card.id}
              card={card}
              isDark={isDark}
              colors={colors}
              onPress={() => onDeleteCard(card)}
            />
          ))}
          <AddCardChip
            isDark={isDark}
            colors={colors}
            onPress={() => { tap('light'); setAddOpen(true); }}
            label={savedCards.length === 0
              ? (t('wallet.addCardCta') || 'Adicionar cartão')
              : (t('common.add') || 'Adicionar')}
          />
        </ScrollView>
      </View>

      {/* Atividade recente */}
      <View style={[styles.section, { paddingBottom: 4 }]}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('wallet.recentActivity') || 'Atividade recente'}
          </Text>
          {items.length > 8 ? (
            <TouchableOpacity
              onPress={() => { tap('light'); router.push('/wallet-cashout'); }}
              accessibilityRole="button"
            >
              <Text style={[styles.sectionLink, { color: PURPLE }]}>
                {t('common.seeAll') || 'Ver tudo'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );

  const renderEmpty = () => (
    <View style={styles.emptyWrap}>
      <View style={[styles.emptyBubble, { backgroundColor: PURPLE + '14' }]}>
        <IconPlus size={42} color={PURPLE} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {t('wallet.emptyTitle') || 'Sua carteira está vazia'}
      </Text>
      <Text style={[styles.emptyBody, { color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)' }]}>
        {t('wallet.emptyBody') || 'Adicione saldo para enviar dinheiro, presentear criadores e desbloquear conteúdo exclusivo.'}
      </Text>
      <TouchableOpacity
        onPress={() => { tap('medium'); setAddOpen(true); }}
        style={[styles.emptyCta, { backgroundColor: PURPLE }]}
        accessibilityRole="button"
      >
        <Text style={styles.emptyCtaText}>
          {t('wallet.actionAdd') || 'Adicionar saldo'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar barStyle="light-content" />

      {/* Floating header — fades in once user scrolls past the hero */}
      <View style={[styles.headBar, { paddingTop: (insets.top || 0) + 6 }]}>
        <Animated.View style={[StyleSheet.absoluteFill, {
          opacity: headerOpacity,
          backgroundColor: colors.background,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
          borderBottomWidth: StyleSheet.hairlineWidth,
        }]} />
        <TouchableOpacity
          onPress={() => { tap('light'); router.back(); }}
          style={[styles.iconBtn, { backgroundColor: 'rgba(255,255,255,0.16)' }]}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={20} color="#fff" />
        </TouchableOpacity>
        <Animated.Text
          style={[styles.headTitle, { color: colors.text, opacity: headerOpacity }]}
          numberOfLines={1}
        >
          {t('wallet.title') || 'Carteira'}
        </Animated.Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={PURPLE} size="large" />
        </View>
      ) : (
        <Animated.FlatList
          data={recentItems}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 18 }}>
              <LedgerRow item={item} colors={colors} isDark={isDark} t={t} lang={language} />
            </View>
          )}
          ListHeaderComponent={renderHeroAndContent()}
          ListEmptyComponent={
            balance === 0 && items.length === 0 ? renderEmpty() : (
              <View style={{ paddingHorizontal: 18, paddingVertical: 18, alignItems: 'center' }}>
                <Text style={{ color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.45)', fontSize: 13 }}>
                  {t('wallet.historyEmpty') || 'Nenhuma transação ainda.'}
                </Text>
              </View>
            )
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PURPLE} />}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}

      <WalletAddSheet
        visible={addOpen}
        onClose={() => { setAddOpen(false); load(); }}
        onBalanceChange={(b) => { if (typeof b === 'number') setBalance(b); }}
      />
      <WalletSendSheet
        visible={sendOpen}
        onClose={() => setSendOpen(false)}
        balance={balance}
        onSent={() => { setSendOpen(false); load(); }}
      />
      <WalletReceiveSheet
        visible={receiveOpen}
        onClose={() => setReceiveOpen(false)}
      />
      <WalletCashoutSheet
        visible={cashoutOpen}
        onClose={() => setCashoutOpen(false)}
        availableCents={pendingPayout}
        onSuccess={() => load()}
      />
    </View>
  );
}

// ---- Styles ------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  headBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 10,
  },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },

  // Hero
  hero: {
    paddingBottom: 28,
    paddingHorizontal: 22,
    overflow: 'hidden',
    shadowColor: PURPLE_DEEP,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 28,
    elevation: 14,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  heroBase: { position: 'relative' },
  heroOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    width: '120%', height: '120%',
  },
  heroSheen: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 80,
    backgroundColor: '#fff', opacity: 0.06,
  },
  heroEyebrow: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
    textTransform: 'uppercase', textAlign: 'center', marginBottom: 8,
  },
  heroBalanceRow: { alignItems: 'center' },
  heroBalance: {
    color: '#fff', fontSize: 64, fontWeight: '900', letterSpacing: -2,
    textShadowColor: 'rgba(255,255,255,0.35)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  heroSub: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13, fontWeight: '500', textAlign: 'center', marginTop: 2,
  },

  payoutPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.20)',
    paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 999, marginTop: 18, gap: 6,
  },
  payoutPillLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '500' },
  payoutPillValue: { color: '#fff', fontSize: 13, fontWeight: '800' },

  // Action quartet
  qaRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 26, paddingHorizontal: 4 },
  qaWrap: { alignItems: 'center', minWidth: 64 },
  qaBubble: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  qaLabel: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },

  // Sections
  section: { paddingTop: 22 },
  sectionHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, marginBottom: 8,
  },
  sectionTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  sectionLink: { fontSize: 13, fontWeight: '700' },

  // Card chip
  cardChip: {
    width: 156,
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
  },
  cardChipAdd: {
    borderStyle: 'dashed', backgroundColor: 'transparent',
    alignItems: 'flex-start', justifyContent: 'center',
  },
  cardChipIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
  },
  cardChipBrand: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  cardChipLast:  { fontSize: 14, fontWeight: '700', marginTop: 2 },
  cardChipExp:   { fontSize: 11, fontWeight: '500', marginTop: 2 },

  // Ledger row
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowKind: { fontSize: 14, fontWeight: '700' },
  rowCp:   { fontSize: 12, fontWeight: '500', marginTop: 1 },
  rowAmt:  { fontSize: 15, fontWeight: '800' },
  rowWhen: { fontSize: 11, fontWeight: '500', marginTop: 2 },

  // Empty
  emptyWrap: { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 30 },
  emptyBubble: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center', marginBottom: 6 },
  emptyBody:  { fontSize: 13, fontWeight: '500', textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  emptyCta:   { paddingVertical: 13, paddingHorizontal: 28, borderRadius: 14 },
  emptyCtaText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
});
