// /wallet-cashout — saque de ganhos de criador via Pix.
//
// [2026-10-13 earnings-v2] Repaginada no padrão P&B (Painel de criador):
// saldo em destaque, formulário com validação clara campo a campo (valor,
// tipo/chave Pix, titular, CPF com dígito verificador), revisão em 2 passos
// antes de enviar, estados de envio / sucesso / erro inline (sem Alert — no
// web o Alert do RN é no-op), histórico como lista + detalhe em Sheet,
// skeleton, pull-to-refresh, escuro, coluna limitada no web desktop.
//
// MOEDA: Pix paga em REAIS — o servidor valida e debita amount_cents em
// centavos de BRL (chat.php wallet_cashout_request: mín 5000, máx 5_000_000).
// Por isso o campo de valor é em BRL (formatMoney(…, 'BRL'), sem "R$" fixo
// no código) e, se a moeda de exibição for outra, mostramos a conversão
// (formatMoneyActive) ao lado. Saldo/mínimo/histórico = formatMoneyActive.
//
// Saques desligados: WALLET_ENABLED=false no app E o servidor responde 410
// {feature_disabled:true} (bloqueio 2026-06-28). Em vez de redirecionar p/
// /chat, a tela mostra o aviso + o histórico (acessível de "Meus Ganhos").
//
// [2026-10-16 saque-v2] Saque de verdade: chave Pix CADASTRADA (1 toque nos
// próximos), taxa e valor líquido claros na revisão, idempotência do pedido
// (client_request_id), status completo (em análise → aprovado → enviando Pix
// → pago | não concluído | recusado | cancelado) com linha do tempo no detalhe,
// cancelar enquanto em análise, atualização ao vivo (WS cashout_status) e aviso
// para quem mora fora do Brasil. Servidor: api/payouts.php.
//
// Sem deps nativas novas. OTA-safe.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, Platform, RefreshControl, KeyboardAvoidingView, Linking,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import { useTheme } from '../context/ThemeContext';
// [2026-05-22 monetization-pause] carteira/saque escondidos por flag
import { WALLET_ENABLED } from '../constants/featureFlags';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { formatMoney, formatMoneyActive, getActiveCurrency } from '../services/currencyService';
import { useCurrency } from '../context/CurrencyContext';
import { IconInfo, IconCheckCircle, IconAlertCircle, IconGlobe } from '../components/Icons';
import { haptic } from '../constants/theme';
import { HeroCard, HERO, TABULAR } from '../components/wallet/WalletKit';
import {
  Button, Card, SectionHeader, TopBar, useSurface, Skeleton, SkeletonFadeIn, SegmentedControl,
  Badge, Sheet, PressableRow, showToast, Type, Space, Radius, Layout,
} from '../components/ui';

const MIN_CENTS = 5000;       // R$ 50,00 — espelha chat.php
const MAX_CENTS = 5000000;    // R$ 50.000,00

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
// [2026-10-14 ganhos-BRL] saldo/mínimo/histórico de saque em R$ (é o que cai no Pix).
function money(cents) { return formatMoney(Number(cents) || 0, 'BRL', 'pt-BR'); }
function brl(cents) { return formatMoney(Number(cents) || 0, 'BRL', 'pt-BR'); }

// "1.234,56" | "1234.56" | "1234" → centavos inteiros.
function parseBrlToCents(text) {
  let v = String(text ?? '').replace(/[^0-9,.]/g, '');
  if (!v) return 0;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}
function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',');
}
function digits(v) { return String(v || '').replace(/\D/g, ''); }
function fmtCpf(raw) {
  const d = digits(raw).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
// CPF com dígitos verificadores (o servidor só confere 11 dígitos).
function isValidCpf(raw) {
  const d = digits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}
function validPixKey(type, key) {
  const k = String(key || '').trim();
  if (k.length < 4 || k.length > 120) return false;
  switch (type) {
    case 'cpf': return isValidCpf(k);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(k);
    case 'phone': {
      // Pix telefone = só Brasil (espelha o servidor): DDI estrangeiro não vira +55.
      let n = digits(k);
      if ((k.startsWith('+') && !n.startsWith('55')) || k.startsWith('00')) return false;
      if (n.length === 10 || n.length === 11) n = '55' + n;
      return /^55[1-9]{2}(9\d{8}|[2-5]\d{7})$/.test(n);
    }
    case 'random': return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(k);
    default: return true;
  }
}

// Chave no formato que o servidor aceita (aleatória sem hífens → UUID com hífens).
function normPixKey(type, key) {
  const k = String(key || '').trim();
  if (type === 'cpf') return digits(k);
  if (type === 'random') {
    const h = k.replace(/-/g, '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : k;
  }
  return k;
}

// [saque-v2] estados do servidor: pending | approved | processing | paid | failed | rejected | canceled
function statusTone(st) {
  if (st === 'paid') return 'success';
  if (st === 'rejected' || st === 'failed') return 'danger';
  if (st === 'canceled') return 'muted';
  if (st === 'approved' || st === 'processing') return 'ink';
  return 'neutral';
}
function statusLabel(t, st) {
  if (st === 'approved') return tr(t, 'saque4.status.approved', 'Aprovado');
  if (st === 'processing') return tr(t, 'saque4.status.processing', 'Enviando Pix');
  if (st === 'failed') return tr(t, 'saque4.status.failed', 'Não concluído');
  if (st === 'canceled') return tr(t, 'saque4.status.canceled', 'Cancelado');
  return tr(t, `wallet.cashoutStatus.${st}`, st === 'paid' ? 'Pago' : st === 'rejected' ? 'Rejeitado' : 'Em análise');
}
function eventLabel(t, st) {
  return tr(t, `saque4.ev.${st}`, {
    pending: 'Pedido recebido', approved: 'Aprovado pela Chatyy', processing: 'Pix enviado ao banco', paid: 'Pix pago',
    failed: 'Pix não concluído — valor devolvido', rejected: 'Recusado — valor devolvido', canceled: 'Cancelado — valor devolvido',
  }[st] || st);
}
// Espelha payouts.php pyoFeeCents (fixo + bps, arredonda p/ cima, sobra >= R$ 1).
function feeFor(amount, rule) {
  const a = Number(amount) || 0;
  if (a <= 0 || !rule) return 0;
  const fixed = Math.max(0, Number(rule.fixed_cents) || 0);
  const bps = Math.max(0, Math.min(2000, Number(rule.bps) || 0));
  const fee = fixed + Math.ceil((a * bps) / 10000);
  return Math.max(0, Math.min(fee, Math.max(0, a - 100)));
}
function newRequestId() {
  return 'co-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function Field({ label, error, hint, children, s }) {
  return (
    <View style={{ marginTop: Space.lg }}>
      <Text style={[Type.footnote, { color: s.text, fontWeight: '600', marginBottom: Space.xs }]}>{label}</Text>
      {children}
      {error ? (
        <Text style={[Type.footnote, { color: s.danger, marginTop: Space.xs }]} accessibilityLiveRegion="polite">{error}</Text>
      ) : hint ? (
        <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.xs }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

function Notice({ icon: Icon, title, body, s, tone }) {
  const c = tone === 'danger' ? s.danger : tone === 'success' ? s.success : s.text;
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: Space.md }}>
        <Icon size={22} color={c} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[Type.headline, { color: s.text }]}>{title}</Text>
          {body ? <Text style={[Type.footnote, { color: s.textSecondary, marginTop: 2 }]}>{body}</Text> : null}
        </View>
      </View>
    </Card>
  );
}

function DetailRow({ label, value, s, mono }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[Type.footnote, { color: s.textSecondary, minWidth: 110 }]}>{label}</Text>
      <Text selectable numberOfLines={3}
        style={[Type.subhead, { flex: 1, minWidth: 0, color: s.text, fontWeight: '600', textAlign: 'right' }, Platform.OS === 'web' ? { wordBreak: 'break-all' } : null,
          mono && { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>
        {value || '—'}
      </Text>
    </View>
  );
}

export default function WalletCashoutScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  useCurrency(); // re-render quando a moeda de exibição muda

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [available, setAvailable] = useState(0);
  const [history, setHistory] = useState([]);
  const [serverDisabled, setServerDisabled] = useState(false);
  const [detailRow, setDetailRow] = useState(null);

  const [amountText, setAmountText] = useState('');
  const [pixType, setPixType] = useState('cpf');
  const [pixKey, setPixKey] = useState('');
  const [fullName, setFullName] = useState('');
  const [cpf, setCpf] = useState('');
  const [touched, setTouched] = useState({});
  const [step, setStep] = useState('form'); // form | review | sending | done
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // [2026-10-13 diamantes-religados] regras do servidor (resumo de ganhos).
  const [rules, setRules] = useState({ onHold: 0, holdDays: 0, block: null, minAgeDays: 30, dailyLimit: 0, kyc: null, maxCents: MAX_CENTS, minCents: MIN_CENTS });
  // [saque-v2] cadastro de recebimento salvo + opções/taxa do servidor (null = servidor antigo).
  const [method, setMethod] = useState(null);
  const [opts, setOpts] = useState(null);
  const [editMethod, setEditMethod] = useState(false);
  const [detail, setDetail] = useState(null);
  const [canceling, setCanceling] = useState(false);
  const [abroadBusy, setAbroadBusy] = useState(false);
  const reqIdRef = useRef('');

  const paused = !WALLET_ENABLED || serverDisabled || rules.block === 'disabled';

  const loadAll = useCallback(async () => {
    const [bal, list, sum, meth] = await Promise.allSettled([api.walletBalance?.(), api.walletCashoutList?.(), api.creatorEarningsSummary?.({ limit: 1 }), api.payoutMethodGet?.()]);
    const mg = meth.status === 'fulfilled' ? meth.value : null;
    if (mg?.success && mg.data) {
      setMethod(mg.data.method && mg.data.method.method === 'pix' && mg.data.method.ready ? mg.data.method : null);
      setOpts({
        feeRule: mg.data.fee_rule || null,
        auto: !!mg.data.options?.br?.automatic,
        intl: !!mg.data.options?.intl?.available,
        minCents: Number(mg.data.min_cents) || MIN_CENTS,
        maxCents: Number(mg.data.max_cents) || MAX_CENTS,
      });
    }
    const b = bal.status === 'fulfilled' ? bal.value : null;
    if (b?.success && b.data) setAvailable(b.data.available_cents != null ? Number(b.data.available_cents) || 0 : Number(b.data.pending_payout_cents) || 0);
    if (b?.data?.feature_disabled) setServerDisabled(true);
    const sm = sum.status === 'fulfilled' ? sum.value : null;
    if (sm?.success && sm.data) {
      const d = sm.data;
      setRules({
        onHold: Number(d.on_hold_cents) || 0,
        holdDays: Number(d.hold_days) || 0,
        block: d.cashout_block_reason && d.cashout_block_reason !== 'below_min' ? d.cashout_block_reason : null,
        minAgeDays: Number(d.account_min_age_days) || 30,
        dailyLimit: Number(d.daily_limit_cents) || 0,
        kyc: d.kyc && typeof d.kyc === 'object' ? d.kyc : null,
        maxCents: Number(d.max_cashout_cents) || MAX_CENTS,
        minCents: Number(d.min_cashout_cents) || MIN_CENTS,
      });
      if (d.kyc && d.kyc.full_name) setFullName(prev => prev || String(d.kyc.full_name));
    }
    const l = list.status === 'fulfilled' ? list.value : null;
    if (l?.success && Array.isArray(l.data?.items)) setHistory(l.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);
  const onRefresh = useCallback(() => { setRefreshing(true); loadAll(); }, [loadAll]);
  // [saque-v2] status ao vivo: aprovado/enviando/pago chega pelo WS → recarrega lista e detalhe aberto.
  useEffect(() => {
    let off = null; let alive = true;
    (async () => {
      try {
        const ws = (await import('../services/websocket')).default;
        if (!alive) return;
        off = ws.on('cashout_status', (d) => {
          loadAll();
          setDetail((cur) => (cur && Number(cur.id) === Number(d?.payout_id) ? { ...cur, status: String(d?.status || cur.status), _stale: true } : cur));
        });
      } catch {}
    })();
    return () => { alive = false; try { off && off(); } catch {} };
  }, [loadAll]);

  const MIN_C = opts?.minCents || rules.minCents || MIN_CENTS;
  const MAX_C = Math.min(opts?.maxCents || MAX_CENTS, rules.maxCents || MAX_CENTS);
  const useSaved = !!method && !editMethod;
  const amountCents = useMemo(() => parseBrlToCents(amountText), [amountText]);
  const feeCents = feeFor(amountCents, opts?.feeRule);
  const netCents = Math.max(0, amountCents - feeCents);
  const maxAllowed = Math.min(available, MAX_C);
  const reachedMin = available >= MIN_C;
  const progress = Math.max(0, Math.min(1, available / MIN_C));
  const showConverted = getActiveCurrency() !== 'BRL';
  const etaText = opts?.auto
    ? tr(t, 'saque4.etaAuto', 'Após a aprovação, o Pix cai em até 1 dia útil.')
    : tr(t, 'saque4.etaManual', 'Após a aprovação, o Pix cai em até 3 dias úteis.');

  const errors = {
    amount: !amountCents ? tr(t, 'cashout2.errAmountEmpty', 'Informe o valor.')
      : amountCents < MIN_C ? tr(t, 'cashout2.errMin', 'O mínimo para saque é {min}.').replace('{min}', money(MIN_C))
      : amountCents > MAX_C ? tr(t, 'cashout2.errMax', 'O máximo por saque é {max}.').replace('{max}', money(MAX_C))
      : amountCents > available ? tr(t, 'cashout2.errOver', 'Acima do disponível ({available}).').replace('{available}', money(available))
      : '',
    pixKey: (validPixKey(pixType, pixKey) && pixType === 'cpf' && isValidCpf(cpf) && digits(pixKey) !== digits(cpf))
      ? tr(t, 'cashout3.errHolder', 'A chave Pix precisa ser do titular (mesmo CPF informado).')
      : validPixKey(pixType, pixKey) ? '' : tr(t, `cashout2.errKey.${pixType}`, {
      cpf: 'CPF da chave inválido.', email: 'E-mail inválido.', phone: 'Telefone inválido (DDD + número).', random: 'Chave aleatória inválida (32 caracteres).',
    }[pixType]),
    fullName: fullName.trim().split(/\s+/).filter(Boolean).length >= 2 && fullName.trim().length >= 3
      ? '' : tr(t, 'cashout2.errName', 'Informe nome e sobrenome do titular.'),
    cpf: isValidCpf(cpf) ? '' : tr(t, 'cashout2.errCpf', 'CPF inválido.'),
  };
  if (useSaved) { errors.pixKey = ''; errors.fullName = ''; errors.cpf = ''; }
  const formValid = !errors.amount && !errors.pixKey && !errors.fullName && !errors.cpf;
  const shown = (k) => (touched[k] || touched._all) ? errors[k] : '';

  const onPixKeyChange = (v) => {
    const raw = String(v).slice(0, 120);
    setPixKey(pixType === 'cpf' ? fmtCpf(raw) : raw);
  };

  const goReview = () => {
    setTouched({ _all: true });
    setError('');
    if (formValid) { if (!reqIdRef.current) reqIdRef.current = newRequestId(); try { haptic.light(); } catch {} setStep('review'); }
    else { try { haptic.warning(); } catch {} }
  };

  const submit = useCallback(async () => {
    setStep('sending');
    setError('');
    try {
      if (!reqIdRef.current) reqIdRef.current = newRequestId();
      const r = await api.walletCashoutRequest(useSaved
        ? { amountCents, useSavedMethod: true, clientRequestId: reqIdRef.current }
        : { amountCents, pixKey: normPixKey(pixType, pixKey), pixKeyType: pixType, fullName, cpf, clientRequestId: reqIdRef.current });
      if (r?.success && r.data) {
        reqIdRef.current = '';
        setEditMethod(false);
        setAvailable(r.data.available_cents != null ? Number(r.data.available_cents) || 0 : Number(r.data.pending_payout_cents) || 0);
        setResult({ amount: Number(r.data.amount_cents) || amountCents, net: r.data.net_cents != null ? Number(r.data.net_cents) : null });
        setAmountText('');
        setTouched({});
        setStep('done');
        try { haptic.success(); } catch {}
        loadAll();
        return;
      }
      const msg = String(r?.message || '');
      const code = r?.data?.code;
      if (r?.data?.feature_disabled) { setServerDisabled(true); setStep('form'); return; }
      if (code === 'insufficient_pending' && r?.data?.pending_payout_cents != null) setAvailable(Number(r.data.pending_payout_cents) || 0);
      if ((code === 'insufficient_available' || msg === 'insufficient_available') && r?.data?.available_cents != null) setAvailable(Number(r.data.available_cents) || 0);
      const map = {
        min_cashout: tr(t, 'cashout2.errMin', 'O mínimo para saque é {min}.').replace('{min}', money(MIN_C)),
        max_cashout: tr(t, 'cashout2.errMax', 'O máximo por saque é {max}.').replace('{max}', money(MAX_C)),
        no_payout_method: tr(t, 'saque4.errNoMethod', 'Cadastre sua chave Pix para sacar.'),
        cpf_invalid: tr(t, 'wallet.cashoutCpfError', 'CPF inválido. Deve ter 11 dígitos.'),
        name_invalid: tr(t, 'wallet.cashoutNameError', 'Informe seu nome completo.'),
        pix_key_invalid: tr(t, 'wallet.cashoutKeyError', 'Chave PIX inválida.'),
        // [2026-10-14] servidor permite 1 pendente por vez (não 3) → texto certo.
        too_many_pending: tr(t, 'earn.blockPending', 'Você já tem um saque em análise.'),
        pending_exists: tr(t, 'earn.blockPending', 'Você já tem um saque em análise.'),
        negative_balance: tr(t, 'earn.blockNegative', 'Há um estorno pendente na sua carteira. Regularize para sacar.'),
        rate_limited: tr(t, 'wallet.cashoutFailed', 'Falha ao solicitar saque.'),
        insufficient_pending: tr(t, 'wallet.cashoutInsufficient', 'Saldo de saque insuficiente.'),
        insufficient_available: tr(t, 'cashout3.errAvailable', 'Valor acima do disponível. Presentes recentes ainda estão em liberação.'),
        daily_limit: tr(t, 'cashout3.errDaily', 'Limite diário de saque atingido. Tente amanhã.'),
        pix_key_not_holder: tr(t, 'cashout3.errHolder', 'A chave Pix precisa ser do titular (mesmo CPF informado).'),
        kyc_mismatch: tr(t, 'cashout3.errKyc', 'O CPF precisa ser o mesmo do seu primeiro saque. Fale com o suporte para alterar.'),
        cpf_in_use: tr(t, 'cashout3.errCpfInUse', 'Este CPF já está vinculado a outra conta.'),
        account_too_new: tr(t, 'earn.blockAccountNew', 'Sua conta precisa ter pelo menos {n} dias para sacar.').replace('{n}', String(rules.minAgeDays || 30)),
        minor_blocked: tr(t, 'earn.blockMinor', 'Saques não estão disponíveis para contas supervisionadas.'),
        disabled: tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.'),
      };
      if (msg === 'disabled') { setServerDisabled(true); setStep('form'); return; }
      if (msg === 'no_payout_method' || code === 'no_payout_method') { setMethod(null); setEditMethod(true); }
      // Erro de regra (não de rede): o próximo envio é um pedido NOVO.
      if (msg && msg !== 'internal_error' && msg !== 'cashout_failed') reqIdRef.current = '';
      setError(map[msg] || map[code] || tr(t, 'wallet.cashoutFailed', 'Falha ao solicitar saque.'));
      setStep('review');
      try { haptic.error(); } catch {}
      if (msg === 'too_many_pending' || msg === 'insufficient_available' || msg === 'negative_balance') loadAll();
    } catch (e) {
      setError(tr(t, 'cashout2.errNetwork', 'Sem conexão. Confira a internet e tente de novo.'));
      setStep('review');
    }
  }, [amountCents, pixKey, pixType, fullName, cpf, t, loadAll, rules.minAgeDays, useSaved, MIN_C, MAX_C]);

  // [saque-v2] detalhe com linha do tempo (servidor novo) + cancelar enquanto em análise.
  const openDetail = useCallback(async (row) => {
    setDetailRow(row);
    setDetail(null);
    try {
      const r = await api.walletCashoutDetail?.(row.id);
      if (r?.success && r.data && Number(r.data.id) === Number(row.id)) setDetail(r.data);
    } catch {}
  }, []);
  const cancelPayout = useCallback(async (row) => {
    if (!row || canceling) return;
    const go = async () => {
      setCanceling(true);
      try {
        const r = await api.payoutCancel?.(row.id);
        if (r?.success) {
          showToast({ message: tr(t, 'saque4.canceled', 'Saque cancelado. O valor voltou para seus ganhos.'), kind: 'success' });
          setDetailRow(null); setDetail(null);
          loadAll();
        } else {
          const m = String(r?.message || '');
          showToast({ message: m === 'cannot_cancel' ? tr(t, 'saque4.errCannotCancel', 'Este saque já foi aprovado e não pode mais ser cancelado.') : tr(t, 'wallet.cashoutFailed', 'Falha ao solicitar saque.'), kind: 'error' });
          loadAll();
        }
      } catch {
        showToast({ message: tr(t, 'cashout2.errNetwork', 'Sem conexão. Confira a internet e tente de novo.'), kind: 'error' });
      }
      setCanceling(false);
    };
    const q = tr(t, 'saque4.cancelConfirm', 'Cancelar este saque? O valor volta para seus ganhos.');
    if (Platform.OS === 'web') { try { if (typeof window !== 'undefined' && !window.confirm(q)) return; } catch {} go(); return; }
    try {
      const { Alert } = require('react-native');
      Alert.alert(tr(t, 'saque4.cancel', 'Cancelar saque'), q, [
        { text: tr(t, 'common.back', 'Voltar'), style: 'cancel' },
        { text: tr(t, 'saque4.cancel', 'Cancelar saque'), style: 'destructive', onPress: go },
      ]);
    } catch { go(); }
  }, [canceling, t, loadAll]);
  const openAbroad = useCallback(async () => {
    if (abroadBusy) return;
    setAbroadBusy(true);
    try {
      const r = await api.payoutOnboardLink?.('US');
      if (r?.success && r.data?.url) { try { await Linking.openURL(String(r.data.url)); } catch {} }
      else showToast({ message: tr(t, 'saque4.abroadSoon', 'Por enquanto os saques são via Pix, para contas no Brasil. Saques internacionais chegam em breve.'), kind: 'info' });
    } catch {}
    setAbroadBusy(false);
  }, [abroadBusy, t]);

  const copyReceipt = async (row) => {
    const lines = [
      `${tr(t, 'wallet.cashoutDetailTitle', 'Detalhes do saque')} #${row.id}`,
      `${tr(t, 'wallet.cashoutDetail.amount', 'Valor')}: ${brl(row.amount_cents)}`,
      ...(Number(row.fee_cents) > 0 ? [`${tr(t, 'saque4.youReceive', 'Você recebe')}: ${brl(row.net_cents)}`] : []),
      ...(row.receipt_ref ? [`${tr(t, 'saque4.receipt', 'Comprovante')}: ${row.receipt_ref}`] : []),
      `${tr(t, 'wallet.cashoutDetail.status', 'Status')}: ${statusLabel(t, String(row.status || 'pending'))}`,
      `${tr(t, 'wallet.cashoutDetail.key', 'Chave PIX')}: ${row.pix_key_masked || row.pix_key || ''}`,
    ];
    try { await Clipboard.setStringAsync(lines.join('\n')); showToast({ message: tr(t, 'wallet.copied', 'Copiado'), kind: 'success' }); } catch {}
  };

  const title = tr(t, 'wallet.cashoutTitle', 'Sacar ganhos');
  const inputStyle = [styles.input, Type.body, { color: s.text, backgroundColor: s.surface, borderColor: s.separator }];
  const fmtDate = (ts, withTime) => {
    const n = Number(ts) * 1000;
    if (!n) return '';
    try { return withTime ? new Date(n).toLocaleString(language || undefined) : new Date(n).toLocaleDateString(language || undefined); } catch { return ''; }
  };

  // ── Bloco do formulário / revisão / sucesso ────────────────────────────
  let formBlock = null;
  if (paused) {
    formBlock = (
      <Notice s={s} icon={IconInfo}
        title={tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.')}
        body={tr(t, 'cashout2.pausedBody', 'Seu saldo continua guardado. Avisaremos quando os saques via Pix voltarem.')} />
    );
  } else if (step === 'done' && result) {
    formBlock = (
      <Card>
        <View style={{ alignItems: 'center', paddingVertical: Space.md }}>
          <IconCheckCircle size={40} color={s.success} />
          <Text style={[Type.title3, { color: s.text, marginTop: Space.md }]}>{tr(t, 'wallet.cashoutSent', 'Saque solicitado')}</Text>
          <Text style={[Type.subhead, { color: s.textSecondary, textAlign: 'center', marginTop: Space.xs }]}>
            {tr(t, 'saque4.sentBody', '{amount} em análise. Você acompanha cada etapa aqui e recebe um aviso quando o Pix for pago.').replace('{amount}', brl(result.net != null ? result.net : result.amount))}
          </Text>
          <Button title={tr(t, 'common.done', 'Concluir')} variant="secondary" style={{ marginTop: Space.lg }} fullWidth
            onPress={() => { setStep('form'); setResult(null); }} />
        </View>
      </Card>
    );
  } else if (rules.block && step !== 'done') {
    const bm = {
      account_too_new: tr(t, 'earn.blockAccountNew', 'Sua conta precisa ter pelo menos {n} dias para sacar.').replace('{n}', String(rules.minAgeDays || 30)),
      minor: tr(t, 'earn.blockMinor', 'Saques não estão disponíveis para contas supervisionadas.'),
      negative_balance: tr(t, 'earn.blockNegative', 'Há um estorno pendente na sua carteira. Regularize para sacar.'),
      pending_exists: tr(t, 'earn.blockPending', 'Você já tem um saque em análise.'),
    };
    formBlock = (
      <Notice s={s} icon={IconInfo} title={bm[rules.block] || tr(t, 'creatorEarnings.cashoutPaused', 'Saques temporariamente indisponíveis.')} />
    );
  } else if (!reachedMin) {
    formBlock = (
      <Card>
        <Text style={[Type.headline, { color: s.text }]}>{tr(t, 'creatorEarnings.belowMin', 'Abaixo do mínimo para saque.')}</Text>
        <View style={[styles.track, { backgroundColor: s.fill, marginTop: Space.md }]}
          accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}>
          <View style={[styles.trackFill, { width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%`, backgroundColor: s.ink }]} />
        </View>
        <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm }]}>
          {tr(t, 'creatorDash.missing', 'Faltam {missing} para o saque mínimo de {min}')
            .replace('{missing}', money(MIN_C - available)).replace('{min}', money(MIN_C))}
        </Text>
      </Card>
    );
  } else if (step === 'review' || step === 'sending') {
    formBlock = (
      <Card>
        <Text style={[Type.headline, { color: s.text, marginBottom: Space.sm }]}>{tr(t, 'cashout2.reviewTitle', 'Confira antes de enviar')}</Text>
        <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.amount', 'Valor')} value={brl(amountCents) + (showConverted ? `  (≈ ${money(amountCents)})` : '')} />
        <DetailRow s={s} label={tr(t, 'saque4.fee', 'Taxa de saque')} value={feeCents > 0 ? '− ' + brl(feeCents) : tr(t, 'saque4.noFee', 'Sem taxa')} />
        <DetailRow s={s} label={tr(t, 'saque4.youReceive', 'Você recebe')} value={brl(netCents)} />
        {useSaved ? (
          <>
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.key', 'Chave PIX')} value={`${String(method?.pix_key_type || '').toUpperCase()} ${method?.pix_key_masked || ''}`} mono />
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.fullName', 'Titular')} value={method?.full_name || rules.kyc?.full_name || ''} />
            {rules.kyc?.cpf_masked ? <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.cpf', 'CPF')} value={rules.kyc.cpf_masked} mono /> : null}
          </>
        ) : (
          <>
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.key', 'Chave PIX')} value={pixType === 'cpf' ? fmtCpf(pixKey) : normPixKey(pixType, pixKey)} mono />
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.fullName', 'Titular')} value={fullName.trim()} />
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.cpf', 'CPF')} value={fmtCpf(cpf)} mono />
          </>
        )}
        <Text style={[Type.footnote, { color: s.textSecondary, marginTop: Space.sm }]}>{etaText}</Text>
        {error ? (
          <View style={{ flexDirection: 'row', gap: Space.sm, marginTop: Space.md }} accessibilityLiveRegion="polite">
            <IconAlertCircle size={18} color={s.danger} />
            <Text style={[Type.footnote, { color: s.danger, flex: 1 }]}>{error}</Text>
          </View>
        ) : null}
        <Button title={tr(t, 'cashout2.confirm', 'Confirmar saque')} size="lg" fullWidth loading={step === 'sending'}
          onPress={submit} style={{ marginTop: Space.lg }} />
        <Button title={tr(t, 'cashout2.edit', 'Editar dados')} variant="ghost" fullWidth disabled={step === 'sending'}
          onPress={() => { setError(''); reqIdRef.current = ''; setStep('form'); }} style={{ marginTop: Space.xs }} />
      </Card>
    );
  } else {
    formBlock = (
      <Card>
        <Field s={s} label={tr(t, 'wallet.cashoutAmount', 'Quanto você quer sacar?')} error={shown('amount')}
          hint={showConverted && amountCents > 0 ? `≈ ${money(amountCents)}`
            : feeCents > 0 && amountCents >= MIN_C ? `${tr(t, 'saque4.youReceive', 'Você recebe')}: ${brl(netCents)} (${tr(t, 'saque4.fee', 'Taxa de saque')} ${brl(feeCents)})`
            : tr(t, 'cashout2.amountHint', 'Pix é pago em reais. Mínimo {min}.').replace('{min}', brl(MIN_C))}>
          <View style={[styles.amountRow, { backgroundColor: s.surface, borderColor: shown('amount') ? s.danger : s.separator }]}>
            <Text style={[Type.title3, { color: s.textSecondary }]}>{brl(0).replace(/[\d.,\s ]/g, '') || 'BRL'}</Text>
            <TextInput
              value={amountText}
              onChangeText={(v) => setAmountText(v.replace(/[^0-9,.]/g, '').slice(0, 12))}
              onBlur={() => setTouched(p => ({ ...p, amount: true }))}
              placeholder="0,00"
              placeholderTextColor={s.textTertiary}
              keyboardType="decimal-pad"
              style={[Type.title2, styles.amountInput, { color: s.text }]}
              accessibilityLabel={tr(t, 'wallet.cashoutAmount', 'Quanto você quer sacar?')}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: Space.sm, marginTop: Space.sm }}>
            <Button size="sm" variant="secondary" title={tr(t, 'cashout2.useMin', 'Mínimo')}
              onPress={() => { setAmountText(centsToInput(MIN_C)); setTouched(p => ({ ...p, amount: true })); }} />
            <Button size="sm" variant="secondary" title={tr(t, 'cashout2.useAll', 'Tudo ({amount})').replace('{amount}', brl(maxAllowed))}
              onPress={() => { setAmountText(centsToInput(maxAllowed)); setTouched(p => ({ ...p, amount: true })); }} />
          </View>
        </Field>

        {useSaved ? (
          <Field s={s} label={tr(t, 'saque4.receiveIn', 'Receber em')}>
            <View style={[styles.savedRow, { backgroundColor: s.surface, borderColor: s.separator }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]} numberOfLines={1}>
                  {`Pix · ${String(method?.pix_key_type || '').toUpperCase()} ${method?.pix_key_masked || ''}`}
                </Text>
                <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                  {[method?.full_name || rules.kyc?.full_name, rules.kyc?.cpf_masked].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Button size="sm" variant="secondary" title={tr(t, 'saque4.change', 'Alterar')}
                onPress={() => { setEditMethod(true); reqIdRef.current = ''; if (rules.kyc?.full_name) setFullName(String(rules.kyc.full_name)); }} />
            </View>
          </Field>
        ) : null}
        {useSaved ? null : (<>
        <Field s={s} label={tr(t, 'wallet.cashoutPixKeyType', 'Tipo da chave')}>
          <SegmentedControl
            size="sm"
            value={pixType}
            onChange={(v) => { setPixType(v); setPixKey(''); setTouched(p => ({ ...p, pixKey: false })); }}
            options={[
              { value: 'cpf', label: tr(t, 'wallet.keyType.cpf', 'CPF') },
              { value: 'email', label: tr(t, 'wallet.keyType.email', 'E-mail') },
              { value: 'phone', label: tr(t, 'wallet.keyType.phone', 'Telefone') },
              { value: 'random', label: tr(t, 'wallet.keyType.random', 'Aleatória') },
            ]}
          />
        </Field>

        <Field s={s} label={tr(t, 'wallet.cashoutPixKey', 'Chave PIX')} error={shown('pixKey')}>
          <TextInput
            value={pixKey}
            onChangeText={onPixKeyChange}
            onBlur={() => setTouched(p => ({ ...p, pixKey: true }))}
            placeholder={{ cpf: '000.000.000-00', email: 'nome@exemplo.com', phone: '+55 11 90000-0000', random: '0000…-0000' }[pixType]}
            placeholderTextColor={s.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={pixType === 'email' ? 'email-address' : pixType === 'phone' ? 'phone-pad' : pixType === 'cpf' ? 'number-pad' : 'default'}
            style={[inputStyle, shown('pixKey') && { borderColor: s.danger }]}
            accessibilityLabel={tr(t, 'wallet.cashoutPixKey', 'Chave PIX')}
          />
        </Field>

        <Field s={s} label={tr(t, 'wallet.cashoutFullName', 'Nome completo (titular da conta)')} error={shown('fullName')}>
          <TextInput
            value={fullName}
            onChangeText={(v) => setFullName(v.slice(0, 120))}
            onBlur={() => setTouched(p => ({ ...p, fullName: true }))}
            placeholder={tr(t, 'wallet.cashoutFullNamePh', 'Nome completo')}
            placeholderTextColor={s.textTertiary}
            autoCapitalize="words"
            autoCorrect={false}
            style={[inputStyle, shown('fullName') && { borderColor: s.danger }]}
            accessibilityLabel={tr(t, 'wallet.cashoutFullName', 'Nome completo (titular da conta)')}
          />
        </Field>

        <Field s={s} label={tr(t, 'wallet.cashoutCpf', 'CPF')} error={shown('cpf')}
          hint={rules.kyc?.cpf_masked
            ? tr(t, 'cashout3.cpfKycHint', 'Use o mesmo CPF dos saques anteriores ({cpf}).').replace('{cpf}', String(rules.kyc.cpf_masked))
            : tr(t, 'cashout2.cpfHint', 'CPF do titular da conta que recebe o Pix.')}>
          <TextInput
            value={cpf}
            onChangeText={(v) => setCpf(fmtCpf(v))}
            onBlur={() => setTouched(p => ({ ...p, cpf: true }))}
            placeholder="000.000.000-00"
            placeholderTextColor={s.textTertiary}
            keyboardType="number-pad"
            maxLength={14}
            style={[inputStyle, shown('cpf') && { borderColor: s.danger }]}
            accessibilityLabel={tr(t, 'wallet.cashoutCpf', 'CPF')}
          />
        </Field>
        </>)}

        <Button title={tr(t, 'cashout2.continue', 'Continuar')} size="lg" fullWidth onPress={goReview} style={{ marginTop: Space.xl }} />
        <Text style={[Type.caption, { color: s.textTertiary, textAlign: 'center', marginTop: Space.md }]}>
          {tr(t, 'cashout3.tos', 'Cada saque passa por análise manual (titularidade do CPF e da chave Pix) antes do pagamento via Pix, em até 3 dias úteis. Taxas já descontadas do saldo.')}
        </Text>
      </Card>
    );
  }
  // [saque-v2] quem mora fora do Brasil: cadastro hospedado (Stripe) quando o servidor liga; senão "em breve".
  const abroadBlock = paused || step === 'review' || step === 'sending' ? null : (
    <Card>
      <View style={{ flexDirection: 'row', gap: Space.md }}>
        <IconGlobe size={22} color={s.textSecondary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{tr(t, 'saque4.abroadTitle', 'Mora fora do Brasil?')}</Text>
          <Text style={[Type.footnote, { color: s.textSecondary, marginTop: 2 }]}>
            {opts?.intl
              ? tr(t, 'saque4.abroadBody', 'O cadastro e a verificação de identidade são feitos pela Stripe, com segurança.')
              : tr(t, 'saque4.abroadSoon', 'Por enquanto os saques são via Pix, para contas no Brasil. Saques internacionais chegam em breve.')}
          </Text>
          {opts?.intl ? (
            <Button size="sm" variant="secondary" title={tr(t, 'saque4.abroadSetup', 'Cadastrar conta de recebimento')}
              loading={abroadBusy} onPress={openAbroad} style={{ marginTop: Space.sm, alignSelf: 'flex-start' }} />
          ) : null}
        </View>
      </View>
    </Card>
  );

  const body = (
    <>
      {/* [2026-10-14 v3.1] mesmo cartão-herói grafite da Carteira / Meus Ganhos. */}
      <HeroCard isDark={isDark} glow={false}>
        <Text style={[styles.heroCaps, { color: HERO.sub }]}>
          {tr(t, 'wallet.cashoutAvailable', 'Disponível para saque')}
        </Text>
        <Text style={[styles.heroNum, TABULAR, { color: HERO.text, marginTop: Space.sm }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {money(available)}
        </Text>
        <Text style={[Type.footnote, { color: HERO.sub, marginTop: Space.xs }]}>
          {tr(t, 'cashout3.heroSub', 'Mínimo {min} · análise manual · Pix em até 3 dias úteis').replace('{min}', money(MIN_C))}
        </Text>
        {rules.onHold > 0 ? (
          <Text style={[Type.footnote, { color: HERO.sub, marginTop: Space.xs }]}>
            {tr(t, 'earn.onHold', '{amount} em liberação (presentes dos últimos {days} dias)')
              .replace('{amount}', money(rules.onHold)).replace('{days}', String(rules.holdDays || 7))}
          </Text>
        ) : null}
      </HeroCard>

      {formBlock}
      {abroadBlock}

      <SectionHeader variant="grouped" inset={Space.xs} style={{ paddingTop: Space.sm }} title={tr(t, 'wallet.cashoutHistory', 'Saques anteriores')} />
      <Card padding={0}>
        {history.length === 0 ? (
          <Text style={[Type.footnote, { color: s.textSecondary, padding: Space.lg }]}>
            {tr(t, 'wallet.cashoutHistoryEmpty', 'Nenhum saque ainda.')}
          </Text>
        ) : history.map((row, idx) => {
          const st = String(row.status || 'pending');
          return (
            <PressableRow key={String(row.id)} onPress={() => openDetail(row)} accessibilityRole="button"
              accessibilityLabel={`${money(row.amount_cents)}, ${statusLabel(t, st)}`}
              style={[styles.histRow, idx < history.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[Type.callout, { color: s.text, fontWeight: '600' }]}>{money(row.amount_cents)}</Text>
                <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>
                  {(row.pix_key_masked || row.pix_key || '')}{row.requested_at_ts ? ' · ' + fmtDate(row.requested_at_ts) : ''}
                </Text>
              </View>
              <Badge label={statusLabel(t, st)} tone={statusTone(st)} />
            </PressableRow>
          );
        })}
      </Card>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: s.bgGrouped }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title })} />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} maxWidth={Layout.contentMaxWidth} />
      )}
      {loading ? (
        <View style={[styles.scrollBody, { gap: Space.md }]}>
          <Skeleton height={124} radius={Radius.card} />
          <Skeleton height={300} radius={Radius.card} delay={60} />
          <Skeleton height={64} radius={Radius.card} delay={120} />
        </View>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            contentContainerStyle={[styles.scrollBody, { paddingBottom: Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
          >
            <SkeletonFadeIn style={{ gap: Space.md }}>{body}</SkeletonFadeIn>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <Sheet visible={!!detailRow} onClose={() => { setDetailRow(null); setDetail(null); }} title={tr(t, 'wallet.cashoutDetailTitle', 'Detalhes do saque')}>
        {detailRow ? (
          <View style={{ paddingHorizontal: Space.lg, paddingBottom: Space.lg }}>
            <View style={{ alignItems: 'center', paddingVertical: Space.md }}>
              <Text style={[Type.title1, { color: s.text }]}>{money(detailRow.amount_cents)}</Text>
              <View style={{ marginTop: Space.sm }}>
                <Badge label={statusLabel(t, String(detailRow.status || 'pending'))} tone={statusTone(String(detailRow.status || 'pending'))} />
              </View>
            </View>
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.key', 'Chave PIX')} value={detailRow.pix_key_masked || detailRow.pix_key} mono />
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.type', 'Tipo')} value={String(detailRow.pix_key_type || 'auto').toUpperCase()} />
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.requested', 'Solicitado em')} value={fmtDate(detailRow.requested_at_ts, true)} />
            {detailRow.processed_at_ts ? <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.processed', 'Processado em')} value={fmtDate(detailRow.processed_at_ts, true)} /> : null}
            <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.id', 'ID do saque')} value={`#${detailRow.id}`} />
            {Number(detailRow.fee_cents) > 0 ? <DetailRow s={s} label={tr(t, 'saque4.fee', 'Taxa de saque')} value={'− ' + brl(detailRow.fee_cents)} /> : null}
            {Number(detailRow.fee_cents) > 0 ? <DetailRow s={s} label={tr(t, 'saque4.youReceive', 'Você recebe')} value={brl(detailRow.net_cents)} /> : null}
            {detailRow.receipt_ref ? <DetailRow s={s} label={tr(t, 'saque4.receipt', 'Comprovante')} value={detailRow.receipt_ref} mono /> : null}
            {detailRow.admin_note ? <DetailRow s={s} label={tr(t, 'wallet.cashoutDetail.note', 'Observação')} value={detailRow.admin_note} /> : null}
            {Array.isArray(detail?.events) && detail.events.length > 0 ? (
              <View style={{ marginTop: Space.md }}>
                <Text style={[Type.footnote, { color: s.textSecondary, fontWeight: '600', marginBottom: Space.xs }]}>{tr(t, 'saque4.timeline', 'Andamento')}</Text>
                {detail.events.map((ev, i) => (
                  <View key={String(i)} style={styles.evRow}>
                    <View style={[styles.evDot, { backgroundColor: i === detail.events.length - 1 ? s.ink : s.separator }]} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[Type.subhead, { color: s.text }]}>{eventLabel(t, String(ev.status))}</Text>
                      {ev.note ? <Text style={[Type.caption, { color: s.textSecondary }]}>{ev.note}</Text> : null}
                    </View>
                    <Text style={[Type.caption, { color: s.textTertiary }]}>{fmtDate(ev.ts, true)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Button title={tr(t, 'cashout2.copyReceipt', 'Copiar comprovante')} variant="secondary" fullWidth
              onPress={() => copyReceipt(detailRow)} style={{ marginTop: Space.lg }} />
            {(detail ? detail.can_cancel && !detail._stale : String(detailRow.status || 'pending') === 'pending' && detailRow.can_cancel) ? (
              <Button title={tr(t, 'saque4.cancel', 'Cancelar saque')} variant="ghost" fullWidth loading={canceling}
                onPress={() => cancelPayout(detailRow)} style={{ marginTop: Space.xs }} />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollBody: {
    padding: Layout.gutter, gap: Space.md,
    width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center',
  },
  heroCaps: { fontSize: 12, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase' },
  heroNum: { fontSize: 42, lineHeight: 50, fontWeight: '700', letterSpacing: -1.2 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  amountRow: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm,
    borderRadius: Radius.control, borderWidth: 1, paddingHorizontal: Space.md, minHeight: 56,
  },
  amountInput: { flex: 1, textAlign: 'right', paddingVertical: Space.sm, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  input: {
    borderRadius: Radius.control, borderWidth: 1, paddingHorizontal: Space.md, minHeight: 48,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: Space.sm, gap: Space.md },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, borderRadius: Radius.control, borderWidth: 1, paddingHorizontal: Space.md, paddingVertical: Space.sm, minHeight: 56 },
  evRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm, paddingVertical: 6 },
  evDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
});
