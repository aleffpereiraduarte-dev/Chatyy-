// /wallet-cashout — creator payout request (PIX).
//
// Surfaces when chat_wallet_balances.pending_payout_cents > 0. The user
// fills a small form (PIX key + full name + CPF + amount) and we POST
// wallet_cashout_request — backend debits pending_payout_cents and writes
// a chat_wallet_payouts row in status='pending'. A back-office worker
// (admin.php cron, out of scope here) reconciles and marks paid.
//
// Constraints (mirrored on the backend):
//   • Minimum: R$ 50,00 (5000 cents)
//   • Maximum: R$ 50.000,00 (5_000_000 cents)
//   • CPF: 11 digits (auto-stripped)
//   • 3 requests / day per user
//
// No native deps — pure JS / Animated. Safe to OTA.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Platform, StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconDiamond, IconX } from '../components/Icons';
import { formatInt, numberLocale } from '../utils/dateFormat';
import { Modal } from 'react-native';
import { Clipboard } from 'react-native';

const MIN_CENTS = 5000;       // R$ 50,00
const MAX_CENTS = 5000000;    // R$ 50.000,00
// Conversion rate (mirrors backend feed_post_tip / live_gift_send split):
// each diamond → R$ 0,05 of pending payout after the 70/30 split is applied
// on the backend. Frontend exposes the post-fee rate so creators see the
// number they will actually withdraw. 1000 ◆ ≈ R$ 50.
const DIAMOND_TO_BRL_CENTS = 5;

// Parse a user-typed BRL amount ("1.234,56" or "1234.56" or "1234")
// into integer cents. Any non-digit besides , and . is stripped.
function parseBrlToCents(text) {
  if (text === null || text === undefined) return 0;
  let s = String(text).replace(/[^0-9,\.]/g, '');
  if (s === '') return 0;
  // Convert "1.234,56" → "1234.56"
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(s);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function fmtBrl(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2).replace('.', ',');
}

function CashoutHistoryRow({ row, colors, isDark, t, onPress }) {
  const status = String(row.status || 'pending');
  const statusLabel =
    t(`wallet.statusBadge.${status}`) ||
    t(`wallet.cashoutStatus.${status}`) ||
    (status === 'paid' ? 'Pago' : status === 'rejected' ? 'Rejeitado' : 'Em análise');
  const color = status === 'paid' ? '#10B981' : status === 'rejected' ? '#EF4444' : '#F59E0B';
  const when = (() => {
    const ts = Number(row.requested_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
  })();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={t('wallet.cashoutDetailTitle') || 'Detalhes do saque'}
      style={[styles.histRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}
    >
      <View style={styles.histLeft}>
        <Text style={[styles.histAmount, { color: colors.text }]}>
          R$ {fmtBrl(row.amount_cents)}
        </Text>
        <Text style={[styles.histKey, { color: colors.textSecondary }]} numberOfLines={1}>
          {row.pix_key_masked || row.pix_key}
        </Text>
        <Text style={[styles.histWhen, { color: colors.textTertiary }]}>{when}</Text>
      </View>
      <View style={[styles.statusPill, { backgroundColor: `${color}22`, borderColor: color }]}>
        <Text style={[styles.statusText, { color }]}>{statusLabel}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Detail modal — opens when user taps a history row. Reveals full PIX key
// (no masking), processed_at if paid, admin_note if rejected. "Compartilhar
// comprovante" copies a multi-line receipt to clipboard.
function CashoutDetailModal({ visible, row, onClose, colors, isDark, t }) {
  if (!row) return null;
  const status = String(row.status || 'pending');
  const color = status === 'paid' ? '#10B981' : status === 'rejected' ? '#EF4444' : '#F59E0B';
  const statusLabel =
    t(`wallet.statusBadge.${status}`) || t(`wallet.cashoutStatus.${status}`) || status;
  const when = (() => {
    const ts = Number(row.requested_at_ts) * 1000;
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return '—'; }
  })();
  const processed = (() => {
    const ts = Number(row.processed_at_ts) * 1000;
    if (!ts) return null;
    try { return new Date(ts).toLocaleString(); } catch { return null; }
  })();

  const buildReceipt = () => {
    const lines = [
      `${t('wallet.cashoutDetailTitle') || 'Detalhes do saque'} #${row.id}`,
      '',
      `${t('wallet.cashoutDetail.amount') || 'Valor'}: R$ ${fmtBrl(row.amount_cents)}`,
      `${t('wallet.cashoutDetail.status') || 'Status'}: ${statusLabel}`,
      `${t('wallet.cashoutDetail.key') || 'Chave PIX'}: ${row.pix_key}`,
      `${t('wallet.cashoutDetail.requested') || 'Solicitado em'}: ${when}`,
    ];
    if (processed) lines.push(`${t('wallet.cashoutDetail.processed') || 'Processado em'}: ${processed}`);
    if (row.admin_note) lines.push(`${t('wallet.cashoutDetail.note') || 'Observação'}: ${row.admin_note}`);
    return lines.join('\n');
  };

  const onShare = async () => {
    const txt = buildReceipt();
    try { Clipboard?.setString?.(txt); } catch {}
    Alert.alert(t('wallet.copied') || 'Copiado', txt);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.detailSheet, { backgroundColor: isDark ? '#0F172A' : '#fff' }]}>
          <View style={styles.detailHead}>
            <Text style={[styles.detailTitle, { color: colors.text }]} numberOfLines={1}>
              {t('wallet.cashoutDetailTitle') || 'Detalhes do saque'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.detailClose} accessibilityRole="button">
              <IconX size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={[styles.detailStatusBlock, { backgroundColor: `${color}14` }]}>
            <Text style={[styles.detailStatusLabel, { color: colors.textSecondary }]}>
              {t('wallet.cashoutDetail.status') || 'Status'}
            </Text>
            <Text style={[styles.detailStatusVal, { color }]}>{statusLabel}</Text>
            <Text style={[styles.detailStatusAmount, { color: colors.text }]}>
              R$ {fmtBrl(row.amount_cents)}
            </Text>
          </View>

          <DetailRow label={t('wallet.cashoutDetail.key') || 'Chave PIX'} value={row.pix_key} colors={colors} mono />
          <DetailRow label={t('wallet.cashoutDetail.type') || 'Tipo'} value={String(row.pix_key_type || 'auto').toUpperCase()} colors={colors} />
          <DetailRow label={t('wallet.cashoutDetail.requested') || 'Solicitado em'} value={when} colors={colors} />
          {processed ? <DetailRow label={t('wallet.cashoutDetail.processed') || 'Processado em'} value={processed} colors={colors} /> : null}
          <DetailRow label={t('wallet.cashoutDetail.id') || 'ID do saque'} value={`#${row.id}`} colors={colors} />
          {row.admin_note ? <DetailRow label={t('wallet.cashoutDetail.note') || 'Observação'} value={row.admin_note} colors={colors} /> : null}

          <TouchableOpacity onPress={onShare} style={styles.detailShareBtn} accessibilityRole="button">
            <Text style={styles.detailShareBtnText}>
              {t('wallet.cashoutDetail.share') || 'Compartilhar comprovante'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function DetailRow({ label, value, colors, mono }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailRowLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text
        style={[
          styles.detailRowVal,
          { color: colors.text, fontFamily: mono ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined },
        ]}
        selectable
        numberOfLines={3}
      >
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

  const [available, setAvailable] = useState(0);
  const [detailRow, setDetailRow] = useState(null);          // pending_payout_cents
  const [loadingBal, setLoadingBal] = useState(true);
  const [history, setHistory] = useState([]);
  const [amountText, setAmountText] = useState('');
  const [pixKey, setPixKey] = useState('');
  const [pixType, setPixType] = useState('auto');         // auto|cpf|email|phone|random
  const [fullName, setFullName] = useState('');
  const [cpf, setCpf] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoadingBal(true);
    try {
      const [bal, list] = await Promise.all([
        api.walletBalance?.(),
        api.walletCashoutList?.(),
      ]);
      if (bal?.success && bal.data) {
        setAvailable(Number(bal.data.pending_payout_cents) || 0);
      }
      if (list?.success && Array.isArray(list?.data?.items)) {
        setHistory(list.data.items);
      }
    } catch {}
    setLoadingBal(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const amountCents = useMemo(() => parseBrlToCents(amountText), [amountText]);
  const tooLow = amountCents > 0 && amountCents < MIN_CENTS;
  const overAvailable = amountCents > available;
  const canSubmit =
    !submitting &&
    amountCents >= MIN_CENTS &&
    amountCents <= MAX_CENTS &&
    amountCents <= available &&
    pixKey.trim().length >= 4 &&
    fullName.trim().length >= 3 &&
    cpf.replace(/[^0-9]/g, '').length === 11;

  const onSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const r = await api.walletCashoutRequest({
        amountCents,
        pixKey,
        pixKeyType: pixType,
        fullName,
        cpf,
      });
      if (r?.success && r?.data) {
        const sentBrl = fmtBrl(r.data.amount_cents);
        Alert.alert(
          t('wallet.cashoutSent') || 'Saque solicitado',
          (t('wallet.cashoutSentBody') || 'R$ {amount} serão enviados para o PIX em até 48h úteis.')
            .replace('{amount}', sentBrl),
        );
        setAvailable(Number(r.data.pending_payout_cents) || 0);
        setAmountText('');
        // Optimistic prepend; loadAll will refresh canonical order.
        setHistory(prev => [{
          id: r.data.payout_id,
          amount_cents: r.data.amount_cents,
          pix_key: pixKey,
          pix_key_type: pixType,
          status: 'pending',
          requested_at_ts: Math.floor(Date.now() / 1000),
        }, ...prev]);
        return;
      }
      const msg = r?.message || '';
      const errKey =
        msg === 'min_cashout'        ? 'wallet.cashoutMinError' :
        msg === 'max_cashout'        ? 'wallet.cashoutMaxError' :
        msg === 'cpf_invalid'        ? 'wallet.cashoutCpfError' :
        msg === 'name_invalid'       ? 'wallet.cashoutNameError' :
        msg === 'pix_key_invalid'    ? 'wallet.cashoutKeyError' :
        msg === 'too_many_pending'   ? 'wallet.cashoutRateLimit' :
        r?.data?.code === 'rate_limit'           ? 'wallet.cashoutRateLimit' :
        r?.data?.code === 'insufficient_pending' ? 'wallet.cashoutInsufficient' :
        'wallet.cashoutFailed';
      Alert.alert(t('common.error') || 'Erro', t(errKey) || msg || 'Falha ao solicitar saque.');
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || (t('wallet.cashoutFailed') || 'Falha ao solicitar saque.'));
    } finally {
      setSubmitting(false);
    }
  }, [amountCents, canSubmit, cpf, fullName, pixKey, pixType, t]);

  const fmtCpf = (raw) => {
    const d = String(raw || '').replace(/[^0-9]/g, '').slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: (insets.top || 0) + 6 }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={styles.headBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headTitle, { color: colors.text }]} numberOfLines={1}>
          {t('wallet.cashoutTitle') || 'Sacar ganhos'}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero */}
        <View style={[styles.hero, {
          backgroundColor: isDark ? 'rgba(16,185,129,0.16)' : 'rgba(16,185,129,0.10)',
          borderColor: isDark ? 'rgba(16,185,129,0.40)' : 'rgba(16,185,129,0.30)',
        }]}>
          <Text style={[styles.heroSubtitle, { color: colors.textSecondary }]}>
            {t('wallet.cashoutHero') || 'Saque seus ganhos de criador via PIX. Mínimo R$ 50,00. Pagamento em até 48h úteis.'}
          </Text>
          <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>
            {t('wallet.cashoutAvailable') || 'Disponível para saque'}
          </Text>
          {loadingBal ? (
            <ActivityIndicator color="#10B981" />
          ) : (
            <Text style={[styles.heroValue, { color: '#10B981' }]}>
              R$ {fmtBrl(available)}
            </Text>
          )}
          <View style={styles.rateChip}>
            <IconDiamond size={12} color="#A855F7" />
            <Text style={[styles.rateChipText, { color: colors.textSecondary }]}>
              {(t('wallet.cashoutRateLine') || '1 000 ◆ ≈ R$ {brl}')
                .replace('{brl}', ((1000 * DIAMOND_TO_BRL_CENTS) / 100).toFixed(2).replace('.', numberLocale(language).startsWith('pt') ? ',' : '.'))}
            </Text>
          </View>
        </View>

        {/* Amount field */}
        <Text style={[styles.label, { color: colors.text }]}>
          {t('wallet.cashoutAmount') || 'Quanto você quer sacar?'}
        </Text>
        <View style={[styles.amountRow, {
          borderColor: tooLow || overAvailable ? '#EF4444' : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.12)'),
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
        }]}>
          <Text style={[styles.brlPrefix, { color: colors.textSecondary }]}>R$</Text>
          <TextInput
            value={amountText}
            onChangeText={setAmountText}
            placeholder={t('wallet.cashoutAmountPh') || '0,00'}
            placeholderTextColor={colors.textTertiary}
            keyboardType="decimal-pad"
            maxLength={12}
            style={[styles.amountInput, { color: colors.text }]}
          />
        </View>
        {tooLow ? (
          <Text style={styles.errText}>{t('wallet.cashoutMinError') || 'Mínimo R$ 50,00.'}</Text>
        ) : overAvailable ? (
          <Text style={styles.errText}>{t('wallet.cashoutInsufficient') || 'Saldo insuficiente.'}</Text>
        ) : amountCents >= MIN_CENTS ? (
          <View style={styles.previewRow}>
            <Text style={[styles.previewLabel, { color: colors.textSecondary }]}>
              {t('wallet.cashoutPreviewLabel') || 'Você vai receber'}
            </Text>
            <Text style={[styles.previewVal, { color: '#10B981' }]}>
              R$ {fmtBrl(amountCents)}
            </Text>
          </View>
        ) : null}

        {/* PIX type chips */}
        <Text style={[styles.label, { color: colors.text }]}>
          {t('wallet.cashoutPixKeyType') || 'Tipo da chave'}
        </Text>
        <View style={styles.chipsRow}>
          {[
            { id: 'cpf',    label: 'CPF' },
            { id: 'email',  label: 'E-mail' },
            { id: 'phone',  label: 'Telefone' },
            { id: 'random', label: 'Aleatória' },
          ].map(c => {
            const active = pixType === c.id;
            return (
              <TouchableOpacity
                key={c.id}
                onPress={() => setPixType(c.id)}
                style={[styles.chip, {
                  backgroundColor: active ? '#10B981' : (isDark ? 'rgba(16,185,129,0.10)' : 'rgba(16,185,129,0.06)'),
                  borderColor: active ? '#10B981' : (isDark ? 'rgba(16,185,129,0.32)' : 'rgba(16,185,129,0.22)'),
                }]}
                accessibilityRole="button"
              >
                <Text style={[styles.chipText, { color: active ? '#fff' : colors.text }]}>
                  {c.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* PIX key */}
        <Text style={[styles.label, { color: colors.text }]}>
          {t('wallet.cashoutPixKey') || 'Chave PIX'}
        </Text>
        <TextInput
          value={pixKey}
          onChangeText={(s) => setPixKey(s.slice(0, 120))}
          placeholder={t('wallet.cashoutPixKeyPh') || 'CPF, e-mail, telefone ou chave aleatória'}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={pixType === 'email' ? 'email-address' : (pixType === 'phone' ? 'phone-pad' : 'default')}
          style={[styles.textInput, {
            color: colors.text,
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
            borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.12)',
          }]}
        />

        {/* Full name */}
        <Text style={[styles.label, { color: colors.text }]}>
          {t('wallet.cashoutFullName') || 'Nome completo (titular da conta)'}
        </Text>
        <TextInput
          value={fullName}
          onChangeText={(s) => setFullName(s.slice(0, 120))}
          placeholder="Maria Aparecida da Silva"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="words"
          autoCorrect={false}
          style={[styles.textInput, {
            color: colors.text,
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
            borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.12)',
          }]}
        />

        {/* CPF */}
        <Text style={[styles.label, { color: colors.text }]}>
          {t('wallet.cashoutCpf') || 'CPF'}
        </Text>
        <TextInput
          value={cpf}
          onChangeText={(s) => setCpf(fmtCpf(s))}
          placeholder={t('wallet.cashoutCpfPh') || '000.000.000-00'}
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          maxLength={14}
          style={[styles.textInput, {
            color: colors.text,
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
            borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.12)',
          }]}
        />

        {/* Submit */}
        <TouchableOpacity
          onPress={onSubmit}
          disabled={!canSubmit}
          style={[styles.submitBtn, {
            backgroundColor: canSubmit ? '#10B981' : (isDark ? 'rgba(16,185,129,0.40)' : 'rgba(16,185,129,0.50)'),
          }]}
          accessibilityRole="button"
          accessibilityLabel={t('wallet.cashoutCta') || 'Solicitar saque'}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>
              {t('wallet.cashoutCta') || 'Solicitar saque'}
              {amountCents >= MIN_CENTS ? `  ·  R$ ${fmtBrl(amountCents)}` : ''}
            </Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.tos, { color: colors.textTertiary }]}>
          {t('wallet.cashoutTos') || 'Ao solicitar, você concorda com os termos. Taxa de plataforma de 30% já descontada do saldo de saque.'}
        </Text>

        {/* History */}
        <Text style={[styles.histTitle, { color: colors.textSecondary }]}>
          {t('wallet.cashoutHistory') || 'Saques anteriores'}
        </Text>
        {history.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textTertiary }]}>
            {t('wallet.cashoutHistoryEmpty') || 'Nenhum saque ainda.'}
          </Text>
        ) : history.map(row => (
          <CashoutHistoryRow
            key={String(row.id)}
            row={row}
            colors={colors}
            isDark={isDark}
            t={t}
            onPress={() => setDetailRow(row)}
          />
        ))}
      </ScrollView>

      <CashoutDetailModal
        visible={!!detailRow}
        row={detailRow}
        onClose={() => setDetailRow(null)}
        colors={colors}
        isDark={isDark}
        t={t}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, marginBottom: 10,
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '800' },

  hero: {
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 18, paddingHorizontal: 16,
    marginBottom: 18, alignItems: 'center',
  },
  heroSubtitle: { fontSize: 13, textAlign: 'center', marginBottom: 14, lineHeight: 18 },
  heroLabel: { fontSize: 12, fontWeight: '600' },
  heroValue: { fontSize: 30, fontWeight: '900', marginTop: 4 },

  label: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  amountRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 8,
  },
  brlPrefix: { fontSize: 18, fontWeight: '800' },
  amountInput: { flex: 1, fontSize: 22, fontWeight: '800', textAlign: 'right' },
  errText: { color: '#EF4444', fontSize: 12, marginTop: 6 },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 12, fontWeight: '700' },

  textInput: {
    borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15, marginBottom: 4,
  },

  submitBtn: {
    marginTop: 22, paddingVertical: 14, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  submitBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  tos: { fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 14 },

  histTitle: {
    fontSize: 12, marginTop: 26, marginBottom: 6,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  empty: { textAlign: 'center', fontSize: 13, paddingVertical: 24 },
  histRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12,
  },
  histLeft: { flex: 1 },
  histAmount: { fontSize: 15, fontWeight: '800' },
  histKey: { fontSize: 12, marginTop: 2 },
  histWhen: { fontSize: 11, marginTop: 2 },
  statusPill: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
  },
  statusText: { fontSize: 11, fontWeight: '800' },

  rateChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 10, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, backgroundColor: 'rgba(168,85,247,0.10)',
  },
  rateChipText: { fontSize: 11, fontWeight: '700' },

  previewRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 8, paddingHorizontal: 4,
  },
  previewLabel: { fontSize: 12 },
  previewVal: { fontSize: 14, fontWeight: '800' },

  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  detailSheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 30,
    minHeight: 380,
  },
  detailHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  detailTitle: { fontSize: 16, fontWeight: '800' },
  detailClose: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  detailStatusBlock: {
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 14, marginBottom: 14, alignItems: 'center',
  },
  detailStatusLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  detailStatusVal: { fontSize: 13, fontWeight: '800', marginTop: 4 },
  detailStatusAmount: { fontSize: 26, fontWeight: '900', marginTop: 6, letterSpacing: -0.4 },
  detailRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingVertical: 10, gap: 12,
  },
  detailRowLabel: { fontSize: 12, fontWeight: '600', minWidth: 110 },
  detailRowVal: { flex: 1, fontSize: 13, fontWeight: '700', textAlign: 'right' },
  detailShareBtn: {
    marginTop: 14, paddingVertical: 12,
    borderRadius: 12, backgroundColor: '#A855F7',
    alignItems: 'center',
  },
  detailShareBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
