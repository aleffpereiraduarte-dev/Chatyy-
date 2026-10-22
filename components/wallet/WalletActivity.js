// components/wallet/WalletActivity.js — [2026-10-21 carteira-pro]
// Histórico da Carteira compartilhado por /wallet (resumo) e /wallet-history
// (tela cheia): normalização das linhas do ledger, agrupamento por dia (com o
// saldo do dia alinhado à direita), linha de transação, detalhe com RECIBO e
// estado vazio. Só leitura — nada aqui move dinheiro nem chama compra/IAP.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Share, Platform } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import * as api from '../../services/api';
import { IconDiamond, IconCopy, IconShare } from '../Icons';
import { PressableScale, Sheet, showToast, useOverlayColors, Type, Space, Radius } from '../ui';
import { haptic } from '../../constants/theme';
import { formatInt } from '../../utils/dateFormat';
import { getCachedGiftCatalog } from '../../services/diamonds';
import { tr, moneyBRL, TABULAR, TxGlyph, txCategory } from './WalletKit';

let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}

export const WALLET_PAGE = 30;
export const RECV = new Set(['gift_recv', 'live_gift_recv', 'tip_recv', 'receive']);

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
const CATEGORY = {
  purchase: ['walletPro.cat.purchase', 'Compra de diamantes'],
  gift: ['walletPro.cat.gift', 'Presente'],
  cashout: ['walletPro.cat.cashout', 'Saque via Pix'],
  convert: ['walletPro.cat.convert', 'Conversão'],
  refund: ['walletPro.cat.refund', 'Estorno'],
  promo: ['walletPro.cat.promo', 'Promoção'],
  transfer: ['walletPro.cat.transfer', 'Transferência'],
};

export function filterOf(item) {
  const k = String(item.kind || '');
  if (k === 'cashout' || k === 'cashout_reversal') return 'cashouts';
  if (RECV.has(k) || k === 'legacy_convert') return 'earnings';
  if (/gift|tip|react/.test(k) || k === 'send') return 'gifts';
  if (k === 'topup' || k === 'topup_refund' || k === 'promote') return 'purchases';
  return 'other';
}

export function walletFilters(t) {
  return [
    { value: 'all', label: tr(t, 'walletV3.filterAll', 'Tudo') },
    { value: 'purchases', label: tr(t, 'walletV3.filterPurchases', 'Compras') },
    { value: 'gifts', label: tr(t, 'walletV3.filterGifts', 'Presentes') },
    { value: 'earnings', label: tr(t, 'walletV3.filterEarnings', 'Ganhos') },
    { value: 'cashouts', label: tr(t, 'walletV3.filterCashouts', 'Saques') },
  ];
}

export function emptyMsg(filter) {
  return {
    all: ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'],
    purchases: ['walletV3.emptyPurchasesSub', 'Suas compras de diamantes aparecem aqui.'],
    gifts: ['walletV3.emptyGiftsSub', 'Mande um presente numa live, reel, post ou conversa.'],
    earnings: ['walletV3.emptyEarningsSub', 'Presentes que você receber aparecem aqui.'],
    cashouts: ['walletV3.emptyCashoutsSub', 'Seus saques via Pix aparecem aqui.'],
  }[filter] || ['walletV3.emptyAllSub', 'Compras, presentes e saques vão aparecer aqui.'];
}

// Normaliza uma linha do ledger p/ exibição.
export function describe(item, t) {
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

export function dayKey(ts) { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
export function dayLabel(ts, t, language) {
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
export function timeLabel(ts, language) {
  try { return new Date(ts * 1000).toLocaleTimeString(language || undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export function txSubtitle(d, item, t, language) {
  const ts = Number(item.created_at_ts) || 0;
  return [d.who && '@' + d.who, d.source, d.isConvert ? tr(t, 'wallet.earningsConversionSub', 'Saldo antigo convertido em reais') : '', ts ? timeLabel(ts, language) : '']
    .filter(Boolean).join(' · ');
}

/**
 * Linhas p/ lista agrupada por dia:
 *   { type:'day', key, label, net }  (net = saldo de diamantes do dia, só se houver)
 *   { type:'tx', key, item, first, last }
 */
export function buildActivityRows(list, t, language) {
  const out = [];
  let cur = null;
  let head = null;
  let group = [];
  const flush = () => {
    group.forEach((it, i) => out.push({ type: 'tx', key: 'tx' + String(it.id ?? i) + '_' + out.length, item: it, first: i === 0, last: i === group.length - 1 }));
    group = [];
  };
  for (const it of list) {
    const ts = Number(it.created_at_ts) || 0;
    const k = ts ? dayKey(ts) : 'none';
    if (k !== cur) {
      flush();
      cur = k;
      head = { type: 'day', key: 'day' + k, label: ts ? dayLabel(ts, t, language) : '', net: 0, hasDia: false };
      out.push(head);
    }
    const d = describe(it, t);
    if (d.diamonds != null && head) { head.net += (d.credit ? 1 : -1) * Math.abs(d.diamonds); head.hasDia = true; }
    group.push(it);
  }
  flush();
  return out;
}

export function DayHeader({ row, s, language }) {
  const net = row.hasDia ? row.net : null;
  return (
    <View style={styles.dayRow}>
      <Text style={[Type.footnote, styles.dayLabel, { color: s.textSecondary }]} accessibilityRole="header">{row.label}</Text>
      {net != null && net !== 0 ? (
        <View style={styles.amt}>
          <Text style={[Type.footnote, TABULAR, { color: s.textSecondary, fontWeight: '600' }]}>{`${net > 0 ? '+' : '−'}${formatInt(Math.abs(net), language)}`}</Text>
          <IconDiamond size={10} color={s.textSecondary} />
        </View>
      ) : null}
    </View>
  );
}

// ── Linha da atividade ─────────────────────────────────────────────────────
export function TxRow({ item, s, t, language, first, last, onPress }) {
  const d = describe(item, t);
  const sub = txSubtitle(d, item, t, language);
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
      style={[styles.txRow, { backgroundColor: s.surface }, first && styles.txFirst, last && styles.txLast]}
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
            <IconDiamond size={12} color={amtColor} />
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

// ── Detalhe da transação (recibo) ─────────────────────────────────────────
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

// Picote do recibo (linha tracejada com "mordidas" nas bordas).
function Perforation({ s }) {
  const [w, setW] = useState(0);
  const oc = useOverlayColors();
  const bite = oc?.sheetBg || s.surface;
  return (
    <View style={styles.perfWrap} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}>
      <View style={[styles.perfBite, { left: -10, backgroundColor: bite }]} />
      {w > 0 ? (
        <Svg width={w} height={2} style={{ position: 'absolute', left: 0, top: 9 }}>
          <Line x1={10} y1={1} x2={w - 10} y2={1} stroke={s.separator} strokeWidth={1.5} strokeDasharray="5,5" />
        </Svg>
      ) : null}
      <View style={[styles.perfBite, { right: -10, backgroundColor: bite }]} />
    </View>
  );
}

export function TxDetailSheet({ item: openItem, onClose, s, t, language }) {
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
  const cat = CATEGORY[txCategory(d.kind)] || CATEGORY.transfer;
  const unit = tr(t, 'wallet.diamondsLabel', 'diamantes');
  const statusText = tr(t, statusKey[0], statusKey[1]);

  async function copyText(txt) {
    if (Clipboard?.setStringAsync) return Clipboard.setStringAsync(txt);
    if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard.writeText(txt);
    return null;
  }
  const copyId = async () => {
    try {
      await copyText(txId);
      try { haptic.success(); } catch {}
      showToast({ message: tr(t, 'walletV3.idCopied', 'ID copiado') });
    } catch {}
  };
  const receipt = [
    tr(t, 'walletV3.receiptTitle', 'Comprovante Chatyy'),
    `${d.title}: ${big}${mainIsMoney ? '' : ' ' + unit}`,
    `${tr(t, 'walletPro.type', 'Tipo')}: ${tr(t, cat[0], cat[1])}`,
    d.payout != null && !mainIsMoney ? `${tr(t, 'walletV3.earned', 'Ganho')}: ${moneyBRL(d.payout)}` : '',
    d.who ? `${tr(t, 'walletV3.person', 'Pessoa')}: @${d.who}` : '',
    d.source ? `${tr(t, 'walletV3.origin', 'Origem')}: ${d.source}` : '',
    giftLabel ? `${tr(t, 'walletV3.gift', 'Presente')}: ${giftLabel}` : '',
    when ? `${tr(t, 'walletV3.dateTime', 'Data e hora')}: ${when}` : '',
    `${tr(t, 'walletV3.status', 'Status')}: ${statusText}`,
    `${tr(t, 'walletV3.txId', 'ID da transação')}: ${txId}`,
  ].filter(Boolean).join('\n');
  const shareReceipt = async () => {
    try {
      if (Platform.OS === 'web') { await copyText(receipt); showToast({ message: tr(t, 'walletV3.receiptCopied', 'Comprovante copiado') }); return; }
      await Share.share({ message: receipt });
    } catch {}
  };

  return (
    <Sheet visible={!!openItem} onClose={onClose} scroll>
      <View style={styles.dHead}>
        <View style={[styles.dIcon, { backgroundColor: s.fill }]}>
          <TxGlyph kind={d.kind} size={26} color={s.text} />
        </View>
        <Text style={[Type.subhead, { color: s.textSecondary, marginTop: Space.md }]}>{d.title}</Text>
        <View style={[styles.amt, { marginTop: Space.xs }]}>
          <Text style={[styles.dBig, TABULAR, { color: d.credit ? s.success : s.text }]} accessibilityRole="header">{big}</Text>
          {!mainIsMoney ? <IconDiamond size={22} color={d.credit ? s.success : s.text} /> : null}
        </View>
        {!mainIsMoney && d.payout != null ? (
          <Text style={[Type.footnote, TABULAR, { color: s.textSecondary, marginTop: 2 }]}>
            {tr(t, 'walletV3.earnedAmount', 'Você ganhou {amount}').replace('{amount}', moneyBRL(d.payout))}
          </Text>
        ) : null}
        <View style={[styles.statusPill, { backgroundColor: s.fill }]}>
          <View style={[styles.statusDot, { backgroundColor: statusTone }]} />
          <Text style={[Type.caption, { color: s.text, fontWeight: '700' }]}>{statusText}</Text>
        </View>
      </View>
      <View style={[styles.receipt, { backgroundColor: s.fill, borderColor: s.separator }]}>
        <Text style={[Type.sectionCaps || Type.caption, styles.receiptCaps, { color: s.textSecondary }]}>{tr(t, 'walletPro.receipt', 'Recibo')}</Text>
        <DetailRow s={s} label={tr(t, 'walletPro.type', 'Tipo')} value={tr(t, cat[0], cat[1])} />
        {!mainIsMoney ? (
          <DetailRow s={s} label={tr(t, 'walletPro.amount', 'Valor')} value={`${sign}${formatInt(Math.abs(d.diamonds || 0), language)} ${unit}`} mono />
        ) : null}
        {d.payout != null ? <DetailRow s={s} label={mainIsMoney ? tr(t, 'walletPro.amount', 'Valor') : tr(t, 'walletV3.earned', 'Ganho')} value={`${mainIsMoney ? sign : '+'}${moneyBRL(d.payout)}`} mono /> : null}
        <DetailRow s={s} label={tr(t, 'walletV3.person', 'Pessoa')} value={d.who ? '@' + d.who : ''} />
        <DetailRow s={s} label={tr(t, 'walletV3.origin', 'Origem')} value={d.source} />
        <DetailRow s={s} label={tr(t, 'walletV3.gift', 'Presente')} value={giftLabel} />
        <DetailRow s={s} label={tr(t, 'walletV3.dateTime', 'Data e hora')} value={when} />
        <Perforation s={s} />
        <DetailRow s={s} label={tr(t, 'walletV3.txId', 'ID da transação')} value={txId} mono
          right={(
            <PressableScale onPress={copyId} haptic="select" hitSlop={10} accessibilityRole="button" accessibilityLabel={tr(t, 'walletV3.copyId', 'Copiar ID')} style={styles.copyBtn}>
              <IconCopy size={16} color={s.textSecondary} />
            </PressableScale>
          )} />
        <Text style={[Type.caption, { color: s.textTertiary || s.textSecondary, textAlign: 'center', marginTop: Space.md }]}>
          {tr(t, 'walletPro.receiptFoot', 'Comprovante gerado pelo Chatyy. Guarde o ID para falar com o suporte.')}
        </Text>
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
export function EmptyActivity({ s, t, filter, onBuy }) {
  const msg = emptyMsg(filter);
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

const styles = StyleSheet.create({
  dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Space.lg, marginBottom: Space.sm, marginHorizontal: Space.xs },
  dayLabel: { fontWeight: '600' },
  txRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, paddingVertical: Space.md, minHeight: 64 },
  txFirst: { borderTopLeftRadius: Radius.card + 4, borderTopRightRadius: Radius.card + 4 },
  txLast: { borderBottomLeftRadius: Radius.card + 4, borderBottomRightRadius: Radius.card + 4 },
  txIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  txMid: { flex: 1, minWidth: 0, marginLeft: Space.md },
  txRight: { alignItems: 'flex-end', marginLeft: Space.sm, minWidth: 64 },
  txSep: { position: 'absolute', left: Space.lg + 40 + Space.md, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  amt: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  empty: { borderRadius: Radius.card + 4, alignItems: 'center', paddingVertical: Space.xxl + 8, paddingHorizontal: Space.xl },
  emptyIcon: { width: 60, height: 60, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  emptyBtn: { marginTop: Space.lg, height: 40, paddingHorizontal: Space.xl, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dHead: { alignItems: 'center', paddingHorizontal: Space.xl, paddingTop: Space.sm, paddingBottom: Space.lg },
  dIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  dBig: { fontSize: 36, lineHeight: 42, fontWeight: '700', letterSpacing: -1 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: Space.md },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  receipt: { marginHorizontal: Space.lg, borderRadius: Radius.card + 4, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: Space.lg, paddingTop: Space.md, paddingBottom: Space.lg, overflow: 'hidden' },
  receiptCaps: { letterSpacing: 0.8, marginBottom: Space.xs },
  dRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 46, borderBottomWidth: StyleSheet.hairlineWidth, gap: Space.md },
  dRowVal: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexShrink: 1, justifyContent: 'flex-end' },
  perfWrap: { height: 20, marginVertical: Space.sm, marginHorizontal: -Space.lg },
  perfBite: { position: 'absolute', top: 0, width: 20, height: 20, borderRadius: 10 },
  copyBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  dActions: { paddingHorizontal: Space.xl, paddingTop: Space.lg, paddingBottom: Space.sm },
  dBtn: { height: 50, borderRadius: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  dBtnText: { fontSize: 15, fontWeight: '700' },
});
