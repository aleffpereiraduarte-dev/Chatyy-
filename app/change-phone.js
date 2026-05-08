// change-phone.js — SIM swap recovery (WhatsApp pattern).
//
// Authenticated flow that migrates an active account to a NEW phone while
// keeping every chat / contact / handle. Five steps in a single screen:
//   1. confirm   → readonly old number + warning + country picker + new digits
//   2. otp       → 6-digit code (single hidden input pattern, autofill-friendly)
//   3. done      → success + auto-back to settings
//
// Backend: phone_change_request → phone_change_verify → phone_change_cancel.
// Reuses the post-Wave-A OTP pattern from signup-phone.js (single hidden
// TextInput overlaying 6 visual boxes — fixes Gboard sms-otp + iOS oneTimeCode
// autofill which break with maxLength=1 per box).
//
// Constraints surfaced as inline errors:
//   - new phone must differ from current
//   - new phone must not already belong to another Chatyy account (server 409)
//   - 60s cooldown between OTP requests, 5/hour cap

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Animated, Platform, KeyboardAvoidingView, ScrollView, Modal, Pressable, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Localization from 'expo-localization';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import useIsMounted from '../hooks/useIsMounted';
import { COUNTRIES, formatPhone } from '../constants/countries';
import {
  IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle,
  IconPhone, IconShield, IconChevronRight, IconAlertTriangle,
} from '../components/Icons';

export default function ChangePhone() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const mountedRef = useIsMounted();

  // Step machine: confirm → otp → done.
  const [step, setStep] = useState('confirm');
  // Old (currently verified) phone — read-only — fetched from get_profile.
  const [oldPhone, setOldPhone] = useState('');
  const [loadingProfile, setLoadingProfile] = useState(true);
  // New phone digits + country (mirrors signup-phone PhoneInput pattern).
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState(() => {
    try {
      return Localization.getLocales?.()[0]?.regionCode || Localization.region || 'BR';
    } catch { return 'BR'; }
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  // Country picker modal (Telegram-stacked phone input).
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  // Focus tracking for the hairline-active treatment.
  const [focused, setFocused] = useState('');

  // OTP single hidden input refs / animations (mirrors signup-phone.js).
  const otpRefs = useRef([]);
  const otpBoxScales = useRef(Array.from({ length: 6 }, () => new Animated.Value(1))).current;
  const otpShake = useRef(new Animated.Value(0)).current;
  const triggerOtpError = () => {
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
    Animated.sequence([
      Animated.timing(otpShake, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: -7,  duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 7,   duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 0,   duration: 50, useNativeDriver: true }),
    ]).start(() => {
      try { otpRefs.current?.[0]?.focus?.(); } catch {}
    });
  };
  const doneScale = useRef(new Animated.Value(0)).current;
  // Confetti dots — lightweight bursts (no extra dep). 16 dots fanning out.
  const confettiAnims = useRef(
    Array.from({ length: 16 }, () => ({
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      o: new Animated.Value(0),
    }))
  ).current;

  // Build E.164 from the picked country + raw digits.
  const fullPhone = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    return `${c.dial}${(phone || '').replace(/\D/g, '')}`;
  }, [countryCode, phone]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const id = setTimeout(() => setResendCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(id);
  }, [resendCountdown]);

  // Hydrate the old phone via get_profile on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.getProfile();
        if (!alive) return;
        const p = r?.data?.verified_phone || r?.data?.phone || '';
        setOldPhone(p);
      } catch { /* show empty old phone — user can still proceed */ }
      finally { if (alive) setLoadingProfile(false); }
    })();
    return () => { alive = false; };
  }, []);

  // Smooth crossfade between steps.
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const stepScale = useRef(new Animated.Value(1)).current;
  const goStep = useCallback((next) => {
    try {
      if (next !== 'done') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
    const EASE_IN  = Easing.bezier(0.55, 0.06, 0.68, 0.19);
    Animated.parallel([
      Animated.timing(fade,  { toValue: 0,    duration: 180, easing: EASE_IN, useNativeDriver: true }),
      Animated.timing(slide, { toValue: -22,  duration: 220, easing: EASE_IN, useNativeDriver: true }),
      Animated.timing(stepScale, { toValue: 0.985, duration: 220, easing: EASE_IN, useNativeDriver: true }),
    ]).start(() => {
      setStep(next);
      slide.setValue(22);
      stepScale.setValue(0.985);
      Animated.parallel([
        Animated.timing(fade,  { toValue: 1, duration: 320, easing: EASE_OUT, useNativeDriver: true }),
        Animated.timing(slide, { toValue: 0, duration: 360, easing: EASE_OUT, useNativeDriver: true }),
        Animated.timing(stepScale, { toValue: 1, duration: 360, easing: EASE_OUT, useNativeDriver: true }),
      ]).start();
    });
  }, [fade, slide, stepScale]);

  // Done step: pop the check + fire confetti once.
  useEffect(() => {
    if (step !== 'done') return;
    doneScale.setValue(0);
    Animated.spring(doneScale, { toValue: 1, friction: 7, tension: 100, useNativeDriver: true }).start();
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    // Confetti burst — random direction per dot.
    confettiAnims.forEach((a, i) => {
      const angle = (Math.PI * 2 * i) / confettiAnims.length + (Math.random() - 0.5) * 0.4;
      const dist  = 90 + Math.random() * 60;
      a.x.setValue(0); a.y.setValue(0); a.o.setValue(1);
      Animated.parallel([
        Animated.timing(a.x, { toValue: Math.cos(angle) * dist, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(a.y, { toValue: Math.sin(angle) * dist + 30, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(a.o, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]).start();
    });
  }, [step, doneScale, confettiAnims]);

  // ── Actions ──
  const sendOtp = async () => {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length < 8) { setError(t('changePhone.phoneInvalid') || 'Número inválido'); return; }
    // Client-side identical-number guard. Backend has the canonical check too.
    const oldDigits = (oldPhone || '').replace(/\D/g, '');
    const newDigits = fullPhone.replace(/\D/g, '');
    if (oldDigits && oldDigits === newDigits) {
      setError(t('changePhone.sameNumber') || 'Esse já é o seu número atual');
      return;
    }
    setError(''); setBusy(true);
    try {
      const r = await api.phoneChangeRequest(fullPhone);
      if (!mountedRef.current) return;
      if (r?.success) {
        setResendCountdown(60);
        setCode('');
        if (step !== 'otp') goStep('otp');
      } else {
        setError(r?.message || (t('changePhone.sendError') || 'Falha ao enviar código'));
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const checkOtp = async () => {
    if (code.length !== 6 || busy) return;
    setError(''); setBusy(true);
    try {
      const r = await api.phoneChangeVerify(fullPhone, code);
      if (!mountedRef.current) return;
      if (r?.success) {
        goStep('done');
        // Auto-back after the success animation settles.
        setTimeout(() => {
          if (!mountedRef.current) return;
          try {
            if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
            else router.replace('/settings');
          } catch {}
        }, 2400);
      } else {
        setError(r?.message || (t('changePhone.otpInvalid') || 'Código incorreto'));
        setCode('');
        triggerOtpError();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const goBack = useCallback(() => {
    setError('');
    const safeBack = () => {
      try {
        if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
        else router.replace('/settings');
      } catch { try { router.replace('/settings'); } catch {} }
    };
    if (step === 'confirm') {
      safeBack();
    } else if (step === 'otp') {
      // Drop the pending flag server-side so a new request can be issued
      // fresh later. Best-effort — UI doesn't block on the response.
      api.phoneChangeCancel?.()?.catch?.(() => {});
      goStep('confirm');
    } else if (step === 'done') {
      safeBack();
    }
  }, [step, router, goStep]);

  // ── Helpers for rendering ──
  const country = useMemo(
    () => COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0],
    [countryCode]
  );
  const filteredCountries = useMemo(() => {
    const q = (countrySearch || '').trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.dial || '').includes(q) ||
      (c.code || '').toLowerCase().includes(q)
    );
  }, [countrySearch]);

  // Format the old phone nicely for display ("+55 (33) 99965-2818" style).
  const oldPhoneFormatted = useMemo(() => {
    if (!oldPhone) return '';
    const digits = (oldPhone || '').replace(/\D/g, '');
    if (digits.length < 8) return oldPhone;
    // Best-effort BR formatting; otherwise group last 4 + rest.
    if (oldPhone.startsWith('+55') && digits.length >= 12) {
      const local = digits.slice(2);
      const dd = local.slice(0, 2);
      const tail = local.slice(2);
      const last4 = tail.slice(-4);
      const middle = tail.slice(0, tail.length - 4);
      return `+55 (${dd}) ${middle}-${last4}`;
    }
    const last4 = digits.slice(-4);
    const head  = digits.slice(0, digits.length - 4);
    return `+${head} ${last4}`;
  }, [oldPhone]);

  // Same for the new phone — used in the success message ("Seu novo número é Y").
  const fullPhoneFormatted = useMemo(() => {
    const c = country;
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) return c.dial;
    if (countryCode === 'BR' && digits.length >= 10) {
      const tail = digits.slice(2);
      const last4 = tail.slice(-4);
      const middle = tail.slice(0, tail.length - 4);
      return `${c.dial} (${digits.slice(0, 2)}) ${middle}-${last4}`;
    }
    const last4 = digits.slice(-4);
    const head  = digits.slice(0, digits.length - 4);
    return `${c.dial} ${head} ${last4}`.trim();
  }, [country, countryCode, phone]);

  const _hairline = isDark ? '#2a2d31' : '#e5e7eb';
  const _hairlineActive = colors.primary;

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: Math.max(insets.top, 12) }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Header — back arrow + title */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={goBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.backBtn}
            accessibilityLabel={t('common.back') || 'Voltar'}
            accessibilityRole="button"
          >
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {t('changePhone.title') || 'Alterar número'}
          </Text>
          <View style={{ width: 22 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            style={{
              opacity: fade,
              transform: [{ translateY: slide }, { scale: stepScale }],
            }}
          >
            {/* Hero icon */}
            {step !== 'done' && (
              <View style={styles.heroWrap}>
                <View style={[styles.heroOrb, { backgroundColor: colors.primary + '15' }]}>
                  <View style={[styles.heroOrbInner, { backgroundColor: colors.primary }]}>
                    {step === 'confirm' && <IconPhone size={36} color="#fff" />}
                    {step === 'otp' && <IconShield size={36} color="#fff" />}
                  </View>
                </View>
              </View>
            )}

            {/* Confirm step */}
            {step === 'confirm' && (
              <>
                <Text style={[styles.title, { color: colors.text }]}>
                  {t('changePhone.confirmTitle') || 'Mudar de número?'}
                </Text>
                <Text style={[styles.sub, { color: colors.textSecondary }]}>
                  {t('changePhone.confirmSub') || 'Sua conta atual será migrada para o novo número. Seus chats, contatos e @ continuam iguais.'}
                </Text>

                {/* Warning banner */}
                <View style={[styles.warnBanner, { backgroundColor: isDark ? '#3a2a14' : '#fff7ed', borderColor: isDark ? '#5a3a1c' : '#fde6c8' }]}>
                  <IconAlertTriangle size={18} color="#d97706" />
                  <Text style={[styles.warnText, { color: isDark ? '#fde6c8' : '#92400e' }]}>
                    {t('changePhone.warning') || 'Após a troca, o login passa a ser feito pelo novo número.'}
                  </Text>
                </View>

                {/* Old number — read-only */}
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                  {t('changePhone.currentLabel') || 'Número atual'}
                </Text>
                <View style={[styles.readonlyBox, { backgroundColor: isDark ? '#1f2229' : '#f3f4f6', borderColor: _hairline }]}>
                  {loadingProfile
                    ? <ActivityIndicator size="small" color={colors.primary} />
                    : (
                        <Text style={[styles.readonlyText, { color: colors.text }]} numberOfLines={1}>
                          {oldPhoneFormatted || (t('changePhone.noCurrent') || 'Não vinculado')}
                        </Text>
                      )
                  }
                </View>

                {/* Country picker row */}
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: 18 }]}>
                  {t('changePhone.countryLabel') || 'País'}
                </Text>
                <TouchableOpacity
                  onPress={() => { setCountrySearch(''); setShowCountryPicker(true); }}
                  activeOpacity={0.6}
                  style={[styles.row, { borderBottomColor: _hairline }]}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{country.flag}</Text>
                  <Text style={{ flex: 1, fontSize: 16, fontWeight: '500', color: colors.text }}>
                    {country.name}
                  </Text>
                  <IconChevronRight size={16} color={isDark ? '#9aa0a6' : '#9ca3af'} />
                </TouchableOpacity>

                {/* Phone input row */}
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: 14 }]}>
                  {t('changePhone.newLabel') || 'Novo número'}
                </Text>
                <View style={{
                  flexDirection: 'row', alignItems: 'center',
                  borderBottomWidth: focused === 'phone' ? 2 : StyleSheet.hairlineWidth,
                  borderBottomColor: focused === 'phone' ? _hairlineActive : _hairline,
                }}>
                  <View style={{ width: 64, paddingVertical: 14, paddingRight: 8 }}>
                    <Text style={{ fontSize: 16, color: colors.text, fontWeight: '500' }}>
                      {country.dial}
                    </Text>
                  </View>
                  <View style={{ width: StyleSheet.hairlineWidth, height: 22, backgroundColor: _hairline, marginRight: 8 }} />
                  <TextInput
                    style={[
                      { flex: 1, fontSize: 16, paddingVertical: 14, color: colors.text },
                      Platform.OS === 'web' && { outlineStyle: 'none' },
                    ]}
                    value={formatPhone(phone, country.mask)}
                    onChangeText={(text) => {
                      const digits = text.replace(/\D/g, '').slice(0, country.maxDigits || 15);
                      setPhone(digits);
                      if (error) setError('');
                    }}
                    keyboardType="phone-pad"
                    placeholder={country.mask ? country.mask.replace(/#/g, '0') : '11 99999-9999'}
                    placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                    onFocus={() => setFocused('phone')}
                    onBlur={() => setFocused('')}
                  />
                </View>

                {!!error && (
                  <Text style={[styles.errorText, { color: colors.error || '#dc2626' }]}>{error}</Text>
                )}
              </>
            )}

            {/* OTP step */}
            {step === 'otp' && (
              <>
                <Text style={[styles.title, { color: colors.text }]}>
                  {t('changePhone.otpTitle') || 'Digite o código'}
                </Text>
                <Text style={[styles.sub, { color: colors.textSecondary }]}>
                  {(t('changePhone.otpSub') || 'Enviamos um código de 6 dígitos para')} {fullPhoneFormatted}
                </Text>

                <Pressable
                  onPress={() => otpRefs.current?.[0]?.focus?.()}
                  style={{ marginTop: 24, alignSelf: 'center' }}
                  accessibilityLabel={t('changePhone.otpAccessibility') || 'Código de 6 dígitos'}
                >
                  <Animated.View style={{
                    flexDirection: 'row', justifyContent: 'center', gap: 8,
                    transform: [{ translateX: otpShake }],
                  }}>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const _digit = code[i] || '';
                      const _filled = !!_digit;
                      const _focused = (code.length === i) || (code.length === 6 && i === 5);
                      const _otpBg = isDark ? (_filled ? `${colors.primary}26` : '#1f2229') : (_filled ? `${colors.primary}10` : '#f3f4f6');
                      const _otpBorder = _focused ? colors.primary : (_filled ? colors.primary : (isDark ? '#2a2d31' : '#e5e7eb'));
                      return (
                        <Animated.View
                          key={i}
                          style={{
                            width: 42, height: 50, borderRadius: 8,
                            borderWidth: 1.5,
                            borderColor: _otpBorder,
                            backgroundColor: _otpBg,
                            alignItems: 'center', justifyContent: 'center',
                            transform: [{ scale: otpBoxScales[i] }],
                          }}
                        >
                          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>{_digit}</Text>
                        </Animated.View>
                      );
                    })}
                  </Animated.View>
                  {/* Single hidden TextInput overlays the 6 visual boxes — autofill-friendly */}
                  <TextInput
                    ref={ref => { otpRefs.current[0] = ref; }}
                    style={{
                      position: 'absolute',
                      top: 0, left: 0, right: 0, bottom: 0,
                      color: 'transparent',
                      backgroundColor: 'transparent',
                      fontSize: 22,
                      textAlign: 'center',
                      ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'transparent' } : {}),
                    }}
                    value={code}
                    onChangeText={(raw) => {
                      const digits = (raw || '').replace(/\D/g, '').slice(0, 6);
                      const prevLen = code.length;
                      setCode(digits);
                      try {
                        for (let j = prevLen; j < digits.length; j++) {
                          const sv = otpBoxScales[j];
                          if (!sv) continue;
                          Animated.sequence([
                            Animated.timing(sv, { toValue: 1.08, duration: 60, useNativeDriver: true }),
                            Animated.timing(sv, { toValue: 1,    duration: 60, useNativeDriver: true }),
                          ]).start();
                        }
                      } catch {}
                      if (digits.length === 6) {
                        // Auto-submit on full code (matches Telegram / iMessage).
                        setTimeout(() => { try { checkOtp(); } catch {} }, 150);
                      }
                    }}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={6}
                    textContentType="oneTimeCode"
                    autoComplete="sms-otp"
                    autoFocus
                    caretHidden
                    importantForAutofill="yes"
                  />
                </Pressable>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
                  <Text style={{ fontSize: 12, color: colors.textTertiary }}>
                    {resendCountdown > 0 ? `${t('changePhone.resendIn') || 'Reenviar em'} ${resendCountdown}s` : ''}
                  </Text>
                  <TouchableOpacity disabled={resendCountdown > 0 || busy} onPress={sendOtp}>
                    <Text style={{
                      fontSize: 13, fontWeight: '600',
                      color: resendCountdown > 0 ? colors.textTertiary : colors.primary,
                    }}>
                      {t('changePhone.resend') || 'Reenviar código'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {!!error && (
                  <Text style={[styles.errorText, { color: colors.error || '#dc2626', textAlign: 'center', marginTop: 14 }]}>
                    {error}
                  </Text>
                )}
              </>
            )}

            {/* Done step — success + confetti */}
            {step === 'done' && (
              <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                {/* Confetti dots */}
                <View style={{ position: 'absolute', top: 50, alignSelf: 'center' }}>
                  {confettiAnims.map((a, i) => {
                    const palette = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
                    const c = palette[i % palette.length];
                    return (
                      <Animated.View
                        key={i}
                        style={{
                          position: 'absolute',
                          width: 8, height: 8, borderRadius: 4,
                          backgroundColor: c,
                          opacity: a.o,
                          transform: [{ translateX: a.x }, { translateY: a.y }],
                        }}
                      />
                    );
                  })}
                </View>

                <Animated.View
                  style={{
                    width: 96, height: 96, borderRadius: 48,
                    backgroundColor: '#22c55e',
                    alignItems: 'center', justifyContent: 'center',
                    transform: [{ scale: doneScale }],
                  }}
                >
                  <IconCheck size={52} color="#fff" />
                </Animated.View>
                <Text style={[styles.title, { color: colors.text, marginTop: 22, textAlign: 'center' }]}>
                  {t('changePhone.doneTitle') || 'Pronto!'}
                </Text>
                <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center', marginTop: 6 }]}>
                  {(t('changePhone.doneSub') || 'Seu novo número é')} {fullPhoneFormatted}
                </Text>
              </View>
            )}
          </Animated.View>
        </ScrollView>

        {/* Primary action bar — only shows on confirm/otp */}
        {step !== 'done' && (
          <View style={[styles.actionBar, { borderTopColor: _hairline, paddingBottom: Math.max(insets.bottom, 12) }]}>
            <TouchableOpacity
              disabled={
                busy ||
                (step === 'confirm' && (phone || '').replace(/\D/g, '').length < 8) ||
                (step === 'otp' && code.length !== 6)
              }
              onPress={() => {
                if (step === 'confirm') sendOtp();
                else if (step === 'otp') checkOtp();
              }}
              activeOpacity={0.85}
              style={[
                styles.primaryBtn,
                {
                  backgroundColor: (
                    busy ||
                    (step === 'confirm' && (phone || '').replace(/\D/g, '').length < 8) ||
                    (step === 'otp' && code.length !== 6)
                  ) ? (isDark ? '#2a2d31' : '#e5e7eb') : colors.primary,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Text style={[styles.primaryBtnText]}>
                    {step === 'confirm'
                      ? (t('changePhone.sendCode') || 'Enviar código')
                      : (t('changePhone.confirm') || 'Confirmar')}
                  </Text>
                  <IconArrowRight size={18} color="#fff" />
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Country picker modal */}
        <Modal
          visible={showCountryPicker}
          animationType="slide"
          transparent={false}
          onRequestClose={() => setShowCountryPicker(false)}
        >
          <View style={[styles.root, { backgroundColor: colors.background, paddingTop: Math.max(insets.top, 12) }]}>
            <View style={styles.header}>
              <TouchableOpacity
                onPress={() => setShowCountryPicker(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={styles.backBtn}
              >
                <IconArrowLeft size={22} color={colors.text} />
              </TouchableOpacity>
              <Text style={[styles.headerTitle, { color: colors.text }]}>
                {t('changePhone.pickCountry') || 'Selecionar país'}
              </Text>
              <View style={{ width: 22 }} />
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <TextInput
                style={[
                  {
                    fontSize: 15, paddingVertical: 12, paddingHorizontal: 14,
                    borderRadius: 10, backgroundColor: isDark ? '#1f2229' : '#f3f4f6',
                    color: colors.text,
                  },
                  Platform.OS === 'web' && { outlineStyle: 'none' },
                ]}
                value={countrySearch}
                onChangeText={setCountrySearch}
                placeholder={t('changePhone.searchCountry') || 'Buscar país'}
                placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
              />
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
              {filteredCountries.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  onPress={() => {
                    setCountryCode(c.code);
                    setShowCountryPicker(false);
                  }}
                  style={[styles.countryRow, { borderBottomColor: _hairline }]}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{c.flag}</Text>
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{c.name}</Text>
                  <Text style={{ fontSize: 14, color: colors.textSecondary, fontWeight: '500' }}>{c.dial}</Text>
                  {c.code === countryCode && (
                    <IconCheckCircle size={18} color={colors.primary} style={{ marginLeft: 10 }} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  backBtn: { padding: 6 },
  headerTitle: { fontSize: 17, fontWeight: '600', flex: 1, textAlign: 'center' },
  scroll: { paddingHorizontal: 22, paddingBottom: 32, flexGrow: 1 },
  heroWrap: { alignItems: 'center', marginTop: 8, marginBottom: 22 },
  heroOrb: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  heroOrbInner: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  sub: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 8 },
  warnBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: 1, marginTop: 18, marginBottom: 8,
  },
  warnText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  fieldLabel: {
    fontSize: 11, fontWeight: '600', letterSpacing: 0.3,
    textTransform: 'uppercase', marginTop: 16, marginBottom: 6,
  },
  readonlyBox: {
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    minHeight: 50, alignItems: 'flex-start', justifyContent: 'center',
  },
  readonlyText: { fontSize: 16, fontWeight: '500' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  errorText: { fontSize: 13, marginTop: 10 },
  actionBar: {
    paddingHorizontal: 18, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 52, borderRadius: 14,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  countryRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
