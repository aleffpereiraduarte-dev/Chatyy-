import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, Modal,
  ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconPhone, IconCake, IconUser, IconX } from './Icons';
import * as api from '../services/api';

const COUNTRY_CODES = [
  { code: '+55', flag: 'BR', label: 'Brasil (+55)' },
  { code: '+1', flag: 'US', label: 'USA (+1)' },
  { code: '+44', flag: 'GB', label: 'UK (+44)' },
  { code: '+351', flag: 'PT', label: 'Portugal (+351)' },
  { code: '+34', flag: 'ES', label: 'Espana (+34)' },
  { code: '+33', flag: 'FR', label: 'France (+33)' },
  { code: '+49', flag: 'DE', label: 'Deutschland (+49)' },
  { code: '+39', flag: 'IT', label: 'Italia (+39)' },
  { code: '+81', flag: 'JP', label: 'Japan (+81)' },
  { code: '+86', flag: 'CN', label: 'China (+86)' },
  { code: '+91', flag: 'IN', label: 'India (+91)' },
  { code: '+52', flag: 'MX', label: 'Mexico (+52)' },
  { code: '+54', flag: 'AR', label: 'Argentina (+54)' },
  { code: '+56', flag: 'CL', label: 'Chile (+56)' },
  { code: '+57', flag: 'CO', label: 'Colombia (+57)' },
  { code: '+598', flag: 'UY', label: 'Uruguay (+598)' },
  { code: '+595', flag: 'PY', label: 'Paraguay (+595)' },
];

const RESEND_COOLDOWN = 30;

export const isProfileComplete = (profile) => {
  return !!(profile?.phone && profile?.birthday);
};

export const COMPLETE_PROFILE_SKIP_KEY = '@chatyy_complete_profile_skip';

function formatBirthday(text, locale) {
  // Remove non-digits
  const digits = text.replace(/\D/g, '');
  const isUS = locale === 'en';
  if (isUS) {
    // MM/DD/YYYY
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return digits.slice(0, 2) + '/' + digits.slice(2);
    return digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4, 8);
  }
  // DD/MM/YYYY (pt-BR, es)
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return digits.slice(0, 2) + '/' + digits.slice(2);
  return digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4, 8);
}

function parseBirthdayToISO(text, locale) {
  const parts = text.split('/');
  if (parts.length !== 3) return null;
  const isUS = locale === 'en';
  const day = isUS ? parseInt(parts[1], 10) : parseInt(parts[0], 10);
  const month = isUS ? parseInt(parts[0], 10) : parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (!day || !month || !year || year < 1900 || year > new Date().getFullYear()) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export default function CompleteProfileModal({ visible, onDone, onSkip, profile }) {
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const locale = language;

  const [countryCode, setCountryCode] = useState('+55');
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [birthday, setBirthday] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // SMS verification state
  const [verifyStep, setVerifyStep] = useState('input'); // 'input' | 'code' | 'verified'
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyToken, setVerifyToken] = useState(null);
  const [maskedPhone, setMaskedPhone] = useState('');
  const [resendTimer, setResendTimer] = useState(0);
  const [successMsg, setSuccessMsg] = useState('');
  const timerRef = useRef(null);
  const codeInputRefs = useRef([]);

  const needsPhone = !profile?.phone;
  const needsBirthday = !profile?.birthday;

  // Resend countdown timer
  useEffect(() => {
    if (resendTimer > 0) {
      timerRef.current = setTimeout(() => setResendTimer(r => r - 1), 1000);
      return () => clearTimeout(timerRef.current);
    }
  }, [resendTimer]);

  // Clear success message after 3s
  useEffect(() => {
    if (successMsg) {
      const id = setTimeout(() => setSuccessMsg(''), 3000);
      return () => clearTimeout(id);
    }
  }, [successMsg]);

  const getFullPhone = useCallback(() => {
    const cleaned = phoneNumber.replace(/\D/g, '');
    return countryCode + cleaned;
  }, [countryCode, phoneNumber]);

  const handleSendCode = useCallback(async () => {
    setError('');
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.length < 8) {
      setError(t('completeProfile.phoneInvalid') || 'Invalid phone number');
      return;
    }
    setSendingCode(true);
    try {
      const r = await api.verifySend(getFullPhone());
      setMaskedPhone(r?.data?.masked_phone || getFullPhone());
      setVerifyStep('code');
      setResendTimer(RESEND_COOLDOWN);
      setVerifyCode('');
      setSuccessMsg(t('completeProfile.codeSent') || 'Code sent!');
    } catch (e) {
      setError(e?.message || 'Error sending code');
    } finally {
      setSendingCode(false);
    }
  }, [phoneNumber, countryCode, t, getFullPhone]);

  const handleVerifyCode = useCallback(async (code) => {
    const codeToCheck = code || verifyCode;
    if (codeToCheck.length !== 6) return;
    setError('');
    setVerifyingCode(true);
    try {
      const r = await api.verifyCheck(getFullPhone(), codeToCheck);
      setVerifyToken(r?.data?.token);
      setVerifyStep('verified');
      setSuccessMsg('');
    } catch (e) {
      setError(t('completeProfile.invalidCode') || 'Invalid code');
      setVerifyCode('');
    } finally {
      setVerifyingCode(false);
    }
  }, [verifyCode, t, getFullPhone]);

  const handleCodeChange = useCallback((text) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setVerifyCode(digits);
    if (digits.length === 6) {
      handleVerifyCode(digits);
    }
  }, [handleVerifyCode]);

  const handleBirthdayChange = useCallback((text) => {
    setBirthday(formatBirthday(text, locale));
  }, [locale]);

  const canSave = (() => {
    const phoneOk = !needsPhone || verifyStep === 'verified';
    const birthdayOk = !needsBirthday || !!parseBirthdayToISO(birthday, locale);
    return phoneOk && birthdayOk;
  })();

  const handleSave = useCallback(async () => {
    setError('');
    const data = {};

    if (needsPhone && verifyStep === 'verified') {
      data.phone = getFullPhone();
      if (verifyToken) data.phone_verify_token = verifyToken;
    }

    if (needsBirthday && birthday.trim()) {
      const iso = parseBirthdayToISO(birthday, locale);
      if (!iso) {
        setError(t('completeProfile.birthdayInvalid') || 'Invalid date');
        return;
      }
      data.birthday = iso;
    }

    if (Object.keys(data).length === 0) {
      onSkip();
      return;
    }

    setSaving(true);
    try {
      await api.updateProfile(data);
      onDone();
    } catch (e) {
      setError(e?.message || 'Error saving profile');
    } finally {
      setSaving(false);
    }
  }, [birthday, needsPhone, needsBirthday, locale, t, onDone, onSkip, verifyStep, verifyToken, getFullPhone]);

  const selectedCountry = COUNTRY_CODES.find(c => c.code === countryCode) || COUNTRY_CODES[0];

  const renderPhoneVerification = () => {
    if (verifyStep === 'verified') {
      return (
        <View style={s.verifiedRow}>
          <Text style={[s.verifiedPhone, { color: colors.text }]}>
            {maskedPhone || getFullPhone()}
          </Text>
          <View style={[s.verifiedBadge, { backgroundColor: '#22c55e' + '20' }]}>
            <Text style={s.verifiedCheck}>{'✓'}</Text>
            <Text style={s.verifiedText}>
              {t('completeProfile.verified') || 'Verified'}
            </Text>
          </View>
        </View>
      );
    }

    if (verifyStep === 'code') {
      return (
        <View style={s.codeSection}>
          <Text style={[s.codeLabel, { color: colors.textSecondary }]}>
            {t('completeProfile.enterCode') || 'Enter code'}
          </Text>
          <View style={s.codeInputRow}>
            <TextInput
              style={[s.codeInput, { backgroundColor: colors.inputBg || colors.background, borderColor: colors.border, color: colors.text }]}
              placeholder="000000"
              placeholderTextColor={colors.textTertiary || colors.textSecondary}
              keyboardType="number-pad"
              value={verifyCode}
              onChangeText={handleCodeChange}
              maxLength={6}
              autoFocus
              textAlign="center"
              letterSpacing={8}
            />
            {verifyingCode && (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 8 }} />
            )}
          </View>
          <View style={s.resendRow}>
            {resendTimer > 0 ? (
              <Text style={[s.resendTimer, { color: colors.textSecondary }]}>
                {(t('completeProfile.resendIn') || 'Resend in {s}s').replace('{s}', String(resendTimer))}
              </Text>
            ) : (
              <TouchableOpacity onPress={handleSendCode} disabled={sendingCode}>
                <Text style={[s.resendLink, { color: colors.primary }]}>
                  {t('completeProfile.resend') || 'Resend code'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      );
    }

    // verifyStep === 'input'
    return (
      <>
        <View style={s.phoneRow}>
          <TouchableOpacity
            style={[s.countryPicker, { backgroundColor: colors.inputBg || colors.background, borderColor: colors.border }]}
            onPress={() => setShowCountryPicker(!showCountryPicker)}
          >
            <Text style={[s.countryCode, { color: colors.text }]}>
              {selectedCountry.flag} {selectedCountry.code}
            </Text>
          </TouchableOpacity>
          <TextInput
            style={[s.phoneInput, { backgroundColor: colors.inputBg || colors.background, borderColor: colors.border, color: colors.text }]}
            placeholder={t('completeProfile.phonePlaceholder')}
            placeholderTextColor={colors.textTertiary || colors.textSecondary}
            keyboardType="phone-pad"
            value={phoneNumber}
            onChangeText={setPhoneNumber}
            maxLength={15}
          />
          <TouchableOpacity
            style={[s.sendCodeBtn, { backgroundColor: colors.primary, opacity: sendingCode ? 0.6 : 1 }]}
            onPress={handleSendCode}
            disabled={sendingCode}
          >
            {sendingCode ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={s.sendCodeBtnText}>
                {t('completeProfile.sendCode') || 'Send code'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
        {showCountryPicker && (
          <ScrollView style={[s.countryList, { backgroundColor: colors.surface, borderColor: colors.border }]} nestedScrollEnabled>
            {COUNTRY_CODES.map(c => (
              <TouchableOpacity
                key={c.code}
                style={[s.countryItem, countryCode === c.code && { backgroundColor: colors.primary + '15' }]}
                onPress={() => { setCountryCode(c.code); setShowCountryPicker(false); }}
              >
                <Text style={[s.countryItemText, { color: colors.text }]}>
                  {c.flag}  {c.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={s.overlay}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.keyboardView}
        >
          <View style={[s.card, { backgroundColor: colors.surface }]}>
            {/* Header */}
            <View style={s.header}>
              <View style={[s.iconCircle, { backgroundColor: colors.primary + '15' }]}>
                <IconUser size={28} color={colors.primary} />
              </View>
              <Text style={[s.title, { color: colors.text }]}>
                {t('completeProfile.title')}
              </Text>
              <Text style={[s.subtitle, { color: colors.textSecondary }]}>
                {t('completeProfile.subtitle')}
              </Text>
            </View>

            {/* Fields */}
            <View style={s.fields}>
              {needsPhone && (
                <View style={s.fieldGroup}>
                  <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
                    <IconPhone size={14} color={colors.textSecondary} />
                    {'  '}{t('completeProfile.phone')}
                  </Text>
                  {renderPhoneVerification()}
                </View>
              )}

              {needsBirthday && (
                <View style={s.fieldGroup}>
                  <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
                    <IconCake size={14} color={colors.textSecondary} />
                    {'  '}{t('completeProfile.birthday')}
                  </Text>
                  <TextInput
                    style={[s.input, { backgroundColor: colors.inputBg || colors.background, borderColor: colors.border, color: colors.text }]}
                    placeholder={t('completeProfile.birthdayPlaceholder')}
                    placeholderTextColor={colors.textTertiary || colors.textSecondary}
                    keyboardType="number-pad"
                    value={birthday}
                    onChangeText={handleBirthdayChange}
                    maxLength={10}
                  />
                </View>
              )}
            </View>

            {/* Success message */}
            {!!successMsg && (
              <Text style={s.successText}>{successMsg}</Text>
            )}

            {/* Error */}
            {!!error && (
              <Text style={s.errorText}>{error}</Text>
            )}

            {/* Actions */}
            <View style={s.actions}>
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: colors.primary, opacity: canSave ? 1 : 0.5 }]}
                onPress={handleSave}
                disabled={saving || !canSave}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={s.saveBtnText}>{t('completeProfile.save')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={s.skipBtn}
                onPress={onSkip}
                disabled={saving}
              >
                <Text style={[s.skipBtnText, { color: colors.textSecondary }]}>
                  {t('completeProfile.skip')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  keyboardView: {
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
  },
  card: {
    width: '100%',
    borderRadius: BorderRadius.xl || 16,
    padding: Spacing.xl || 24,
    ...Platform.select({
      web: { boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
      default: { elevation: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.2, shadowRadius: 20 },
    }),
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing.lg || 20,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md || 12,
  },
  title: {
    fontSize: FontSize.xl || 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: FontSize.sm || 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  fields: {
    gap: Spacing.md || 16,
    marginBottom: Spacing.lg || 20,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: FontSize.sm || 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  phoneRow: {
    flexDirection: 'row',
    gap: 8,
  },
  countryPicker: {
    borderWidth: 1,
    borderRadius: BorderRadius.md || 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    minWidth: 90,
  },
  countryCode: {
    fontSize: FontSize.md || 15,
    fontWeight: '500',
  },
  phoneInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: BorderRadius.md || 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: FontSize.md || 15,
  },
  countryList: {
    maxHeight: 180,
    borderWidth: 1,
    borderRadius: BorderRadius.md || 10,
    marginTop: 4,
  },
  countryItem: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  countryItemText: {
    fontSize: FontSize.sm || 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: BorderRadius.md || 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: FontSize.md || 15,
  },
  sendCodeBtn: {
    borderRadius: BorderRadius.md || 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 90,
  },
  sendCodeBtnText: {
    color: '#fff',
    fontSize: FontSize.sm || 13,
    fontWeight: '600',
  },
  codeSection: {
    gap: 8,
  },
  codeLabel: {
    fontSize: FontSize.sm || 13,
  },
  codeInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  codeInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: BorderRadius.md || 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 20,
    fontWeight: '600',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  resendRow: {
    alignItems: 'center',
    marginTop: 2,
  },
  resendTimer: {
    fontSize: FontSize.sm || 13,
  },
  resendLink: {
    fontSize: FontSize.sm || 13,
    fontWeight: '600',
  },
  verifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  verifiedPhone: {
    fontSize: FontSize.md || 15,
    fontWeight: '500',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  verifiedCheck: {
    color: '#22c55e',
    fontSize: 14,
    fontWeight: '700',
  },
  verifiedText: {
    color: '#22c55e',
    fontSize: FontSize.sm || 13,
    fontWeight: '600',
  },
  successText: {
    color: '#22c55e',
    fontSize: FontSize.sm || 13,
    textAlign: 'center',
    marginBottom: Spacing.sm || 8,
  },
  errorText: {
    color: '#ef4444',
    fontSize: FontSize.sm || 13,
    textAlign: 'center',
    marginBottom: Spacing.sm || 8,
  },
  actions: {
    gap: 10,
  },
  saveBtn: {
    borderRadius: BorderRadius.md || 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: FontSize.md || 15,
    fontWeight: '700',
  },
  skipBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  skipBtnText: {
    fontSize: FontSize.sm || 14,
  },
});
