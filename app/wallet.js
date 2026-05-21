// /wallet — diamond wallet hub (premium polish, WAVE 50).
//
// Renders, top → bottom:
//   • Sticky back header (fades to solid as user scrolls past hero).
//   • HERO card with simulated purple→pink gradient (stacked translucent
//     overlays — no expo-linear-gradient dependency so OTA-safe), huge
//     balance number, breathing scale animation, soft purple glow.
//   • Quick actions row: 4 chip buttons (Comprar, Enviar, Histórico, Sacar)
//     each with a tinted SVG icon + soft background. Tap = haptic light.
//   • Featured packs horizontal scroller (5 packs) — "MAIS POPULAR" badge
//     on the 3rd. Tap → /diamond-shop?sku=<sku>.
//   • Stats card "Você usou X ◆ esse mês" with mini 7d sparkline (pure
//     RN — bars).
//   • Top senders card (only when there is at least 1 inbound transfer in
//     the visible ledger) — surfaces avatars of people who sent you the
//     most diamonds in the current ledger window.
//   • Recent activity (compact, top 5 ledger rows) with "Ver tudo" CTA
//     that expands the full FlatList.
//   • Empty state when balance=0 AND zero history: SVG diamond + copy.
//
// All data comes from wallet_history (server returns balance + items in one
// shot so the header paints without a second round-trip). Pull-to-refresh
// + infinite scroll preserved from prior version.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  RefreshControl, Platform, StatusBar, Alert, Modal, TextInput, ScrollView,
  Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import {
  IconArrowLeft, IconDiamond, IconX, IconSearch, IconSend, IconClock,
  IconGiftBox, IconSparkles, IconChevronRight, IconArrowRight,
  IconCreditCard, IconSettings, IconRefresh,
} from '../components/Icons';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import SendDiamondSheet from '../components/SendDiamondSheet';
import AvatarCircle from '../components/AvatarCircle';
import { formatInt } from '../utils/dateFormat';

// ----- Constants ---------------------------------------------------------

// Brand palette — purple → pink premium gradient (Bumble/TikTok-ish).
const PURPLE_DEEP = '#7C3AED';
const PURPLE      = '#A855F7';
const PINK        = '#EC4899';
const GOLD        = '#F59E0B';
const GREEN       = '#10B981';
const RED         = '#EF4444';
const BLUE        = '#3B82F6';

// Featured packs surfaced in the hero scroller. SKUs match diamond-shop
// IAP IDs so the deep-link consumes the correct product. "popular" marks
// the middle pack as featured.
const FEATURED_PACKS = [
  { sku: 'diamonds_100',   amount: 100,   priceBRL: 9.90,    popular: false },
  { sku: 'diamonds_550',   amount: 550,   priceBRL: 49.90,   popular: false },
  { sku: 'diamonds_1700',  amount: 1700,  priceBRL: 149.90,  popular: true  },
  { sku: 'diamonds_6000',  amount: 6000,  priceBRL: 499.90,  popular: false },
  { sku: 'diamonds_19500', amount: 19500, priceBRL: 1499.90, popular: false },
];

// [WAVE 51] Local-only key for the "esconder saldo" privacy toggle. Per-device
// preference (never sync to backend) so users can hide values in screenshots
// or when handing the phone to someone else.
const PRIVACY_KEY = 'wallet:hideBalance:v1';

// [WAVE 51] BRL cashout floor — keep in sync with backend wallet_cashout_request.
const MIN_CASHOUT_CENTS = 5000;

// [WAVE 51] Format integer cents as BRL string ("12,34"). No currency prefix.
function fmtBrl(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2).replace('.', ',');
}

// Safe haptic — wraps in try/catch so Android dev builds without the native
// module don't throw. We use light impact on every action.
function tap(kind = 'light') {
  try {
    if (kind === 'light')  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (kind === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (kind === 'select') Haptics.selectionAsync();
  } catch {}
}

// ----- Sub-components ----------------------------------------------------

// Hero gradient — fakes a linear-gradient by stacking 3 translucent layers.
// We can't use expo-linear-gradient without a native rebuild (project rule:
// OTA-safe only). The base is solid PURPLE_DEEP; we overlay a pink wedge
// from the top-right and a violet wedge from the bottom-left, plus a
// faint white sheen across the top for a premium specular highlight.
function HeroGradient({ children, style }) {
  return (
    <View style={[styles.heroBase, { backgroundColor: PURPLE_DEEP }, style]}>
      <View style={[styles.heroOverlay, {
        backgroundColor: PINK, opacity: 0.55,
        transform: [{ translateX: 80 }, { translateY: -60 }, { rotate: '-15deg' }],
      }]} />
      <View style={[styles.heroOverlay, {
        backgroundColor: PURPLE, opacity: 0.40,
        transform: [{ translateX: -60 }, { translateY: 40 }, { rotate: '20deg' }],
      }]} />
      <View style={[styles.heroSheen]} />
      {children}
    </View>
  );
}

// Quick action chip — square-ish button with a tinted icon over a soft
// background of the same tint at 14% alpha. Tap scales to 0.94 + haptic.
function QuickAction({ icon: Icon, label, tint, onPress, t }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => {
    Animated.timing(scale, { toValue: 0.94, duration: 80, useNativeDriver: true }).start();
  };
  const pressOut = () => {
    Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start();
  };
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPressIn={pressIn}
      onPressOut={pressOut}
      onPress={() => { tap('light'); onPress?.(); }}
      style={styles.qaWrap}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Animated.View style={[styles.qaInner, { transform: [{ scale }] }]}>
        <View style={[styles.qaIconBubble, { backgroundColor: tint + '22' }]}>
          <Icon size={22} color={tint} />
        </View>
        <Text style={[styles.qaLabel, { color: '#fff' }]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Featured pack card — horizontally scrolled. Shows pack size, price, and
// a "MAIS POPULAR" ribbon on the featured one. Lifts +2px on press-in.
function PackCard({ pack, onPress, isDark, colors, language, t }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => Animated.timing(scale, { toValue: 0.97, duration: 80, useNativeDriver: true }).start();
  const pressOut = () => Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start();
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPressIn={pressIn}
      onPressOut={pressOut}
      onPress={() => { tap('medium'); onPress?.(pack); }}
      style={{ marginRight: 12 }}
    >
      <Animated.View style={[styles.packCard, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
        borderColor: pack.popular ? GOLD : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.08)'),
        borderWidth: pack.popular ? 1.5 : StyleSheet.hairlineWidth,
        transform: [{ scale }],
        shadowColor: pack.popular ? GOLD : '#000',
        shadowOpacity: pack.popular ? 0.30 : 0.12,
      }]}>
        {pack.popular ? (
          <View style={styles.popularBadge}>
            <IconSparkles size={10} color="#fff" style={{ marginRight: 3 }} />
            <Text style={styles.popularBadgeText}>
              {(t('wallet.mostPopular') || 'MAIS POPULAR')}
            </Text>
          </View>
        ) : null}
        <View style={styles.packIconBubble}>
          <IconDiamond size={32} color={pack.popular ? GOLD : PURPLE} />
        </View>
        <Text style={[styles.packAmount, { color: colors.text }]}>
          {formatInt(pack.amount, language)}
        </Text>
        <Text style={[styles.packDiamonds, { color: colors.textSecondary }]}>
          {t('wallet.diamondsLabel') || 'diamantes'}
        </Text>
        <View style={[styles.packPricePill, { backgroundColor: pack.popular ? GOLD : PURPLE }]}>
          <Text style={styles.packPriceText}>
            R$ {pack.priceBRL.toFixed(2).replace('.', ',')}
          </Text>
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Sparkline — 7 bars showing relative spend amounts. Pure RN flex, no SVG.
function Sparkline({ values, color, height = 38 }) {
  const max = Math.max(1, ...values);
  return (
    <View style={[styles.sparkRow, { height }]}>
      {values.map((v, i) => {
        const h = Math.max(4, (v / max) * height);
        return (
          <View key={i} style={{
            width: 6, height: h, marginHorizontal: 2,
            borderRadius: 3, backgroundColor: v > 0 ? color : color + '33',
          }} />
        );
      })}
    </View>
  );
}

function LedgerRow({ item, colors, isDark, t, lang, compact = false }) {
  const isCredit = item.direction === 'credit';
  const sign = isCredit ? '+' : '-';
  const color = isCredit ? GREEN : RED;
  const kindLabel = (() => {
    const map = {
      topup:     t('wallet.kind.topup')    || 'Compra',
      send:      t('wallet.kind.send')     || 'Enviado',
      receive:   t('wallet.kind.receive')  || 'Recebido',
      tip_send:  t('wallet.kind.tipSend')  || 'Gorjeta enviada',
      tip_recv:  t('wallet.kind.tipRecv')  || 'Gorjeta recebida',
      promote:   t('wallet.kind.promote')  || 'Promoção',
      bonus:     t('wallet.kind.bonus')    || 'Bônus',
      daily_bonus: t('wallet.kind.bonus')  || 'Bônus',
    };
    const fallback = (isCredit && (!item.kind || !map[item.kind]))
      ? (t('wallet.kind.bonus') || 'Bônus')
      : (item.kind || '');
    return map[item.kind] || fallback;
  })();
  const when = (() => {
    const ts = Number(item.created_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  })();
  return (
    <View style={[styles.row, {
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
      paddingVertical: compact ? 10 : 12,
    }]}>
      <View style={[styles.rowIconBubble, { backgroundColor: color + '18' }]}>
        {isCredit
          ? <IconArrowRight size={16} color={color} style={{ transform: [{ rotate: '-135deg' }] }} />
          : <IconArrowRight size={16} color={color} style={{ transform: [{ rotate: '45deg' }] }} />
        }
      </View>
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
        {sign}{formatInt(item.amount, lang)} ◆
      </Text>
    </View>
  );
}

// ----- Screen ------------------------------------------------------------

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  const [items, setItems] = useState([]);
  const [balance, setBalance] = useState(0);
  const [pendingPayout, setPendingPayout] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);

  // [WAVE 51] Carteira completa state — saved cards, recent cashouts,
  // creator insights, history filter chips, privacy toggle, settings sheet.
  const [savedCards, setSavedCards] = useState([]);
  const [recentCashouts, setRecentCashouts] = useState([]);
  const [insights, setInsights] = useState({
    month_payout_cents: 0,
    gifts_count_30d: 0,
    gifts_count_lifetime: 0,
    lifetime_payout_cents: 0,
  });
  const [historyFilter, setHistoryFilter] = useState('all'); // all|in|out|cashout
  const [hideAmounts, setHideAmounts] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Restore privacy preference once per mount.
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(PRIVACY_KEY);
        if (v === '1') setHideAmounts(true);
      } catch {}
    })();
  }, []);

  const togglePrivacy = useCallback(async () => {
    const next = !hideAmounts;
    setHideAmounts(next);
    try { await AsyncStorage.setItem(PRIVACY_KEY, next ? '1' : '0'); } catch {}
    tap('select');
  }, [hideAmounts]);

  // Picker sheet state (Enviar button → conversation picker → SendDiamondSheet)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerConvs, setPickerConvs] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [sendTarget, setSendTarget] = useState(null);

  // ----- Breathing animation on the balance text (subtle 1.0 ↔ 1.02). -----
  // Runs continuously over ~3.2s ease-in-out. useNativeDriver=true so it
  // doesn't block JS; pause on scroll is unnecessary since amplitude is tiny.
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);
  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] });

  // Hero shrink-on-scroll: capture scrollY, used for header bar opacity.
  const scrollY = useRef(new Animated.Value(0)).current;
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 80, 120],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });

  // ----- Data load ------------------------------------------------------

  // [WAVE 51] Single round-trip via walletOverview. Falls back to legacy
  // walletHistory if endpoint missing (e.g. backend not yet deployed).
  // On append=true (pagination) the aggregator short-circuits and returns
  // only ledger items, so we skip refreshing the aggregate panels.
  const load = useCallback(async ({ append = false } = {}) => {
    try {
      const offset = append ? items.length : 0;
      let r = null;
      try { r = await api.walletOverview?.({ limit: 50, offset }); } catch { r = null; }

      if (r?.success && r.data) {
        const next = (Array.isArray(r.data.items) ? r.data.items : [])
          .filter(it => Number.isFinite(Number(it?.amount)) && Math.abs(Number(it.amount)) >= 1);
        setItems(prev => append ? [...prev, ...next] : next);
        setBalance(Number(r.data.diamond_balance) || 0);
        setPendingPayout(Number(r.data.pending_payout_cents) || 0);
        setHasMore(!!r.data.has_more);
        if (!append) {
          setSavedCards(Array.isArray(r.data.saved_cards) ? r.data.saved_cards : []);
          setRecentCashouts(Array.isArray(r.data.recent_cashouts) ? r.data.recent_cashouts : []);
          setInsights({
            month_payout_cents:    Number(r.data.month_payout_cents) || 0,
            gifts_count_30d:       Number(r.data.gifts_count_30d) || 0,
            gifts_count_lifetime:  Number(r.data.gifts_count_lifetime) || 0,
            lifetime_payout_cents: Number(r.data.lifetime_payout_cents) || 0,
          });
        }
      } else {
        // Legacy fallback — preserves screen if aggregator not deployed.
        const h = await api.walletHistory({ limit: 50, offset });
        if (h?.success && h.data) {
          const next = (Array.isArray(h.data.items) ? h.data.items : [])
            .filter(it => Number.isFinite(Number(it?.amount)) && Math.abs(Number(it.amount)) >= 1);
          setItems(prev => append ? [...prev, ...next] : next);
          setBalance(Number(h.data.diamond_balance) || 0);
          setPendingPayout(Number(h.data.pending_payout_cents) || 0);
          setHasMore(!!h.data.has_more);
        }
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

  // Daily login bonus.
  const bonusFiredRef = useRef(false);
  useEffect(() => {
    if (bonusFiredRef.current) return;
    bonusFiredRef.current = true;
    (async () => {
      try {
        const r = await api.walletDailyBonus?.();
        if (r?.success && r?.data?.granted) {
          const amt = Number(r.data.amount) || 0;
          const streak = Number(r.data.streak_days) || 1;
          const newBal = Number(r.data.diamond_balance);
          if (!isNaN(newBal)) setBalance(newBal);
          const title = t('wallet.dailyBonusTitle') || 'Bem-vindo de volta!';
          const body = (t('wallet.dailyBonusBody') || '+{n} ◆ por entrar hoje.').replace('{n}', amt);
          const streakLine = streak > 1
            ? '\n' + (t('wallet.streakDays') || 'Sequência de {n} dias').replace('{n}', streak)
            : '';
          Alert.alert(title, body + streakLine);
          load();
        }
      } catch {}
    })();
  }, [t, load]);

  const onRefresh = useCallback(() => {
    tap('select');
    setRefreshing(true);
    load();
  }, [load]);

  const onEndReached = useCallback(() => {
    if (loadingMore || !hasMore || !showAllHistory) return;
    setLoadingMore(true);
    load({ append: true });
  }, [hasMore, load, loadingMore, showAllHistory]);

  // ----- Send picker ----------------------------------------------------

  const openSendPicker = useCallback(async () => {
    tap('light');
    setPickerOpen(true);
    setPickerLoading(true);
    setPickerQuery('');
    try {
      const r = await api.chatConversations();
      const raw = Array.isArray(r?.conversations) ? r.conversations
        : Array.isArray(r?.data?.conversations) ? r.data.conversations
        : Array.isArray(r?.data) ? r.data
        : Array.isArray(r) ? r
        : [];
      const directs = raw.filter(c => {
        const type = String(c.type || c.conv_type || 'direct').toLowerCase();
        if (type !== 'direct') return false;
        const peer = String(c.peer_email || c.other_email || c.email || '').toLowerCase();
        return peer && peer !== 'me' && peer !== 'self';
      });
      setPickerConvs(directs);
    } catch (e) {
      setPickerConvs([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const onPickerSelect = useCallback((conv) => {
    const email = conv.peer_email || conv.other_email || conv.email;
    const name = conv.peer_name || conv.name || conv.title || (email ? email.split('@')[0] : '');
    const avatar = conv.peer_avatar_url || conv.avatar_url || conv.photo_url;
    if (!email) return;
    setSendTarget({ email, name, avatar });
    setPickerOpen(false);
  }, []);

  const filteredPickerConvs = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return pickerConvs;
    return pickerConvs.filter(c => {
      const name = String(c.peer_name || c.name || c.title || '').toLowerCase();
      const email = String(c.peer_email || c.other_email || c.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [pickerConvs, pickerQuery]);

  // ----- Derived stats --------------------------------------------------

  // Top senders: aggregate credits by counterparty from ledger window.
  const topSenders = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      if (it.direction !== 'credit') continue;
      const cp = it.counterparty;
      if (!cp) continue;
      // Skip system kinds (topup/bonus) — those aren't from a person.
      if (it.kind === 'topup' || it.kind === 'bonus' || it.kind === 'daily_bonus') continue;
      const prev = m.get(cp) || { name: cp, total: 0 };
      prev.total += Number(it.amount) || 0;
      m.set(cp, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total).slice(0, 4);
  }, [items]);

  // Monthly spend stat: sum of debits in the current calendar month.
  const monthlySpend = useMemo(() => {
    const now = new Date();
    const m = now.getMonth(), y = now.getFullYear();
    let sum = 0;
    for (const it of items) {
      if (it.direction !== 'debit') continue;
      const ts = Number(it.created_at_ts) * 1000;
      if (!ts) continue;
      const d = new Date(ts);
      if (d.getMonth() === m && d.getFullYear() === y) sum += Number(it.amount) || 0;
    }
    return sum;
  }, [items]);

  // 7-day spend sparkline: aggregate debits per day for last 7 days.
  const sparkValues = useMemo(() => {
    const days = [0, 0, 0, 0, 0, 0, 0];
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (const it of items) {
      if (it.direction !== 'debit') continue;
      const ts = Number(it.created_at_ts) * 1000;
      if (!ts) continue;
      const diffDays = Math.floor((todayMid - ts) / 86400000);
      if (diffDays < 0 || diffDays > 6) continue;
      days[6 - diffDays] += Number(it.amount) || 0;
    }
    return days;
  }, [items]);

  const isEmpty = !loading && balance === 0 && items.length === 0;

  // Featured pack tap → /diamond-shop with sku preselected. We use the
  // same route used by the buy CTA; diamond-shop reads the ?sku= and
  // auto-scrolls to that card.
  const onPackPress = useCallback((pack) => {
    router.push(`/diamond-shop?sku=${encodeURIComponent(pack.sku)}`);
  }, [router]);

  // ----- Render ---------------------------------------------------------

  const renderHero = () => (
    <View>
      <HeroGradient style={styles.hero}>
        <Text style={styles.heroLabel}>
          {t('wallet.currentBalance') || 'Saldo atual'}
        </Text>
        <Animated.View style={[styles.heroBalRow, { transform: [{ scale: breathScale }] }]}>
          <IconDiamond size={42} color="#fff" style={{ marginRight: 10 }} />
          <Text style={styles.heroBalVal} numberOfLines={1} adjustsFontSizeToFit>
            {formatInt(balance, language)}
          </Text>
        </Animated.View>
        <Text style={styles.heroSub}>
          {t('wallet.diamondsAvailable') || 'diamantes disponíveis'}
        </Text>

        {pendingPayout > 0 ? (
          <TouchableOpacity
            onPress={() => { tap('light'); router.push('/creator-earnings'); }}
            accessibilityRole="button"
            accessibilityLabel={t('creatorEarnings.title') || 'Meus Ganhos'}
            style={styles.payoutPillRow}
          >
            <View style={styles.payoutPillBg}>
              <Text style={styles.payoutPillText}>
                {t('wallet.pendingPayout') || 'Saque pendente'}: R$ {(pendingPayout / 100).toFixed(2).replace('.', ',')}
              </Text>
              <IconChevronRight size={14} color="#fff" />
            </View>
          </TouchableOpacity>
        ) : null}

        {/* Quick actions row inside the hero (4 buttons) */}
        <View style={styles.qaRow}>
          <QuickAction
            icon={IconGiftBox}
            tint="#FFD166"
            label={t('wallet.topup') || 'Comprar'}
            onPress={() => router.push('/diamond-shop')}
            t={t}
          />
          <QuickAction
            icon={IconSend}
            tint="#86EFAC"
            label={t('wallet.sendAction') || 'Enviar'}
            onPress={openSendPicker}
            t={t}
          />
          <QuickAction
            icon={IconClock}
            tint="#93C5FD"
            label={t('wallet.history') || 'Histórico'}
            onPress={() => { setShowAllHistory(true); tap('light'); }}
            t={t}
          />
          <QuickAction
            icon={IconArrowRight}
            tint="#FCA5A5"
            label={t('wallet.cashoutAction') || 'Sacar'}
            onPress={() => router.push('/wallet-cashout')}
            t={t}
          />
        </View>
      </HeroGradient>

      {/* Featured packs horizontal scroll */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('wallet.featuredPacks') || 'Pacotes em destaque'}
          </Text>
          <TouchableOpacity
            onPress={() => { tap('light'); router.push('/diamond-shop'); }}
            accessibilityRole="button"
          >
            <Text style={[styles.seeAll, { color: PURPLE }]}>
              {t('common.seeAll') || 'Ver tudo'}
            </Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingLeft: 14, paddingRight: 2, paddingVertical: 4 }}
        >
          {FEATURED_PACKS.map(p => (
            <PackCard
              key={p.sku}
              pack={p}
              onPress={onPackPress}
              isDark={isDark}
              colors={colors}
              language={language}
              t={t}
            />
          ))}
        </ScrollView>
      </View>

      {/* Stats card — shows when there's any spend in the 30d window */}
      {monthlySpend > 0 || sparkValues.some(v => v > 0) ? (
        <View style={[styles.statsCard, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
          borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)',
        }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.statsLabel, { color: colors.textSecondary }]}>
              {t('wallet.monthlySpend') || 'Gasto este mês'}
            </Text>
            <View style={styles.statsAmtRow}>
              <IconDiamond size={18} color={PURPLE} style={{ marginRight: 6 }} />
              <Text style={[styles.statsAmt, { color: colors.text }]}>
                {formatInt(monthlySpend, language)}
              </Text>
            </View>
            <Text style={[styles.statsSub, { color: colors.textTertiary }]}>
              {t('wallet.last7Days') || 'Últimos 7 dias'}
            </Text>
          </View>
          <Sparkline values={sparkValues} color={PURPLE} height={42} />
        </View>
      ) : null}

      {/* Top senders */}
      {topSenders.length > 0 ? (
        <View style={[styles.topSendersCard, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
          borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)',
        }]}>
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('wallet.topSenders') || 'Quem te enviou mais'}
            </Text>
          </View>
          <View style={styles.sendersRow}>
            {topSenders.map((s, i) => (
              <View key={i} style={styles.senderChip}>
                <AvatarCircle size={42} email={s.name} name={s.name} />
                <Text style={[styles.senderName, { color: colors.text }]} numberOfLines={1}>
                  {s.name.split('@')[0]}
                </Text>
                <View style={styles.senderTotal}>
                  <IconDiamond size={11} color={PURPLE} style={{ marginRight: 3 }} />
                  <Text style={[styles.senderTotalText, { color: PURPLE }]}>
                    {formatInt(s.total, language)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* [WAVE 51] Cash / BRL summary card — Dinheiro side of the wallet.
          Shows pending payout (saque disponível), recent cashout pills,
          and CTAs to /wallet-cashout + /creator-earnings. Only renders
          when there's BRL data OR a creator-eligible signal (any monthly
          gift income). */}
      {pendingPayout > 0 || insights.month_payout_cents > 0 || recentCashouts.length > 0 ? (
        <View style={[styles.cashCard, {
          backgroundColor: isDark ? 'rgba(16,185,129,0.10)' : 'rgba(16,185,129,0.08)',
          borderColor: isDark ? 'rgba(16,185,129,0.30)' : 'rgba(16,185,129,0.22)',
        }]}>
          <View style={styles.cashHeadRow}>
            <Text style={[styles.cashLabel, { color: colors.textSecondary }]}>
              {t('wallet.cashAvailable') || 'Disponível para saque'}
            </Text>
            <TouchableOpacity onPress={() => router.push('/creator-earnings')} accessibilityRole="button">
              <Text style={[styles.seeAll, { color: GREEN }]}>
                {t('wallet.earnings') || 'Ganhos'}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.cashAmtRow}>
            <Text style={[styles.cashPrefix, { color: GREEN }]}>R$</Text>
            <Text style={[styles.cashAmt, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
              {hideAmounts ? '••••' : fmtBrl(pendingPayout)}
            </Text>
          </View>
          {pendingPayout > 0 && pendingPayout < MIN_CASHOUT_CENTS ? (
            <Text style={[styles.cashHint, { color: colors.textSecondary }]}>
              {(t('wallet.minCashoutHint') || 'Faltam R$ {missing} para o saque mínimo (R$ 50,00).')
                .replace('{missing}', fmtBrl(MIN_CASHOUT_CENTS - pendingPayout))}
            </Text>
          ) : null}

          <View style={styles.cashCtaRow}>
            <TouchableOpacity
              onPress={() => { tap('medium'); router.push('/wallet-cashout'); }}
              disabled={pendingPayout < MIN_CASHOUT_CENTS}
              style={[styles.cashCta, {
                backgroundColor: pendingPayout >= MIN_CASHOUT_CENTS ? GREEN : (isDark ? 'rgba(16,185,129,0.40)' : 'rgba(16,185,129,0.45)'),
              }]}
              accessibilityRole="button"
            >
              <Text style={styles.cashCtaText}>{t('wallet.cashoutAction') || 'Sacar via PIX'}</Text>
            </TouchableOpacity>
          </View>

          {recentCashouts.length > 0 ? (
            <View style={{ marginTop: 12 }}>
              <Text style={[styles.cashSubLabel, { color: colors.textSecondary }]}>
                {t('wallet.recentCashouts') || 'Saques recentes'}
              </Text>
              {recentCashouts.slice(0, 3).map(co => {
                const status = String(co.status || 'pending');
                const c = status === 'paid' ? GREEN : status === 'rejected' ? RED : GOLD;
                const lbl = t(`wallet.statusBadge.${status}`) || status;
                return (
                  <View key={String(co.id)} style={styles.cashRow}>
                    <Text style={[styles.cashRowAmt, { color: colors.text }]} numberOfLines={1}>
                      {hideAmounts ? '••••' : `R$ ${fmtBrl(co.amount_cents)}`}
                    </Text>
                    <View style={[styles.cashStatusPill, { backgroundColor: c + '22', borderColor: c }]}>
                      <Text style={[styles.cashStatusText, { color: c }]}>{lbl}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* [WAVE 51] Creator insights — month_payout, gifts_count_30d, lifetime.
          Only renders for users with at least 1 received gift to avoid empty
          card clutter for non-creators. */}
      {insights.gifts_count_lifetime > 0 || insights.month_payout_cents > 0 ? (
        <View style={[styles.insightsCard, {
          backgroundColor: isDark ? 'rgba(245,158,11,0.10)' : 'rgba(245,158,11,0.08)',
          borderColor: isDark ? 'rgba(245,158,11,0.28)' : 'rgba(245,158,11,0.20)',
        }]}>
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('wallet.insightsTitle') || 'Seus ganhos'}
            </Text>
          </View>
          <View style={styles.insightsGrid}>
            <View style={styles.insightCol}>
              <Text style={[styles.insightVal, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
                {hideAmounts ? '••••' : `R$ ${fmtBrl(insights.month_payout_cents)}`}
              </Text>
              <Text style={[styles.insightLbl, { color: colors.textSecondary }]}>
                {t('wallet.insight30d') || 'Recebido em 30d'}
              </Text>
            </View>
            <View style={[styles.insightDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)' }]} />
            <View style={styles.insightCol}>
              <Text style={[styles.insightVal, { color: colors.text }]}>
                {insights.gifts_count_30d}
              </Text>
              <Text style={[styles.insightLbl, { color: colors.textSecondary }]}>
                {t('wallet.insightGifts30d') || 'Presentes 30d'}
              </Text>
            </View>
            <View style={[styles.insightDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)' }]} />
            <View style={styles.insightCol}>
              <Text style={[styles.insightVal, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
                {hideAmounts ? '••••' : `R$ ${fmtBrl(insights.lifetime_payout_cents)}`}
              </Text>
              <Text style={[styles.insightLbl, { color: colors.textSecondary }]}>
                {t('wallet.insightLifetime') || 'Total ganho'}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* [WAVE 51] Saved payment methods — Stripe cards from wallet_overview.
          Tap "Adicionar" pushes /diamond-shop where SetupIntent flow lives. */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('wallet.methodsTitle') || 'Métodos de pagamento'}
          </Text>
          <TouchableOpacity
            onPress={() => { tap('light'); router.push('/diamond-shop'); }}
            accessibilityRole="button"
            accessibilityLabel={t('wallet.addMethod') || 'Adicionar'}
          >
            <Text style={[styles.seeAll, { color: PURPLE }]}>
              {t('wallet.addMethod') || 'Adicionar'}
            </Text>
          </TouchableOpacity>
        </View>
        {savedCards.length > 0 ? savedCards.map(card => {
          const brand = String(card.brand || 'card').toUpperCase();
          const last4 = card.last4 || '••••';
          const exp = card.exp_month && card.exp_year
            ? `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`
            : '';
          return (
            <View key={card.id} style={[styles.methodRow, {
              backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
            }]}>
              <View style={[styles.methodIconBox, { backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.12)' }]}>
                <IconCreditCard size={18} color={PURPLE_DEEP} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.methodTitle, { color: colors.text }]} numberOfLines={1}>
                  {brand} •••• {last4}
                </Text>
                {!!exp && (
                  <Text style={[styles.methodSub, { color: colors.textSecondary }]} numberOfLines={1}>
                    {(t('wallet.cardExp') || 'Expira em')} {exp}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                onPress={() => {
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
                }}
                style={styles.methodRemove}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.cardRemove') || 'Remover'}
              >
                <IconX size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          );
        }) : (
          <TouchableOpacity
            onPress={() => { tap('light'); router.push('/diamond-shop'); }}
            style={[styles.methodEmpty, {
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
            }]}
            accessibilityRole="button"
          >
            <IconCreditCard size={20} color={colors.textTertiary} />
            <Text style={[styles.methodEmptyText, { color: colors.textTertiary }]}>
              {t('wallet.noMethods') || 'Adicione um cartão para comprar diamantes mais rápido.'}
            </Text>
            <IconChevronRight size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Activity section header */}
      <View style={[styles.section, { paddingBottom: 0 }]}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('wallet.recentActivity') || 'Atividade recente'}
          </Text>
          {items.length > 5 && !showAllHistory ? (
            <TouchableOpacity
              onPress={() => { tap('light'); setShowAllHistory(true); }}
              accessibilityRole="button"
            >
              <Text style={[styles.seeAll, { color: PURPLE }]}>
                {t('common.seeAll') || 'Ver tudo'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* [WAVE 51] History filter chips — only render when expanded.
            Backend doesn't paginate by filter; we filter client-side over
            the items we already have. */}
        {showAllHistory ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipsScroll}>
            {[
              { id: 'all', label: t('wallet.filterAll') || 'Tudo' },
              { id: 'in',  label: t('wallet.filterIn')  || 'Recebidos' },
              { id: 'out', label: t('wallet.filterOut') || 'Enviados' },
              { id: 'cashout', label: t('wallet.filterCashout') || 'Saques' },
            ].map(f => {
              const active = historyFilter === f.id;
              return (
                <TouchableOpacity
                  key={f.id}
                  onPress={() => { setHistoryFilter(f.id); tap('select'); }}
                  style={[styles.filterChip, {
                    backgroundColor: active ? PURPLE : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)'),
                    borderColor: active ? PURPLE : 'transparent',
                  }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.filterChipText, { color: active ? '#fff' : colors.text }]}>{f.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );

  const renderEmpty = () => (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIconBubble}>
        <IconDiamond size={64} color={PURPLE} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {t('wallet.emptyTitle') || 'Comece sua coleção'}
      </Text>
      <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
        {t('wallet.emptyBody') || 'Compre diamantes para presentear criadores, enviar para amigos e desbloquear conteúdo exclusivo.'}
      </Text>
      <TouchableOpacity
        onPress={() => { tap('medium'); router.push('/diamond-shop'); }}
        style={styles.emptyCta}
        accessibilityRole="button"
      >
        <IconGiftBox size={18} color="#fff" style={{ marginRight: 8 }} />
        <Text style={styles.emptyCtaText}>
          {t('wallet.topup') || 'Comprar diamantes'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  // Subset of items to render: top 5 if collapsed, all if "Ver tudo" tapped.
  const visibleItems = showAllHistory ? items : items.slice(0, 5);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Floating header — back arrow + title; bg fades in once user
          scrolls past the hero. */}
      <View style={[styles.headBar, { paddingTop: (insets.top || 0) + 6 }]}>
        <Animated.View style={[StyleSheet.absoluteFill, {
          opacity: headerOpacity,
          backgroundColor: colors.background,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
          borderBottomWidth: StyleSheet.hairlineWidth,
        }]} />
        <TouchableOpacity
          onPress={() => { tap('light'); router.back(); }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Animated.Text
          style={[styles.headTitle, { color: colors.text, opacity: headerOpacity }]}
          numberOfLines={1}
        >
          {t('wallet.myDiamonds') || 'Meus diamantes'}
        </Animated.Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={PURPLE} size="large" />
        </View>
      ) : isEmpty ? (
        <ScrollView
          contentContainerStyle={{ paddingTop: (insets.top || 0) + 60, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PURPLE} />}
        >
          {renderEmpty()}
        </ScrollView>
      ) : (
        <Animated.FlatList
          data={visibleItems}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 14 }}>
              <LedgerRow item={item} colors={colors} isDark={isDark} t={t} lang={language} compact />
            </View>
          )}
          ListHeaderComponent={renderHero()}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PURPLE} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          ListEmptyComponent={(
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('wallet.historyEmpty') || 'Nenhuma transação ainda. Compre diamantes para começar.'}
            </Text>
          )}
          ListFooterComponent={(
            <>
              {loadingMore ? (
                <View style={{ paddingVertical: 12 }}>
                  <ActivityIndicator color={PURPLE} size="small" />
                </View>
              ) : null}
              {!showAllHistory && items.length > 5 ? (
                <TouchableOpacity
                  onPress={() => { tap('light'); setShowAllHistory(true); }}
                  style={[styles.seeAllBtn, {
                    borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
                  }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.seeAllBtnText, { color: colors.text }]}>
                    {t('wallet.seeFullHistory') || 'Ver histórico completo'}
                  </Text>
                  <IconChevronRight size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
            </>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}

      <DiamondTopUpSheet
        visible={topUpOpen}
        onClose={() => { setTopUpOpen(false); load(); }}
        onBalanceChange={(b) => { if (typeof b === 'number') setBalance(b); }}
      />

      {/* Picker sheet — listar conversas diretas */}
      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: Math.max(insets.bottom, 16) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 }}>
              <View style={{ width: 34 }} />
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                {t('wallet.pickRecipient') || 'Enviar diamantes para'}
              </Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: isDark ? '#2a2a2a' : '#f1f1f4' }}>
              <IconSearch size={16} color={colors.textTertiary} />
              <TextInput
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder={t('common.search') || 'Buscar'}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 14, padding: 0 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
            {pickerLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={PURPLE} />
              </View>
            ) : filteredPickerConvs.length === 0 ? (
              <View style={{ paddingVertical: 40, paddingHorizontal: 24 }}>
                <Text style={{ textAlign: 'center', color: colors.textTertiary, fontSize: 13 }}>
                  {pickerQuery
                    ? (t('common.noResults') || 'Nenhum contato encontrado')
                    : (t('wallet.noContactsBody') || 'Sem conversas ainda. Inicie um chat para enviar diamantes.')
                  }
                </Text>
              </View>
            ) : (
              <FlatList
                data={filteredPickerConvs}
                keyExtractor={(item, idx) => String(item.id || item.peer_email || idx)}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const email = item.peer_email || item.other_email || item.email || '';
                  const name = item.peer_name || item.name || item.title || (email ? email.split('@')[0] : '');
                  const avatar = item.peer_avatar_url || item.avatar_url || item.photo_url;
                  return (
                    <TouchableOpacity
                      onPress={() => onPickerSelect(item)}
                      activeOpacity={0.7}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12 }}
                    >
                      <AvatarCircle size={42} email={email} name={name} avatarUrl={avatar} />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={1}>{name || email}</Text>
                        {!!email && email !== name && (
                          <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 1 }} numberOfLines={1}>{email}</Text>
                        )}
                      </View>
                      <IconDiamond size={18} color={PURPLE} />
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      <SendDiamondSheet
        visible={!!sendTarget}
        onClose={() => setSendTarget(null)}
        toEmail={sendTarget?.email}
        toName={sendTarget?.name}
        toAvatarUrl={sendTarget?.avatar}
        onSent={() => { setSendTarget(null); load(); }}
      />
    </View>
  );
}

// ----- Styles -----------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header (floating, fades on scroll)
  headBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingBottom: 8,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  headTitle: { fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },

  // Hero
  hero: {
    marginTop: 0, paddingTop: 80, paddingBottom: 24,
    paddingHorizontal: 18,
    overflow: 'hidden',
    // Soft purple glow shadow — works on iOS; Android falls back to elevation.
    shadowColor: PURPLE_DEEP,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 12,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  heroBase: { position: 'relative' },
  heroOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    width: '120%', height: '120%',
  },
  heroSheen: {
    position: 'absolute',
    top: 0, left: 0, right: 0, height: 60,
    backgroundColor: '#fff', opacity: 0.08,
  },
  heroLabel: {
    color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600',
    letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 6,
  },
  heroBalRow: { flexDirection: 'row', alignItems: 'center' },
  heroBalVal: {
    color: '#fff', fontSize: 56, fontWeight: '900', letterSpacing: -1.5,
    // Subtle white glow on the number
    textShadowColor: 'rgba(255,255,255,0.35)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  heroSub: { color: 'rgba(255,255,255,0.80)', fontSize: 13, marginTop: 2 },

  // Payout pill (inside hero)
  payoutPillRow: { marginTop: 14, alignSelf: 'flex-start' },
  payoutPillBg: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: 'rgba(16,185,129,0.95)',
  },
  payoutPillText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  // Quick actions row
  qaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 22, gap: 8 },
  qaWrap: { flex: 1 },
  qaInner: { alignItems: 'center' },
  qaIconBubble: {
    width: 52, height: 52, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  qaLabel: { fontSize: 12, fontWeight: '700' },

  // Section frame
  section: { paddingHorizontal: 14, paddingTop: 22 },
  sectionHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10, paddingHorizontal: 4,
  },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  seeAll: { fontSize: 13, fontWeight: '700' },

  // Pack card
  packCard: {
    width: 150, paddingHorizontal: 12, paddingVertical: 14,
    borderRadius: 18,
    alignItems: 'center',
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 4,
  },
  packIconBubble: {
    width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(168,85,247,0.10)',
    marginBottom: 8,
  },
  packAmount: { fontSize: 20, fontWeight: '900' },
  packDiamonds: { fontSize: 11, fontWeight: '600', marginTop: 1, marginBottom: 10 },
  packPricePill: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
  },
  packPriceText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  popularBadge: {
    position: 'absolute', top: -8, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: GOLD, paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 999, zIndex: 1,
  },
  popularBadgeText: { color: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },

  // Stats card
  statsCard: {
    marginHorizontal: 14, marginTop: 18,
    flexDirection: 'row', alignItems: 'center',
    padding: 16, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statsLabel: {
    fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4,
  },
  statsAmtRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  statsAmt: { fontSize: 24, fontWeight: '900' },
  statsSub: { fontSize: 11, marginTop: 2 },
  sparkRow: { flexDirection: 'row', alignItems: 'flex-end' },

  // Top senders
  topSendersCard: {
    marginHorizontal: 14, marginTop: 16,
    padding: 14, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendersRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  senderChip: { flex: 1, alignItems: 'center' },
  senderName: { fontSize: 12, fontWeight: '700', marginTop: 6, maxWidth: 70 },
  senderTotal: {
    flexDirection: 'row', alignItems: 'center', marginTop: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: 'rgba(168,85,247,0.12)',
  },
  senderTotalText: { fontSize: 11, fontWeight: '800' },

  // Ledger row
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIconBubble: {
    width: 34, height: 34, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  rowLeft: { flex: 1, paddingRight: 12 },
  rowKind: { fontSize: 14, fontWeight: '700' },
  rowCp: { fontSize: 12, marginTop: 2 },
  rowWhen: { fontSize: 11, marginTop: 2 },
  rowAmount: { fontSize: 15, fontWeight: '800' },

  // See-all CTA at bottom of collapsed history
  seeAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: 14, marginTop: 12, paddingVertical: 12,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  seeAllBtnText: { fontSize: 14, fontWeight: '700' },

  // Empty state
  emptyWrap: {
    paddingHorizontal: 32, paddingTop: 20,
    alignItems: 'center',
  },
  emptyIconBubble: {
    width: 140, height: 140, borderRadius: 70,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(168,85,247,0.12)',
    marginBottom: 20,
  },
  emptyTitle: { fontSize: 22, fontWeight: '900', textAlign: 'center', marginBottom: 8 },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, paddingVertical: 14,
    backgroundColor: PURPLE, borderRadius: 999,
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 14,
    elevation: 8,
  },
  emptyCtaText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  empty: { textAlign: 'center', fontSize: 13, paddingVertical: 40 },
});
