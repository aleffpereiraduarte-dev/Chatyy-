// [recovery 2026-10-18] Recuperação de conta nível Gmail.
// Fluxo: identificar (e-mail, @usuário ou telefone) → escolher como confirmar
// (aparelho conectado, código por WhatsApp/SMS, código no e-mail de recuperação,
// chave de acesso) → PIN da verificação em duas etapas quando a conta tem e o
// fator não foi aparelho/chave → nova senha (força + confirmação + "Sair de todos
// os outros aparelhos") → pronto. Backend: account-recovery.php (ações recovery_*).
// Antes: forgot_password_options/find_account nem existiam no servidor ("Unknown
// action") — quem esquecia a senha não tinha saída.
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
  Animated, Easing, Linking, Switch, AppState, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuthTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  recoveryLookup, recoverySend, recoveryStatus, recoveryVerify, recoveryPin,
  recoveryPasskeyBegin, recoveryPasskeyFinish, recoveryReset,
} from '../services/api';
import OtpInput from '../components/signup/OtpInput';
import { calcStrength } from '../components/signup/PasswordStrength';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import {
  IconMailLogo, IconAlertTriangle, IconArrowRight, IconMail, IconShield, IconCheckCircle,
  IconEye, IconEyeOff, IconLock, IconSun, IconMoon, IconSmartphone, IconKey, IconMessageSquare,
} from '../components/Icons';
import LoginKeyboardScroll from '../components/login/LoginKeyboardScroll';
import LoginNotice from '../components/login/LoginNotice';
import PressableScale from '../components/PressableScale';
import { saveLastIdentifier } from '../components/login/loginSmart';
import { tap as hTap, success as hSuccess, error as hError, selection as hSelection } from '../services/haptics';
import { PASSKEYS_ENABLED } from '../constants/featureFlags';

const SUPPORT_EMAIL = 'suporte@chatyy.app';

function firstParam(v) {
  if (Array.isArray(v)) return v[0] || '';
  return typeof v === 'string' ? v : '';
}

export default function ForgotPassword() {
  const { colors, isDark, toggle } = useAuthTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && winW >= 768;
  const accent = colors.authAccent || colors.text;
  const onAccent = colors.authOnAccent || colors.background || '#fff';

  const [showHelp, setShowHelp] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  // identify | methods | code | device | pin | password | done
  const [step, setStep] = useState('identify');
  const [loading, setLoading] = useState(false);
  const [busyMethod, setBusyMethod] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [focused, setFocused] = useState('');

  const [identifier, setIdentifier] = useState(() => {
    const pre = firstParam(params?.email) || firstParam(params?.identifier);
    return pre ? String(pre).replace(/\s+/g, '').toLowerCase() : '';
  });
  const [phoneHint, setPhoneHint] = useState(() => firstParam(params?.find) === '1');

  const [rid, setRid] = useState('');
  const [account, setAccount] = useState('');
  const [methods, setMethods] = useState([]);
  const [pinRequired, setPinRequired] = useState(false);

  const [method, setMethod] = useState('');
  const [masked, setMasked] = useState('');
  const [sentVia, setSentVia] = useState('');
  const [waAvailable, setWaAvailable] = useState(null);
  const [code, setCode] = useState('');
  const [codeKey, setCodeKey] = useState(0);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  const [deviceNumber, setDeviceNumber] = useState(0);
  const [deviceUntil, setDeviceUntil] = useState(0);
  const [deviceState, setDeviceState] = useState('pending');
  const pollRef = useRef(null);

  const [pin, setPin] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [doneEmail, setDoneEmail] = useState('');

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(12)).current;
  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(12);
    const EASE = Easing.bezier(0.23, 1, 0.32, 1);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 260, easing: EASE, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 260, easing: EASE, useNativeDriver: true }),
    ]).start();
  }, [step]);

  // Relógio (contagem pelo relógio — não congela em segundo plano).
  useEffect(() => {
    if (step !== 'code' && step !== 'device') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  useEffect(() => { if (error) hError(); }, [error]);

  const passkeyUsable = (() => {
    if (!PASSKEYS_ENABLED) return false;
    try { return !!require('../services/passkeys').isPasskeySupported(); } catch { return false; }
  })();
  const visibleMethods = methods.filter(m => m && (m.type !== 'passkey' || passkeyUsable));

  const goBackToLogin = () => {
    hSelection();
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    router.replace('/login');
  };

  const restart = (msg) => {
    stopPolling();
    setRid(''); setMethods([]); setMethod(''); setCode(''); setPin(''); setResetToken('');
    setStep('identify');
    setInfo('');
    setError(msg || '');
  };

  // Mensagem por motivo estável do servidor (i18n), com fallback no texto dele.
  const errText = (r, fallbackKey) => {
    const d = r?.data || {};
    const reason = d.reason || '';
    const mins = (s) => Math.max(1, Math.ceil(Number(s || 0) / 60));
    switch (reason) {
      case 'rate_limited': return t('rec.err.rateLimited');
      case 'locked': return t('rec.err.locked', { min: mins(d.retry_after) });
      case 'cooldown': return t('rec.err.cooldown', { s: Math.max(1, Number(d.retry_after || 30)) });
      case 'wrong_code':
        return (typeof d.attempts_left === 'number' && d.attempts_left >= 0)
          ? t('rec.err.wrongCodeLeft', { n: d.attempts_left }) : t('rec.err.wrongCode');
      case 'expired': return t('rec.err.codeExpired');
      case 'too_many_attempts': return t('rec.err.tooManyAttempts');
      case 'network': return t('rec.err.network');
      case 'weak_password': return r?.message || t('rec.err.weak');
      case 'wrong_pin':
        return (typeof d.attempts_left === 'number') ? t('rec.err.wrongPinLeft', { n: d.attempts_left }) : t('rec.err.wrongPin');
      case 'method_unavailable': return t('rec.err.methodUnavailable');
      case 'passkey_failed': return t('rec.err.passkey');
      case 'identifier_required': return t('rec.err.identifierRequired');
      default: return r?.message || t(fallbackKey || 'forgot.validation.connectionError');
    }
  };
  const isExpiredSession = (r) => r?.data?.reason === 'session_expired' || r?.status === 410;

  // ── 1) identificar ────────────────────────────────────────────────
  const handleLookup = async () => {
    const id = String(identifier || '').trim();
    if (!id) { setError(t('rec.err.identifierRequired')); return; }
    hTap('light');
    setError(''); setInfo('');
    setLoading(true);
    try {
      const r = await recoveryLookup(id);
      if (r?.success && r.data?.rid) {
        setRid(r.data.rid);
        setAccount(r.data.account || '');
        setMethods(Array.isArray(r.data.methods) ? r.data.methods : []);
        setPinRequired(!!r.data.pin_required);
        setStep('methods');
      } else {
        setError(errText(r));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // ── 2) enviar código / prompt ─────────────────────────────────────
  const startMethod = async (m, channel) => {
    if (!rid) { restart(); return; }
    hTap('light');
    setError(''); setInfo('');
    setBusyMethod(m + (channel || ''));
    setLoading(true);
    try {
      if (m === 'passkey') { await runPasskey(); return; }
      const r = await recoverySend(rid, m, channel);
      if (r?.success) {
        setMethod(m);
        setMasked(r.data?.masked || '');
        if (m === 'device') {
          setDeviceNumber(Number(r.data?.number || 0));
          setDeviceUntil(Date.now() + 1000 * Number(r.data?.expires_in || 180));
          setDeviceState('pending');
          setStep('device');
          startPolling();
        } else {
          setSentVia(r.data?.channel || (m === 'email' ? 'email' : 'sms'));
          if (r.data && 'whatsapp_available' in r.data) setWaAvailable(r.data.whatsapp_available);
          setResendAt(Date.now() + 1000 * Number(r.data?.resend_after || 60));
          setCode(''); setCodeKey(k => k + 1);
          setStep('code');
          if (step === 'code') setInfo(t('rec.resent'));
        }
      } else if (isExpiredSession(r)) {
        restart(t('rec.err.sessionExpired'));
      } else {
        setError(errText(r));
        const ra = Number(r?.data?.retry_after || 0);
        if (ra > 0 && step === 'code') setResendAt(Date.now() + ra * 1000);
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); setBusyMethod(''); }
  };

  const runPasskey = async () => {
    const b = await recoveryPasskeyBegin(rid);
    if (!b?.success) { if (isExpiredSession(b)) restart(t('rec.err.sessionExpired')); else setError(errText(b)); return; }
    const pk = require('../services/passkeys');
    const g = await pk.getPasskeyAssertion(b.data);
    if (!g?.ok) { if (g?.reason !== 'cancelled') setError(t('rec.err.passkey')); return; }
    const f = await recoveryPasskeyFinish(rid, g.assertion);
    if (f?.success) afterVerified(f.data, 'passkey');
    else if (isExpiredSession(f)) restart(t('rec.err.sessionExpired'));
    else setError(errText(f));
  };

  const afterVerified = (d, m) => {
    hSuccess();
    if (d?.pin_required) { setPin(''); setStep('pin'); return; }
    if (d?.reset_token) { setResetToken(d.reset_token); setStep('password'); return; }
    restart(t('rec.err.sessionExpired'));
  };

  // ── aparelho: polling do status ───────────────────────────────────
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const pollOnce = useCallback(async (ridNow) => {
    try {
      const r = await recoveryStatus(ridNow);
      if (!r?.success) { if (isExpiredSession(r)) { stopPolling(); restart(t('rec.err.sessionExpired')); } return; }
      const st = r.data?.status;
      if (st === 'approved') { stopPolling(); setDeviceState('approved'); afterVerified(r.data, 'device'); }
      else if (st === 'denied') { stopPolling(); setDeviceState('denied'); }
      else if (st === 'expired' || st === 'none') { stopPolling(); setDeviceState('expired'); }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const startPolling = () => {
    stopPolling();
    const ridNow = rid;
    pollRef.current = setInterval(() => pollOnce(ridNow), 2500);
  };
  useEffect(() => () => stopPolling(), []);
  // Volta do outro app/aparelho → confere na hora.
  useEffect(() => {
    if (step !== 'device') return undefined;
    const sub = AppState.addEventListener?.('change', (s) => { if (s === 'active' && rid) pollOnce(rid); });
    return () => { try { sub?.remove?.(); } catch {} };
  }, [step, rid, pollOnce]);
  useEffect(() => {
    if (step === 'device' && deviceState === 'pending' && deviceUntil && now > deviceUntil + 3000) {
      stopPolling(); setDeviceState('expired');
    }
  }, [now, step, deviceState, deviceUntil]);

  // ── 3) código ─────────────────────────────────────────────────────
  // [2026-10-21] auto-envio (closure com `loading` velho) + botão podiam
  // verificar 2x; a 2ª apagava o código e mostrava erro já na etapa de senha.
  const verifyingRef = useRef(false);
  const handleVerify = async (c0) => {
    const c = String(c0 || code).replace(/\D/g, '');
    if (c.length < 6) { setError(t('forgot.validation.codeLength')); return; }
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setError(''); setInfo('');
    setLoading(true);
    try {
      const r = await recoveryVerify(rid, c);
      if (r?.success) afterVerified(r.data, method);
      else if (isExpiredSession(r)) restart(t('rec.err.sessionExpired'));
      else { setError(errText(r, 'forgot.validation.invalidCode')); setCode(''); setCodeKey(k => k + 1); }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { verifyingRef.current = false; setLoading(false); }
  };
  const handleCodeChange = (c) => {
    setCode(c);
    if (error) setError('');
    if (String(c).length === 6 && !loading) setTimeout(() => handleVerify(c), 200);
  };

  // ── 4) PIN ────────────────────────────────────────────────────────
  const handlePin = async () => {
    const p = String(pin || '').replace(/\D/g, '');
    if (p.length < 4) { setError(t('rec.err.pinLength')); return; }
    setError('');
    setLoading(true);
    try {
      const r = await recoveryPin(rid, p);
      if (r?.success && r.data?.reset_token) { hSuccess(); setResetToken(r.data.reset_token); setStep('password'); }
      else if (isExpiredSession(r)) restart(t('rec.err.sessionExpired'));
      else { setError(errText(r)); setPin(''); }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  // ── 5) nova senha ─────────────────────────────────────────────────
  const strength = calcStrength(newPwd);
  const handleReset = async () => {
    if (!newPwd) { setError(t('forgot.validation.passwordRequired')); return; }
    if (newPwd.length < 8) { setError(t('forgot.validation.passwordMinLength')); return; }
    if (newPwd !== confirmPwd) { setError(t('forgot.validation.passwordsMismatch')); return; }
    setError('');
    setLoading(true);
    try {
      const r = await recoveryReset(rid, resetToken, newPwd, logoutOthers);
      if (r?.success) {
        hSuccess();
        const em = r.data?.email || '';
        setDoneEmail(em);
        if (em) saveLastIdentifier(em);
        setNewPwd(''); setConfirmPwd('');
        setStep('done');
      } else if (isExpiredSession(r)) {
        restart(t('rec.err.sessionExpired'));
      } else {
        setError(errText(r, 'forgot.validation.resetError'));
      }
    } catch { setError(t('forgot.validation.connectionError')); }
    finally { setLoading(false); }
  };

  const openSupport = () => {
    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t('rec.supportSubject'))}`;
    if (Platform.OS === 'web') { try { window.open(url, '_blank'); } catch {} }
    else Linking.openURL(url).catch(() => {});
  };

  // ── UI helpers ────────────────────────────────────────────────────
  const inputBoxStyle = (name) => [
    s.inputBox,
    { backgroundColor: colors.authInputBg, borderColor: focused === name ? colors.authInputFocusBorder : colors.authInputBorder },
    focused === name && { borderWidth: 2, ...Platform.select({ web: { boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}` }, default: {} }) },
  ];
  const renderNotice = () => (
    <>
      {!!error && <LoginNotice tone="error" text={error} colors={colors} style={{ marginBottom: 14 }} />}
      {!!info && !error && <LoginNotice tone="info" text={info} colors={colors} style={{ marginBottom: 14 }} />}
    </>
  );
  const PrimaryBtn = ({ label, onPress, disabled, icon }) => (
    <PressableScale
      style={[s.primaryBtn, { backgroundColor: accent }, (loading || disabled) && { opacity: 0.6 }]}
      onPress={onPress}
      haptic={false}
      disabled={loading || disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading && !busyMethod ? <ActivityIndicator color={onAccent} size="small" /> : (
        <>
          {icon}
          <Text style={[s.primaryBtnText, { color: onAccent }]}>{label}</Text>
        </>
      )}
    </PressableScale>
  );
  const LinkBtn = ({ label, onPress, muted }) => (
    <TouchableOpacity style={s.linkBtn} onPress={onPress} activeOpacity={0.6} accessibilityRole="button">
      <Text style={[s.linkText, { color: muted ? colors.textSecondary : colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
  const AccountChip = () => (!account ? null : (
    <View style={[s.accountChip, { borderColor: colors.authInputBorder }]}>
      <View style={[s.accountDot, { backgroundColor: colors.surfaceVariant }]}>
        <Text style={[s.accountDotText, { color: colors.text }]}>{String(account).charAt(0).toUpperCase()}</Text>
      </View>
      <Text style={[s.accountText, { color: colors.text }]} numberOfLines={1}>{account}</Text>
    </View>
  ));

  const methodIcon = (type) => {
    const c = colors.text;
    if (type === 'device') return <IconSmartphone size={20} color={c} />;
    if (type === 'phone') return <IconMessageSquare size={20} color={c} />;
    if (type === 'email') return <IconMail size={20} color={c} />;
    return <IconKey size={20} color={c} />;
  };
  const methodTitle = (m) => ({
    device: t('rec.method.device'),
    phone: t('rec.method.phone'),
    email: t('rec.method.email'),
    passkey: t('rec.method.passkey'),
  }[m.type] || m.type);
  const methodDesc = (m) => {
    if (m.type === 'device') return t('rec.method.deviceDesc', { n: m.count || 1 });
    if (m.type === 'phone') return t('rec.method.phoneDesc', { phone: m.masked || '' });
    if (m.type === 'email') return t('rec.method.emailDesc', { email: m.masked || '' });
    return t('rec.method.passkeyDesc');
  };

  const fmtLeft = (ms) => {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };

  // ── telas ─────────────────────────────────────────────────────────
  const renderContent = () => {
    if (step === 'identify') return (
      <>
        {renderNotice()}
        <Text style={[s.label, { color: colors.authLabelColor }]}>{phoneHint ? t('rec.identify.labelPhone') : t('rec.identify.label')}</Text>
        <View style={inputBoxStyle('id')}>
          <TextInput
            style={[s.textInput, { color: colors.text }]}
            value={identifier}
            onChangeText={(v) => { setIdentifier(String(v || '').replace(/^\s+/, '')); if (error) setError(''); }}
            placeholder={phoneHint ? t('rec.identify.placeholderPhone') : t('rec.identify.placeholder')}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            keyboardType={phoneHint ? 'phone-pad' : 'email-address'}
            textContentType={phoneHint ? 'telephoneNumber' : 'username'}
            autoComplete={phoneHint ? 'tel' : 'username'}
            importantForAutofill="yes"
            accessibilityLabel={t('rec.identify.label')}
            autoFocus={!identifier}
            returnKeyType="go"
            onSubmitEditing={() => { if (!loading) handleLookup(); }}
            onFocus={() => setFocused('id')}
            onBlur={() => setFocused('')}
          />
        </View>
        <Text style={[s.hintText, { color: colors.textTertiary, marginTop: 8 }]}>{t('rec.identify.hint')}</Text>
        <View style={s.btnCol}>
          <PrimaryBtn label={t('forgot.continue')} onPress={handleLookup} icon={null} />
          <LinkBtn label={phoneHint ? t('rec.identify.useEmail') : t('rec.identify.usePhone')} onPress={() => { hSelection(); setPhoneHint(v => !v); setIdentifier(''); setError(''); }} />
          <LinkBtn label={t('forgot.backToLogin')} onPress={goBackToLogin} muted />
        </View>
      </>
    );

    if (step === 'methods') return (
      <>
        {renderNotice()}
        <AccountChip />
        {visibleMethods.length === 0 ? (
          <View style={s.noMethodsBox}>
            <View style={[s.noMethodsIcon, { backgroundColor: colors.surfaceVariant }]}>
              <IconAlertTriangle size={30} color={colors.text} />
            </View>
            <Text style={[s.noMethodsTitle, { color: colors.text }]}>{t('rec.none.title')}</Text>
            <Text style={[s.noMethodsDesc, { color: colors.textSecondary }]}>{t('rec.none.desc')}</Text>
            <View style={{ width: '100%', marginTop: 18 }}>
              <PrimaryBtn label={t('forgot.contactSupportBtn')} onPress={openSupport} icon={<IconMail size={16} color={onAccent} style={{ marginRight: 8 }} />} />
            </View>
          </View>
        ) : (
          <View style={s.methodsList}>
            {visibleMethods.map((m) => (
              <TouchableOpacity
                key={m.type}
                style={[s.methodCard, { backgroundColor: colors.authInputBg, borderColor: colors.authInputBorder }]}
                onPress={() => startMethod(m.type)}
                disabled={loading}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${methodTitle(m)}. ${methodDesc(m)}`}
              >
                <View style={[s.methodIconWrap, { backgroundColor: colors.surfaceVariant }]}>{methodIcon(m.type)}</View>
                <View style={s.methodInfo}>
                  <Text style={[s.methodTitle, { color: colors.text }]}>{methodTitle(m)}</Text>
                  <Text style={[s.methodDesc, { color: colors.textSecondary }]}>{methodDesc(m)}</Text>
                </View>
                {loading && busyMethod === m.type
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <IconArrowRight size={16} color={colors.textTertiary} />}
              </TouchableOpacity>
            ))}
            {pinRequired && (
              <View style={s.hintRow}>
                <IconShield size={15} color={colors.textTertiary} />
                <Text style={[s.hintText, { color: colors.textTertiary }]}>{t('rec.pinNotice')}</Text>
              </View>
            )}
          </View>
        )}
        <View style={{ marginTop: 10 }}>
          {visibleMethods.length > 0 && <LinkBtn label={t('rec.noAccess')} onPress={openSupport} muted />}
          <LinkBtn label={t('rec.otherAccount')} onPress={() => restart()} />
        </View>
      </>
    );

    if (step === 'code') {
      const left = resendAt - now;
      const isPhone = method === 'phone';
      return (
        <>
          {renderNotice()}
          <View style={[s.sentBox, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
            <View style={[s.sentIconWrap, { backgroundColor: colors.surfaceVariant }]}>
              {isPhone ? <IconMessageSquare size={18} color={colors.text} /> : <IconMail size={18} color={colors.text} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.sentTitle, { color: colors.text }]}>
                {isPhone ? (sentVia === 'whatsapp' ? t('rec.code.sentWa') : t('rec.code.sentSms')) : t('rec.code.sentEmail')}
              </Text>
              <Text style={[s.sentText, { color: colors.textSecondary }]}>{masked}</Text>
            </View>
          </View>
          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.enterCode')}</Text>
          <OtpInput key={codeKey} value={code} onChange={handleCodeChange} />
          <View style={s.btnCol}>
            <PrimaryBtn label={t('forgot.verifyCode')} onPress={() => handleVerify()} icon={<IconCheckCircle size={16} color={onAccent} style={{ marginRight: 8 }} />} />
          </View>
          {left > 0 ? (
            <Text style={[s.countdownText, { color: colors.textTertiary }]}>{t('forgot.resendIn', { time: fmtLeft(left) })}</Text>
          ) : (
            <View>
              <LinkBtn label={t('forgot.resendCode')} onPress={() => startMethod(method)} />
              {isPhone && sentVia === 'whatsapp' && <LinkBtn label={t('rec.code.viaSms')} onPress={() => startMethod('phone', 'force_sms')} />}
              {isPhone && sentVia !== 'whatsapp' && waAvailable !== false && <LinkBtn label={t('rec.code.viaWa')} onPress={() => startMethod('phone', 'whatsapp')} />}
            </View>
          )}
          <LinkBtn label={t('rec.tryAnother')} onPress={() => { setError(''); setInfo(''); setStep('methods'); }} muted />
        </>
      );
    }

    if (step === 'device') {
      const left = deviceUntil - now;
      return (
        <>
          {renderNotice()}
          <AccountChip />
          {deviceState === 'pending' && (
            <>
              <View style={s.deviceBox}>
                <View style={[s.deviceIcon, { backgroundColor: colors.surfaceVariant }]}>
                  <IconSmartphone size={30} color={colors.text} />
                </View>
                <Text style={[s.deviceLead, { color: colors.text }]}>{t('rec.device.lead')}</Text>
                <Text style={[s.deviceSub, { color: colors.textSecondary }]}>{t('rec.device.sub')}</Text>
                <View style={[s.numberBadge, { borderColor: colors.text }]} accessibilityLabel={t('rec.device.numberA11y', { n: deviceNumber })}>
                  <Text style={[s.numberText, { color: colors.text }]}>{deviceNumber}</Text>
                </View>
                <View style={s.waitRow}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={[s.waitText, { color: colors.textSecondary }]}>{t('rec.device.waiting', { time: fmtLeft(left) })}</Text>
                </View>
              </View>
              <LinkBtn label={t('rec.device.resend')} onPress={() => startMethod('device')} />
            </>
          )}
          {deviceState !== 'pending' && (
            <View style={s.deviceBox}>
              <View style={[s.deviceIcon, { backgroundColor: colors.surfaceVariant }]}>
                <IconAlertTriangle size={28} color={colors.text} />
              </View>
              <Text style={[s.deviceLead, { color: colors.text }]}>
                {deviceState === 'denied' ? t('rec.device.denied') : t('rec.device.expired')}
              </Text>
              <Text style={[s.deviceSub, { color: colors.textSecondary }]}>
                {deviceState === 'denied' ? t('rec.device.deniedDesc') : t('rec.device.expiredDesc')}
              </Text>
              <View style={{ width: '100%', marginTop: 16 }}>
                <PrimaryBtn label={t('rec.device.again')} onPress={() => startMethod('device')} />
              </View>
            </View>
          )}
          <LinkBtn label={t('rec.tryAnother')} onPress={() => { stopPolling(); setError(''); setStep('methods'); }} muted />
        </>
      );
    }

    if (step === 'pin') return (
      <>
        {renderNotice()}
        <View style={s.hintRow}>
          <IconShield size={16} color={colors.textTertiary} />
          <Text style={[s.hintText, { color: colors.textTertiary }]}>{t('rec.pin.hint')}</Text>
        </View>
        <Text style={[s.label, { color: colors.authLabelColor }]}>{t('rec.pin.label')}</Text>
        <View style={inputBoxStyle('pin')}>
          <TextInput
            style={[s.textInput, { color: colors.text, letterSpacing: 8, fontSize: 20, textAlign: 'center' }]}
            value={pin}
            onChangeText={(v) => { setPin(String(v || '').replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            autoFocus
            textContentType="oneTimeCode"
            accessibilityLabel={t('rec.pin.label')}
            returnKeyType="go"
            onSubmitEditing={() => { if (!loading) handlePin(); }}
            onFocus={() => setFocused('pin')}
            onBlur={() => setFocused('')}
          />
        </View>
        <View style={s.btnCol}>
          <PrimaryBtn label={t('forgot.continue')} onPress={handlePin} />
        </View>
        <Text style={[s.hintText, { color: colors.textTertiary, textAlign: 'center', marginTop: 12 }]}>{t('rec.pin.forgot')}</Text>
        {visibleMethods.some(m => m.type === 'device' || m.type === 'passkey') && (
          <LinkBtn label={t('rec.tryAnother')} onPress={() => { setError(''); setStep('methods'); }} muted />
        )}
      </>
    );

    if (step === 'password') {
      const bars = Math.max(0, Math.min(4, strength.score + (newPwd.length >= 8 && strength.score === 0 ? 1 : 0)));
      const levelKey = ['signup.password.weak', 'signup.password.weak', 'signup.password.fair', 'signup.password.good', 'signup.password.strong'][bars];
      return (
        <>
          {renderNotice()}
          {/* âncora invisível: gerenciadores de senha associam a senha nova a ESTA conta */}
          <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
            <TextInput value={doneEmail || (account && account.includes('•') ? '' : account)} editable textContentType="username" autoComplete="username" importantForAutofill="yes" autoCapitalize="none" {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} style={{ width: 1, height: 1 }} />
          </View>
          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.newPassword')}</Text>
          <View style={inputBoxStyle('pwd')}>
            <TextInput
              style={[s.textInput, { color: colors.text }]}
              value={newPwd}
              onChangeText={(v) => { setNewPwd(v); if (error) setError(''); }}
              placeholder={t('forgot.newPasswordPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              secureTextEntry={!showPwd}
              textContentType="newPassword"
              autoComplete={Platform.OS === 'android' ? 'password-new' : 'new-password'}
              passwordRules="minlength: 8;"
              importantForAutofill="yes"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              accessibilityLabel={t('forgot.newPassword')}
              onFocus={() => setFocused('pwd')}
              onBlur={() => setFocused('')}
            />
            <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPwd(v => !v)} accessibilityRole="button" accessibilityLabel={showPwd ? t('login.hidePassword') : t('login.showPassword')}>
              {showPwd ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
            </TouchableOpacity>
          </View>
          {!!newPwd && (
            <View style={s.meterWrap} accessibilityLabel={t(levelKey)}>
              <View style={s.meterRow}>
                {[0, 1, 2, 3].map(i => (
                  <View key={i} style={[s.meterBar, { backgroundColor: i < bars ? colors.text : colors.authInputBorder }]} />
                ))}
              </View>
              <Text style={[s.meterText, { color: colors.textSecondary }]}>{t(levelKey)}</Text>
            </View>
          )}
          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('forgot.confirmNewPassword')}</Text>
          <View style={inputBoxStyle('confirm')}>
            <TextInput
              style={[s.textInput, { color: colors.text }]}
              value={confirmPwd}
              onChangeText={(v) => { setConfirmPwd(v); if (error) setError(''); }}
              placeholder={t('forgot.repeatPassword')}
              placeholderTextColor={colors.textTertiary}
              secureTextEntry={!showPwd}
              textContentType="newPassword"
              autoComplete={Platform.OS === 'android' ? 'password-new' : 'new-password'}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => { if (!loading) handleReset(); }}
              accessibilityLabel={t('forgot.confirmNewPassword')}
              onFocus={() => setFocused('confirm')}
              onBlur={() => setFocused('')}
            />
          </View>
          {!!confirmPwd && (
            <Text style={[s.matchText, { color: newPwd === confirmPwd ? colors.text : colors.error }]}>
              {newPwd === confirmPwd ? t('forgot.passwordsMatch') : t('forgot.passwordsMismatch')}
            </Text>
          )}
          <View style={[s.switchRow, { borderColor: colors.authInputBorder }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[s.switchTitle, { color: colors.text }]}>{t('rec.logoutOthers')}</Text>
              <Text style={[s.switchDesc, { color: colors.textSecondary }]}>{t('rec.logoutOthersDesc')}</Text>
            </View>
            <Switch
              value={logoutOthers}
              onValueChange={(v) => { hSelection(); setLogoutOthers(v); }}
              trackColor={{ false: colors.authInputBorder, true: colors.text }}
              thumbColor={Platform.OS === 'android' ? (logoutOthers ? onAccent : '#f4f4f4') : undefined}
              accessibilityLabel={t('rec.logoutOthers')}
            />
          </View>
          <View style={s.btnCol}>
            <PrimaryBtn label={t('rec.savePassword')} onPress={handleReset} icon={<IconLock size={16} color={onAccent} style={{ marginRight: 8 }} />} />
          </View>
        </>
      );
    }

    // done
    return (
      <View style={s.successBox}>
        <View style={[s.successIcon, { backgroundColor: colors.surfaceVariant }]}>
          <IconCheckCircle size={44} color={colors.text} />
        </View>
        <Text style={[s.successTitle, { color: colors.text }]}>{t('forgot.passwordChanged')}</Text>
        <Text style={[s.successSub, { color: colors.textSecondary }]}>
          {logoutOthers ? t('rec.done.descLoggedOut') : t('rec.done.desc')}
        </Text>
        <View style={{ width: '100%', marginTop: 22 }}>
          <PrimaryBtn
            label={t('forgot.goToLogin')}
            onPress={() => router.replace(doneEmail ? `/login?email=${encodeURIComponent(doneEmail)}` : '/login')}
          />
        </View>
      </View>
    );
  };

  const TITLES = {
    identify: [t('rec.title.identify'), t('rec.sub.identify')],
    methods: [visibleMethods.length ? t('rec.title.methods') : t('rec.title.identify'), visibleMethods.length ? t('rec.sub.methods') : ''],
    code: [t('rec.title.code'), method === 'phone' ? t('rec.sub.codePhone') : t('rec.sub.codeEmail')],
    device: [t('rec.title.device'), ''],
    pin: [t('rec.title.pin'), t('rec.sub.pin')],
    password: [t('rec.title.password'), t('rec.sub.password')],
    done: ['', ''],
  };
  const [title, subtitle] = TITLES[step] || ['', ''];
  const entryScale = fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });

  return (
    <View style={[s.outerRoot, { backgroundColor: colors.authBg }]}>
      <TouchableOpacity onPress={toggle} style={[s.themeToggle, { top: insets.top + 16 }]} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={isDark ? t('a11y.switchToLight') : t('a11y.switchToDark')}>
        <View style={s.themeBtn}>
          {isDark ? <IconSun size={16} color={colors.textSecondary} /> : <IconMoon size={16} color={colors.textSecondary} />}
        </View>
      </TouchableOpacity>

      <LoginKeyboardScroll contentContainerStyle={s.scroll} bottomOffset={96} keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}>
        <View style={[s.center, { paddingBottom: 48 + insets.bottom }, !isDesktop && { justifyContent: 'flex-start', paddingTop: insets.top + 72 }]}>
          <Animated.View style={[s.cardWrap, { opacity: fadeAnim, transform: [{ scale: entryScale }, { translateY: slideAnim }] }]}>
            <View style={[s.card, !isDesktop ? s.cardFlat : {
              backgroundColor: colors.authCardBg,
              ...(Platform.OS === 'web' ? {
                boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.35), 0 8px 32px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.04), 0 4px 24px rgba(0,0,0,0.08)',
              } : {}),
              borderColor: isDark ? colors.authCardBorder : 'transparent',
              borderWidth: isDark ? 1 : 0,
              borderRadius: 24, paddingHorizontal: 40, paddingTop: 36, paddingBottom: 28,
            }]}>
              <View style={s.iconRow}>
                <View style={[s.iconCircle, { backgroundColor: colors.surfaceVariant }]}>
                  <IconMailLogo size={26} color={colors.text} />
                </View>
              </View>
              {!!title && <Text style={[s.title, { color: colors.text }]} accessibilityRole="header">{title}</Text>}
              {!!subtitle && <Text style={[s.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}
              {renderContent()}
            </View>

            <View style={[s.footer, !isDesktop && s.footerStacked]}>
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
  scroll: { flexGrow: 1 },
  themeToggle: { position: 'absolute', top: 16, right: 16, zIndex: 10 },
  themeBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 48, minHeight: '100%', zIndex: 1 },
  cardWrap: { width: '100%', maxWidth: 448 },
  card: { borderRadius: 16, paddingHorizontal: 28, paddingTop: 28, paddingBottom: 24, width: '100%' },
  cardFlat: { backgroundColor: 'transparent', paddingHorizontal: 8, paddingTop: 0, paddingBottom: 8 },
  iconRow: { alignItems: 'center', marginBottom: 14 },
  iconCircle: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', textAlign: 'center', marginBottom: 8, letterSpacing: -0.7, lineHeight: 34 },
  subtitle: { fontSize: 15, textAlign: 'center', marginBottom: 22, lineHeight: 22 },
  hintRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 4 },
  hintText: { fontSize: 13, lineHeight: 19, flex: 1 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', letterSpacing: 0.5 },
  inputBox: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: 1, borderRadius: 14 },
  textInput: {
    flex: 1, minWidth: 0, fontSize: 16, paddingVertical: Platform.OS === 'web' ? 14 : 12, paddingHorizontal: 14,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  eyeBtn: { padding: 10, marginRight: 4 },
  btnCol: { marginTop: 20 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingVertical: 12, minHeight: 50,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  primaryBtnText: { fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  linkBtn: { paddingVertical: 10, minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 2 },
  linkText: { fontSize: 14, fontWeight: '600' },
  accountChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 8, borderWidth: 1, borderRadius: 999,
    paddingVertical: 5, paddingLeft: 5, paddingRight: 14, marginBottom: 18, maxWidth: '100%',
  },
  accountDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  accountDotText: { fontSize: 13, fontWeight: '700' },
  accountText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  methodsList: { gap: 10 },
  methodCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, minHeight: 64 },
  methodIconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  methodInfo: { flex: 1 },
  methodTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  methodDesc: { fontSize: 13 },
  noMethodsBox: { alignItems: 'center', paddingVertical: 8 },
  noMethodsIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  noMethodsTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  noMethodsDesc: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  sentBox: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, marginBottom: 4, borderWidth: 1 },
  sentIconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sentTitle: { fontSize: 14, fontWeight: '700' },
  sentText: { fontSize: 13, marginTop: 2 },
  countdownText: { textAlign: 'center', fontSize: 13, marginTop: 16, fontWeight: '500' },
  deviceBox: { alignItems: 'center', paddingVertical: 4 },
  deviceIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  deviceLead: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  deviceSub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  numberBadge: { marginTop: 20, width: 96, height: 96, borderRadius: 48, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  waitText: { fontSize: 13 },
  meterWrap: { marginTop: 8 },
  meterRow: { flexDirection: 'row', gap: 6 },
  meterBar: { flex: 1, height: 4, borderRadius: 2 },
  meterText: { fontSize: 12, marginTop: 6, fontWeight: '600' },
  matchText: { fontSize: 12, marginTop: 6, fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
  switchTitle: { fontSize: 15, fontWeight: '600' },
  switchDesc: { fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  successBox: { alignItems: 'center', paddingVertical: 16 },
  successIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  successTitle: { fontSize: 22, fontWeight: '800', marginBottom: 6, letterSpacing: -0.4 },
  successSub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, paddingHorizontal: 8 },
  footerStacked: { flexDirection: 'column', gap: 8, marginTop: 32 },
  footerLinks: { flexDirection: 'row', alignItems: 'center' },
  footerItem: { fontSize: 12 },
  footerDot: { fontSize: 12 },
});
