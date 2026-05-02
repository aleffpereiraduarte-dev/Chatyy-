// signup-phone.js — WhatsApp-style phone-first signup.
//
// Flow (single screen, 4 steps):
//   1. phone        → verify_send (SMS + WhatsApp template)
//   2. otp          → verify_check (returns verify_token)
//   3. name         → user types display name
//   4. handle       → pick @chatyy.com.br username (with availability check)
//                  → phone_signup → bearer token → /chat
//
// No password screen. Server generates the dovecot password and stores an
// encrypted recovery blob (see /var/www/mail/api/phone-auth.php).

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Animated, Platform, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import PhoneInput, { COUNTRIES } from '../components/signup/PhoneInput';
import OtpInput from '../components/signup/OtpInput';
import { IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle, IconUser, IconAtSign, IconAlertTriangle } from '../components/Icons';

export default function SignupPhone() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { loginWithToken } = useAuth();

  const [step, setStep] = useState('phone'); // phone | otp | name | handle | done
  const [phone, setPhone] = useState('');           // digits only (sem DDI)
  const [countryCode, setCountryCode] = useState('BR'); // PhoneInput espera ISO code
  const [code, setCode] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(null); // null | true | false
  const [usernameSuggestions, setUsernameSuggestions] = useState([]);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);

  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const usernameDebRef = useRef(null);
  const resendTimerRef = useRef(null);
  // Guard against setState after unmount (user can swipe back mid-API-call).
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Build E.164 from country dial + digits (PhoneInput holds digits only).
  const fullPhone = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    return `${c.dial}${phone.replace(/\D/g, '')}`;
  }, [countryCode, phone]);

  // Resend countdown ticker (60s after each verify_send).
  useEffect(() => {
    if (resendCountdown <= 0) return;
    resendTimerRef.current = setTimeout(() => setResendCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(resendTimerRef.current);
  }, [resendCountdown]);

  // Smooth crossfade between steps so the screen feels like one continuous form.
  const goStep = (next) => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(slide, { toValue: -16, duration: 140, useNativeDriver: true }),
    ]).start(() => {
      setStep(next);
      slide.setValue(16);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(slide, { toValue: 0, tension: 80, friction: 9, useNativeDriver: true }),
      ]).start();
    });
  };

  const sendOtp = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) { setError(t('login.phoneInvalid') || 'Número inválido'); return; }
    setError(''); setBusy(true);
    try {
      const r = await api.verifySend(fullPhone);
      if (!mountedRef.current) return;
      if (r?.success) {
        setResendCountdown(60);
        goStep('otp');
        setCode('');
      } else {
        setError(r?.message || (t('signupPhone.sendError') || 'Falha ao enviar código'));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const checkOtp = async () => {
    if (code.length !== 6) return;
    setError(''); setBusy(true);
    try {
      const r = await api.verifyCheck(fullPhone, code);
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        setVerifyToken(r.data.token);
        goStep('name');
      } else {
        setError(r?.message || (t('signupPhone.otpInvalid') || 'Código incorreto'));
        setCode('');
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const goName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) { setError(t('signupPhone.nameTooShort') || 'Nome muito curto'); return; }
    setError('');
    // Suggest a default handle from the name (lowercase, no spaces, no accents).
    const handle = trimmed.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!username) setUsername(handle);
    goStep('handle');
  };

  // Live username availability check (debounced 400ms).
  useEffect(() => {
    if (step !== 'handle' || !username || username.length < 3) {
      setUsernameAvailable(null);
      setUsernameSuggestions([]);
      return;
    }
    if (usernameDebRef.current) clearTimeout(usernameDebRef.current);
    setUsernameChecking(true);
    usernameDebRef.current = setTimeout(async () => {
      try {
        const r = await api.checkUsername(username, 'chatyy.com.br');
        const ok = r && r.success && (r.data?.available !== false);
        setUsernameAvailable(ok);
        setUsernameSuggestions(r?.data?.suggestions || []);
      } catch {
        setUsernameAvailable(null);
      } finally { setUsernameChecking(false); }
    }, 400);
    return () => clearTimeout(usernameDebRef.current);
  }, [username, step]);

  const finishSignup = async () => {
    if (!verifyToken) { setError(t('signupPhone.expired') || 'Verificação expirou. Recomece.'); goStep('phone'); return; }
    if (!username || usernameAvailable === false) return;
    setError(''); setBusy(true);
    try {
      const r = await api.phoneSignup({ verify_token: verifyToken, username, name, domain: 'chatyy.com.br' });
      if (r?.success && r.data?.token) {
        // Hand off via the standard token-login path so the auth state hydrates,
        // tokens persist, push is registered, and the rest of the app comes up
        // with the same guarantees as email login. Mirrors login.js:699.
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (lr?.success) {
          goStep('done');
          setTimeout(() => router.replace('/chat'), 700);
        } else {
          setError(lr?.message || (t('signupPhone.signupError') || 'Falha ao entrar após criar conta'));
        }
      } else {
        setError(r?.message || (t('signupPhone.signupError') || 'Falha ao criar conta'));
      }
    } catch (e) {
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { setBusy(false); }
  };

  const headerTitle = {
    phone:  t('signupPhone.titlePhone')  || 'Seu telefone',
    otp:    t('signupPhone.titleOtp')    || 'Código de verificação',
    name:   t('signupPhone.titleName')   || 'Como podemos te chamar?',
    handle: t('signupPhone.titleHandle') || 'Escolha seu @',
    done:   t('signupPhone.titleDone')   || 'Tudo pronto!',
  }[step];

  const headerSub = {
    phone:  t('signupPhone.subPhone')  || 'Vamos confirmar pra registrar sua conta',
    otp:    `${t('signupPhone.subOtp') || 'Enviamos o código pra'} ${phone}`,
    name:   t('signupPhone.subName')   || 'Esse é o nome que aparece pros amigos',
    handle: t('signupPhone.subHandle') || 'Você ganha um email Chatyy de presente',
    done:   t('signupPhone.subDone')   || 'Sua conta foi criada — bora conversar',
  }[step];

  const goBack = () => {
    setError('');
    if (step === 'phone' || step === 'done') router.back();
    else if (step === 'otp') goStep('phone');
    else if (step === 'name') goStep('otp');
    else if (step === 'handle') goStep('name');
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header — back button + brand */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.brand, { color: colors.text }]}>Chatyy</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Progress dots — 4 steps + done */}
      <View style={styles.dotsRow}>
        {['phone', 'otp', 'name', 'handle'].map((s, i) => {
          const order = ['phone', 'otp', 'name', 'handle', 'done'];
          const cur = order.indexOf(step);
          const idx = order.indexOf(s);
          const active = idx <= cur;
          return (
            <View
              key={s}
              style={[
                styles.dot,
                { backgroundColor: active ? '#7C3AED' : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.10)') },
              ]}
            />
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }], width: '100%' }}>
          <Text style={[styles.title, { color: colors.text }]}>{headerTitle}</Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>{headerSub}</Text>

          {/* Step body */}
          <View style={{ marginTop: 24 }}>
            {step === 'phone' && (
              <>
                <PhoneInput
                  value={phone}
                  onChange={setPhone}
                  countryCode={countryCode}
                  onCountryChange={setCountryCode}
                />
                <Text style={[styles.hint, { color: colors.textTertiary }]}>
                  {t('signupPhone.hintPhone') || 'Vamos enviar um código por SMS e WhatsApp'}
                </Text>
              </>
            )}

            {step === 'otp' && (
              <>
                <OtpInput value={code} onChange={setCode} autoFocus />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
                  <Text style={{ fontSize: 12, color: colors.textTertiary }}>
                    {resendCountdown > 0
                      ? `${t('signupPhone.resendIn') || 'Reenviar em'} ${resendCountdown}s`
                      : ''}
                  </Text>
                  <TouchableOpacity disabled={resendCountdown > 0 || busy} onPress={sendOtp}>
                    <Text style={{
                      fontSize: 13, fontWeight: '600',
                      color: resendCountdown > 0 ? colors.textTertiary : '#7C3AED',
                    }}>
                      {t('signupPhone.resend') || 'Reenviar código'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {step === 'name' && (
              <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <IconUser size={18} color={colors.textSecondary} />
                <TextInput
                  style={[styles.input, { color: colors.text }]}
                  placeholder={t('signupPhone.namePlaceholder') || 'Seu nome'}
                  placeholderTextColor={colors.textTertiary}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  autoFocus
                  maxLength={50}
                  returnKeyType="next"
                  onSubmitEditing={goName}
                />
              </View>
            )}

            {step === 'handle' && (
              <>
                <View style={[styles.inputWrap, {
                  borderColor: usernameAvailable === false ? '#ef4444'
                    : usernameAvailable === true ? '#22c55e'
                    : colors.border,
                  backgroundColor: colors.surface,
                }]}>
                  <IconAtSign size={18} color={colors.textSecondary} />
                  <TextInput
                    style={[styles.input, { color: colors.text }]}
                    placeholder="seu.username"
                    placeholderTextColor={colors.textTertiary}
                    value={username}
                    onChangeText={(v) => setUsername(v.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30))}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    maxLength={30}
                  />
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>@chatyy.com.br</Text>
                  {usernameChecking ? (
                    <ActivityIndicator size="small" color="#7C3AED" style={{ marginLeft: 6 }} />
                  ) : usernameAvailable === true ? (
                    <View style={{ marginLeft: 6 }}><IconCheckCircle size={18} color="#22c55e" /></View>
                  ) : usernameAvailable === false ? (
                    <View style={{ marginLeft: 6 }}><IconAlertTriangle size={18} color="#ef4444" /></View>
                  ) : null}
                </View>
                {/* Suggestions when taken */}
                {usernameAvailable === false && usernameSuggestions.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    {usernameSuggestions.slice(0, 4).map(s => (
                      <TouchableOpacity
                        key={s}
                        onPress={() => setUsername(s)}
                        style={{
                          paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
                          backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
                          borderWidth: 1, borderColor: isDark ? 'rgba(124,58,237,0.35)' : 'rgba(124,58,237,0.25)',
                        }}
                      >
                        <Text style={{ fontSize: 13, color: '#7C3AED', fontWeight: '600' }}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <Text style={[styles.hint, { color: colors.textTertiary }]}>
                  {t('signupPhone.hintHandle') || 'Esse vai ser seu email no Chatyy também — pra receber e mandar mensagem.'}
                </Text>
              </>
            )}

            {step === 'done' && (
              <View style={{ alignItems: 'center', marginTop: 24 }}>
                <View style={{
                  width: 84, height: 84, borderRadius: 42,
                  backgroundColor: '#22c55e',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconCheck size={48} color="#fff" strokeWidth={3} />
                </View>
                <Text style={{ marginTop: 16, fontSize: 15, color: colors.textSecondary, textAlign: 'center' }}>
                  {t('signupPhone.redirecting') || 'Abrindo seu Chatyy…'}
                </Text>
              </View>
            )}

            {!!error && step !== 'done' && (
              <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 12, textAlign: 'center' }}>{error}</Text>
            )}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Primary action button (sticky bottom for the form-like feel) */}
      {step !== 'done' && (
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={[
              styles.cta,
              {
                backgroundColor: busy ? '#9CA3AF' : '#7C3AED',
                opacity: (
                  (step === 'phone' && phone.replace(/\D/g, '').length < 10) ||
                  (step === 'otp'   && code.length !== 6) ||
                  (step === 'name'  && name.trim().length < 2) ||
                  (step === 'handle' && (!username || usernameAvailable !== true))
                ) ? 0.55 : 1,
              },
            ]}
            disabled={busy ||
              (step === 'phone' && phone.replace(/\D/g, '').length < 10) ||
              (step === 'otp'   && code.length !== 6) ||
              (step === 'name'  && name.trim().length < 2) ||
              (step === 'handle' && (!username || usernameAvailable !== true))}
            onPress={() => {
              if (step === 'phone')  sendOtp();
              else if (step === 'otp')    checkOtp();
              else if (step === 'name')   goName();
              else if (step === 'handle') finishSignup();
            }}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={styles.ctaText}>
                  {step === 'handle' ? (t('signupPhone.finish') || 'Criar conta') : (t('common.next') || 'Próximo')}
                </Text>
                {step !== 'handle' && <IconArrowRight size={18} color="#fff" style={{ marginLeft: 8 }} />}
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 24, paddingBottom: 12 },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 20 },
  dot: { width: 28, height: 4, borderRadius: 2 },
  scroll: { paddingHorizontal: 22, paddingBottom: 120 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.4, marginBottom: 6 },
  sub: { fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12, marginTop: 12, lineHeight: 17 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    height: 52, borderRadius: 12, borderWidth: 1.5,
    paddingHorizontal: 14,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 22, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'transparent',
  },
  cta: {
    height: 52, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
