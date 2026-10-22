// /wallet — Carteira de diamantes.
//
// [2026-10-14 carteira-v3] Repaginação completa nível fintech P&B (Apple
// Wallet/Cash, Revolut, Nubank P&B, TikTok Coins). O diamante é a única cor;
// verde/vermelho só p/ estado (+ crédito, saldo negativo).
//   • Cartão-herói grafite (igual nos 2 temas): saldo com contagem animada,
//     "Comprar diamantes" (preenchido) + "Enviar presente". [2026-10-16
//     carteira-clara] SEM "≈ valor" e SEM "Sacar" aqui: diamante comprado não é
//     sacável (regra das lojas + antifraude) — o saque mora no cartão de Ganhos.
//   • Ganhos (criador): disponível p/ saque em R$, retido 7 dias, barra até o
//     mínimo (R$ 50), link Meus Ganhos.
//   • Mais vendidos: carrossel com preço da loja local (mesmo fluxo de compra
//     do DiamondStorePanel via useDiamondStore: iOS StoreKit, Android Play/"Em
//     breve", web Stripe; menor/servidor desligado = bloqueado).
//   • Atividade: agrupada por dia, filtro por tipo, paginação infinita,
//     detalhe da transação num sheet (id, data/hora, status, copiar/compartilhar).
// Sem P2P (desligado no servidor): presente é pelo chat/live/reel/post.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, ScrollView, Platform } from 'react-native';
import UIRefreshControl from '../components/ui/RefreshControl'; // [2026-10-16 motion] P&B + toque soft ao armar
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView, IOS_NATIVE_INSET, nativeListLargeTitleOn } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import * as api from '../services/api';
import { WALLET_ENABLED } from '../constants/featureFlags';
import { IconChevronRight, IconBroadcast, IconReels, IconMessageCircle } from '../components/Icons';
import { TopBar, useSurface, Skeleton, PressableScale, FadeSlideIn, Sheet, ActionList, Type, Space, Radius, Layout } from '../components/ui';
import { haptic } from '../constants/theme';
import { formatInt } from '../utils/dateFormat';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import { peekCached, putCached } from '../hooks/useCachedAction';
import { WALLET_SCREEN, fetchWalletScreen } from '../services/screenData';
import { useWallet, isMinorAccount, MIN_CASHOUT_CENTS, getCachedGiftCatalog, loadGiftCatalog, noteCashoutRules } from '../services/diamonds';
import useDiamondStore from '../components/diamonds/useDiamondStore';
import {
  tr, moneyBRL, TABULAR, HERO, HeroCard, AnimatedNumber, DiamondMark,
  ProgressBar, TxGlyph, FilterChips, PackCard, NOFLEX, txCategory, QuickActions,
} from '../components/wallet/WalletKit';
import {
  WALLET_PAGE, RECV, filterOf, describe, buildActivityRows, walletFilters, emptyMsg,
  TxRow, TxDetailSheet, EmptyActivity, DayHeader, txSubtitle,
} from '../components/wallet/WalletActivity';
// [2026-10-15 native-wallet] Herói + histórico em NATIVO (kill switch __chatyy_native_wallet).
import NativeWalletList, { useNativeWallet, walletColors } from '../components/native/NativeWalletList';
import WalletHowItWorksSheet from '../components/wallet/WalletHowItWorksSheet';

const PAGE = WALLET_PAGE;
const FEATURED = [550, 1700, 6000];

// [2026-10-21 carteira-pro] Equivalência EXATA do saldo (sem "≈" e sem valor em
// dinheiro — diretriz de 16/10): quantos presentes do maior presente que cabe no
// saldo. Ex.: 450 → "Dá para 2 Coroas" (Coroa = 199).
function giftEquivalence(balance, t) {
  const n = Number(balance) || 0;
  if (n <= 0) return '';
  const cat = (getCachedGiftCatalog() || []).filter((g) => Number(g.diamonds_cost) > 0)
    .sort((a, b) => Number(b.diamonds_cost) - Number(a.diamonds_cost));
  const g = cat.find((x) => Number(x.diamonds_cost) <= n && Number(x.diamonds_cost) >= 5) || cat.find((x) => Number(x.diamonds_cost) <= n);
  if (!g) return '';
  const qty = Math.floor(n / Number(g.diamonds_cost));
  const name = g.label_key ? tr(t, g.label_key, g.label || g.sku) : (g.label || g.sku);
  return tr(t, 'walletPro.equivalence', 'Dá para enviar {n}× {gift}').replace('{n}', String(qty)).replace('{gift}', name);
}

function WalletSkeleton({ insetsTop }) {
  return (
    <View style={[styles.body, { gap: Space.md, paddingTop: Layout.gutter + (insetsTop || 0) }]}>
      <Skeleton height={232} radius={22} />
      <Skeleton height={132} radius={Radius.card + 4} delay={60} />
      <View style={{ flexDirection: 'row', gap: Space.sm }}>
        <Skeleton height={170} width={150} radius={Radius.card + 4} delay={90} />
        <Skeleton height={170} width={150} radius={Radius.card + 4} delay={110} />
        <Skeleton height={170} width={150} radius={Radius.card + 4} delay={130} />
      </View>
      <Skeleton height={14} width={90} radius={6} delay={150} />
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md }}>
          <Skeleton height={40} width={40} radius={20} delay={160 + i * 30} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton height={13} width="55%" radius={6} delay={160 + i * 30} />
            <Skeleton height={11} width="35%" radius={6} delay={170 + i * 30} />
          </View>
          <Skeleton height={14} width={56} radius={6} delay={180 + i * 30} />
        </View>
      ))}
    </View>
  );
}

function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  useCurrency();
  const wallet = useWallet();
  const store = useDiamondStore({ t, language });
  // [2026-10-14 offline-first] última 1ª página salva no aparelho (por conta) → sem skeleton na 2ª abertura.
  const _seed = useMemo(() => peekCached(WALLET_SCREEN.key), []);
  const [items, setItems] = useState(() => (Array.isArray(_seed?.items) ? _seed.items : []));
  const [loading, setLoading] = useState(() => !_seed);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(() => !!_seed?.has_more);
  const [loadingMore, setLoadingMore] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState(null);
  const busyRef = useRef(false);
  const [nativeOn, onNativeFail] = useNativeWallet();

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
      const r = await api.walletHistory({ limit: PAGE, offset: items.length });
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

  const title = tr(t, 'wallet.title', 'Carteira');
  // [2026-10-17 carteira-sem-piscar] Skeleton SÓ quando não há nada local (nem
  // histórico nem saldo em cache). Com o saldo do cache por conta, a tela já
  // nasce no layout final (herói + blocos) e só a lista espera a rede — antes o
  // 1º open sem histórico salvo trocava skeleton → conteúdo de uma vez (flash).
  const showSkeleton = loading && !wallet.loaded;
  const minor = isMinorAccount();
  const negative = typeof wallet.diamonds === 'number' && wallet.diamonds < 0;
  const off = wallet.loaded && !wallet.enabled;
  const isCreator = wallet.availableCents > 0 || wallet.onHoldCents > 0 || wallet.pendingCents > 0 || items.some((x) => RECV.has(String(x.kind)));
  const canPurchase = !minor && !off && wallet.purchaseEnabled !== false;
  // Regras de saque = SERVIDOR (wallet_balance / creator_earnings_summary). A
  // constante só serve p/ a barra enquanto o servidor não respondeu.
  const minKnown = Number(wallet.minCashoutCents) > 0;
  const min = minKnown ? Number(wallet.minCashoutCents) : (MIN_CASHOUT_CENTS || 5000);
  const holdDays = Number(wallet.holdDays) || 0;
  const available = wallet.availableCents || 0;
  const reachedMin = available >= min;
  const canCashout = reachedMin && wallet.cashoutEnabled && !minor;
  const openTopup = useCallback(() => setTopupOpen(true), []);
  const minText = minKnown
    ? tr(t, 'walletHow.minHint', 'Você pode sacar a partir de {min} em ganhos de presentes recebidos.').replace('{min}', moneyBRL(min))
    : tr(t, 'walletHow.minHintNoValue', 'Você pode sacar ao atingir o mínimo em ganhos de presentes recebidos.');
  const goCashout = () => {
    if (canCashout) { router.push('/wallet-cashout'); return; }
    try { haptic.light(); } catch {}
    setHowOpen(true);
  };
  // Criador sem regras no cache → pede o resumo 1x (traz mínimo/retenção reais).
  const rulesAsked = useRef(false);
  useEffect(() => {
    if (!isCreator || rulesAsked.current || (minKnown && holdDays > 0)) return;
    rulesAsked.current = true;
    api.creatorEarningsSummary?.({ limit: 1 }).then((r) => { if (r?.success && r.data) noteCashoutRules(r.data); }).catch(() => {});
  }, [isCreator, minKnown, holdDays]);

  const featured = useMemo(() => {
    const list = store.packs || [];
    const pick = list.filter((p) => FEATURED.includes(Number(p.diamonds)));
    return (pick.length >= 2 ? pick : list.slice(1, 4)).slice(0, 3);
  }, [store.packs]);

  const filters = walletFilters(t);


  // [2026-10-16 carteira-clara] nada de "≈ US$ … em valor de compra": diamante
  // não é dinheiro sacável. Linha-guia do uso real.
  // [2026-10-21 carteira-pro] + equivalência exata em presentes ("Dá para
  // enviar 2× Coroa") quando há saldo; catálogo vem do cache/servidor.
  const [giftCatTick, setGiftCatTick] = useState(0);
  useEffect(() => { let on = true; loadGiftCatalog().then(() => { if (on) setGiftCatTick((n) => n + 1); }).catch(() => {}); return () => { on = false; }; }, []);
  const equivalence = useMemo(() => (giftCatTick >= 0 ? giftEquivalence(wallet.diamonds, t) : ''), [wallet.diamonds, t, giftCatTick]);
  const heroSub = equivalence || tr(t, 'walletHow.diamondsUse', 'Use para enviar presentes');
  const canGift = !minor && !off && wallet.giftingEnabled !== false;
  const quickActions = [
    { id: 'buy', glyph: 'plus', primary: true, label: tr(t, 'walletPro.qaBuy', 'Comprar'), a11y: tr(t, 'wallet.topup', 'Comprar diamantes'), disabled: !canPurchase, onPress: openTopup, testID: 'wallet-buy' },
    { id: 'gift', glyph: 'gift', label: tr(t, 'walletV3.sendGift', 'Enviar presente'), disabled: !canGift, onPress: () => setGiftOpen(true), testID: 'wallet-gift' },
    { id: 'history', glyph: 'history', label: tr(t, 'wallet.history', 'Histórico'), a11y: tr(t, 'walletPro.qaHistoryA11y', 'Ver todo o histórico'), onPress: () => router.push('/wallet-history'), testID: 'wallet-history' },
  ];

  const heroCard = (
      <FadeSlideIn style={NOFLEX}>
        <HeroCard isDark={isDark}>
          <View style={styles.heroTop}>
            <Text style={[styles.heroCaps, { color: HERO.sub }]}>{tr(t, 'wallet.diamondBalance', 'Saldo de diamantes')}</Text>
            <Text style={[styles.heroBrand, { color: HERO.faint }]}>CHATYY</Text>
          </View>
          <View style={styles.balRow} accessible accessibilityRole="summary"
            accessibilityLabel={`${tr(t, 'wallet.diamondBalance', 'Saldo de diamantes')}: ${wallet.diamonds == null ? '—' : formatInt(wallet.diamonds, language)}`}>
            <DiamondMark size={30} color={HERO.text} />
            <AnimatedNumber
              value={typeof wallet.diamonds === 'number' ? wallet.diamonds : null}
              format={(n) => formatInt(n, language)}
              style={[styles.bigNum, { color: negative ? HERO.danger : HERO.text }]}
              adjustsFontSizeToFit
              minimumFontScale={0.55}
            />
          </View>
          <Text style={[Type.footnote, { color: HERO.sub, marginTop: 2 }]}>{heroSub}</Text>
          {negative ? (
            <Text style={[Type.footnote, { color: HERO.sub, marginTop: Space.sm }]}>
              {tr(t, 'gifts.negativeBalance', 'Seu saldo está negativo por causa de um reembolso. Recarregue para voltar a enviar.')}
            </Text>
          ) : null}
          {minor ? (
            <View style={[styles.heroNotice, { borderColor: HERO.line }]}>
              <Text style={[Type.footnote, { color: HERO.sub }]}>{tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.')}</Text>
            </View>
          ) : off ? (
            <View style={[styles.heroNotice, { borderColor: HERO.line }]}>
              <Text style={[Type.footnote, { color: HERO.sub }]}>{tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.')}</Text>
            </View>
          ) : (
            // [2026-10-21 carteira-pro] ações saíram do cartão → botões redondos logo abaixo.
            <View style={[styles.heroFoot, { borderColor: HERO.line }]}>
              <Text style={[Type.caption, { color: HERO.faint }]} numberOfLines={1}>{tr(t, 'walletPro.heroFoot', 'Diamantes · presentes em lives, reels, posts e conversas')}</Text>
            </View>
          )}
        </HeroCard>
      </FadeSlideIn>
  );

  // Blocos abaixo do herói (no nativo viram o filho RN, logo abaixo do herói nativo).
  const restBlocks = (
    <>
      {/* ── Ações principais (redondas) ─────────────────────── */}
      <QuickActions actions={quickActions} s={s} />
      {/* ── Ganhos (criador) ─────────────────────────────────── */}
      {isCreator ? (
        <FadeSlideIn delay={60} style={NOFLEX}>
          <View style={[styles.card, { backgroundColor: s.surface, borderColor: s.border }]}>
            <View style={styles.cardHead}>
              <Text style={[Type.sectionCaps, styles.caps, { color: s.textSecondary }]}>{tr(t, 'walletV3.earnings', 'Ganhos')}</Text>
              <PressableScale onPress={() => router.push('/creator-earnings')} hitSlop={10} accessibilityRole="link" style={styles.linkRow}>
                <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{tr(t, 'creatorEarnings.title', 'Meus Ganhos')}</Text>
                <IconChevronRight size={16} color={s.textSecondary} />
              </PressableScale>
            </View>
            <View style={styles.earnAmtRow}>
              <AnimatedNumber value={available} format={(n) => moneyBRL(n)} style={[styles.midNum, { color: s.text }]} />
            </View>
            <Text style={[Type.footnote, { color: s.textSecondary }]}>{tr(t, 'creatorEarnings.availableLabel', 'Disponível para saque')}</Text>
            <View style={{ marginTop: Space.md }}>
              <ProgressBar progress={available / min} color={s.ink} track={s.fill}
                label={tr(t, 'walletV3.progressLabel', 'Progresso até o saque mínimo')} />
              <Text style={[Type.caption, { color: s.textSecondary, marginTop: Space.sm }]}>
                {reachedMin
                  ? tr(t, 'walletV3.readyToCashout', 'Pronto para sacar via Pix')
                  : minKnown
                    ? tr(t, 'creatorDash.missing', 'Faltam {missing} para o saque mínimo de {min}').replace('{missing}', moneyBRL(min - available)).replace('{min}', moneyBRL(min))
                    : tr(t, 'creatorEarnings.belowMin', 'Abaixo do mínimo para saque.')}
              </Text>
            </View>
            <View style={[styles.holdRow, { borderTopColor: s.separator }]}>
              <View style={{ flex: 1 }}>
                <Text style={[Type.subhead, { color: s.text }]}>{tr(t, 'walletV3.onHold', 'Em liberação')}</Text>
                <Text style={[Type.caption, { color: s.textSecondary }]}>
                  {holdDays > 0
                    ? tr(t, 'walletV3.onHoldSub', 'Presentes ficam retidos {days} dias').replace('{days}', String(holdDays))
                    : tr(t, 'walletHow.onHoldSubNoDays', 'Presentes recentes, ainda no prazo de estorno')}
                </Text>
              </View>
              <Text style={[Type.subhead, TABULAR, { color: s.text, fontWeight: '700' }]}>{moneyBRL(wallet.onHoldCents)}</Text>
            </View>
            {/* Sacar mora AQUI (só ganhos são sacáveis). Abaixo do mínimo: visual
                desabilitado, mas tocável → explica (folha "Como funciona"). */}
            <PressableScale onPress={goCashout} haptic={canCashout ? 'medium' : false} testID="wallet-cashout"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canCashout }}
              accessibilityLabel={canCashout ? tr(t, 'creatorDash.withdraw', 'Sacar') : `${tr(t, 'creatorDash.withdraw', 'Sacar')}. ${minText}`}
              accessibilityHint={canCashout ? undefined : tr(t, 'walletHow.tapToLearn', 'Toque para saber como funciona')}
              style={[styles.cashBtn, canCashout ? { backgroundColor: s.ink } : { backgroundColor: s.fill }]}>
              <Text style={[styles.cashBtnText, { color: canCashout ? s.onInk : s.textTertiary }]}>{tr(t, 'creatorDash.withdraw', 'Sacar')}</Text>
            </PressableScale>
            {!canCashout ? (
              <PressableScale onPress={() => setHowOpen(true)} haptic="select" hitSlop={8} accessibilityRole="button" style={styles.cashWhy}>
                <Text style={[Type.caption, { color: s.textSecondary, textAlign: 'center' }]}>
                  {/* [2026-10-19 carteira-polish] sem o 2º "Como funciona" colado (o cartão logo abaixo já é o atalho) */}
                  {!wallet.cashoutEnabled && reachedMin ? tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.') : minText}
                </Text>
              </PressableScale>
            ) : null}
          </View>
        </FadeSlideIn>
      ) : null}

      {/* ── Como funciona (todos) ───────────────────────────── */}
      <PressableScale onPress={() => setHowOpen(true)} haptic="select" accessibilityRole="button"
        style={[styles.howRow, { backgroundColor: s.surface, borderColor: s.border }]} testID="wallet-how">
        <View style={[styles.howIcon, { borderColor: s.separator }]}><TxGlyph name="receipt" size={18} color={s.text} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{tr(t, 'walletHow.title', 'Como funciona')}</Text>
          <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={2}>{tr(t, 'walletHow.rowSub', 'Diamantes são para presentear. Presentes que você recebe viram ganhos sacáveis.')}</Text>
        </View>
        <IconChevronRight size={16} color={s.textSecondary} />
      </PressableScale>

      {/* ── Mais vendidos ───────────────────────────────────── */}
      {canPurchase && featured.length ? (
        <FadeSlideIn delay={110} style={NOFLEX}>
          <View style={styles.secHead}>
            <Text style={[Type.title3, { color: s.text, fontWeight: '700' }]} accessibilityRole="header">{tr(t, 'walletV3.bestSellers', 'Mais vendidos')}</Text>
            <PressableScale onPress={() => router.push('/diamond-shop')} hitSlop={10} accessibilityRole="link" style={styles.linkRow}>
              <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{tr(t, 'walletV3.seeAll', 'Ver todos')}</Text>
              <IconChevronRight size={16} color={s.textSecondary} />
            </PressableScale>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.carousel}
            snapToInterval={150 + Space.sm} decelerationRate="fast" style={styles.carouselWrap}>
            {featured.map((p) => (
              <PackCard key={p.sku} pack={p} s={s} t={t} language={language} width={150}
                price={store.priceLabel(p)} soon={store.isSoon(p)}
                disabled={!store.canBuy(p) || !!store.pendingSku}
                loading={store.pendingSku === p.sku}
                highlight={Number(p.diamonds) === 1700}
                badge={Number(p.diamonds) === 1700 ? tr(t, 'walletV3.popular', 'Mais popular') : undefined}
                onPress={() => store.onBuy(p)} />
            ))}
          </ScrollView>
          {store.banner ? (
            <Text style={[Type.footnote, { color: store.banner.tone === 'warn' ? s.danger : s.text, marginTop: Space.sm }]} accessibilityLiveRegion="polite">{store.banner.text}</Text>
          ) : store.allSoon && store.iapState !== 'connecting' ? (
            <Text style={[Type.caption, { color: s.textSecondary, marginTop: Space.sm }]}>
              {Platform.OS === 'android'
                ? tr(t, 'diamondShop.androidSoon', 'A compra de diamantes pelo Google Play chega em breve.')
                : tr(t, 'diamondShop.iosSoon', 'Os pacotes de diamantes estão chegando à App Store.')}
            </Text>
          ) : null}
        </FadeSlideIn>
      ) : null}

      {/* ── Atividade ───────────────────────────────────────── */}
      <View style={{ gap: Space.md, marginTop: Space.xs }}>
        <View style={styles.secHeadTight}>
          <Text style={[Type.title3, { color: s.text, fontWeight: '700' }]} accessibilityRole="header">{tr(t, 'walletV3.activity', 'Atividade')}</Text>
          <PressableScale onPress={() => router.push('/wallet-history')} hitSlop={10} accessibilityRole="link" style={styles.linkRow} testID="wallet-see-all">
            <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{tr(t, 'walletV3.seeAll', 'Ver todos')}</Text>
            <IconChevronRight size={16} color={s.textSecondary} />
          </PressableScale>
        </View>
        <View style={styles.chipsBleed}>
          <FilterChips options={filters} value={filter} onChange={setFilter} s={s} inset={Layout.gutter} fadeColor={s.bgGrouped} />
        </View>
      </View>
    </>
  );

  const header = (
    <View style={{ gap: Space.lg }}>
      {/* ── Cartão-herói ─────────────────────────────────────── */}
      {heroCard}
      {restBlocks}
    </View>
  );

  const renderItem = useCallback(({ item: r }) => {
    if (r.type === 'day') return <DayHeader row={r} s={s} language={language} />;
    return <TxRow item={r.item} s={s} t={t} language={language} first={r.first} last={r.last} onPress={() => setDetail(r.item)} />;
  }, [s, t, language]);

  // ── [2026-10-15 native-wallet] Modelo do herói + linhas da lista nativa ──
  const nativeHero = useMemo(() => {
    if (!nativeOn) return null;
    const bal = typeof wallet.diamonds === 'number' ? wallet.diamonds : null;
    const caps = tr(t, 'wallet.diamondBalance', 'Saldo de diamantes');
    // [2026-10-21 carteira-pro] botões do herói nativo vazios: as ações agora são
    // os botões REDONDOS (QuickActions, 1º bloco RN logo abaixo do herói).
    const buttons = [];
    // [2026-10-17 carteira-sem-piscar] `value` = null + `text` pronto: o herói
    // nativo rolava a contagem 0 → saldo A CADA abertura (o "pisca" do número).
    // Saldo vem do cache por conta (services/diamonds) → 1º quadro já certo.
    return {
      caps, brand: 'CHATYY', value: null, fmt: 'int', loc: language || '',
      text: bal == null ? '—' : formatInt(bal, language), dia: true, danger: !!negative, numSize: 46,
      sub: heroSub,
      note: negative ? tr(t, 'gifts.negativeBalance', 'Seu saldo está negativo por causa de um reembolso. Recarregue para voltar a enviar.') : '',
      notice: minor ? tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.')
        : off ? tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.') : '',
      buttons, glow: true,
      a11y: `${caps}: ${bal == null ? '—' : formatInt(bal, language)}`,
    };
  }, [nativeOn, wallet.diamonds, t, language, canPurchase, negative, heroSub, minor, off]);

  const nativeRows = useMemo(() => {
    if (!nativeOn) return [];
    const out = [];
    let sid = '';
    for (const r of rows) {
      if (r.type === 'day') { sid = r.key; out.push({ id: r.key, k: 'd', t: r.label }); continue; }
      const it = r.item;
      const d = describe(it, t);
      const sub = txSubtitle(d, it, t, language);
      const sign = d.credit ? '+' : '−';
      const mainIsMoney = d.diamonds == null && d.payout != null;
      const a11y = `${d.title}. ${d.diamonds != null ? sign + formatInt(Math.abs(d.diamonds), language) + ' ' + tr(t, 'wallet.diamondsLabel', 'diamantes') : ''} ${d.payout != null ? sign + moneyBRL(d.payout) : ''}. ${sub}`;
      out.push({
        id: 'tx' + String(it.id ?? out.length), k: 'x', sid, gl: txCategory(d.kind), t: d.title, sb: sub,
        am: mainIsMoney ? `${sign}${moneyBRL(d.payout)}` : `${sign}${formatInt(Math.abs(d.diamonds || 0), language)}`,
        cr: d.credit ? 1 : 0, dm: mainIsMoney ? 0 : 1,
        a2: !mainIsMoney && d.payout != null ? `+${moneyBRL(d.payout)}` : '',
        a11y,
      });
    }
    if (!filtered.length && loading) {
      // [2026-10-17 carteira-sem-piscar] histórico ainda vindo (sem cache) →
      // spinner discreto NO LUGAR da lista; herói/blocos já no layout final.
      out.push({ id: 'loading', k: 'l' });
      return out;
    }
    if (!filtered.length && !more && !loadingMore) {
      const msg = emptyMsg(filter);
      const btn = canPurchase && (filter === 'all' || filter === 'purchases');
      out.push({
        id: 'empty:' + filter, k: 'e', gl: 'receipt',
        t: tr(t, 'wallet.historyEmptyTitle', 'Nenhuma transação ainda'), sb: tr(t, msg[0], msg[1]),
        b: btn ? tr(t, 'wallet.topup', 'Comprar diamantes') : '', ba: btn ? 'buy' : '',
      });
    }
    if (loadingMore) out.push({ id: 'loading', k: 'l' });
    else if (!more && filtered.length > 8) out.push({ id: 'end', k: 'n', t: tr(t, 'walletV3.endOfList', 'Isso é tudo por aqui') });
    return out;
  }, [nativeOn, rows, filtered.length, more, loadingMore, loading, filter, canPurchase, t, language]);

  const txById = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set('tx' + String(it.id), it);
    return m;
  }, [items]);

  const onNativeHero = useCallback((id) => {
    if (id === 'buy') { if (canPurchase) openTopup(); }
    else if (id === 'gift') setGiftOpen(true);
  }, [canPurchase, openTopup]);
  const nativeColors = useMemo(() => walletColors(s, isDark), [s, isDark]);

  const footer = loadingMore ? (
    <View style={styles.more}><ActivityIndicator color={s.textSecondary} /></View>
  ) : (!more && filtered.length > 8 ? (
    <Text style={[Type.caption, { color: s.textTertiary, textAlign: 'center', marginTop: Space.lg }]}>{tr(t, 'walletV3.endOfList', 'Isso é tudo por aqui')}</Text>
  ) : null);

  return (
    <View style={{ flex: 1, backgroundColor: s.bgGrouped }}>
      {USE_NATIVE_HEADER ? (
        // [2026-10-15 nav-motion] iOS: título grande que colapsa ao rolar (spring
        // do UINavigationBar). A FlatList é o 1º scrollable → o UIKit a acompanha.
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title, largeTitle: nativeListLargeTitleOn(), headerLargeTitle: nativeListLargeTitleOn(), headerLargeStyle: { backgroundColor: s.bgGrouped } })} /* [2026-10-17 freeze] large title + lista nativa = laço na main thread (nativeListLargeTitleOn) */ />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} maxWidth={Layout.contentMaxWidth} />
      )}
      {showSkeleton ? (
        <NativeInsetView><WalletSkeleton /></NativeInsetView>
      ) : nativeOn ? (
        <NativeWalletList
          hero={nativeHero}
          rows={nativeRows}
          header={<View style={{ gap: Space.lg }}>{restBlocks}</View>}
          colors={nativeColors}
          isDark={isDark}
          maxWidth={Layout.contentMaxWidth}
          autoInset={IOS_NATIVE_INSET}
          bottomInset={IOS_NATIVE_INSET ? Space.xxxl : Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl)}
          heroTop={Layout.gutter}
          heroGap={Space.lg}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={loadMore}
          onHeroAction={onNativeHero}
          onRowPress={(id) => { const it = txById.get(id); if (it) setDetail(it); }}
          onRowAction={(id, action) => { if (action === 'buy' && canPurchase) openTopup(); }}
          onFailure={onNativeFail}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={loading ? <View style={styles.more}><ActivityIndicator color={s.textSecondary} /></View> : more || loadingMore ? null : <View style={{ marginTop: Space.md }}><EmptyActivity s={s} t={t} filter={filter} onBuy={canPurchase ? openTopup : null} /></View>}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          {...nativeScrollInsetProps()}
          contentContainerStyle={[styles.body, { paddingBottom: IOS_NATIVE_INSET ? Space.xxxl : Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          windowSize={9}
          refreshControl={<UIRefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
        />
      )}
      <DiamondTopUpSheet visible={topupOpen} onClose={() => { setTopupOpen(false); load(); }} />
      <Sheet visible={giftOpen} onClose={() => setGiftOpen(false)} title={tr(t, 'walletV3.sendGift', 'Enviar presente')}
        subtitle={tr(t, 'walletV3.sendGiftSub', 'Presentes são enviados onde a pessoa está. Escolha um lugar:')}>
        <ActionList
          onDone={() => setGiftOpen(false)}
          items={[
            { key: 'live', label: tr(t, 'walletV3.giftInLive', 'Numa live'), subtitle: tr(t, 'walletV3.giftInLiveSub', 'Apoie quem está ao vivo agora'), icon: IconBroadcast, onPress: () => router.push('/live-discover') },
            { key: 'reels', label: tr(t, 'walletV3.giftInReels', 'Em reels e posts'), subtitle: tr(t, 'walletV3.giftInReelsSub', 'Toque no presente embaixo do vídeo'), icon: IconReels, onPress: () => router.push('/spotlight') },
            { key: 'chat', label: tr(t, 'walletV3.giftInChat', 'Numa conversa'), subtitle: tr(t, 'walletV3.giftInChatSub', 'Abra o chat e toque em + › Presente'), icon: IconMessageCircle, onPress: () => router.push('/chat') },
          ]}
        />
      </Sheet>
      <WalletHowItWorksSheet visible={howOpen} onClose={() => setHowOpen(false)} />
      <TxDetailSheet item={detail} onClose={() => setDetail(null)} s={s} t={t} language={language} />
      {store.checkout}
    </View>
  );
}

export default function WalletRoute() {
  if (!WALLET_ENABLED) return <Redirect href="/chat" />;
  return <WalletScreen />;
}

const styles = StyleSheet.create({
  body: { padding: Layout.gutter, width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center' },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroCaps: { fontSize: 12, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase' },
  heroBrand: { fontSize: 11, fontWeight: '800', letterSpacing: 2.2 },
  balRow: { flexDirection: 'row', alignItems: 'center', marginTop: Space.sm, marginLeft: -10 },
  bigNum: { flex: 1, fontSize: 46, lineHeight: 54, fontWeight: '700', letterSpacing: -1.4, marginLeft: 2 },
  heroFoot: { marginTop: Space.xl, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Space.md },
  secHeadTight: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroNotice: { marginTop: Space.lg, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Space.md },
  card: { borderRadius: Radius.card + 4, padding: Space.lg, borderWidth: StyleSheet.hairlineWidth },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Space.xs },
  caps: { letterSpacing: 0.8 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32 },
  earnAmtRow: { flexDirection: 'row', alignItems: 'baseline', gap: Space.sm, marginTop: 2 },
  midNum: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.8 },
  cashBtn: { height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginTop: Space.lg },
  cashBtnText: { fontSize: 16, fontWeight: '700' },
  cashWhy: { marginTop: Space.sm, paddingHorizontal: Space.sm },
  howRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, borderRadius: Radius.card + 4, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: Space.lg, paddingVertical: Space.md, minHeight: 64 },
  howIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  holdRow: { flexDirection: 'row', alignItems: 'center', marginTop: Space.md, paddingTop: Space.md, borderTopWidth: StyleSheet.hairlineWidth },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Space.md },
  carouselWrap: { marginHorizontal: -Layout.gutter, flexGrow: 0, flexShrink: 0 },
  carousel: { gap: Space.sm, paddingHorizontal: Layout.gutter, paddingVertical: 4 },
  chipsBleed: { marginHorizontal: -Layout.gutter },
  dayLabel: { fontWeight: '600', marginTop: Space.lg, marginBottom: Space.sm, marginLeft: Space.xs },
  txRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md, minHeight: 64 },
  txFirst: { borderTopLeftRadius: Radius.card + 4, borderTopRightRadius: Radius.card + 4 },
  txLast: { borderBottomLeftRadius: Radius.card + 4, borderBottomRightRadius: Radius.card + 4 },
  txIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  txMid: { flex: 1, minWidth: 0, marginLeft: Space.md },
  txRight: { alignItems: 'flex-end', marginLeft: Space.sm },
  txSep: { position: 'absolute', left: Space.lg + 40 + Space.md, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  amt: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  more: { alignItems: 'center', justifyContent: 'center', minHeight: 56 },
  empty: { borderRadius: Radius.card + 4, alignItems: 'center', paddingVertical: Space.xxl + 8, paddingHorizontal: Space.xl },
  emptyIcon: { width: 60, height: 60, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  emptyBtn: { marginTop: Space.lg, height: 40, paddingHorizontal: Space.xl, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dHead: { alignItems: 'center', paddingHorizontal: Space.xl, paddingTop: Space.sm, paddingBottom: Space.lg },
  dIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  dBig: { fontSize: 36, lineHeight: 42, fontWeight: '700', letterSpacing: -1 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: Space.md },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  dBody: { paddingHorizontal: Space.xl },
  dRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, gap: Space.md },
  dRowVal: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexShrink: 1, justifyContent: 'flex-end' },
  copyBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  dActions: { paddingHorizontal: Space.xl, paddingTop: Space.lg, paddingBottom: Space.sm },
  dBtn: { height: 50, borderRadius: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  dBtnText: { fontSize: 15, fontWeight: '700' },
});
