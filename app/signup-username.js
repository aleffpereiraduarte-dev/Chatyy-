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

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Animated, Platform, KeyboardAvoidingView, ScrollView, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import useDebouncedCallback from '../hooks/useDebouncedCallback';
import useIsMounted from '../hooks/useIsMounted';
import {
  IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle, IconUser,
  IconAtSign, IconAlertTriangle, IconSparkles, IconLock, IconEye, IconEyeOff,
} from '../components/Icons';

export default function SignupUsername() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { loginWithToken } = useAuth();
  const insets = useSafeAreaInsets();
  const mountedRef = useIsMounted();

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
  const runUsernameCheck = useDebouncedCallback(async (uname) => {
    try {
      const r = await api.checkUsername(uname, 'chatyy.com.br');
      const ok = r && r.success && (r.data?.available !== false);
      setUsernameAvailable(ok);
      setUsernameSuggestions(r?.data?.suggestions || []);
    } catch {
      setUsernameAvailable(null);
    } finally { setUsernameChecking(false); }
  }, 600);

  useEffect(() => {
    if (step !== 'handle' || !username || username.length < 3) {
      setUsernameAvailable(null);
      setUsernameSuggestions([]);
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
      const r = await api.usernameSignup({ username, name: fn, password, domain: 'chatyy.com.br' });
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (!mountedRef.current) return;
        if (lr?.success) {
          goStep('done');
          setTimeout(() => { if (mountedRef.current) try { router.replace('/chat'); } catch {} }, 700);
        } else {
          setError(lr?.message || (t('signupUsername.loginFailed') || 'Falha ao entrar após criar conta'));
        }
      } else {
        setError(r?.message || (t('signupUsername.signupFailed') || 'Falha ao criar conta'));
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

  const _hairline = isDark ? '#2a2d31' : '#e5e7eb';

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header — back button + brand */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (require('react-native').StatusBar.currentHeight || 24) : 44) + 8 }]}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.brand, { color: colors.text }]}>Chatyy</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Segmented progress bar — 2 segments (handle, name) */}
      {step !== 'done' && (
        <View style={{ height: 3, flexDirection: 'row', gap: 2, marginHorizontal: 24, marginTop: 4, marginBottom: 18 }}>
          {(() => {
            const order = ['handle', 'name'];
            const cur = order.indexOf(step);
            return order.map((s, idx) => (
              <View
                key={s}
                style={{
                  flex: 1,
                  height: 3,
                  borderRadius: 2,
                  backgroundColor: idx <= cur ? colors.primary : (isDark ? '#3A3A3A' : '#DBDBDB'),
                }}
              />
            ));
          })()}
        </View>
      )}

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }, { scale: stepScale }], width: '100%' }}>

          {/* Hero orb — same pattern as signup-phone, only on the handle step
              where the user is being introduced to the @ choice. */}
          {step === 'handle' && (
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <Animated.View style={{
                width: 200, height: 200, alignItems: 'center', justifyContent: 'center',
                transform: [{ scale: heroScale }],
              }}>
                <View style={{
                  position: 'absolute', width: 148, height: 148, borderRadius: 74,
                  backgroundColor: `${colors.primary}26`,
                }} />
                <View style={{
                  width: 92, height: 92, borderRadius: 46,
                  backgroundColor: colors.primary,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: colors.primary,
                  shadowOffset: { width: 0, height: 12 },
                  shadowOpacity: 0.42, shadowRadius: 26, elevation: 12,
                  ...(Platform.OS === 'web' ? { boxShadow: `0 14px 36px ${colors.primary}66, inset 0 1px 0 rgba(255,255,255,0.18)` } : {}),
                }}>
                  <Animated.View style={{ opacity: heroIconFade, transform: [{ scale: heroIconFade.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }}>
                    <IconAtSign size={42} color="#fff" />
                  </Animated.View>
                </View>
              </Animated.View>
            </View>
          )}

          {step !== 'done' && (
            <>
              <Text style={[styles.title, { color: colors.text, textAlign: 'center' }]}>{headerTitle}</Text>
              <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>{headerSub}</Text>
            </>
          )}

          <View style={{ marginTop: 24 }}>

            {step === 'handle' && (() => {
              const _isFocused = focused === 'handle';
              const _bottomColor = usernameAvailable === false ? '#ef4444'
                : usernameAvailable === true ? '#22c55e'
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
                    <IconAtSign size={18} color={_isFocused ? colors.primary : colors.textSecondary} />
                    <TextInput
                      style={[{
                        flex: 1, fontSize: 16, paddingVertical: 14, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder="seu.username"
                      placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                      value={username}
                      onChangeText={(v) => setUsername(v.toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 20))}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus
                      maxLength={20}
                      onFocus={() => setFocused('handle')}
                      onBlur={() => setFocused('')}
                    />
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>@chatyy.com.br</Text>
                    {usernameChecking ? (
                      <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 6 }} />
                    ) : usernameAvailable === true ? (
                      <Animated.View style={{ marginLeft: 6, transform: [{ scale: checkScale }] }}>
                        <IconCheckCircle size={18} color="#22c55e" />
                      </Animated.View>
                    ) : usernameAvailable === false ? (
                      <View style={{ marginLeft: 6 }}><IconAlertTriangle size={18} color="#ef4444" /></View>
                    ) : null}
                  </View>

                  {usernameAvailable === false && usernameSuggestions.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                      {usernameSuggestions.slice(0, 4).map(s => (
                        <TouchableOpacity
                          key={s}
                          onPress={() => setUsername(s)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
                            backgroundColor: isDark ? `${colors.primary}2e` : `${colors.primary}1a`,
                            borderWidth: 1, borderColor: isDark ? `${colors.primary}59` : `${colors.primary}3f`,
                          }}
                        >
                          <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '600' }}>{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  <Text style={[styles.hint, { color: colors.textTertiary }]}>
                    {t('signupUsername.hintHandle') || 'Esse vai ser seu email no Chatyy também. Sem SMS, sem telefone.'}
                  </Text>

                  {/* Password — required (mirrors handle step in signup-phone). */}
                  {(() => {
                    const _isFocusedPwd = focused === 'password';
                    const _pwdValid = password.length >= 8;
                    const _bottomColorP = _pwdValid ? '#22c55e' : (_isFocusedPwd ? colors.primary : _hairline);
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
                            placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                            value={password}
                            onChangeText={setPassword}
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
                          >
                            {showPassword ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
                          </TouchableOpacity>
                          {_pwdValid && <IconCheckCircle size={18} color="#22c55e" style={{ marginLeft: 4 }} />}
                        </View>
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
                    placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                    value={name}
                    onChangeText={(v) => { setName(v); if (error) setError(''); }}
                    autoCapitalize="words"
                    autoFocus
                    maxLength={50}
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
                      backgroundColor: 'rgba(34, 197, 94, 0.15)',
                      opacity: doneScale,
                      transform: [{ scale: doneScale.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
                    }} />
                    <Animated.View style={{
                      width: 96, height: 96, borderRadius: 48,
                      backgroundColor: '#22c55e',
                      alignItems: 'center', justifyContent: 'center',
                      transform: [{ scale: doneScale }],
                      shadowColor: '#22c55e', shadowOffset: { width: 0, height: 10 },
                      shadowOpacity: 0.45, shadowRadius: 22, elevation: 12,
                      ...(Platform.OS === 'web' ? { boxShadow: '0 14px 32px rgba(34,197,94,0.45), inset 0 1px 0 rgba(255,255,255,0.25)' } : {}),
                    }}>
                      <IconCheck size={56} color="#fff" strokeWidth={3} />
                    </Animated.View>
                  </View>
                  {!!_firstName && (
                    <Text style={{ fontSize: 24, fontWeight: '800', marginTop: 18, textAlign: 'center', color: colors.text, letterSpacing: -0.4 }}>
                      {(t('signupPhone.welcomeUser', { name: _firstName }) && t('signupPhone.welcomeUser', { name: _firstName }) !== 'signupPhone.welcomeUser')
                        ? t('signupPhone.welcomeUser', { name: _firstName })
                        : `Bem-vindo, ${_firstName}!`}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
                    <IconSparkles size={16} color={colors.primary} />
                    <Text style={{ fontSize: 15, color: colors.textSecondary }}>
                      {t('signupPhone.redirecting') || 'Abrindo seu Chatyy…'}
                    </Text>
                  </View>
                </View>
              );
            })()}

            {!!error && step !== 'done' && (
              <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 12, textAlign: 'center' }}>{error}</Text>
            )}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Sticky CTA */}
      {step !== 'done' && (
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={[
              styles.cta,
              {
                backgroundColor: colors.primary,
                opacity: busy ? 0.7 : (
                  (step === 'handle' && (!username || usernameAvailable !== true || password.length < 8)) ||
                  (step === 'name' && (name || '').trim().length < 2)
                ) ? 0.5 : 1,
              },
            ]}
            disabled={busy ||
              (step === 'handle' && (!username || usernameAvailable !== true || password.length < 8)) ||
              (step === 'name' && (name || '').trim().length < 2)}
            onPress={() => {
              if (step === 'handle') goHandle();
              else if (step === 'name') finishSignup();
            }}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={styles.ctaText}>
                  {step === 'name' ? (t('signupPhone.finish') || 'Criar conta') : (t('common.next') || 'Próximo')}
                </Text>
                {step !== 'name' && <IconArrowRight size={18} color="#fff" style={{ marginLeft: 8 }} />}
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
  scroll: { paddingHorizontal: 22, paddingBottom: 120 },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, marginBottom: 8, lineHeight: 36 },
  sub: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  hint: { fontSize: 12, marginTop: 12, lineHeight: 17 },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 22, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'transparent',
  },
  cta: {
    height: 52, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
