import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Animated, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { forgotPasswordOptions, forgotPasswordInitiate, forgotPasswordVerify, resetPassword } from '../services/api';
import OtpInput from '../components/signup/OtpInput';
import PasswordStrength, { calcStrength } from '../components/signup/PasswordStrength';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import {
  IconMailLogo, IconAlertTriangle, IconArrowRight, IconArrowLeft,
  IconMail, IconShield, IconCheckCircle, IconEye, IconEyeOff, IconSend, IconLock,
  IconSun, IconMoon, IconSmartphone,
} from '../components/Icons';

export default function ForgotPassword() {
  const { colors, isDark, toggle } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  // Steps: 1=email, 2=choose method, 3=verify code, 4=new password, 5=success
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 1
  const [username, setUsername] = useState('');
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
    Animated.parallel([
      Animated.spring(fadeAnim, { toValue: 1, tension: 60, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
      Animated.spring(slideAnim, { toValue: 0, tension: 60, friction: 12, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  }, [step]);

  useEffect(() => {
    if (step === 5) {
      Animated.spring(successAnim, { toValue: 1, tension: 50, friction: 8, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [step]);

  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timerRef.current);
  }, [countdown]);

  const fullEmail = `${username}@${domain}`;

  // Step 1: Get recovery options
  const handleGetOptions = async () => {
    if (!username.trim()) { setError(t('forgot.validation.usernameRequired')); return; }
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
    if (!findQuery.trim() || findQuery.trim().length < 3) { setError('Digite pelo menos 3 caracteres'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('https://chatyy.com.br/api/email.php?action=find_account', {
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
        setError(data?.message || 'Erro ao buscar');
        setFoundEmails([]);
      }
    } catch { setError('Erro de conexao'); }
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

  const renderError = () => !!error && (
    <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
      <IconAlertTriangle size={15} color={colors.error} />
      <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
    </View>
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

        <Text style={[s.label, { color: colors.authLabelColor }]}>Email</Text>
        <View style={inputBoxStyle('username')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={username}
            onChangeText={(t) => {
              // Allow full email input (strip @domain if typed)
              const clean = t.replace(`@${domain}`, '').replace(/@.*$/, '');
              setUsername(clean);
            }}
            placeholder="nome@chatyy.com.br"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoFocus
            onFocus={() => setFocused('username')}
            onBlur={() => setFocused('')}
          />
        </View>

        <View style={s.btnCol}>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleGetOptions}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <Text style={s.primaryBtnText}>{t('forgot.continue')}</Text>
                <IconArrowRight size={15} color="#fff" style={{ marginLeft: 6 }} />
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={() => setStep(6)} activeOpacity={0.6}>
            <Text style={[s.backText, { color: colors.primary }]}>Esqueceu o email?</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={() => router.push('/login')} activeOpacity={0.6}>
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
            Digite seu telefone ou nome completo para encontrar sua conta
          </Text>
        </View>

        <Text style={[s.label, { color: colors.authLabelColor }]}>Telefone ou nome</Text>
        <View style={inputBoxStyle('findEmail')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={findQuery}
            onChangeText={setFindQuery}
            placeholder="(11) 99999-9999 ou Nome Completo"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="words"
            autoFocus
            onFocus={() => setFocused('findEmail')}
            onBlur={() => setFocused('')}
          />
        </View>

        {foundEmails.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={[s.label, { color: colors.authLabelColor }]}>Contas encontradas</Text>
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
            Nenhuma conta encontrada. Verifique o telefone ou nome.
          </Text>
        )}

        <View style={s.btnCol}>
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleFindEmail}
            disabled={loading || !findQuery.trim()}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <Text style={s.primaryBtnText}>Buscar conta</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.backBtn} onPress={() => { setStep(1); setFindQuery(''); setFoundEmails([]); }} activeOpacity={0.6}>
            <Text style={[s.backText, { color: colors.primary }]}>Voltar</Text>
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
              style={[s.primaryBtn, { backgroundColor: colors.primary, marginTop: 20, width: '100%' }]}
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
              <Text style={s.primaryBtnText}>{t('forgot.contactSupportBtn')}</Text>
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
                <View style={[s.methodIconWrap, { backgroundColor: '#10b981' + '15' }]}>
                  <IconSmartphone size={22} color="#10b981" />
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
                <View style={[s.methodIconWrap, { backgroundColor: '#6366f1' + '15' }]}>
                  <IconMail size={22} color="#6366f1" />
                </View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>Email Chatyy</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>
                    Enviar codigo para {emailMasked}
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
          <View style={[s.sentIconWrap, { backgroundColor: (selectedMethod === 'phone' ? '#10b981' : colors.primary) + '12' }]}>
            {selectedMethod === 'phone' ? (
              <IconSmartphone size={18} color="#10b981" />
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
          style={[s.primaryBtn, { backgroundColor: colors.primary, marginTop: 22 }, loading && { opacity: 0.65 }]}
          onPress={() => handleVerify()}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? <ActivityIndicator color="#fff" size="small" /> : (
            <>
              <IconCheckCircle size={16} color="#fff" style={{ marginRight: 8 }} />
              <Text style={s.primaryBtnText}>{t('forgot.verifyCode')}</Text>
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

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.newPassword')}</Text>
        <View style={inputBoxStyle('newPwd')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={newPwd}
            onChangeText={setNewPwd}
            placeholder={t('forgot.newPasswordPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry={!showPwd}
            autoFocus
            onFocus={() => setFocused('newPwd')}
            onBlur={() => setFocused('')}
          />
          <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPwd(!showPwd)} activeOpacity={0.6}>
            {showPwd ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
          </TouchableOpacity>
        </View>

        <PasswordStrength password={newPwd} />

        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.confirmNewPassword')}</Text>
        <View style={inputBoxStyle('confirmPwd')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={confirmPwd}
            onChangeText={setConfirmPwd}
            placeholder={t('forgot.repeatPassword')}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry={!showConfirm}
            onFocus={() => setFocused('confirmPwd')}
            onBlur={() => setFocused('')}
          />
          <TouchableOpacity style={s.eyeBtn} onPress={() => setShowConfirm(!showConfirm)} activeOpacity={0.6}>
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
            style={[s.primaryBtn, { backgroundColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={handleReset}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <IconLock size={16} color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.primaryBtnText}>{t('forgot.changePassword')}</Text>
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
            style={[s.primaryBtn, { backgroundColor: colors.primary, marginTop: 24, width: '100%' }]}
            onPress={() => router.replace('/login')}
            activeOpacity={0.85}
          >
            <Text style={s.primaryBtnText}>{t('forgot.goToLogin')}</Text>
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
      <TouchableOpacity onPress={toggle} style={s.themeToggle} activeOpacity={0.7}>
        <View style={[s.themeBtn, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
          borderColor: colors.authInputBorder,
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          } : {
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
          }),
        }]}>
          {isDark ? <IconSun size={16} color="#fbbf24" /> : <IconMoon size={16} color={colors.textSecondary} />}
        </View>
      </TouchableOpacity>

    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.center}>
          <Animated.View style={[s.cardWrap, { opacity: fadeAnim, transform: [{ scale: entryScale }, { translateY: slideAnim }] }]}>
            <View style={[s.card, {
              backgroundColor: colors.authCardBg,
              ...(Platform.OS === 'web' ? {
                boxShadow: isDark
                  ? '0 2px 8px rgba(0,0,0,0.35), 0 8px 32px rgba(0,0,0,0.2)'
                  : '0 1px 3px rgba(0,0,0,0.04), 0 4px 24px rgba(0,0,0,0.08)',
              } : {
                shadowColor: '#000',
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
      </ScrollView>
    </KeyboardAvoidingView>
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
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
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
    flexDirection: 'row', alignItems: 'center',
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
        boxShadow: '0 2px 6px rgba(37,99,235,0.35), 0 6px 20px rgba(37,99,235,0.2)',
      },
      default: {
        shadowColor: '#2563eb', shadowOffset: { width: 0, height: 3 },
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
