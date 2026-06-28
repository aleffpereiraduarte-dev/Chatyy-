// WalletSendSheet — full-screen "Enviar saldo" sheet.
//
// WAVE 57 (2026-05-21) — single-currency wallet redesign.
// Combines peer-picker + amount entry + optional note into ONE sheet so
// the user doesn't have to navigate. Backend stays the same: wallet_send
// (to_email, amount, message).
//
// Flow:
//   Step 1 (recipient): search bar + list of direct conversations.
//   Step 2 (amount):    receiver chip + quick chips (10/50/100/500/custom)
//                       + note input + Send CTA. Tap arrow back to recipient.
//
// On 402 "insufficient_diamonds" we surface a friendly alert pointing to
// /wallet "Adicionar saldo".

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
  TextInput, FlatList, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconArrowLeft, IconSearch, IconSend } from '../Icons';
import AvatarCircle from '../AvatarCircle';
import * as api from '../../services/api';
import { formatInt } from '../../utils/dateFormat';

const PURPLE = '#A855F7';

const QUICK_AMOUNTS = [10, 50, 100, 500];

function tap(kind = 'light') {
  try {
    if (kind === 'light')  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (kind === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (kind === 'select') Haptics.selectionAsync();
    if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

export default function WalletSendSheet({ visible, onClose, balance, onSent }) {
  // DIAMANTE DESLIGADO — "Enviar saldo" é transferência da carteira de diamante
  // (wallet_send). Backend retorna 410; o sheet vira no-op (nunca renderiza).
  return null;
  // eslint-disable-next-line no-unreachable
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  const [step, setStep] = useState('pick'); // pick | amount
  const [loading, setLoading] = useState(false);
  const [convs, setConvs] = useState([]);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState(null);
  const [amount, setAmount] = useState(50);
  const [customInput, setCustomInput] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  // Reset state on open / close.
  useEffect(() => {
    if (!visible) return;
    setStep('pick');
    setQuery('');
    setTarget(null);
    setAmount(50);
    setCustomInput('');
    setNote('');
    setSending(false);
    setLoading(true);
    (async () => {
      try {
        const r = await api.chatConversations?.();
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
        setConvs(directs);
      } catch {
        setConvs([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [visible]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return convs;
    return convs.filter(c => {
      const name = String(c.peer_name || c.name || c.title || '').toLowerCase();
      const email = String(c.peer_email || c.other_email || c.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [convs, query]);

  const onPickRecipient = useCallback((c) => {
    const email = c.peer_email || c.other_email || c.email;
    const name = c.peer_name || c.name || c.title || (email ? email.split('@')[0] : '');
    const avatar = c.peer_avatar_url || c.avatar_url || c.photo_url;
    if (!email) return;
    setTarget({ email, name, avatar });
    setStep('amount');
    tap('light');
  }, []);

  const finalAmount = useMemo(() => {
    if (customInput) {
      const n = parseInt(String(customInput).replace(/[^0-9]/g, ''), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    return amount || 0;
  }, [amount, customInput]);

  const onSend = useCallback(async () => {
    if (!target?.email || finalAmount <= 0) return;
    if (finalAmount > (Number(balance) || 0)) {
      Alert.alert(
        t('wallet.insufficientTitle') || 'Saldo insuficiente',
        (t('wallet.insufficientBody') || 'Você tem {n} de saldo. Adicione mais para enviar {a}.')
          .replace('{n}', formatInt(balance || 0, language))
          .replace('{a}', formatInt(finalAmount, language)),
      );
      return;
    }
    setSending(true);
    try {
      const r = await api.walletSend?.(target.email, finalAmount, note);
      if (r?.success) {
        tap('success');
        Alert.alert(
          t('wallet.sentTitle') || 'Enviado!',
          (t('wallet.sentBody') || '{a} de saldo enviado para {n}.')
            .replace('{a}', formatInt(finalAmount, language))
            .replace('{n}', target.name || target.email),
        );
        onSent?.({ amount: finalAmount, toEmail: target.email });
        onClose?.();
      } else if (r?.code === 'insufficient_diamonds' || r?.message === 'insufficient_diamonds') {
        Alert.alert(
          t('wallet.insufficientTitle') || 'Saldo insuficiente',
          t('wallet.insufficientBodyShort') || 'Adicione mais saldo na sua carteira para enviar.',
        );
      } else {
        Alert.alert(
          t('common.error') || 'Erro',
          r?.message || t('wallet.sendFailed') || 'Não foi possível enviar.',
        );
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Não foi possível enviar.');
    } finally {
      setSending(false);
    }
  }, [target, finalAmount, note, balance, t, language, onSent, onClose]);

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
              {step === 'amount' ? (
                <TouchableOpacity onPress={() => { setStep('pick'); tap('light'); }} style={[styles.iconBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' }]} accessibilityRole="button">
                  <IconArrowLeft size={18} color={colors.text} />
                </TouchableOpacity>
              ) : (
                <View style={{ width: 34 }} />
              )}
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={[styles.eyebrow, { color: subtle }]}>{t('wallet.sendEyebrow') || 'ENVIAR'}</Text>
                <Text style={[styles.title, { color: colors.text }]}>
                  {step === 'pick'
                    ? (t('wallet.sendPickTitle') || 'Para quem?')
                    : (t('wallet.sendAmountTitle') || 'Quanto enviar?')}
                </Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[styles.iconBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' }]} accessibilityRole="button">
                <IconX size={18} color={colors.text} />
              </TouchableOpacity>
            </View>

            {step === 'pick' ? (
              <>
                <View style={[styles.search, { backgroundColor: chipBg }]}>
                  <IconSearch size={16} color={subtle} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('common.search') || 'Buscar'}
                    placeholderTextColor={subtle}
                    style={[styles.searchInput, { color: colors.text }]}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />
                </View>
                {loading ? (
                  <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                    <ActivityIndicator color={PURPLE} />
                  </View>
                ) : filtered.length === 0 ? (
                  <View style={{ paddingVertical: 40, paddingHorizontal: 16 }}>
                    <Text style={{ textAlign: 'center', color: subtle, fontSize: 13 }}>
                      {query
                        ? (t('common.noResults') || 'Nenhum contato encontrado')
                        : (t('wallet.noContactsBody') || 'Sem conversas ainda. Inicie um chat para enviar.')}
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={filtered}
                    keyExtractor={(item, idx) => String(item.id || item.peer_email || idx)}
                    keyboardShouldPersistTaps="handled"
                    style={{ maxHeight: 360 }}
                    renderItem={({ item }) => {
                      const email = item.peer_email || item.other_email || item.email || '';
                      const name = item.peer_name || item.name || item.title || (email ? email.split('@')[0] : '');
                      const avatar = item.peer_avatar_url || item.avatar_url || item.photo_url;
                      return (
                        <TouchableOpacity
                          onPress={() => onPickRecipient(item)}
                          activeOpacity={0.7}
                          style={[styles.contactRow, { borderBottomColor: border }]}
                        >
                          <AvatarCircle size={42} email={email} name={name} avatarUrl={avatar} />
                          <View style={{ flex: 1, marginLeft: 12 }}>
                            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={1}>{name || email}</Text>
                            {!!email && email !== name && (
                              <Text style={{ fontSize: 12, color: subtle, marginTop: 1 }} numberOfLines={1}>{email}</Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    }}
                  />
                )}
              </>
            ) : (
              <>
                {/* Recipient chip */}
                <View style={[styles.recipChip, { backgroundColor: cardBg, borderColor: border }]}>
                  <AvatarCircle size={48} email={target?.email} name={target?.name} avatarUrl={target?.avatar} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[styles.recipName, { color: colors.text }]} numberOfLines={1}>{target?.name || target?.email}</Text>
                    {target?.email && target.email !== target.name ? (
                      <Text style={[styles.recipEmail, { color: subtle }]} numberOfLines={1}>{target.email}</Text>
                    ) : null}
                  </View>
                </View>

                {/* Big amount */}
                <View style={styles.amountWrap}>
                  <Text style={[styles.amountValue, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
                    {formatInt(finalAmount, language)}
                  </Text>
                  <Text style={[styles.amountUnit, { color: subtle }]}>
                    {t('wallet.unitLabel') || 'de saldo'}
                  </Text>
                </View>

                {/* Quick chips */}
                <View style={styles.quickRow}>
                  {QUICK_AMOUNTS.map(q => {
                    const active = !customInput && amount === q;
                    return (
                      <TouchableOpacity
                        key={q}
                        onPress={() => { setAmount(q); setCustomInput(''); tap('select'); }}
                        style={[styles.quickChip, {
                          backgroundColor: active ? PURPLE : chipBg,
                          borderColor: active ? PURPLE : 'transparent',
                        }]}
                      >
                        <Text style={[styles.quickChipText, { color: active ? '#fff' : colors.text }]}>
                          {formatInt(q, language)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Custom input */}
                <View style={[styles.customRow, { backgroundColor: chipBg }]}>
                  <Text style={[styles.customLabel, { color: subtle }]}>
                    {t('wallet.customAmount') || 'Valor personalizado'}
                  </Text>
                  <TextInput
                    value={customInput}
                    onChangeText={(v) => setCustomInput(v.replace(/[^0-9]/g, ''))}
                    placeholder="0"
                    placeholderTextColor={subtle}
                    keyboardType="numeric"
                    style={[styles.customInput, { color: colors.text }]}
                    maxLength={7}
                  />
                </View>

                {/* Note */}
                <View style={[styles.customRow, { backgroundColor: chipBg, marginTop: 8 }]}>
                  <Text style={[styles.customLabel, { color: subtle }]}>
                    {t('wallet.noteOptional') || 'Mensagem (opcional)'}
                  </Text>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    placeholder={t('wallet.notePlaceholder') || 'Ex: parabéns!'}
                    placeholderTextColor={subtle}
                    style={[styles.customInput, { color: colors.text, textAlign: 'right', flex: 1 }]}
                    maxLength={200}
                  />
                </View>

                <Text style={[styles.balLine, { color: subtle }]}>
                  {(t('wallet.youHave') || 'Você tem {n} disponível.').replace('{n}', formatInt(balance || 0, language))}
                </Text>

                <TouchableOpacity
                  onPress={onSend}
                  disabled={sending || finalAmount <= 0}
                  activeOpacity={0.9}
                  style={[styles.cta, {
                    backgroundColor: finalAmount > 0 ? PURPLE : (isDark ? 'rgba(168,85,247,0.35)' : 'rgba(168,85,247,0.40)'),
                  }]}
                >
                  {sending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <IconSend size={18} color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.ctaText}>
                        {t('wallet.sendCta') || 'Enviar'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}
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
  title: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  iconBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 12, marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },

  contactRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },

  recipChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 18,
  },
  recipName: { fontSize: 16, fontWeight: '700' },
  recipEmail: { fontSize: 12, marginTop: 2 },

  amountWrap: { alignItems: 'center', paddingVertical: 8 },
  amountValue: { fontSize: 56, fontWeight: '900', letterSpacing: -2 },
  amountUnit: { fontSize: 13, fontWeight: '500', marginTop: 2 },

  quickRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, gap: 8 },
  quickChip: {
    flex: 1, paddingVertical: 12, borderRadius: 14,
    alignItems: 'center', borderWidth: 1.2,
  },
  quickChipText: { fontSize: 14, fontWeight: '700' },

  customRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, marginTop: 14,
  },
  customLabel: { fontSize: 13, fontWeight: '500' },
  customInput: { fontSize: 15, fontWeight: '700', padding: 0, minWidth: 80, textAlign: 'right' },

  balLine: { fontSize: 12, textAlign: 'center', marginTop: 14, marginBottom: 6 },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: 16, marginTop: 6,
  },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
});
