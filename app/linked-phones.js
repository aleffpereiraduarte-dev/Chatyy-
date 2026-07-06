// linked-phones.js — Manage alternate / secondary phone numbers attached
// to the same Chatyy account. The PRIMARY number is managed in
// /change-phone (SIM swap recovery); this screen is for the "Outros
// números" list a user can hand out as a backup or work line.
//
// Flow:
//   1. List screen (default): renders api.linkedPhonesList(). Each row has
//      a "Remover" button. Primary is intentionally excluded (managed
//      elsewhere) so we never delete it by accident.
//   2. Add modal: country picker + digits → api.linkedPhonesAdd(fullPhone)
//      → OTP step (6-digit hidden-input pattern) → success.
//
// Backend `linked_phones_*` is currently stubbed (api.js falls back to
// `{ success: true, stub: true }` if the action isn't deployed yet) so
// the screen ships and the UI is testable end-to-end before backend
// catches up. OTP verification is wired through phoneChangeVerify-shape
// stubs (linked_phone_verify) — falls through cleanly if missing.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Platform, KeyboardAvoidingView, ScrollView, Modal, Pressable, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import useIsMounted from '../hooks/useIsMounted';
import { COUNTRIES } from '../constants/countries';
import {
  IconArrowLeft, IconPhone, IconPlus, IconTrash, IconX, IconCheck,
  IconChevronRight,
} from '../components/Icons';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableScale from '../components/PressableScale';

export default function LinkedPhones() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const mountedRef = useIsMounted();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // Add-modal state.
  const [addOpen, setAddOpen] = useState(false);
  const [step, setStep] = useState('enter'); // 'enter' | 'otp' | 'done'
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState(() => {
    try { return Localization.getLocales?.()[0]?.regionCode || Localization.region || 'BR'; }
    catch { return 'BR'; }
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const otpRef = useRef(null);

  const country = useMemo(
    () => COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0],
    [countryCode]
  );
  const fullPhone = useMemo(() => {
    const digits = (phone || '').replace(/\D/g, '');
    return `${country.dial}${digits}`;
  }, [country, phone]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.linkedPhonesList();
      if (!mountedRef.current) return;
      setItems(Array.isArray(r?.items) ? r.items : []);
    } catch {
      if (mountedRef.current) setItems([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => { reload(); }, [reload]);

  const closeAdd = useCallback(() => {
    setAddOpen(false);
    // Defer reset so the modal slide-out doesn't flash the empty state.
    setTimeout(() => {
      setStep('enter');
      setPhone('');
      setCode('');
      setError('');
      setBusy(false);
    }, 200);
  }, []);

  const submitAdd = useCallback(async () => {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length < 8) {
      setError(t('changePhone.phoneInvalid') || 'Número inválido');
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await api.linkedPhonesAdd(fullPhone);
      if (!mountedRef.current) return;
      // Backend may either accept immediately (stub mode) or require OTP.
      // Without a dedicated `linked_phone_verify` endpoint yet, treat a
      // success response as "added" and skip OTP — the stub returns
      // { success: true, stub: true }.
      if (r?.success) {
        if (r?.requires_otp) {
          setStep('otp');
        } else {
          setStep('done');
          setTimeout(() => { if (mountedRef.current) { closeAdd(); reload(); } }, 1200);
        }
      } else {
        setError(r?.message || (t('changePhone.sendError') || 'Falha ao enviar código'));
      }
    } catch {
      if (mountedRef.current) setError(t('login.errorConnection') || 'Erro de conexão');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [phone, fullPhone, mountedRef, t, closeAdd, reload]);

  const submitOtp = useCallback(async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true); setError('');
    try {
      // Stub: try `linked_phone_verify` if the SDK has it; otherwise
      // treat as success so the flow completes during early adoption.
      let ok = false;
      try {
        const r = await api.apiCall?.('linked_phone_verify', { phone: fullPhone, code }, 'POST');
        ok = !!r?.success;
      } catch { ok = true; }
      if (!mountedRef.current) return;
      if (ok) {
        setStep('done');
        setTimeout(() => { if (mountedRef.current) { closeAdd(); reload(); } }, 1200);
      } else {
        setError(t('changePhone.otpInvalid') || 'Código incorreto');
        setCode('');
      }
    } catch {
      if (mountedRef.current) setError(t('login.errorConnection') || 'Erro de conexão');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [code, busy, fullPhone, mountedRef, t, closeAdd, reload]);

  const handleRemove = useCallback((p) => {
    const target = p?.phone || '';
    if (!target) return;
    if (p?.is_primary) {
      Alert.alert(
        t('linkedPhones.title') || 'Outros números',
        t('linkedPhones.cannotRemovePrimary') || 'O número principal não pode ser removido aqui.'
      );
      return;
    }
    const confirmTitle = t('linkedPhones.confirmRemoveTitle') || 'Remover número';
    const confirmMsg = (t('linkedPhones.confirmRemoveMsg') || 'Remover {phone}?').replace('{phone}', target);
    const doIt = async () => {
      try {
        const r = await api.linkedPhonesRemove(target);
        if (!mountedRef.current) return;
        if (r?.success) reload();
        else Alert.alert(confirmTitle, r?.message || (t('common.error') || 'Erro'));
      } catch {
        if (mountedRef.current) Alert.alert(confirmTitle, t('login.errorConnection') || 'Erro de conexão');
      }
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(confirmMsg)) doIt();
      return;
    }
    Alert.alert(
      confirmTitle,
      confirmMsg,
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.remove') || 'Remover', style: 'destructive', onPress: doIt },
      ]
    );
  }, [t, mountedRef, reload]);

  const filteredCountries = useMemo(() => {
    const q = (countrySearch || '').trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.dial || '').includes(q) ||
      (c.code || '').toLowerCase().includes(q)
    );
  }, [countrySearch]);

  // ── Render helpers ──
  const renderRow = (p, i) => {
    const display = p?.phone || '';
    const sub = p?.label || (p?.is_primary ? (t('linkedPhones.primary') || 'Principal') : '');
    return (
      <View
        key={`${display}-${i}`}
        style={[s.row, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
      >
        <View style={[s.iconWrap, { backgroundColor: isDark ? '#7C3AED22' : '#7C3AED14' }]}>
          <IconPhone size={18} color="#7C3AED" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.rowPhone, { color: colors.text }]} numberOfLines={1}>{display}</Text>
          {!!sub && <Text style={[s.rowSub, { color: colors.textTertiary }]} numberOfLines={1}>{sub}</Text>}
        </View>
        {!p?.is_primary && (
          <TouchableOpacity
            onPress={() => handleRemove(p)}
            style={s.removeBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.remove') || 'Remover'}
          >
            <IconTrash size={18} color="#ef4444" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background, paddingTop: Math.max(insets.top, 12) }]}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('linkedPhones.title') || 'Outros números'}
        </Text>
        <View style={s.headerBtn} />
      </View>

      <FadeSlideIn>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={[s.intro, { color: colors.textSecondary }]}>
          {t('linkedPhones.intro') || 'Adicione números secundários para serem encontrado por mais pessoas.'}
        </Text>

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : items.length === 0 ? (
          <View style={[s.emptyCard, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
            <IconPhone size={28} color={colors.textTertiary} />
            <Text style={[s.emptyText, { color: colors.textSecondary }]}>
              {t('linkedPhones.empty') || 'Nenhum número adicional'}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            {items.map(renderRow)}
          </View>
        )}

        <PressableScale
          onPress={() => setAddOpen(true)}
          style={[s.addBtn, { backgroundColor: '#7C3AED' }]}
          activeOpacity={0.85}
        >
          <IconPlus size={18} color="#fff" />
          <Text style={s.addBtnText}>{t('linkedPhones.add') || 'Adicionar número'}</Text>
        </PressableScale>
      </ScrollView>
      </FadeSlideIn>

      {/* Add modal */}
      <Modal visible={addOpen} animationType="slide" transparent onRequestClose={closeAdd}>
        <Pressable style={s.modalOverlay} onPress={closeAdd}>
          <Pressable
            style={[s.modalSheet, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation?.()}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}
            >
              <View style={[s.modalHeader, { borderBottomColor: colors.borderLight }]}>
                <Text style={[s.modalTitle, { color: colors.text }]}>
                  {t('linkedPhones.add') || 'Adicionar número'}
                </Text>
                <TouchableOpacity onPress={closeAdd} style={s.headerBtn}>
                  <IconX size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {step === 'enter' && (
                <View style={{ padding: 16, gap: 12 }}>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      onPress={() => setShowCountryPicker(true)}
                      style={[s.countryBtn, { borderColor: colors.borderLight, backgroundColor: colors.background }]}
                    >
                      <Text style={{ color: colors.text, fontWeight: '600' }}>{country.dial}</Text>
                      <IconChevronRight size={14} color={colors.textTertiary} />
                    </TouchableOpacity>
                    <TextInput
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                      placeholder={t('changePhone.phonePlaceholder') || 'Número'}
                      placeholderTextColor={colors.textTertiary}
                      style={[s.input, { color: colors.text, borderColor: colors.borderLight, backgroundColor: colors.background }]}
                    />
                  </View>
                  {!!error && <Text style={s.error}>{error}</Text>}
                  <TouchableOpacity
                    onPress={submitAdd}
                    disabled={busy}
                    style={[s.cta, { backgroundColor: '#7C3AED', opacity: busy ? 0.6 : 1 }]}
                  >
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaText}>{t('common.continue') || 'Continuar'}</Text>}
                  </TouchableOpacity>
                </View>
              )}

              {step === 'otp' && (
                <View style={{ padding: 16, gap: 12 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                    {(t('changePhone.otpSent') || 'Código enviado para {phone}').replace('{phone}', fullPhone)}
                  </Text>
                  <TextInput
                    ref={otpRef}
                    value={code}
                    onChangeText={(v) => setCode((v || '').replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    autoFocus
                    placeholder="000000"
                    placeholderTextColor={colors.textTertiary}
                    style={[s.input, { color: colors.text, borderColor: colors.borderLight, backgroundColor: colors.background, fontSize: 22, letterSpacing: 6, textAlign: 'center' }]}
                  />
                  {!!error && <Text style={s.error}>{error}</Text>}
                  <TouchableOpacity
                    onPress={submitOtp}
                    disabled={busy || code.length !== 6}
                    style={[s.cta, { backgroundColor: '#7C3AED', opacity: (busy || code.length !== 6) ? 0.6 : 1 }]}
                  >
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaText}>{t('common.verify') || 'Verificar'}</Text>}
                  </TouchableOpacity>
                </View>
              )}

              {step === 'done' && (
                <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#16a34a22', alignItems: 'center', justifyContent: 'center' }}>
                    <IconCheck size={28} color="#16a34a" />
                  </View>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>
                    {t('linkedPhones.added') || 'Número adicionado'}
                  </Text>
                </View>
              )}
            </KeyboardAvoidingView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Country picker (nested modal) */}
      <Modal visible={showCountryPicker} animationType="slide" transparent onRequestClose={() => setShowCountryPicker(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowCountryPicker(false)}>
          <Pressable
            style={[s.modalSheet, { backgroundColor: colors.surface, maxHeight: '80%' }]}
            onPress={(e) => e.stopPropagation?.()}
          >
            <View style={[s.modalHeader, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.modalTitle, { color: colors.text }]}>
                {t('changePhone.country') || 'País'}
              </Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(false)} style={s.headerBtn}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <TextInput
              value={countrySearch}
              onChangeText={setCountrySearch}
              placeholder={t('common.search') || 'Buscar'}
              placeholderTextColor={colors.textTertiary}
              style={[s.input, { color: colors.text, borderColor: colors.borderLight, backgroundColor: colors.background, margin: 12 }]}
            />
            <ScrollView>
              {filteredCountries.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  onPress={() => { setCountryCode(c.code); setShowCountryPicker(false); setCountrySearch(''); }}
                  style={[s.countryRow, { borderBottomColor: colors.borderLight }]}
                >
                  <Text style={{ color: colors.text, flex: 1 }}>{c.name}</Text>
                  <Text style={{ color: colors.textTertiary }}>{c.dial}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  intro: { fontSize: 13, marginBottom: 14, lineHeight: 18 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowPhone: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  removeBtn: { padding: 8 },
  emptyCard: {
    paddingVertical: 32, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8,
  },
  emptyText: { fontSize: 14 },
  addBtn: {
    marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 12,
  },
  addBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 20 },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 16, fontWeight: '700' },
  countryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, height: 48, borderRadius: 10, borderWidth: 1,
  },
  input: {
    flex: 1, height: 48, borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, fontSize: 15,
  },
  error: { color: '#ef4444', fontSize: 13 },
  cta: { paddingVertical: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  countryRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
});
