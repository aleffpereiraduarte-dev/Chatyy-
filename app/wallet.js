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
import { View, Text, StyleSheet, FlatList, ActivityIndicator, ScrollView, Share, Platform } from 'react-native';
import UIRefreshControl from '../components/ui/RefreshControl'; // [2026-10-16 motion] P&B + toque soft ao armar
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView, IOS_NATIVE_INSET, nativeListLargeTitleOn } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import * as api from '../services/api';
import { WALLET_ENABLED } from '../constants/featureFlags';
import { IconDiamond, IconChevronRight, IconBroadcast, IconReels, IconMessageCircle, IconCopy, IconShare } from '../components/Icons';
import { TopBar, useSurface, Skeleton, PressableScale, FadeSlideIn, Sheet, ActionList, showToast, Type, Space, Radius, Layout } from '../components/ui';
import { haptic } from '../constants/theme';
import { formatInt } from '../utils/dateFormat';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import { peekCached, putCached } from '../hooks/useCachedAction';
import { WALLET_SCREEN, fetchWalletScreen } from '../services/screenData';
import { useWallet, refreshWallet, isMinorAccount, MIN_CASHOUT_CENTS, getCachedGiftCatalog, noteCashoutRules } from '../services/diamonds';
import useDiamondStore from '../components/diamonds/useDiamondStore';
import {
  tr, moneyBRL, TABULAR, HERO, HeroCard, HeroButton, AnimatedNumber, DiamondMark,
  ProgressBar, TxGlyph, FilterChips, PackCard, NOFLEX, txCategory,
} from '../components/wallet/WalletKit';
// [2026-10-15 native-wallet] Herói + histórico em NATIVO (kill switch __chatyy_native_wallet).
import NativeWalletList, { useNativeWallet, walletColors } from '../components/native/NativeWalletList';
import WalletHowItWorksSheet from '../components/wallet/WalletHowItWorksSheet';

let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}

const PAGE = 30;
const FEATURED = [550, 1700, 6000];
const RECV = new Set(['gift_recv', 'live_gift_recv', 'tip_recv', 'receive']);

function handleOf(email) { const s = String(email || ''); return s.split('@')[0] || s; }

const KIND = {
  topup: ['wallet.kind.topup', 'Recarga'],
  topup_refund: ['wallet.kind.topupRefund', 'Estorno de compra'],
  gift_send: ['wallet.kind.giftSend', 'Presente enviado'],
  gift_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  live_gift_send: ['wallet.kind.giftSend', 'Presente enviado'],
  live_gift_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  tip_send: ['wallet.kind.giftSend', 'Presente enviado'],
  tip_recv: ['wallet.kind.giftRecv', 'Presente recebido'],
  live_react: ['wallet.kind.giftSend', 'Presente enviado'],
  send: ['wallet.kind.send', 'Enviado'],
  receive: ['wallet.kind.receive', 'Recebido'],
  promote: ['wallet.kind.promote', 'Promoção'],
  cashout: ['wallet.kind.cashout', 'Saque'],
  cashout_reversal: ['wallet.kind.cashoutReversal', 'Saque devolvido'],
  legacy_convert: ['wallet.kind.earningsConversion', 'Conversão de ganhos'],
};
const SOURCE = {
  live_gift: ['creatorEarnings.source.live', 'Ao vivo'], live: ['creatorEarnings.source.live', 'Ao vivo'],
  feed_post: ['creatorEarnings.source.feed', 'Post'], post: ['creatorEarnings.source.feed', 'Post'], post_gift: ['creatorEarnings.source.feed', 'Post'],
  reel: ['creatorEarnings.source.reel', 'Reel'], reel_tip: ['creatorEarnings.source.reel', 'Reel'],
  chat: ['gifts.sourceChat', 'Chat'], chat_gift: ['gifts.sourceChat', 'Chat'],
};

function filterOf(item) {
  const k = String(item.kind || '');
  if (k === 'cashout' || k === 'cashout_reversal') return 'cashouts';
  if (RECV.has(k) || k === 'legacy_convert') return 'earnings';
  if (/gift|tip|react/.test(k) || k === 'send') return 'gifts';
  if (k === 'topup' || k === 'topup_refund' || k === 'promote') return 'purchases';
  return 'other';
}

// Normaliza uma linha do ledger p/ exibição.
function describe(item, t) {
  const kind = String(item.kind || '');
  const credit = item.direction === 'credit';
  const [k, fb] = KIND[kind] || (credit ? KIND.receive : KIND.send);
  const isCashout = kind === 'cashout' || kind === 'cashout_reversal';
  const isConvert = kind === 'legacy_convert';
  // Linhas legadas de ganho (tip_recv/live_gift_recv antigos) gravavam centavos em `amount`.
  const legacyEarn = (kind === 'tip_recv' || kind === 'live_gift_recv') && item.diamonds == null;
  const diamonds = isConvert ? null : (item.diamonds != null ? Number(item.diamonds) : (legacyEarn || isCashout ? null : Number(item.amount) || 0));
  const payout = item.payout_cents != null ? Number(item.payout_cents) : (legacyEarn || isCashout || isConvert ? Number(item.amount) || 0 : null);
  const showPayout = payout != null && (RECV.has(kind) || isCashout || isConvert);
  const src = SOURCE[String(item.ref_kind || '')];
  return {
    kind, credit, title: tr(t, k, fb), isCashout, isConvert, diamonds,
    payout: showPayout ? payout : null,
    source: src ? tr(t, src[0], src[1]) : '',
    who: item.counterparty ? handleOf(item.counterparty) : '',
  };
}

function dayKey(ts) { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ts, t, language) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(now.getTime() / 1000)) return tr(t, 'walletV3.today', 'Hoje');
  if (dayKey(ts) === dayKey(y.getTime() / 1000)) return tr(t, 'walletV3.yesterday', 'Ontem');
  try {
    const opts = { weekday: 'short', day: 'numeric', month: 'long' };
    if (d.getFullYear() !== now.getFullYear()) { delete opts.weekday; opts.year = 'numeric'; }
    const s = d.toLocaleDateString(language || undefined, opts);
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch { return d.toDateString(); }
}
function timeLabel(ts, language) {
  try { return new Date(ts * 1000).toLocaleTimeString(language || undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// ── Linha da atividade ─────────────────────────────────────────────────────
function TxRow({ item, s, t, language, first, last, onPress }) {
  const d = describe(item, t);
  const ts = Number(item.created_at_ts) || 0;
  const sub = [d.who && '@' + d.who, d.source, d.isConvert ? tr(t, 'wallet.earningsConversionSub', 'Saldo antigo convertido em reais') : '', ts ? timeLabel(ts, language) : '']
    .filter(Boolean).join(' · ');
  const sign = d.credit ? '+' : '−';
  const amtColor = d.credit ? s.success : s.text;
  const mainIsMoney = d.diamonds == null && d.payout != null;
  const a11y = `${d.title}. ${d.diamonds != null ? sign + formatInt(Math.abs(d.diamonds), language) + ' ' + tr(t, 'wallet.diamondsLabel', 'diamantes') : ''} ${d.payout != null ? sign + moneyBRL(d.payout) : ''}. ${sub}`;
  return (
    <PressableScale
      onPress={onPress}
      haptic="select"
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={tr(t, 'walletV3.openDetailHint', 'Abre os detalhes da transação')}
      style={[
        styles.txRow,
        { backgroundColor: s.surface },
        first && styles.txFirst,
        last && styles.txLast,
      ]}
    >
      <View style={[styles.txIcon, { backgroundColor: s.fill }]}>
        <TxGlyph kind={d.kind} size={20} color={s.text} />
      </View>
      <View style={styles.txMid}>
        <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>{d.title}</Text>
        {sub ? <Text style={[Type.footnote, { color: s.textSecondary, marginTop: 1 }]} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <View style={styles.txRight}>
        {mainIsMoney ? (
          <Text style={[Type.callout, TABULAR, { color: amtColor, fontWeight: '700' }]}>{`${sign}${moneyBRL(d.payout)}`}</Text>
        ) : (
          <View style={styles.amt}>
            <Text style={[Type.callout, TABULAR, { color: amtColor, fontWeight: '700' }]}>{`${sign}${formatInt(Math.abs(d.diamonds || 0), language)}`}</Text>
            <IconDiamond size={12} />
          </View>
        )}
        {!mainIsMoney && d.payout != null ? (
          <Text style={[Type.caption, TABULAR, { color: s.textSecondary, marginTop: 1 }]}>{`+${moneyBRL(d.payout)}`}</Text>
        ) : null}
      </View>
      {!last ? <View style={[styles.txSep, { backgroundColor: s.separator }]} /> : null}
    </PressableScale>
  );
}

// ── Detalhe da transação ───────────────────────────────────────────────────
function DetailRow({ label, value, s, right, mono }) {
  if (!value && !right) return null;
  return (
    <View style={[styles.dRow, { borderBottomColor: s.separator }]}>
      <Text style={[Type.subhead, { color: s.textSecondary }]}>{label}</Text>
      <View style={styles.dRowVal}>
        {value ? <Text style={[Type.subhead, mono && TABULAR, { color: s.text, fontWeight: '600', textAlign: 'right', flexShrink: 1 }]} selectable numberOfLines={2}>{value}</Text> : null}
        {right || null}
      </View>
    </View>
  );
}

function TxDetailSheet({ item: openItem, onClose, s, t, language }) {
  const [cashoutStatus, setCashoutStatus] = useState(null);
  // Mantém o conteúdo durante a animação de saída do sheet.
  const lastRef = useRef(null);
  if (openItem) lastRef.current = openItem;
  const item = openItem || lastRef.current;
  const d = item ? describe(item, t) : null;
  useEffect(() => {
    setCashoutStatus(null);
    if (!item || item.kind !== 'cashout' || !item.ref_id) return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await api.walletCashoutList?.();
        const hit = (r?.data?.items || []).find((x) => String(x.id) === String(item.ref_id));
        if (alive && hit) setCashoutStatus(String(hit.status || 'pending'));
      } catch {}
    })();
    return () => { alive = false; };
  }, [item]);
  if (!item || !d) return null;

  const ts = Number(item.created_at_ts) || 0;
  let when = '';
  try { when = ts ? new Date(ts * 1000).toLocaleString(language || undefined, { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; } catch {}
  const txId = `CHY-${String(item.id ?? '').padStart(8, '0')}`;
  const statusKey = item.kind === 'cashout'
    ? (cashoutStatus ? [`wallet.cashoutStatus.${cashoutStatus}`, cashoutStatus === 'paid' ? 'Pago' : cashoutStatus === 'rejected' ? 'Rejeitado' : 'Em análise'] : ['wallet.cashoutStatus.pending', 'Em análise'])
    : /refund|reversal/.test(d.kind) ? ['walletV3.statusReversed', 'Estornado'] : ['walletV3.statusDone', 'Concluído'];
  const statusTone = item.kind === 'cashout' && cashoutStatus === 'rejected' ? s.danger : (item.kind === 'cashout' && cashoutStatus !== 'paid') ? s.textSecondary : s.success;
  const gift = item.gift_sku ? (getCachedGiftCatalog() || []).find((g) => g.sku === item.gift_sku) : null;
  const giftLabel = gift ? `${gift.label_key ? tr(t, gift.label_key, gift.label || gift.sku) : (gift.label || gift.sku)}${Number(item.quantity) > 1 ? ' ×' + item.quantity : ''}` : '';
  const sign = d.credit ? '+' : '−';
  const mainIsMoney = d.diamonds == null && d.payout != null;
  const big = mainIsMoney ? `${sign}${moneyBRL(d.payout)}` : `${sign}${formatInt(Math.abs(d.diamonds || 0), language)}`;

  const copyId = async () => {
    try {
      if (Clipboard?.setStringAsync) await Clipboard.setStringAsync(txId);
      else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(txId);
      try { haptic.success(); } catch {}
      showToast({ message: tr(t, 'walletV3.idCopied', 'ID copiado') });
    } catch {}
  };
  const receipt = [
    tr(t, 'walletV3.receiptTitle', 'Comprovante Chatyy'),
    `${d.title}: ${big}${mainIsMoney ? '' : ' ' + tr(t, 'wallet.diamondsLabel', 'diamantes')}`,
    d.payout != null && !mainIsMoney ? `${tr(t, 'walletV3.earned', 'Ganho')}: ${moneyBRL(d.payout)}` : '',
    d.who ? `${tr(t, 'walletV3.person', 'Pessoa')}: @${d.who}` : '',
    when ? `${tr(t, 'walletV3.dateTime', 'Data e hora')}: ${when}` : '',
    `${tr(t, 'walletV3.status', 'Status')}: ${tr(t, statusKey[0], statusKey[1])}`,
    `${tr(t, 'walletV3.txId', 'ID da transação')}: ${txId}`,
  ].filter(Boolean).join('\n');
  const shareReceipt = async () => {
    try {
      if (Platform.OS === 'web') { await copyText(receipt); showToast({ message: tr(t, 'walletV3.receiptCopied', 'Comprovante copiado') }); return; }
      await Share.share({ message: receipt });
    } catch {}
  };
  async function copyText(txt) {
    if (Clipboard?.setStringAsync) return Clipboard.setStringAsync(txt);
    if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard.writeText(txt);
    return null;
  }

  return (
    <Sheet visible={!!openItem} onClose={onClose} scroll>
      <View style={styles.dHead}>
        <View style={[styles.dIcon, { backgroundColor: s.fill }]}>
          <TxGlyph kind={d.kind} size={26} color={s.text} />
        </View>
        <Text style={[Type.subhead, { color: s.textSecondary, marginTop: Space.md }]}>{d.title}</Text>
        <View style={[styles.amt, { marginTop: Space.xs }]}>
          <Text style={[styles.dBig, TABULAR, { color: d.credit ? s.success : s.text }]} accessibilityRole="header">{big}</Text>
          {!mainIsMoney ? <IconDiamond size={22} /> : null}
        </View>
        {!mainIsMoney && d.payout != null ? (
          <Text style={[Type.footnote, TABULAR, { color: s.textSecondary, marginTop: 2 }]}>
            {tr(t, 'walletV3.earnedAmount', 'Você ganhou {amount}').replace('{amount}', moneyBRL(d.payout))}
          </Text>
        ) : null}
        <View style={[styles.statusPill, { backgroundColor: s.fill }]}>
          <View style={[styles.statusDot, { backgroundColor: statusTone }]} />
          <Text style={[Type.caption, { color: s.text, fontWeight: '700' }]}>{tr(t, statusKey[0], statusKey[1])}</Text>
        </View>
      </View>
      <View style={styles.dBody}>
        <DetailRow s={s} label={tr(t, 'walletV3.dateTime', 'Data e hora')} value={when} />
        <DetailRow s={s} label={tr(t, 'walletV3.person', 'Pessoa')} value={d.who ? '@' + d.who : ''} />
        <DetailRow s={s} label={tr(t, 'walletV3.origin', 'Origem')} value={d.source} />
        <DetailRow s={s} label={tr(t, 'walletV3.gift', 'Presente')} value={giftLabel} />
        <DetailRow s={s} label={tr(t, 'walletV3.txId', 'ID da transação')} value={txId} mono
          right={(
            <PressableScale onPress={copyId} haptic="select" hitSlop={10} accessibilityRole="button" accessibilityLabel={tr(t, 'walletV3.copyId', 'Copiar ID')} style={styles.copyBtn}>
              <IconCopy size={16} color={s.textSecondary} />
            </PressableScale>
          )} />
      </View>
      <View style={styles.dActions}>
        <PressableScale onPress={shareReceipt} haptic="light" accessibilityRole="button" style={[styles.dBtn, { backgroundColor: s.ink }]}>
          <IconShare size={18} color={s.onInk} />
          <Text style={[styles.dBtnText, { color: s.onInk }]}>{tr(t, 'walletV3.shareReceipt', 'Compartilhar comprovante')}</Text>
        </PressableScale>
      </View>
    </Sheet>
  );
}

// ── Estado vazio ───────────────────────────────────────────────────────────
function EmptyActivity({ s, t, filter, onBuy }) {
  const msg = {
    all: ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'],
    purchases: ['walletV3.emptyPurchasesSub', 'Suas compras de diamantes aparecem aqui.'],
    gifts: ['walletV3.emptyGiftsSub', 'Mande um presente numa live, reel, post ou conversa.'],
    earnings: ['walletV3.emptyEarningsSub', 'Presentes que você receber aparecem aqui.'],
    cashouts: ['walletV3.emptyCashoutsSub', 'Seus saques via Pix aparecem aqui.'],
  }[filter] || ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'];
  return (
    <View style={[styles.empty, { backgroundColor: s.surface }]}>
      <View style={[styles.emptyIcon, { borderColor: s.separator }]}>
        <TxGlyph name="receipt" size={26} color={s.textSecondary} strokeWidth={1.4} />
      </View>
      <Text style={[Type.headline, { color: s.text, marginTop: Space.md }]}>{tr(t, 'wallet.historyEmptyTitle', 'Nenhuma transação ainda')}</Text>
      <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs, textAlign: 'center' }]}>{tr(t, msg[0], msg[1])}</Text>
      {onBuy && (filter === 'all' || filter === 'purchases') ? (
        <PressableScale onPress={onBuy} haptic="medium" accessibilityRole="button" style={[styles.emptyBtn, { borderColor: s.ink }]}>
          <Text style={[Type.subhead, { color: s.text, fontWeight: '700' }]}>{tr(t, 'wallet.topup', 'Comprar diamantes')}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
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

  const rows = useMemo(() => {
    const out = [];
    let cur = null;
    let group = [];
    const flush = () => {
      group.forEach((it, i) => out.push({ type: 'tx', key: 'tx' + String(it.id ?? i) + '_' + out.length, item: it, first: i === 0, last: i === group.length - 1 }));
      group = [];
    };
    for (const it of filtered) {
      const ts = Number(it.created_at_ts) || 0;
      const k = ts ? dayKey(ts) : 'none';
      if (k !== cur) {
        flush();
        cur = k;
        out.push({ type: 'day', key: 'day' + k, label: ts ? dayLabel(ts, t, language) : '' });
      }
      group.push(it);
    }
    flush();
    return out;
  }, [filtered, t, language]);

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

  const filters = [
    { value: 'all', label: tr(t, 'walletV3.filterAll', 'Tudo') },
    { value: 'purchases', label: tr(t, 'walletV3.filterPurchases', 'Compras') },
    { value: 'gifts', label: tr(t, 'walletV3.filterGifts', 'Presentes') },
    { value: 'earnings', label: tr(t, 'walletV3.filterEarnings', 'Ganhos') },
    { value: 'cashouts', label: tr(t, 'walletV3.filterCashouts', 'Saques') },
  ];

  // [2026-10-16 carteira-clara] nada de "≈ US$ … em valor de compra": diamante
  // não é dinheiro sacável. Linha-guia do uso real.
  const heroSub = tr(t, 'walletHow.diamondsUse', 'Use para enviar presentes');

  const heroCard = (
      <FadeSlideIn style={NOFLEX}>
        <HeroCard isDark={isDark}>
          <View style={styles.heroTop}>
            <Text style={[styles.heroCaps, { color: HERO.sub }]}>{tr(t, 'wallet.diamondBalance', 'Saldo de diamantes')}</Text>
            <Text style={[styles.heroBrand, { color: HERO.faint }]}>CHATYY</Text>
          </View>
          <View style={styles.balRow} accessible accessibilityRole="summary"
            accessibilityLabel={`${tr(t, 'wallet.diamondBalance', 'Saldo de diamantes')}: ${wallet.diamonds == null ? '—' : formatInt(wallet.diamonds, language)}`}>
            <DiamondMark size={30} />
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
            <View style={styles.heroActions}>
              <HeroButton primary weight={1.15} haptic="medium" label={tr(t, 'wallet.topup', 'Comprar diamantes')} onPress={openTopup} disabled={!canPurchase} testID="wallet-buy" />
              <HeroButton label={tr(t, 'walletV3.sendGift', 'Enviar presente')} onPress={() => setGiftOpen(true)} testID="wallet-gift" />
            </View>
          )}
        </HeroCard>
      </FadeSlideIn>
  );

  // Blocos abaixo do herói (no nativo viram o filho RN, logo abaixo do herói nativo).
  const restBlocks = (
    <>
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
                  {!wallet.cashoutEnabled && reachedMin ? tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.') : minText}
                  <Text style={{ color: s.text, fontWeight: '600' }}>{'  ' + tr(t, 'walletHow.title', 'Como funciona')}</Text>
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
        <Text style={[Type.title3, { color: s.text, fontWeight: '700' }]} accessibilityRole="header">{tr(t, 'walletV3.activity', 'Atividade')}</Text>
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
    if (r.type === 'day') {
      return <Text style={[Type.footnote, styles.dayLabel, { color: s.textSecondary }]} accessibilityRole="header">{r.label}</Text>;
    }
    return <TxRow item={r.item} s={s} t={t} language={language} first={r.first} last={r.last} onPress={() => setDetail(r.item)} />;
  }, [s, t, language]);

  // ── [2026-10-15 native-wallet] Modelo do herói + linhas da lista nativa ──
  const nativeHero = useMemo(() => {
    if (!nativeOn) return null;
    const bal = typeof wallet.diamonds === 'number' ? wallet.diamonds : null;
    const caps = tr(t, 'wallet.diamondBalance', 'Saldo de diamantes');
    const buttons = [{ id: 'buy', label: tr(t, 'wallet.topup', 'Comprar diamantes'), primary: true, disabled: !canPurchase }];
    buttons.push({ id: 'gift', label: tr(t, 'walletV3.sendGift', 'Enviar presente') });
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
      const ts = Number(it.created_at_ts) || 0;
      const sub = [d.who && '@' + d.who, d.source, d.isConvert ? tr(t, 'wallet.earningsConversionSub', 'Saldo antigo convertido em reais') : '', ts ? timeLabel(ts, language) : '']
        .filter(Boolean).join(' · ');
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
      const msg = {
        all: ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'],
        purchases: ['walletV3.emptyPurchasesSub', 'Suas compras de diamantes aparecem aqui.'],
        gifts: ['walletV3.emptyGiftsSub', 'Mande um presente numa live, reel, post ou conversa.'],
        earnings: ['walletV3.emptyEarningsSub', 'Presentes que você receber aparecem aqui.'],
        cashouts: ['walletV3.emptyCashoutsSub', 'Seus saques via Pix aparecem aqui.'],
      }[filter] || ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'];
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
  heroActions: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xl },
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
