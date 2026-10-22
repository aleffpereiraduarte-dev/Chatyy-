// signup-username.js — Telegram-style username-only signup, no phone/SIM.
//
// 4 steps in a single screen:
//   1. credentials → email (auto-suggest @chatyy.com.br) + password
//   2. name        → display name
//   3. handle      → @username (live availability check, default = name slug)
//   4. done        → bearer token + router.replace('/chat')
//
// Mirrors signup-phone.js's visual language but skips phone+OTP entirely.
// Backend: `username_signup` action accepts { username, name, password,
// domain }, returns the same {token, email, name, csrf_token} shape as
// phone_signup. The new account is flagged `phone_required: false` so the
// user can add a phone later in settings without being nagged.

import { androidBottomInset, androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Animated, Platform, KeyboardAvoidingView, ScrollView, Easing, useWindowDimensions,
} from 'react-native';
import KeyboardSafeView from '../components/ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useRouter, Redirect } from 'expo-router';
import { HapticsCompat as Haptics } from '../services/haptics'; // [2026-10-11] same API, routed via the shared haptics shim
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import useDebouncedCallback from '../hooks/useDebouncedCallback';
import useIsMounted from '../hooks/useIsMounted';
import {
  IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle, IconUser,
  IconAtSign, IconAlertTriangle, IconSparkles, IconLock, IconEye, IconEyeOff,
} from '../components/Icons';
// [2026-10-12 auth-polish] same rules / error mapping / strength meter as /signup-phone.
import SignupPasswordMeter from '../components/signup/SignupPasswordMeter';
import { SignupConsentBlock } from '../components/consent/ConsentOptions'; // [2026-10-13 consent-lgpd]
import { usernameLocalError, sanitizeUsernameTyping, friendlyServerError } from '../components/signup/signupSmarts';

// [phone-obrigatorio 2026-10-15] Cadastro SEM telefone FECHADO (founder: 1 conta = 1 número, como WhatsApp).
// O servidor recusa username_signup (403 phone_required); a rota (links antigos / URL no web) cai no
// cadastro por telefone. Tela antiga mantida abaixo só como referência — não é mais alcançável.
export const USERNAME_SIGNUP_ENABLED = false;
export default function SignupUsernameRoute() {
  if (!USERNAME_SIGNUP_ENABLED) return <Redirect href="/signup-phone" />;
  return <SignupUsername />;
}

function SignupUsername() {
  const router = useRouter();
  const { colors, isDark } = useAuthTheme();
  const { t } = useLanguage();
  const { loginWithToken } = useAuth();
  const insets = useSafeAreaInsets();
  const mountedRef = useIsMounted();
  // [2026-10-12 auth-polish] wide web → centered card on the auth background (login parity).
  const { width: _winW } = useWindowDimensions();
  const _wideWeb = Platform.OS === 'web' && _winW >= 768;
  const AuthCardWrap = _wideWeb ? View : Fragment;
  const _errText = (r, fallbackKey) => { const f = friendlyServerError(r, fallbackKey); return f.text || t(f.key); };

  // Telegram-style step ladder: handle → name → done is the canonical flow,
  // but we lead with credentials (email + password) because the
  // username-only path needs an explicit password the user can remember.
  const [step, setStep] = useState('handle'); // 'handle' | 'name' | 'done'

  const [username, setUsername] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(null);
  const [usernameSuggestions, setUsernameSuggestions] = useState([]);
  const [usernameChecking, setUsernameChecking] = useState(false);

  const [name, setName] = useState('');

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState('');

  // Step transition fade/slide — same pattern as signup-phone for visual
  // continuity across both signup paths.
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const stepScale = useRef(new Animated.Value(1)).current;
  const doneScale = useRef(new Animated.Value(0)).current;
  const checkScale = useRef(new Animated.Value(0)).current;

  // Hero orb scale-pop on each step.
  const heroScale = useRef(new Animated.Value(0.6)).current;
  const heroIconFade = useRef(new Animated.Value(1)).current;
  // Soft breathing halo behind the orb — parity with signup-phone so the
  // username path feels equally alive. 4s cycle, opacity + scale only on the
  // halos (the orb itself stays still). Calm, not flashy.
  useEffect(() => {
    if (step === 'done') return;
    heroScale.setValue(0.6);
    Animated.spring(heroScale, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }).start();
    heroIconFade.setValue(0);
    Animated.timing(heroIconFade, { toValue: 1, duration: 280, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
  }, [step, heroScale, heroIconFade]);

  useEffect(() => {
    if (step === 'done') {
      doneScale.setValue(0);
      Animated.spring(doneScale, { toValue: 1, friction: 7, tension: 100, useNativeDriver: true }).start();
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    }
  }, [step, doneScale]);

  const goStep = (next) => {
    try { if (next !== 'done') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
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
  };

  // Live username availability check (same shape as signup-phone.js).
  // [2026-10-12 auth-polish] Was: any non-success (429 / network blip) read as
  // "taken", "a..b" / "joao." hit the server, and a slow reply for an older
  // handle could overwrite the current one. Now mirrors /signup-phone.
  const [usernameReason, setUsernameReason] = useState(null);
  const _usernameLatestRef = useRef('');
  const runUsernameCheck = useDebouncedCallback(async (uname) => {
    try {
      const r = await api.checkUsername(uname, 'chatyy.com.br');
      if (!mountedRef.current || _usernameLatestRef.current !== uname) return;
      const status = Number(r?.__httpStatus || 0);
      if (r?.success) {
        const ok = r.data?.available !== false;
        setUsernameAvailable(ok);
        setUsernameReason(ok ? null : 'taken');
        const sugg = Array.isArray(r.data?.suggestions) ? r.data.suggestions.filter(x => typeof x === 'string' && !usernameLocalError(x)) : [];
        setUsernameSuggestions(ok ? [] : sugg);
      } else if (status === 429 || status === 0 || !r) {
        setUsernameAvailable(null); setUsernameReason(null);
      } else {
        setUsernameAvailable(false); setUsernameReason('chars');
        setUsernameSuggestions([]);
      }
    } catch {
      if (_usernameLatestRef.current === uname) { setUsernameAvailable(null); setUsernameReason(null); }
    } finally { if (mountedRef.current && _usernameLatestRef.current === uname) setUsernameChecking(false); }
  }, 600);

  useEffect(() => {
    _usernameLatestRef.current = username;
    if (step !== 'handle' || !username) {
      setUsernameAvailable(null); setUsernameReason(null);
      setUsernameSuggestions([]);
      setUsernameChecking(false);
      return;
    }
    const localErr = usernameLocalError(username);
    if (localErr) {
      setUsernameAvailable(localErr === 'short' ? null : false);
      setUsernameReason(localErr);
      setUsernameSuggestions([]);
      setUsernameChecking(false);
      return;
    }
    setUsernameChecking(true);
    runUsernameCheck(username);
  }, [username, step, runUsernameCheck]);

  useEffect(() => {
    if (usernameAvailable === true) {
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, friction: 5, tension: 100, useNativeDriver: true }).start();
    } else {
      checkScale.setValue(0);
    }
  }, [usernameAvailable, checkScale]);

  const goHandle = () => {
    const uname = (username || '').trim();
    if (uname.length < 3) { setError(t('signupUsername.handleTooShort') || 'Username muito curto'); return; }
    if (usernameLocalError(uname)) { setError(t('signupPhone.err.usernameInvalid')); return; }
    if (usernameAvailable === false) { setError(t('signupUsername.handleTaken') || 'Esse username já foi escolhido'); return; }
    if (password.length < 8) { setError(t('signupUsername.passwordShort') || 'Senha precisa ter ao menos 8 caracteres'); return; }
    setError('');
    goStep('name');
  };

  const finishSignup = async () => {
    const fn = (name || '').trim();
    if (fn.length < 2) { setError(t('signupUsername.nameTooShort') || 'Nome muito curto'); return; }
    if (!username || usernameAvailable === false) { goStep('handle'); return; }
    setError(''); setBusy(true);
    try {
      let _ref = ''; try { _ref = await require('../services/pendingReferral').getPendingRef(); } catch {} // [bia-convite 2026-10-19]
      const r = await api.usernameSignup({ username, name: fn, password, domain: 'chatyy.com.br', ref: _ref });
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (!mountedRef.current) return;
        if (lr?.success) {
          // [2026-10-13 consent-lgpd] sem auto-redirect: a etapa final mostra as 2
          // opções opcionais (desmarcadas) + "Começar" (ver step === 'done').
          goStep('done');
        } else {
          setError(lr?.message ? _errText(lr, 'signupUsername.loginFailed') : (t('signupUsername.loginFailed') || 'Falha ao entrar após criar conta'));
        }
      } else {
        // [2026-10-12 auth-polish] backend messages are hard-coded pt-BR →
        // translated/friendly text; a handle taken in the race window sends
        // the user back to the @ step with the field flagged.
        const f = friendlyServerError(r, 'signupUsername.signupFailed');
        setError(f.text || t(f.key));
        if (f.kind === 'username') { setUsernameAvailable(false); setUsernameReason('taken'); goStep('handle'); }
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const goBack = () => {
    setError('');
    const safeBack = () => {
      try {
        if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
        else router.replace('/login');
      } catch { try { router.replace('/login'); } catch {} }
    };
    if (step === 'handle') safeBack();
    else if (step === 'name') goStep('handle');
    else if (step === 'done') safeBack();
  };

  const headerTitle = {
    handle: t('signupUsername.titleHandle') || 'Escolha seu @',
    name:   t('signupUsername.titleName')   || 'Como podemos te chamar?',
    done:   t('signupUsername.titleDone')   || 'Tudo pronto!',
  }[step];
  const headerSub = {
    handle: t('signupUsername.subHandle') || 'Você ganha um email Chatyy de presente — e nada de SMS.',
    name:   t('signupUsername.subName')   || 'Esse é o nome que aparece pros amigos',
    done:   t('signupUsername.subDone')   || 'Sua conta foi criada — bora conversar',
  }[step];

  const _hairline = colors.border;
  const _ctaOff = !busy && (
    (step === 'handle' && (!username || usernameAvailable !== true || !!usernameLocalError(username) || password.length < 8)) ||
    (step === 'name' && (name || '').trim().length < 2)
  );

  return (
    <KeyboardSafeView
      style={[styles.container, { backgroundColor: _wideWeb ? (colors.authBg || colors.background) : colors.background }, _wideWeb && styles.wideRoot]}
    >
      <AuthCardWrap {...(_wideWeb ? { style: [styles.wideCard, { backgroundColor: colors.authCardBg || colors.background, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.08)' }, Platform.OS === 'web' && { boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.30), 0 18px 60px rgba(0,0,0,0.40)' : '0 1px 2px rgba(60,64,67,0.06), 0 6px 20px rgba(17,17,17,0.07), 0 24px 64px rgba(60,64,67,0.10)' }] } : {})}>
      {/* [2026-10-12 first-run polish] One compact top row — back · progress ·
          n/2 — identical to /signup-phone (was a centered "Chatyy" wordmark
          + a separate full-bleed bar), constrained to the 520pt column. */}
      <View style={[styles.header, { paddingTop: _wideWeb ? 18 : Math.max(insets.top, Platform.OS === 'android' ? (require('react-native').StatusBar.currentHeight || 24) : (Platform.OS === 'web' ? 12 : 44)) + 6 }]}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        {step !== 'done' ? (() => {
          const order = ['handle', 'name'];
          const cur = order.indexOf(step);
          return (
            <>
              <View
                style={{ flex: 1, height: 4, flexDirection: 'row', gap: 4 }}
                accessibilityRole="progressbar"
                accessibilityLabel={t('onb.stepLabel', { n: cur + 1, total: order.length })}
                accessibilityValue={{ min: 1, max: order.length, now: cur + 1 }}
              >
                {order.map((k, idx) => (
                  <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: idx <= cur ? colors.text : colors.border }} />
                ))}
              </View>
              <Text style={{ minWidth: 28, textAlign: 'right', fontSize: 13, fontWeight: '700', color: colors.textSecondary, fontVariant: ['tabular-nums'] }}>
                {`${cur + 1}/${order.length}`}
              </Text>
            </>
          );
        })() : <View style={{ flex: 1 }} />}
      </View>

      <ScrollView style={_wideWeb ? { flexGrow: 0, flexShrink: 1 } : undefined} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }, { scale: stepScale }], width: '100%' }}>

          {/* Hero orb — same pattern as signup-phone, only on the handle step
              where the user is being introduced to the @ choice. */}
          {/* [2026-10-12 first-run polish] Compact ink tile (signup-phone
              parity) replaces the 200pt breathing purple orb. */}
          {step === 'handle' && (
            <Animated.View style={{
              width: 52, height: 52, borderRadius: 16, marginBottom: 20,
              backgroundColor: colors.text,
              alignItems: 'center', justifyContent: 'center',
              transform: [{ scale: heroScale }],
            }}>
              <Animated.View style={{ opacity: heroIconFade }}>
                <IconAtSign size={24} color={colors.background} />
              </Animated.View>
            </Animated.View>
          )}

          {step !== 'done' && (
            <>
              <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{headerTitle}</Text>
              <Text style={[styles.sub, { color: colors.textSecondary }]}>{headerSub}</Text>
            </>
          )}

          <View style={{ marginTop: 24 }}>

            {step === 'handle' && (() => {
              const _isFocused = focused === 'handle';
              const _bottomColor = usernameAvailable === false ? colors.error
                : usernameAvailable === true ? colors.success
                : (_isFocused ? colors.primary : _hairline);
              const _bottomWidth = (_isFocused || usernameAvailable !== null) ? 2 : StyleSheet.hairlineWidth;
              return (
                <>
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingVertical: 6,
                    borderBottomWidth: _bottomWidth,
                    borderBottomColor: _bottomColor,
                  }}>
                    {/* flexShrink 0: on narrow web widths the glyph was squeezed to a dot. */}
                    <View style={{ flexShrink: 0 }}><IconAtSign size={18} color={_isFocused ? colors.primary : colors.textSecondary} /></View>
                    <TextInput
                      style={[{
                        flex: 1, minWidth: 0, fontSize: 16, paddingVertical: 14, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupUsername.handlePlaceholder')}
                      placeholderTextColor={colors.textTertiary}
                      value={username}
                      onChangeText={(v) => { setUsername(sanitizeUsernameTyping(v).slice(0, 20)); if (error) setError(''); }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete={Platform.OS === 'web' ? 'username' : 'username-new'}
                      textContentType="username"
                      accessibilityLabel={t('signupUsername.titleHandle') || 'Escolha seu @'}
                      autoFocus
                      maxLength={20}
                      onFocus={() => setFocused('handle')}
                      onBlur={() => setFocused('')}
                    />
                    <Text style={{ fontSize: 13, color: colors.textSecondary, flexShrink: 0 }}>@chatyy.com.br</Text>
                    {usernameChecking ? (
                      <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 6 }} />
                    ) : usernameAvailable === true ? (
                      <Animated.View style={{ marginLeft: 6, transform: [{ scale: checkScale }] }}>
                        <IconCheckCircle size={18} color={colors.success} />
                      </Animated.View>
                    ) : usernameAvailable === false ? (
                      <View style={{ marginLeft: 6 }}><IconAlertTriangle size={18} color={colors.error} /></View>
                    ) : null}
                  </View>

                  {usernameAvailable === false && usernameSuggestions.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                      {usernameSuggestions.slice(0, 4).map(s => (
                        <TouchableOpacity
                          key={s}
                          onPress={() => setUsername(s)}
                          accessibilityRole="button"
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
                            borderWidth: 1, borderColor: colors.text,
                          }}
                        >
                          <Text style={{ fontSize: 13, color: colors.text, fontWeight: '600' }}>@{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  {/* Live @handle preview card — parity with signup-phone so the
                      username path gets the same "here's your Chatyy address"
                      delight. Tints red while the handle is taken. */}
                  {!!username && (
                    <View style={{
                      marginTop: 14, padding: 12, borderRadius: 12,
                      backgroundColor: usernameAvailable === false ? `${colors.error}14` : (isDark ? `${colors.primary}1f` : `${colors.primary}0f`),
                    }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.textTertiary }}>
                        {t('onb.handlePreview')}
                      </Text>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 3 }} numberOfLines={1}>
                        {username}@chatyy.com.br
                      </Text>
                      {!usernameChecking && (usernameAvailable !== null || usernameReason === 'short') && (
                        <Text style={{ fontSize: 12, fontWeight: '600', marginTop: 3, color: usernameAvailable ? colors.success : (usernameReason === 'short' ? colors.textTertiary : colors.error) }} accessibilityLiveRegion="polite">
                          {usernameAvailable ? t('onb.available')
                            : usernameReason === 'taken' ? t('onb.taken')
                            : usernameReason === 'short' ? t('signupPhone.err.usernameShort')
                            : t('signupPhone.err.usernameInvalid')}
                        </Text>
                      )}
                    </View>
                  )}

                  <Text style={[styles.hint, { color: colors.textTertiary }]}>
                    {t('signupUsername.hintHandle') || 'Esse vai ser seu email no Chatyy também. Sem SMS, sem telefone.'}
                  </Text>

                  {/* Password — required (mirrors handle step in signup-phone). */}
                  {(() => {
                    const _isFocusedPwd = focused === 'password';
                    const _pwdValid = password.length >= 8;
                    const _bottomColorP = _pwdValid ? colors.success : (_isFocusedPwd ? colors.primary : _hairline);
                    const _bottomWidthP = (_isFocusedPwd || _pwdValid) ? 2 : StyleSheet.hairlineWidth;
                    return (
                      <View style={{ marginTop: 18 }}>
                        <View style={{
                          flexDirection: 'row', alignItems: 'center', gap: 10,
                          paddingVertical: 6,
                          borderBottomWidth: _bottomWidthP,
                          borderBottomColor: _bottomColorP,
                        }}>
                          <IconLock size={18} color={_isFocusedPwd ? colors.primary : colors.textSecondary} />
                          <TextInput
                            style={[{
                              flex: 1, fontSize: 16, paddingVertical: 14, color: colors.text,
                            }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                            placeholder={t('signupUsername.passwordPlaceholder') || 'Mínimo 8 caracteres'}
                            placeholderTextColor={colors.textTertiary}
                            value={password}
                            onChangeText={(v) => { setPassword(v); if (error) setError(''); }}
                            accessibilityLabel={t('signupPhone.passwordLabel')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry={!showPassword}
                            textContentType="newPassword"
                            autoComplete="new-password"
                            maxLength={72}
                            onFocus={() => setFocused('password')}
                            onBlur={() => setFocused('')}
                          />
                          <TouchableOpacity
                            onPress={() => setShowPassword(v => !v)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel={showPassword ? (t('signupPhone.hidePassword') || 'Ocultar senha') : (t('signupPhone.showPassword') || 'Mostrar senha')}
                          >
                            {showPassword ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
                          </TouchableOpacity>
                          {_pwdValid && <IconCheckCircle size={18} color={colors.success} style={{ marginLeft: 4 }} />}
                        </View>
                        <SignupPasswordMeter password={password} context={[username, name]} colors={colors} t={t} />
                        <Text style={[styles.hint, { color: colors.textTertiary, marginTop: 8 }]}>
                          {t('signupUsername.passwordHint') || 'Use pra entrar pelo email também (IMAP / web). Guarde com carinho.'}
                        </Text>
                      </View>
                    );
                  })()}
                </>
              );
            })()}

            {step === 'name' && (() => {
              const _isFocused = focused === 'name';
              return (
                <View style={{
                  paddingVertical: 6,
                  borderBottomWidth: _isFocused ? 2 : StyleSheet.hairlineWidth,
                  borderBottomColor: _isFocused ? colors.primary : _hairline,
                }}>
                  <TextInput
                    style={[{
                      fontSize: 16, paddingVertical: 14, color: colors.text,
                    }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                    placeholder={t('signupPhone.firstName') || 'Nome'}
                    placeholderTextColor={colors.textTertiary}
                    value={name}
                    onChangeText={(v) => { setName(v); if (error) setError(''); }}
                    autoCapitalize="words"
                    autoFocus
                    maxLength={50}
                    textContentType="name"
                    autoComplete="name"
                    accessibilityLabel={t('signupPhone.firstName') || 'Nome'}
                    returnKeyType="done"
                    onFocus={() => setFocused('name')}
                    onBlur={() => setFocused('')}
                    onSubmitEditing={finishSignup}
                  />
                </View>
              );
            })()}

            {step === 'done' && (() => {
              const _firstName = (name || '').trim().split(/\s+/)[0] || '';
              return (
                <View style={{ alignItems: 'center', marginTop: 24 }}>
                  <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                    <Animated.View style={{
                      position: 'absolute',
                      width: 124, height: 124, borderRadius: 62,
                      backgroundColor: colors.surfaceVariant, // [2026-10-12 auth-polish] B&W, /signup-phone parity
                      opacity: doneScale,
                      transform: [{ scale: doneScale.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
                    }} />
                    <Animated.View style={{
                      width: 96, height: 96, borderRadius: 48,
                      backgroundColor: colors.text,
                      alignItems: 'center', justifyContent: 'center',
                      transform: [{ scale: doneScale }],
                      shadowColor: '#000', shadowOffset: { width: 0, height: 10 },
                      shadowOpacity: 0.25, shadowRadius: 22, elevation: 10,
                      ...(Platform.OS === 'web' ? { boxShadow: '0 14px 32px rgba(0,0,0,0.25)' } : {}),
                    }}>
                      <IconCheck size={52} color={colors.background} strokeWidth={3} />
                    </Animated.View>
                  </View>
                  {!!_firstName && (
                    <Text style={{ fontSize: 24, fontWeight: '800', marginTop: 18, textAlign: 'center', color: colors.text, letterSpacing: -0.4 }}>
                      {(t('signupPhone.welcomeUser', { name: _firstName }) && t('signupPhone.welcomeUser', { name: _firstName }) !== 'signupPhone.welcomeUser')
                        ? t('signupPhone.welcomeUser', { name: _firstName })
                        : `Bem-vindo, ${_firstName}!`}
                    </Text>
                  )}
                  {/* [2026-10-13 consent-lgpd] opções opcionais depois do aceite dos Termos. */}
                  <SignupConsentBlock colors={colors} style={{ marginTop: 28 }} />
                  <TouchableOpacity
                    onPress={() => { try { router.replace('/chat'); } catch {} }}
                    activeOpacity={0.85}
                    style={[styles.cta, { alignSelf: 'stretch', marginTop: 24, backgroundColor: colors.primary }]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.ctaText, { color: colors.onPrimary || '#fff' }]}>{t('onb.doneStart')}</Text>
                    <IconArrowRight size={18} color={colors.onPrimary || '#fff'} style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                </View>
              );
            })()}

            {/* Inline error — iconized + left-aligned for parity with the
                phone-signup flow (was a bare centered line that read like a
                toast). The lucide alert glyph sits beside the field it relates
                to so the failure feels anchored, not floating. */}
            {!!error && step !== 'done' && (
              <View style={{
                flexDirection: 'row', alignItems: 'flex-start', gap: 8,
                marginTop: 12, paddingHorizontal: 2,
              }}>
                <IconAlertTriangle size={15} color={colors.error} style={{ marginTop: 2 }} />
                <Text style={{ color: colors.error, fontSize: 13, lineHeight: 18, flex: 1 }}>
                  {error}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Sticky CTA */}
      {step !== 'done' && (
        <View style={[styles.footer, { borderTopColor: colors.border, paddingBottom: _wideWeb ? 24 : Math.max(Platform.OS === 'ios' ? 30 : 16, insets.bottom + 12) }]}>
          {/* [2026-10-12 auth-polish] this path created accounts with NO terms /
              privacy consent anywhere (the phone path shows it). Same line as
              /signup-phone, shown at the account-creating step. */}
          {step === 'name' && (
            <Text style={{ fontSize: 12, color: colors.textTertiary, textAlign: 'center', marginBottom: 10, lineHeight: 17, paddingHorizontal: 8 }}>
              {t('signupPhone.tosLine') || 'Ao continuar você concorda com os '}
              <Text style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }} accessibilityRole="link" onPress={() => { try { router.push({ pathname: '/legal', params: { doc: 'terms' } }); } catch {} }}>
                {t('signupPhone.tosLink') || 'Termos'}
              </Text>
              {' '}{t('common.and') || 'e'}{' '}
              <Text style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }} accessibilityRole="link" onPress={() => { try { router.push({ pathname: '/legal', params: { doc: 'privacy' } }); } catch {} }}>
                {t('signupPhone.privacyLink') || 'Privacidade'}
              </Text>
              .
            </Text>
          )}
          <TouchableOpacity
            style={[
              styles.cta,
              // [2026-10-12 first-run polish] disabled = neutral fill (login parity).
              _ctaOff ? [{ backgroundColor: colors.border }, styles.ctaFlat] : { backgroundColor: colors.primary, opacity: busy ? 0.85 : 1 },
            ]}
            disabled={busy ||
              (step === 'handle' && (!username || usernameAvailable !== true || !!usernameLocalError(username) || password.length < 8)) ||
              (step === 'name' && (name || '').trim().length < 2)}
            onPress={() => {
              if (step === 'handle') goHandle();
              else if (step === 'name') finishSignup();
            }}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={colors.onPrimary || '#fff'} />
            ) : (
              <>
                <Text style={[styles.ctaText, { color: _ctaOff ? colors.textTertiary : (colors.onPrimary || '#fff') }]}>
                  {step === 'name' ? (t('signupPhone.finish') || 'Criar conta') : (t('onb.continue') || 'Continuar')}
                </Text>
                {step !== 'name' && <IconArrowRight size={18} color={_ctaOff ? colors.textTertiary : (colors.onPrimary || '#fff')} style={{ marginLeft: 8 }} />}
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
      </AuthCardWrap>
    </KeyboardSafeView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // [2026-10-12 auth-polish] wide-web card (login parity)
  wideRoot: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, paddingHorizontal: 16 },
  wideCard: { width: '100%', maxWidth: 520, maxHeight: '100%', borderRadius: 24, borderWidth: 1, overflow: 'hidden', paddingTop: 8 },
  // [2026-10-12 first-run polish] same column / type scale as /signup-phone.
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 56 : androidTopInset(24), paddingBottom: 6, width: '100%', maxWidth: 520, alignSelf: 'center' },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 32, width: '100%', maxWidth: 520, alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: '800', letterSpacing: -0.9, marginBottom: 10, lineHeight: 38 },
  sub: { fontSize: 16, lineHeight: 23, fontWeight: '400' },
  hint: { fontSize: 12, marginTop: 12, lineHeight: 17 },
  // Sticky footer — NOT position:absolute, otherwise on web/Android it
  // anchors to the screen and the keyboard occludes it. KeyboardAvoidingView
  // (padding behavior on iOS) pushes the whole flex column up so the footer
  // floats just above the keyboard naturally.
  footer: {
    width: '100%', maxWidth: 520, alignSelf: 'center',
    paddingHorizontal: 22, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : androidBottomInset(16),
    borderTopWidth: 0,
    backgroundColor: 'transparent',
  },
  cta: {
    height: 50, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 1px 2px rgba(0,0,0,0.10), 0 6px 16px rgba(0,0,0,0.12)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
      },
      ios: { shadowColor: '#000000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.14, shadowRadius: 10 },
      android: { elevation: 2 },
    }),
  },
  ctaFlat: Platform.select({
    web: { boxShadow: 'none', cursor: 'default' },
    ios: { shadowOpacity: 0 },
    android: { elevation: 0 },
    default: {},
  }),
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
});
