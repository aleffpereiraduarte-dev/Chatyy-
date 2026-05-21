// WalletCashoutSheet — "Sacar via PIX" sheet for creator earnings.
//
// WAVE 57 (2026-05-21) — single-currency wallet redesign.
// Calls the existing wallet_cashout_request endpoint. Available when
// the user has at least R$ 50,00 (5000 cents) of pending_payout_cents
// — same constraint enforced server-side.
//
// Fields: amount (BRL), PIX key, key type, full name, CPF.
// Mirrors the `/wallet-cashout` screen but in a slimmer bottom-sheet
// optimized for first-time cashout. Power users can still tap "Ver
// histórico" to go to the full screen.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
  TextInput, Alert, Platform, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconChevronRight } from '../Icons';
import * as api from '../../services/api';

const GREEN  = '#10B981';
const PURPLE = '#A855F7';
const RED    = '#EF4444';

const MIN_CASHOUT_CENTS = 5000; // R$ 50,00

const KEY_TYPES = [
  { id: 'cpf',    label: 'CPF' },
  { id: 'email',  label: 'E-mail' },
  { id: 'phone',  label: 'Telefone' },
  { id: 'random', label: 'Aleatória' },
];

function tap(kind = 'light') {
  try {
    if (kind === 'light')  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

function fmtBrl(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2).replace('.', ',');
}

export default function WalletCashoutSheet({ visible, onClose, availableCents = 0, onSuccess }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [amountInput, setAmountInput] = useState('');
  const [pixKey, setPixKey]     = useState('');
  const [keyType, setKeyType]   = useState('cpf');
  const [fullName, setFullName] = useState('');
  const [cpf, setCpf]           = useState('');
  const [submitting, setSubmitting] = useState(false);

  const amountCents = useMemo(() => {
    const cleaned = String(amountInput).replace(/[^0-9,.]/g, '').replace(',', '.');
    const v = parseFloat(cleaned);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(v * 100);
  }, [amountInput]);

  const reset = useCallback(() => {
    setAmountInput('');
    setPixKey('');
    setKeyType('cpf');
    setFullName('');
    setCpf('');
    setSubmitting(false);
  }, []);

  const onSubmit = useCallback(async () => {
    if (amountCents < MIN_CASHOUT_CENTS) {
      Alert.alert(t('common.error') || 'Erro', t('wallet.cashoutMinError') || 'O saque mínimo é R$ 50,00.');
      return;
    }
    if (amountCents > availableCents) {
      Alert.alert(t('common.error') || 'Erro', t('wallet.cashoutInsufficient') || 'Saldo de saque insuficiente.');
      return;
    }
    const cleanedCpf = String(cpf).replace(/[^0-9]/g, '');
    if (cleanedCpf.length !== 11) {
      Alert.alert(t('common.error') || 'Erro', t('wallet.cashoutCpfInvalid') || 'CPF inválido (11 dígitos).');
      return;
    }
    if (String(fullName).trim().length < 3) {
      Alert.alert(t('common.error') || 'Erro', t('wallet.cashoutNameInvalid') || 'Informe o nome completo do titular.');
      return;
    }
    if (String(pixKey).trim().length < 4) {
      Alert.alert(t('common.error') || 'Erro', t('wallet.cashoutKeyInvalid') || 'Chave PIX inválida.');
      return;
    }

    setSubmitting(true);
    try {
      const r = await api.walletCashoutRequest?.({
        amountCents,
        pixKey: pixKey.trim(),
        pixKeyType: keyType,
        fullName: fullName.trim(),
        cpf: cleanedCpf,
      });
      if (r?.success) {
        tap('success');
        Alert.alert(
          t('wallet.cashoutSent') || 'Saque solicitado',
          (t('wallet.cashoutSentBody') || 'R$ {amount} serão enviados para o PIX em até 48h úteis.').replace('{amount}', fmtBrl(amountCents)),
        );
        reset();
        onSuccess?.();
        onClose?.();
      } else {
        const code = r?.message || r?.code || '';
        const msg = code === 'min_cashout'   ? (t('wallet.cashoutMinError')      || 'O saque mínimo é R$ 50,00.')
                  : code === 'max_cashout'   ? (t('wallet.cashoutMaxError')      || 'O saque máximo é R$ 50.000,00.')
                  : code === 'cpf_invalid'   ? (t('wallet.cashoutCpfInvalid')    || 'CPF inválido.')
                  : code === 'name_invalid'  ? (t('wallet.cashoutNameInvalid')   || 'Nome inválido.')
                  : code === 'pix_key_invalid' ? (t('wallet.cashoutKeyInvalid')  || 'Chave PIX inválida.')
                  : code === 'insufficient_payout' ? (t('wallet.cashoutInsufficient') || 'Saldo de saque insuficiente.')
                  : code === 'too_many_pending'    ? (t('wallet.cashoutTooMany') || 'Você já tem saques pendentes. Aguarde o processamento.')
                  : (t('wallet.cashoutFailed') || 'Falha ao solicitar saque.');
        Alert.alert(t('common.error') || 'Erro', msg);
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || (t('wallet.cashoutFailed') || 'Falha ao solicitar saque.'));
    } finally {
      setSubmitting(false);
    }
  }, [amountCents, availableCents, pixKey, keyType, fullName, cpf, t, onSuccess, onClose, reset]);

  const surface = isDark ? '#0B0B0F' : '#F7F7FB';
  const cardBg  = isDark ? '#16161E' : '#FFFFFF';
  const border  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)';
  const subtle  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)';
  const chipBg  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)';

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: Math.max(insets.bottom, 18) }]}>
            <View style={styles.handleRow}>
              <View style={[styles.handle, { backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.18)' }]} />
            </View>

            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.eyebrow, { color: subtle }]}>{t('wallet.cashoutEyebrow') || 'SACAR'}</Text>
                <Text style={[styles.title, { color: colors.text }]}>{t('wallet.cashoutTitle') || 'Sacar via PIX'}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' }]}>
                <IconX size={18} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
              {/* Available balance pill */}
              <View style={[styles.availCard, { backgroundColor: GREEN + '14', borderColor: GREEN + '40' }]}>
                <Text style={[styles.availLabel, { color: subtle }]}>{t('wallet.cashAvailable') || 'Disponível para saque'}</Text>
                <Text style={[styles.availValue, { color: GREEN }]}>R$ {fmtBrl(availableCents)}</Text>
              </View>

              {/* Amount */}
              <Text style={[styles.fieldLabel, { color: subtle }]}>
                {t('wallet.cashoutAmount') || 'Quanto você quer sacar?'}
              </Text>
              <View style={[styles.amountRow, { backgroundColor: cardBg, borderColor: border }]}>
                <Text style={[styles.amountPrefix, { color: GREEN }]}>R$</Text>
                <TextInput
                  value={amountInput}
                  onChangeText={setAmountInput}
                  placeholder={t('wallet.cashoutAmountPh') || '0,00'}
                  placeholderTextColor={subtle}
                  keyboardType="decimal-pad"
                  style={[styles.amountInput, { color: colors.text }]}
                />
              </View>
              {amountCents > 0 && amountCents < MIN_CASHOUT_CENTS ? (
                <Text style={[styles.warnLine, { color: RED }]}>
                  {t('wallet.cashoutMinError') || 'O saque mínimo é R$ 50,00.'}
                </Text>
              ) : null}

              {/* PIX key type chips */}
              <Text style={[styles.fieldLabel, { color: subtle, marginTop: 14 }]}>
                {t('wallet.cashoutPixKeyType') || 'Tipo da chave'}
              </Text>
              <View style={styles.keyTypeRow}>
                {KEY_TYPES.map(k => {
                  const active = keyType === k.id;
                  return (
                    <TouchableOpacity
                      key={k.id}
                      onPress={() => { setKeyType(k.id); tap('light'); }}
                      style={[styles.keyTypeChip, {
                        backgroundColor: active ? PURPLE : chipBg,
                        borderColor: active ? PURPLE : 'transparent',
                      }]}
                    >
                      <Text style={[styles.keyTypeText, { color: active ? '#fff' : colors.text }]}>
                        {t(`wallet.keyType.${k.id}`) || k.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* PIX key */}
              <Text style={[styles.fieldLabel, { color: subtle, marginTop: 14 }]}>
                {t('wallet.cashoutPixKey') || 'Chave PIX'}
              </Text>
              <TextInput
                value={pixKey}
                onChangeText={setPixKey}
                placeholder={t('wallet.cashoutPixKeyPh') || 'CPF, e-mail, telefone ou chave aleatória'}
                placeholderTextColor={subtle}
                style={[styles.input, { backgroundColor: cardBg, borderColor: border, color: colors.text }]}
                autoCapitalize="none"
              />

              {/* Full name */}
              <Text style={[styles.fieldLabel, { color: subtle, marginTop: 14 }]}>
                {t('wallet.cashoutFullName') || 'Nome completo (titular)'}
              </Text>
              <TextInput
                value={fullName}
                onChangeText={setFullName}
                placeholder={t('wallet.cashoutFullNamePh') || 'Nome completo'}
                placeholderTextColor={subtle}
                style={[styles.input, { backgroundColor: cardBg, borderColor: border, color: colors.text }]}
              />

              {/* CPF */}
              <Text style={[styles.fieldLabel, { color: subtle, marginTop: 14 }]}>
                {t('wallet.cashoutCpf') || 'CPF'}
              </Text>
              <TextInput
                value={cpf}
                onChangeText={(v) => setCpf(v.replace(/[^0-9]/g, '').slice(0, 11))}
                placeholder={t('wallet.cashoutCpfPh') || '000.000.000-00'}
                placeholderTextColor={subtle}
                keyboardType="number-pad"
                style={[styles.input, { backgroundColor: cardBg, borderColor: border, color: colors.text }]}
                maxLength={11}
              />

              <TouchableOpacity
                onPress={onSubmit}
                disabled={submitting}
                activeOpacity={0.9}
                style={[styles.cta, { backgroundColor: submitting ? (isDark ? 'rgba(16,185,129,0.4)' : 'rgba(16,185,129,0.55)') : GREEN }]}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.ctaText}>
                    {t('wallet.cashoutCta') || 'Solicitar saque'}
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => { onClose?.(); router.push('/wallet-cashout'); }}
                style={styles.linkRow}
              >
                <Text style={[styles.linkText, { color: subtle }]}>
                  {t('wallet.cashoutHistory') || 'Ver histórico de saques'}
                </Text>
                <IconChevronRight size={14} color={subtle} />
              </TouchableOpacity>

              <Text style={[styles.tos, { color: subtle }]}>
                {t('wallet.cashoutTos') || 'Mínimo R$ 50,00. Pagamento via PIX em até 48h úteis após análise.'}
              </Text>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 18, paddingTop: 8,
    maxHeight: '92%',
  },
  handleRow: { alignItems: 'center', paddingVertical: 6 },
  handle: { width: 38, height: 4, borderRadius: 2 },

  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, paddingTop: 4 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { fontSize: 22, fontWeight: '800', marginTop: 2 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  availCard: {
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 14,
  },
  availLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  availValue: { fontSize: 26, fontWeight: '900', marginTop: 2, letterSpacing: -0.5 },

  fieldLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6, letterSpacing: 0.2 },
  amountRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 14,
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
  },
  amountPrefix: { fontSize: 18, fontWeight: '800', marginRight: 8 },
  amountInput: { flex: 1, fontSize: 22, fontWeight: '800', padding: 0, letterSpacing: -0.5 },
  warnLine: { fontSize: 11, fontWeight: '600', marginTop: 6 },

  keyTypeRow: { flexDirection: 'row', gap: 8 },
  keyTypeChip: { flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center', borderWidth: 1 },
  keyTypeText: { fontSize: 12, fontWeight: '700' },

  input: {
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14, fontWeight: '500',
  },

  cta: {
    paddingVertical: 16, borderRadius: 16, marginTop: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },

  linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 12 },
  linkText: { fontSize: 12, fontWeight: '600' },

  tos: { fontSize: 11, textAlign: 'center', marginTop: 4, lineHeight: 15 },
});
