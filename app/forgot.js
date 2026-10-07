import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Animated, Easing, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuthTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { forgotPasswordOptions, forgotPasswordInitiate, forgotPasswordVerify, resetPassword, BASE_URL } from '../services/api';
import OtpInput from '../components/signup/OtpInput';
import PasswordStrength, { calcStrength } from '../components/signup/PasswordStrength';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import {
  IconMailLogo, IconAlertTriangle, IconArrowRight, IconArrowLeft,
  IconMail, IconShield, IconCheckCircle, IconEye, IconEyeOff, IconSend, IconLock,
  IconSun, IconMoon, IconSmartphone,
} from '../components/Icons';
// [2026-10-07 login-ux] shared auth-screen pieces (keyboard-aware scroll,
// inline notices, haptics, identifier normalisation, last-identifier prefill).
import LoginKeyboardScroll from '../components/login/LoginKeyboardScroll';
import LoginNotice from '../components/login/LoginNotice';
import { normalizeLoginEmail, isPlausibleEmail, saveLastIdentifier } from '../components/login/loginSmart';
import { tap as hTap, success as hSuccess, error as hError, selection as hSelection } from '../services/haptics';

export default function ForgotPassword() {
  const { colors, isDark, toggle } = useAuthTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const [showHelp, setShowHelp] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  // Steps: 1=email, 2=choose method, 3=verify code, 4=new password, 5=success
  // ?find=1 (login "Não lembra seu e-mail?") opens straight on the finder.
  const [step, setStep] = useState(() => (String(params?.find || '') === '1' ? 6 : 1));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 1
  // ?email= from the login password step → prefilled (no retyping).
  const [username, setUsername] = useState(() => {
    try {
      const pre = typeof params?.email === 'string' ? params.email : (Array.isArray(params?.email) ? params.email[0] : '');
      return pre ? String(pre).replace(/\s+/g, '').toLowerCase() : '';
    } catch { return ''; }
  });
  const [domain, setDomain] = useState('chatyy.com.br');
  const [findQuery, setFindQuery] = useState('');
  const [foundEmails, setFoundEmails] = useState([]);
  const [focused, setFocused] = useState('');

  // Step 2: method selection
  const [methods, setMethods] = useState([]);
  const [phoneMasked, setPhoneMasked] = useState('');
  const [emailMasked, setEmailMasked] = useState('');
  const [selectedMethod, setSelectedMethod] = useState('');

  // Step 3: verify
  const [code, setCode] = useState('');
  const [maskedTarget, setMaskedTarget] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef(null);

  // Step 4
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(12)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(12);
    // Telegram-style ease-out-quint — same curve we use in signup-phone for
    // step transitions. Springs felt slightly bouncy on auth screens; users
    // expect form transitions to settle deterministically.
    const EASE = Easing.bezier(0.23, 1, 0.32, 1);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 260, easing: EASE, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 260, easing: EASE, useNativeDriver: true }),
    ]).start();
  }, [step]);

  useEffect(() => {
    if (step === 5) {
      Animated.spring(successAnim, { toValue: 1, tension: 50, friction: 8, useNativeDriver: true }).start();
    }
  }, [step]);

  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timerRef.current);
  }, [countdown]);

  // [2026-10-07 login-ux] BUG FIX: was always `${username}@${domain}` — the
  // field accepts a FULL address of any domain (Apple 2.1a fix), so typing
  // "ana@gmail.com" asked the server about "ana@gmail.com@chatyy.com.br" and
  // recovery could never find the account.
  const fullEmail = String(username || '').includes('@')
    ? normalizeLoginEmail(username)
    : normalizeLoginEmail(`${String(username || '').replace(/^@/, '')}@${domain}`);

  // Haptic on every new inline error (was silent).
  useEffect(() => { if (error) hError(); }, [error]);
  const goBackToLogin = () => {
    hSelection();
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    router.replace('/login');
  };

  // Step 1: Get recovery options
  const handleGetOptions = async () => {
    if (!username.trim()) { setError(t('forgot.validation.usernameRequired')); return; }
    if (!isPlausibleEmail(fullEmail)) { setError(t('login.errorEmailInvalid')); return; }
    hTap('light');
    setError('');
    setLoading(true);
    try {
      const r = await forgotPasswordOptions(fullEmail);
      if (r.success) {
        const m = r.data?.methods || [];
        setMethods(m);
        setPhoneMasked(r.data?.phone_masked || '');
        setEmailMasked(r.data?.email_masked || '');
        if (m.length === 0) {
          // No methods available
          setStep(2);
        } else if (m.length === 1) {
          // Only one method, auto-select and go to initiate
          setSelectedMethod(m[0]);
          setStep(2);
        } else {
          // Multiple methods, let user choose
          setStep(2);
        }
      } else {
        setError(r.message || t('forgot.validation.initiateError'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // Find email by phone or name (Google-style "Forgot email?")
  const handleFindEmail = async () => {
    if (!findQuery.trim() || findQuery.trim().length < 3) { setError(t('forgot.findMinChars')); return; }
    hTap('light');
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/email.php?action=find_account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: findQuery.trim() }),
      });
      const data = await res.json();
      if (data?.success) {
        setFoundEmails((data.data?.accounts || []).map(a => ({
          email: a.email,
          name: a.name,
          match: a.match,
        })));
      } else {
        setError(data?.message || t('forgot.findError'));
        setFoundEmails([]);
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // Step 2: Initiate with selected method
  const handleSelectMethod = async (method) => {
    setSelectedMethod(method);
    setError('');
    setLoading(true);
    try {
      const r = await forgotPasswordInitiate(fullEmail, method);
      if (r.success) {
        if (method === 'phone') {
          setMaskedTarget(r.data?.masked_phone || phoneMasked);
        } else {
          setMaskedTarget(r.data?.masked_email || emailMasked);
        }
        setStep(3);
        setCountdown(60);
      } else {
        setError(r.message || t('forgot.validation.initiateError'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // Step 3: Verify code
  const handleVerify = async (codeToVerify) => {
    const c = codeToVerify || code;
    if (c.length < 6) { setError(t('forgot.validation.codeLength')); return; }
    setError('');
    setLoading(true);
    try {
      const r = await forgotPasswordVerify(fullEmail, c);
      if (r.success) {
        setResetToken(r.data?.reset_token || '');
        setStep(4);
      } else {
        setError(r.message || t('forgot.validation.invalidCode'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  const handleCodeChange = (newCode) => {
    setCode(newCode);
    if (newCode.length === 6 && !loading) {
      setTimeout(() => handleVerify(newCode), 300);
    }
  };

  const handleResend = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await forgotPasswordInitiate(fullEmail, selectedMethod);
      if (r.success) {
        setCountdown(60);
        setCode('');
      } else {
        setError(r.message || t('forgot.validation.resendError'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // Step 4: Reset password
  const handleReset = async () => {
    if (!newPwd) { setError(t('forgot.validation.passwordRequired')); return; }
    if (newPwd.length < 8) { setError(t('forgot.validation.passwordMinLength')); return; }
    if (!confirmPwd) { setError(t('forgot.validation.confirmRequired')); return; }
    if (newPwd !== confirmPwd) { setError(t('forgot.validation.passwordsMismatch')); return; }
    setError('');
    setLoading(true);
    try {
      const r = await resetPassword(fullEmail, resetToken, newPwd);
      if (r.success) {
        hSuccess();
        // The login screen will open with this account prefilled.
        saveLastIdentifier(fullEmail);
        setStep(5);
      } else {
        setError(r.message || t('forgot.validation.resetError'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  const inputBoxStyle = (name) => [
    s.inputBox,
    {
      backgroundColor: colors.authInputBg,
      borderColor: focused === name ? colors.authInputFocusBorder : colors.authInputBorder,
    },
    focused === name && {
      borderWidth: 2,
      ...Platform.select({ web: { boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}` }, default: {} }),
    },
  ];

  const entryScale = fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });

  // [2026-10-07 login-ux] Same inline notice as the login (a11y live region).
  const renderError = () => !!error && (
    <LoginNotice tone="error" text={error} colors={colors} style={{ marginBottom: 16 }} />
  );

  const renderContent = () => {
    // Step 1: Enter email
    if (step === 1) return (
      <>
        {renderError()}
        <View style={s.hintRow}>
          <IconShield size={16} color={colors.textTertiary} />
          <Text style={[s.hintText, { color: colors.textTertiary }]}>
            {t('forgot.hint')}
          </Text>
        </View>

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.emailLabel')}</Text>
        <View style={inputBoxStyle('username')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={username}
            onChangeText={(val) => {
              // Accept a FULL email of ANY domain, or a bare username — never
              // strip what the user typed. (Apple review 2.1a, 2026-06-03: the
              // old regex deleted everything after "@", so reviewers literally
              // could not type a non-chatyy email like apitest@onemundo.com.br.)
              setUsername((val || '').replace(/\s+/g, ''));
              if (error) setError('');
            }}
            placeholder="nome@chatyy.com.br"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            keyboardType="email-address"
            textContentType="username"
            autoComplete="username"
            importantForAutofill="yes"
            accessibilityLabel={t('forgot.emailLabel')}
            autoFocus={!username}
            returnKeyType="go"
            onSubmitEditing={() => { if (username && !loading) handleGetOptions(); }}
            onFocus={() => setFocused('username')}
            onBlur={() => setFocused('')}
          />
        </View>

        <View style={s.btnCol}>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleGetOptions}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.continue')}</Text>
                <IconArrowRight size={15} color="#fff" style={{ marginLeft: 6 }} />
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={() => setStep(6)} activeOpacity={0.6}>
            <Text style={[s.backText, { color: colors.primary }]}>{t('forgot.forgotEmail') || 'Esqueceu o email?'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={goBackToLogin} activeOpacity={0.6} accessibilityRole="button">
            <Text style={[s.backText, { color: colors.textSecondary }]}>{t('forgot.backToLogin')}</Text>
          </TouchableOpacity>
        </View>
      </>
    );

    // Step 6: Find email by phone or name (Google-style)
    if (step === 6) return (
      <>
        {renderError()}
        <View style={s.hintRow}>
          <IconShield size={16} color={colors.textTertiary} />
          <Text style={[s.hintText, { color: colors.textTertiary }]}>
            {t('forgot.findHint')}
          </Text>
        </View>

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.findLabel')}</Text>
        <View style={inputBoxStyle('findEmail')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={findQuery}
            onChangeText={(v) => { setFindQuery(v); if (error) setError(''); }}
            placeholder={t('forgot.findPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => { if (!loading && findQuery.trim()) handleFindEmail(); }}
            accessibilityLabel={t('forgot.findLabel')}
            autoFocus
            onFocus={() => setFocused('findEmail')}
            onBlur={() => setFocused('')}
          />
        </View>

        {foundEmails.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.foundAccounts')}</Text>
            {foundEmails.map((acc, i) => (
              <TouchableOpacity
                key={i}
                style={[s.methodCard, { backgroundColor: colors.authInputBg, borderColor: colors.authInputBorder }]}
                onPress={() => {
                  const parts = acc.email.split('@');
                  setUsername(parts[0]);
                  setDomain(parts[1] || 'chatyy.com.br');
                  setFoundEmails([]);
                  setFindQuery('');
                  setStep(1);
                }}
                activeOpacity={0.7}
              >
                <View style={[s.methodIconWrap, { backgroundColor: colors.primary + '15' }]}>
                  <IconMail size={18} color={colors.primary} />
                </View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>{acc.name || acc.email.split('@')[0]}</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>{acc.email}</Text>
                </View>
                <IconArrowRight size={14} color={colors.textTertiary} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {findQuery.length > 0 && foundEmails.length === 0 && !loading && (
          <Text style={{ color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 12 }}>
            {t('forgot.noAccountsFound')}
          </Text>
        )}

        <View style={s.btnCol}>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleFindEmail}
            disabled={loading || !findQuery.trim()}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.findCta')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={() => { setStep(1); setFindQuery(''); setFoundEmails([]); }} activeOpacity={0.6}>
            <Text style={[s.backText, { color: colors.primary }]}>{t('forgot.back')}</Text>
          </TouchableOpacity>
        </View>
      </>
    );

    // Step 2: Choose verification method
    if (step === 2) return (
      <>
        {renderError()}

        {methods.length === 0 ? (
          // No recovery methods available
          <View style={s.noMethodsBox}>
            <View style={[s.noMethodsIcon, { backgroundColor: colors.error + '12' }]}>
              <IconAlertTriangle size={36} color={colors.error} />
            </View>
            <Text style={[s.noMethodsTitle, { color: colors.text }]}>{t('forgot.noMethods')}</Text>
            <Text style={[s.noMethodsDesc, { color: colors.textSecondary }]}>{t('forgot.contactSupport')}</Text>
            <TouchableOpacity
              style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary, marginTop: 20, width: '100%' }]}
              onPress={() => {
                if (Platform.OS === 'web') {
                  window.open('mailto:suporte@chatyy.com.br', '_blank');
                } else {
                  Linking.openURL('mailto:suporte@chatyy.com.br').catch(() => {});
                }
              }}
              activeOpacity={0.85}
            >
              <IconMail size={16} color="#fff" style={{ marginRight: 8 }} />
              <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.contactSupportBtn')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Show available methods
          <View style={s.methodsList}>
            {methods.includes('phone') && (
              <TouchableOpacity
                style={[s.methodCard, {
                  backgroundColor: colors.authInputBg,
                  borderColor: colors.authInputBorder,
                }]}
                onPress={() => handleSelectMethod('phone')}
                disabled={loading}
                activeOpacity={0.7}
              >
                <View style={[s.methodIconWrap, { backgroundColor: colors.authSuccessGreen + '15' }]}>
                  <IconSmartphone size={22} color={colors.authSuccessGreen} />
                </View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>{t('forgot.methodPhone')}</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>
                    {t('forgot.methodPhoneTo', { phone: phoneMasked })}
                  </Text>
                </View>
                {loading && selectedMethod === 'phone' ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <IconArrowRight size={16} color={colors.textTertiary} />
                )}
              </TouchableOpacity>
            )}

            {methods.includes('email') && (
              <TouchableOpacity
                style={[s.methodCard, {
                  backgroundColor: colors.authInputBg,
                  borderColor: colors.authInputBorder,
                }]}
                onPress={() => handleSelectMethod('email')}
                disabled={loading}
                activeOpacity={0.7}
              >
                <View style={[s.methodIconWrap, { backgroundColor: colors.primary + '15' }]}>
                  <IconMail size={22} color={colors.primary} />
                </View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>{t('forgot.methodEmail')}</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>
                    {t('forgot.methodEmailTo', { email: emailMasked })}
                  </Text>
                </View>
                {loading && selectedMethod === 'email' ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <IconArrowRight size={16} color={colors.textTertiary} />
                )}
              </TouchableOpacity>
            )}

            {methods.includes('self_email') && (
              <TouchableOpacity
                style={[s.methodCard, {
                  backgroundColor: colors.authInputBg,
                  borderColor: colors.authInputBorder,
                }]}
                onPress={() => handleSelectMethod('self_email')}
                disabled={loading}
                activeOpacity={0.7}
              >
                <View style={[s.methodIconWrap, { backgroundColor: colors.brandSecondary + '15' }]}>
                  <IconMail size={22} color={colors.brandSecondary} />
                </View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>{t('forgot.methodSelfEmail')}</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>
                    {t('forgot.methodSelfEmailTo', { email: emailMasked })}
                  </Text>
                </View>
                {loading && selectedMethod === 'self_email' ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <IconArrowRight size={16} color={colors.textTertiary} />
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        <TouchableOpacity style={s.backBtn} onPress={() => { setStep(1); setError(''); setMethods([]); }} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('forgot.back')}</Text>
        </TouchableOpacity>
      </>
    );

    // Step 3: Verify code
    if (step === 3) return (
      <>
        {renderError()}
        <View style={[s.sentBox, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
          <View style={[s.sentIconWrap, { backgroundColor: (selectedMethod === 'phone' ? colors.authSuccessGreen : colors.primary) + '12' }]}>
            {selectedMethod === 'phone' ? (
              <IconSmartphone size={18} color={colors.authSuccessGreen} />
            ) : (
              <IconSend size={18} color={colors.primary} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.sentTitle, { color: colors.text }]}>
              {selectedMethod === 'phone' ? t('forgot.smsSent') : t('forgot.codeSent')}
            </Text>
            <Text style={[s.sentText, { color: colors.textSecondary }]}>{maskedTarget}</Text>
          </View>
        </View>

        {selectedMethod === 'email' && (
          <TouchableOpacity
            style={[s.openEmailBtn, { borderColor: colors.primary + '40', backgroundColor: colors.primary + '08' }]}
            onPress={() => {
              if (Platform.OS === 'web') {
                const emailDomain = maskedTarget.match(/@([^.]+)/)?.[1]?.toLowerCase();
                const urlMap = { gmail: 'https://mail.google.com', outlook: 'https://outlook.live.com', hotmail: 'https://outlook.live.com', yahoo: 'https://mail.yahoo.com' };
                const url = urlMap[emailDomain] || 'mailto:';
                window.open(url, '_blank');
              } else {
                Linking.openURL('mailto:').catch(() => {});
              }
            }}
            activeOpacity={0.7}
          >
            <IconMail size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.openEmailText, { color: colors.primary }]}>{t('forgot.openEmail')}</Text>
          </TouchableOpacity>
        )}

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.enterCode')}</Text>
        <OtpInput value={code} onChange={handleCodeChange} />

        <TouchableOpacity
          style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary, marginTop: 22 }, loading && { opacity: 0.65 }]}
          onPress={() => handleVerify()}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? <ActivityIndicator color="#fff" size="small" /> : (
            <>
              <IconCheckCircle size={16} color="#fff" style={{ marginRight: 8 }} />
              <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.verifyCode')}</Text>
            </>
          )}
        </TouchableOpacity>

        {countdown > 0 ? (
          <Text style={[s.countdownText, { color: colors.textTertiary }]}>
            {t('forgot.resendIn', { time: `${Math.floor(countdown / 60)}:${(countdown % 60).toString().padStart(2, '0')}` })}
          </Text>
        ) : (
          <TouchableOpacity style={s.resendBtn} onPress={handleResend} activeOpacity={0.6}>
            <Text style={[s.resendText, { color: colors.primary }]}>{t('forgot.resendCode')}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={s.backBtn} onPress={() => { setStep(2); setCode(''); setError(''); }} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('forgot.back')}</Text>
        </TouchableOpacity>
      </>
    );

    // Step 4: New password
    if (step === 4) return (
      <>
        {renderError()}

        {/* Keychain anchor: lets iOS / password managers attach the NEW
            password to THIS account (invisible, not focusable). */}
        <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
          <TextInput
            value={fullEmail}
            editable
            textContentType="username"
            autoComplete="username"
            importantForAutofill="yes"
            autoCapitalize="none"
            {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
            style={{ width: 1, height: 1 }}
          />
        </View>

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.newPassword')}</Text>
        <View style={inputBoxStyle('newPwd')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={newPwd}
            onChangeText={(v) => { setNewPwd(v); if (error) setError(''); }}
            placeholder={t('forgot.newPasswordPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry={!showPwd}
            // iOS strong-password suggestion + Keychain update; Android/web
            // password managers offer to save the NEW password.
            textContentType="newPassword"
            autoComplete={Platform.OS === 'android' ? 'password-new' : 'new-password'}
            passwordRules="minlength: 8;"
            importantForAutofill="yes"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            accessibilityLabel={t('forgot.newPassword')}
            autoFocus
            onFocus={() => setFocused('newPwd')}
            onBlur={() => setFocused('')}
          />
          <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPwd(!showPwd)} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={showPwd ? t('login.hidePassword') : t('login.showPassword')}>
            {showPwd ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
          </TouchableOpacity>
        </View>

        <PasswordStrength password={newPwd} />

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.confirmNewPassword')}</Text>
        <View style={inputBoxStyle('confirmPwd')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={confirmPwd}
            onChangeText={(v) => { setConfirmPwd(v); if (error) setError(''); }}
            placeholder={t('forgot.repeatPassword')}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry={!showConfirm}
            textContentType="newPassword"
            autoComplete={Platform.OS === 'android' ? 'password-new' : 'new-password'}
            importantForAutofill="yes"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => { if (!loading) handleReset(); }}
            accessibilityLabel={t('forgot.confirmNewPassword')}
            onFocus={() => setFocused('confirmPwd')}
            onBlur={() => setFocused('')}
          />
          <TouchableOpacity style={s.eyeBtn} onPress={() => setShowConfirm(!showConfirm)} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={showConfirm ? t('login.hidePassword') : t('login.showPassword')}>
            {showConfirm ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
          </TouchableOpacity>
        </View>

        {confirmPwd && newPwd !== confirmPwd && (
          <View style={s.matchRow}>
            <IconAlertTriangle size={13} color={colors.error} />
            <Text style={[s.matchText, { color: colors.error }]}>{t('forgot.passwordsMismatch')}</Text>
          </View>
        )}
        {confirmPwd && newPwd === confirmPwd && confirmPwd.length >= 8 && (
          <View style={s.matchRow}>
            <IconCheckCircle size={13} color={colors.authSuccessGreen} />
            <Text style={[s.matchText, { color: colors.authSuccessGreen, fontWeight: '700' }]}>{t('forgot.passwordsMatch')}</Text>
          </View>
        )}

        <View style={s.btnCol}>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleReset}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <IconLock size={16} color="#fff" style={{ marginRight: 8 }} />
                <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.changePassword')}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </>
    );

    // Step 5: Success
    if (step === 5) {
      const scale = successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
      return (
        <Animated.View style={[s.successBox, { opacity: successAnim, transform: [{ scale }] }]}>
          <View style={[s.successIcon, { backgroundColor: colors.authSuccessGreen + '12' }]}>
            <IconCheckCircle size={52} color={colors.authSuccessGreen} />
          </View>
          <Text style={[s.successTitle, { color: colors.authSuccessGreen }]}>{t('forgot.passwordChanged')}</Text>
          <Text style={[s.successSub, { color: colors.textSecondary }]}>{t('forgot.passwordChangedDesc')}</Text>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary, shadowColor: colors.primary, marginTop: 24, width: '100%' }]}
            onPress={() => router.replace('/login')}
            activeOpacity={0.85}
          >
            <Text style={[s.primaryBtnText, { color: colors.onPrimary }]}>{t('forgot.goToLogin')}</Text>
          </TouchableOpacity>
        </Animated.View>
      );
    }
  };

  const TITLES = {
    1: { title: t('forgot.title'), subtitle: t('forgot.subtitle') },
    2: { title: methods.length > 0 ? t('forgot.chooseMethodTitle') : t('forgot.title'), subtitle: methods.length > 0 ? t('forgot.chooseMethodSubtitle') : '' },
    3: { title: t('forgot.verifyTitle'), subtitle: selectedMethod === 'phone' ? t('forgot.verifySubtitlePhone') : t('forgot.verifySubtitle') },
    4: { title: t('forgot.newPasswordTitle'), subtitle: t('forgot.newPasswordSubtitle') },
    5: { title: '', subtitle: '' },
    // Step 6 = "find email by phone/name". Reachable via the "Esqueceu o
    // email?" link on step 1. Without this entry the screen renders with
    // empty title/subtitle (broken state).
    6: { title: t('forgot.titleNoEmail') || 'Esqueceu o email?', subtitle: t('forgot.subNoEmail') || 'Digite seu telefone ou nome completo para encontrarmos sua conta.' },
  };

  return (
    <View style={[s.outerRoot, { backgroundColor: colors.authBg }]}>
      {/* Decorative background */}
      <View style={s.bgDecor} pointerEvents="none">
        <View style={[s.bgCircle1, { backgroundColor: colors.primary + '08' }]} />
        <View style={[s.bgCircle2, { backgroundColor: colors.primary + '05' }]} />
        <View style={[s.bgCircle3, { backgroundColor: (colors.authSuccessGreen || '#10b981') + '06' }]} />
      </View>

      {/* Theme toggle */}
      <TouchableOpacity onPress={toggle} style={[s.themeToggle, { top: insets.top + 16 }]} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={isDark ? t('a11y.switchToLight') : t('a11y.switchToDark')}>
        <View style={[s.themeBtn, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : colors.surface,
          borderColor: colors.authInputBorder,
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          } : {
            shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
          }),
        }]}>
          {isDark ? <IconSun size={16} color={colors.warning} /> : <IconMoon size={16} color={colors.textSecondary} />}
        </View>
      </TouchableOpacity>

    <LoginKeyboardScroll
      contentContainerStyle={s.scroll}
      bottomOffset={96}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
        <View style={[s.center, { paddingBottom: 48 + insets.bottom }]}>
          <Animated.View style={[s.cardWrap, { opacity: fadeAnim, transform: [{ scale: entryScale }, { translateY: slideAnim }] }]}>
            <View style={[s.card, {
              backgroundColor: colors.authCardBg,
              ...(Platform.OS === 'web' ? {
                boxShadow: isDark
                  ? '0 2px 8px rgba(0,0,0,0.35), 0 8px 32px rgba(0,0,0,0.2)'
                  : '0 1px 3px rgba(0,0,0,0.04), 0 4px 24px rgba(0,0,0,0.08)',
              } : {
                shadowColor: colors.shadow,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: isDark ? 0.3 : 0.12,
                shadowRadius: 24,
                elevation: 8,
              }),
              borderColor: isDark ? colors.authCardBorder : 'transparent',
              borderWidth: isDark ? 1 : 0,
            }]}>
              {/* Icon with glow */}
              <View style={s.iconRow}>
                <View style={s.iconWrap}>
                  <View style={[s.iconGlow, { backgroundColor: colors.primary + '0a' }]} />
                  <View style={[s.iconCircle, {
                    backgroundColor: isDark ? colors.primary + '15' : colors.primary + '08',
                  }]}>
                    <IconMailLogo size={26} color={colors.primary} />
                  </View>
                </View>
              </View>

              {/* Title */}
              {!!TITLES[step]?.title && <Text style={[s.title, { color: colors.text }]}>{TITLES[step].title}</Text>}
              {!!TITLES[step]?.subtitle && <Text style={[s.subtitle, { color: colors.textSecondary }]}>{TITLES[step].subtitle}</Text>}

              {renderContent()}
            </View>

            {/* Footer */}
            <View style={s.footer}>
              <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('forgot.footerLanguage')}</Text>
              <View style={s.footerLinks}>
                <TouchableOpacity onPress={() => setShowHelp(true)}><Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('forgot.help')}</Text></TouchableOpacity>
                <Text style={[s.footerDot, { color: colors.authFooterText }]}> · </Text>
                <TouchableOpacity onPress={() => setShowPrivacy(true)}><Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('forgot.privacy')}</Text></TouchableOpacity>
                <Text style={[s.footerDot, { color: colors.authFooterText }]}> · </Text>
                <TouchableOpacity onPress={() => setShowTerms(true)}><Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('forgot.terms')}</Text></TouchableOpacity>
              </View>
            </View>
            <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} />
            <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
            <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />
          </Animated.View>
        </View>
    </LoginKeyboardScroll>
    </View>
  );
}

const s = StyleSheet.create({
  outerRoot: { flex: 1, overflow: 'hidden' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },

  /* Decorative background */
  bgDecor: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0,
    overflow: 'hidden',
  },
  bgCircle1: {
    position: 'absolute', width: 400, height: 400, borderRadius: 200,
    top: -120, right: -100,
  },
  bgCircle2: {
    position: 'absolute', width: 300, height: 300, borderRadius: 150,
    bottom: -60, left: -80,
  },
  bgCircle3: {
    position: 'absolute', width: 200, height: 200, borderRadius: 100,
    top: '40%', left: '60%',
  },

  /* Theme toggle */
  themeToggle: { position: 'absolute', top: 16, right: 16, zIndex: 10 },
  themeBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },

  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 48, minHeight: '100%',
    zIndex: 1,
  },
  cardWrap: { width: '100%', maxWidth: 448 },
  card: {
    borderRadius: 16, paddingHorizontal: 28, paddingTop: 28, paddingBottom: 24, width: '100%',
  },

  iconRow: { alignItems: 'center', marginBottom: 10 },
  iconWrap: { alignItems: 'center', justifyContent: 'center' },
  iconGlow: {
    position: 'absolute', width: 56, height: 56, borderRadius: 28,
  },
  iconCircle: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 2, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, textAlign: 'center', marginBottom: 14, lineHeight: 18 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },

  hintRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 8 },
  hintText: { fontSize: 13, lineHeight: 19, flex: 1 },

  label: { fontSize: 11, fontWeight: '500', marginBottom: 4, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  inputBox: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44,
    borderWidth: 1, borderRadius: 8,
    ...Platform.select({ web: { transition: 'all 0.2s ease' }, default: {} }),
  },
  textInput: {
    flex: 1, fontSize: 14, paddingVertical: Platform.OS === 'web' ? 12 : 11,
    paddingHorizontal: 14,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  inputSuffix: { fontSize: 13, fontWeight: '500', paddingRight: 16 },
  eyeBtn: { padding: 8, marginRight: 4 },

  btnCol: { marginTop: 16 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, paddingVertical: 12,
    ...Platform.select({
      web: {
        cursor: 'pointer', transition: 'all 0.2s ease',
        boxShadow: '0 8px 22px rgba(17,17,17,0.35), 0 2px 6px rgba(17,17,17,0.20)',
      },
      default: {
        shadowColor: '#111111', shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.35, shadowRadius: 10, elevation: 6,
      },
    }),
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  backBtn: { paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  backText: { fontSize: 14, fontWeight: '600' },

  // Method selection cards (Step 2)
  methodsList: { gap: 12, marginTop: 4 },
  methodCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 10, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s ease' }, default: {} }),
  },
  methodIconWrap: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  methodInfo: { flex: 1 },
  methodTitle: { fontSize: 14, fontWeight: '600', marginBottom: 1 },
  methodDesc: { fontSize: 11 },

  // No methods available
  noMethodsBox: { alignItems: 'center', paddingVertical: 16 },
  noMethodsIcon: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  noMethodsTitle: { fontSize: 15, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  noMethodsDesc: { fontSize: 13, textAlign: 'center', lineHeight: 19 },

  sentBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 16, borderRadius: 14, marginBottom: 8, borderWidth: 1,
  },
  sentIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  sentTitle: { fontSize: 14, fontWeight: '700' },
  sentText: { fontSize: 12, marginTop: 2 },
  openEmailBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: 12, paddingVertical: 10, marginTop: 12, marginBottom: 4,
  },
  openEmailText: { fontSize: 14, fontWeight: '600' },

  countdownText: { textAlign: 'center', fontSize: 13, marginTop: 16, fontWeight: '500' },
  resendBtn: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  resendText: { fontSize: 14, fontWeight: '600' },

  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  matchText: { fontSize: 12, fontWeight: '500' },

  successBox: { alignItems: 'center', padding: 24 },
  successIcon: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  successTitle: { fontSize: 20, fontWeight: '700', marginBottom: 6 },
  successSub: { fontSize: 13, marginBottom: 0 },

  footer: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 24, paddingHorizontal: 8,
  },
  footerLinks: { flexDirection: 'row', alignItems: 'center' },
  footerItem: { fontSize: 12 },
  footerDot: { fontSize: 12 },
});
