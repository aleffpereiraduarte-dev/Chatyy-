// [2026-10-15 native-onboarding] Primeira tela + cadastro "nível WhatsApp/Telegram".
//
//   welcome → phone → otp ─┬─ conta existente → permissões → restaurar → app
//                          └─ conta nova → perfil (foto+nome) → @usuário
//                                → (cria conta) → permissões → restaurar → pronto (LGPD) → app
//
// MESMOS endpoints e regras do fluxo legado (app/signup-phone.js):
//   phone_login_request (conta existe? já envia o código) · verify_send (canais
//   sms/whatsapp/force_sms/voice; Firebase só no SMS) · phone_login_verify(+PIN
//   anti-SIM-swap) / phone_login_firebase · check_username · phone_signup ·
//   upload_avatar · consentimentos LGPD (SignupConsentBlock grava a prova) ·
//   cooldowns/limites vindos do servidor (friendlyServerError). Nada de segredo
//   no rascunho local (nunca código, PIN, senha ou verify_token).
//
// Liga/desliga: components/nativeOnboarding/flag.js (__chatyy_native_onboarding).
// Crash de render → NativeOnboardingGate cai no fluxo legado (fallback).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, Platform, Animated, Easing, ScrollView,
  ActivityIndicator, Image, Modal, Keyboard, BackHandler, AccessibilityInfo, StatusBar,
  ActionSheetIOS, useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { useAuthTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../services/api';
import { firebasePhoneAvailable, fbSendCode, fbConfirm, fbSignOut } from '../../services/firebasePhone';
import { useSmsOtpAutofill, requestPhoneHint } from '../../services/smsOtp';
import { useOtpAutofillAssist, primeWhatsAppOtp } from '../../services/otpAutofill'; // [2026-10-18 otp-autofill]
import OtpAssist from '../OtpAssist';
import { selection as hSelection, tap as hTap, success as hSuccess, error as hError } from '../../services/haptics';
import useDebouncedCallback from '../../hooks/useDebouncedCallback';
import useIsMounted from '../../hooks/useIsMounted';
import { COUNTRIES, formatPhone, toE164, E164_RE, countryDisplayName } from '../../constants/countries';
import { VOICE_OTP_ENABLED } from '../../constants/featureFlags';
import { markFreshSignup } from '../../services/firstRun';
import { ThreadKeyboardAvoider } from '../../utils/threadKeyboard';
import { SignupConsentBlock } from '../consent/ConsentOptions';
import {
  loadSignupDraft, saveSignupDraft, clearSignupDraft, parsePhoneInput,
  usernameCandidates, usernameLocalError, sanitizeUsernameTyping, friendlyServerError,
} from '../signup/signupSmarts';
import {
  IconArrowLeft, IconChevronDown, IconCheck, IconAlertTriangle, IconCamera, IconGlobe, IconX,
  IconMessageCircle, IconSmartphone, IconPhone, IconMic, IconAtSign, IconMoreHorizontal, IconUser,
} from '../Icons';
import AvatarCircle from '../AvatarCircle';
import { useReducedMotion } from '../reducedMotion';
import { useOnbCopy } from '../onboarding/copy';
import { FriendsArt, BellArt } from '../onboarding/illustrations';
import { LANGUAGES } from '../../i18n';
import FlagIcon from './FlagIcon';
import CountryPicker from './CountryPicker';
import LanguageSheet from './LanguageSheet';
import OtpCells from './OtpCells';
import RestorePanel from './RestorePanel';
import LoginPinResetSheet, { ForgotLoginPinLink } from '../settings/LoginPinResetSheet';
import { computePermissionSteps } from './permissions';
import { probeRestore } from './restore';
import { hasNativeCircleCrop } from './flag';
import { fitPhoneFontSize, textEm } from './phoneFit';
import OpeningScreen from './OpeningScreen';
import WelcomeIntro from './WelcomeIntro'; // [2026-10-18 onb-telegram]
import { signupDomainLabel } from '../../utils/displayEmail';

const FORM_STEPS = ['phone', 'otp', 'profile', 'username'];
// Nomes do rascunho compartilhado com o fluxo legado (signupSmarts).
const LEGACY_STEP = { phone: 'phone', otp: 'otp', profile: 'name', username: 'handle' };

function _deviceRegion() {
  try { return Localization.getLocales?.()[0]?.regionCode || Localization.region || 'BR'; } catch { return 'BR'; }
}

function _tt(t, key, fb, vars) {
  try {
    const v = t(key, vars);
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {}
  return fb;
}

export default function NativeOnboardingFlow({ entry = 'phone', params = {}, onExitToLogin }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const { colors, isDark } = useAuthTheme();
  const { t, language, changeLanguage } = useLanguage();
  const { loginWithToken, user } = useAuth();
  const reduced = useReducedMotion();
  const c = useOnbCopy();
  const mountedRef = useIsMounted();
  const T = useCallback((k, fb, v) => _tt(t, k, fb, v), [t]);

  // ── passo inicial ──────────────────────────────────────────────────────
  const initialStep = (params?.step === 'name' && params?.verify_token) ? 'profile' : entry;
  const [step, setStep] = useState(initialStep);
  const stepRef = useRef(step); stepRef.current = step;

  // ── estado do cadastro (espelho do legado) ─────────────────────────────
  const [countryCode, setCountryCode] = useState(() => (params?.country ? String(params.country).toUpperCase() : _deviceRegion()));
  const [phone, setPhone] = useState(() => {
    const raw = String(params?.phone || '').replace(/[^0-9]/g, '');
    if (!raw) return '';
    const iso = String(params?.country || '').toUpperCase();
    const dial = (COUNTRIES.find((x) => x.code === iso)?.dial || '').replace('+', '');
    return dial && raw.startsWith(dial) ? raw.slice(dial.length) : raw;
  });
  const [code, setCode] = useState('');
  const codeRef = useRef(''); codeRef.current = code;
  const [verifyToken, setVerifyToken] = useState(() => String(params?.verify_token || ''));
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const name = useMemo(() => {
    const f = (firstName || '').trim(); const l = (lastName || '').trim();
    return l ? `${f} ${l}` : f;
  }, [firstName, lastName]);
  const [avatarUri, setAvatarUri] = useState(null);
  const [username, setUsername] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(null);
  const [usernameReason, setUsernameReason] = useState(null);
  const [usernameSuggestions, setUsernameSuggestions] = useState([]);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // [otp-wa 2026-10-18] Contagem pelo RELÓGIO (prazo absoluto): o setTimeout do JS
  // congela com o app em segundo plano (usuário sai p/ ler o SMS/WhatsApp) e o
  // "Reenviar em Ns" voltava parado. Agora cada tique recalcula do prazo.
  const [resendCountdown, _setResendCountdown] = useState(0);
  const resendDeadlineRef = useRef(0);
  const setResendCountdown = useCallback((n) => {
    const s = Math.max(0, Math.round(Number(n) || 0));
    resendDeadlineRef.current = s > 0 ? Date.now() + s * 1000 : 0;
    _setResendCountdown(s);
  }, []);
  // [otp-wa 2026-10-18] servidor disse que o número NÃO tem WhatsApp → some o "Receber pelo WhatsApp".
  const [waUnavailable, setWaUnavailable] = useState(false);
  const [sentVia, setSentVia] = useState('sms');
  const [otpChannels, setOtpChannels] = useState({ wa: true, sms: true });
  const [otpProvider, setOtpProvider] = useState(null); // [2026-10-18 otp-autofill] twilio|baileys|local
  const [accountExists, setAccountExists] = useState(null);
  const [codeAlreadySent, setCodeAlreadySent] = useState(false); // [2026-10-15 onb-existing]
  const [moreOpen, setMoreOpen] = useState(false); // [2026-10-15 onb-existing] menu "⋯" (e-mail de conta antiga)
  const [accountName, setAccountName] = useState(''); // nome da conta existente (só DEPOIS do código)
  const [lockRequired, setLockRequired] = useState(false);
  const [lockPin, setLockPin] = useState('');
  // [wave14a 2026-10-16] "Esqueci meu PIN" pré-login: desafio do requires_lock (servidor).
  const [lockChallenge, setLockChallenge] = useState('');
  const [lockHasEmail, setLockHasEmail] = useState(undefined);
  const [pinResetOpen, setPinResetOpen] = useState(false);
  const [otpErrorTick, setOtpErrorTick] = useState(0);
  const [showCountry, setShowCountry] = useState(false);
  const [phoneRowW, setPhoneRowW] = useState(0); // [2026-10-16 onb-phone-fit]
  const [showLang, setShowLang] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [photoSheet, setPhotoSheet] = useState(false);
  const [isNewAccount, setIsNewAccount] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [permSteps, setPermSteps] = useState([]);
  const [permIdx, setPermIdx] = useState(0);
  const [permBusy, setPermBusy] = useState(false);
  const [restore, setRestore] = useState(null); // { kind, ... }
  const [legacyModal, setLegacyModal] = useState(null); // 'backup' | 'history'
  const [resumedDraft, setResumedDraft] = useState(false);

  const fbConfirmRef = useRef(null);
  const fbIdTokenRef = useRef(null);
  const phoneViaFirebaseRef = useRef(false);
  const otpRef = useRef(null);
  const lastNameRef = useRef(null);

  const country = useMemo(() => COUNTRIES.find((x) => x.code === countryCode) || COUNTRIES[0], [countryCode]);
  const fullPhone = useMemo(() => toE164(country.dial, phone), [country, phone]);
  const minDigits = Math.max(8, (country.maxDigits || 11) - 1);
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneValid = phoneDigits.length >= minDigits && E164_RE.test(fullPhone);
  const fullPhoneFormatted = `${country.dial} ${formatPhone(phoneDigits, country.mask)}`.trim();

  // ── transição shared-axis X (UI thread) ────────────────────────────────
  const fade = useRef(new Animated.Value(1)).current;
  const shift = useRef(new Animated.Value(0)).current;
  // transPhase: '' (parado) | 'out' (saindo — o destino pode ser trocado) | 'in'
  const transPhaseRef = useRef('');
  const targetRef = useRef(step);
  const go = useCallback((next, dir = 1) => {
    if (next === targetRef.current && transPhaseRef.current) return;
    if (next === stepRef.current && !transPhaseRef.current) return;
    setError('');
    try { if (next !== 'done' && next !== 'finishing') hTap('light'); } catch {}
    targetRef.current = next;
    if (reduced) { setStep(next); return; }
    if (transPhaseRef.current === 'out') return; // o fim da saída aplica targetRef
    if (transPhaseRef.current === 'in') { setStep(next); return; }
    transPhaseRef.current = 'out';
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 130, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(shift, { toValue: -40 * dir, duration: 130, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(() => {
      transPhaseRef.current = 'in';
      setStep(targetRef.current);
      shift.setValue(40 * dir);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 240, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }),
        Animated.timing(shift, { toValue: 0, duration: 300, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }),
      ]).start(() => { transPhaseRef.current = ''; });
    });
  }, [reduced, fade, shift]);

  // Leitor de tela: anuncia o passo novo.
  const titles = useMemo(() => ({
    welcome: T('signupPhone.titleWelcome', 'Bem-vindo ao Chatyy'),
    phone: T('signupPhone.titlePhone', 'Seu telefone'),
    otp: T('signupPhone.titleOtp', 'Digite o código'),
    profile: T('nob.profileTitle', 'Seu perfil'),
    username: T('signupPhone.titleHandle', 'Escolha seu @'),
    welcomeBack: T('nob.welcomeBack', 'Bem-vindo de volta'),
    permissions: '',
    restore: T('ownBackup.restorePromptTitle', 'Restaurar backup'),
    done: T('signupPhone.titleDone', 'Tudo pronto!'),
  }), [T]);
  useEffect(() => {
    const s = titles[step];
    if (!s) return;
    try { AccessibilityInfo.announceForAccessibility?.(s); } catch {}
  }, [step, titles]);

  // ── rascunho (sem segredos) ────────────────────────────────────────────
  const draftReadyRef = useRef(false);
  const reachedRef = useRef('phone');
  useEffect(() => {
    if (params?.verify_token || params?.phone) { draftReadyRef.current = true; return undefined; }
    let cancelled = false;
    loadSignupDraft().then((d) => {
      if (cancelled) return;
      if (d) {
        if (d.countryCode) setCountryCode(d.countryCode);
        if (d.phone) setPhone(d.phone);
        if (d.firstName) setFirstName(d.firstName);
        if (d.lastName) setLastName(d.lastName);
        if (d.username) setUsername(d.username);
        if (d.avatarUri) setAvatarUri(d.avatarUri);
        if (d.reached) reachedRef.current = d.reached;
        if (d.phone) setResumedDraft(true);
      }
      draftReadyRef.current = true;
    }).catch(() => { draftReadyRef.current = true; });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!draftReadyRef.current || !FORM_STEPS.includes(step)) return undefined;
    const order = ['phone', 'otp', 'name', 'handle'];
    const cur = LEGACY_STEP[step];
    if (order.indexOf(cur) > order.indexOf(reachedRef.current)) reachedRef.current = cur;
    const id = setTimeout(() => {
      saveSignupDraft({ countryCode, phone, firstName, lastName, username, avatarUri, reached: reachedRef.current });
    }, 500);
    return () => clearTimeout(id);
  }, [step, countryCode, phone, firstName, lastName, username, avatarUri]);

  // ── contagem p/ reenviar ───────────────────────────────────────────────
  useEffect(() => {
    if (resendCountdown <= 0) return undefined;
    const id = setTimeout(() => {
      const dl = resendDeadlineRef.current;
      _setResendCountdown((x) => (dl > 0 ? Math.max(0, Math.ceil((dl - Date.now()) / 1000)) : Math.max(0, x - 1)));
    }, 1000);
    return () => clearTimeout(id);
  }, [resendCountdown]);

  const errText = useCallback((r, fallbackKey) => {
    const f = friendlyServerError(r, fallbackKey);
    return f.text || t(f.key);
  }, [t]);

  // ── enviar código (idêntico ao legado) ─────────────────────────────────
  const sendOtp = useCallback(async (channel = 'sms') => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8 || !E164_RE.test(fullPhone)) { setError(T('login.phoneInvalid', 'Número inválido')); return; }
    setError(''); setBusy(true);
    setCodeAlreadySent(false);
    if (stepRef.current !== 'otp') setWaUnavailable(false); // número novo → reavalia
    // [2026-10-15 onb-existing] Já existe um código válido emitido há < 60 s (cooldown
    // do servidor, compartilhado por phone_login_request/verify_send) → vai para a
    // tela do código em vez de travar no telefone com "Aguarde Ns".
    const toOtpOnCooldown = (r) => {
      const st = Number(r?.__httpStatus || 0);
      const ra = Number(r?.data?.retry_after || 0);
      if (!(st === 429 && r?.data?.reason === 'cooldown' && ra > 0 && ra <= 60)) return false;
      setResendCountdown(ra);
      setCodeAlreadySent(true);
      setCode('');
      setBusy(false);
      if (stepRef.current !== 'otp') go('otp', 1);
      return true;
    };
    try {
      if (accountExists === null && stepRef.current !== 'otp') {
        let lr = null;
        primeWhatsAppOtp(); // [2026-10-18 otp-autofill] login_request já envia o código (conta existe)
        try { lr = await api.phoneLoginRequest(fullPhone); } catch { lr = null; }
        if (!mountedRef.current) return;
        if (lr?.success && lr?.data?.exists === true) {
          // phone_login_request JÁ enviou o código da conta existente (e
          // armou o cooldown de 60 s) → mesma tela de código, sem 2º envio.
          setAccountExists(true);
          const wa = !!lr.data.whatsapp_sent;
          setOtpChannels({ wa, sms: !wa && lr.data.sms_sent !== false });
          setOtpProvider(lr.data.provider || null);
          if (lr.data.whatsapp_available === false) setWaUnavailable(true);
          setSentVia('sms');
          setCode('');
          if (lr.data.delivered === false) {
            // Nenhum canal entregou: tela do código + erro + "Reenviar" no retry_after.
            setResendCountdown(Math.min(3600, Math.max(0, Number(lr.data.retry_after || 0))));
            setError(T('signupPhone.sendError', 'Não foi possível enviar o código. Tente novamente.'));
          } else setResendCountdown(60);
          setBusy(false);
          go('otp', 1);
          return;
        }
        if (lr?.success && lr?.data?.exists === false) setAccountExists(false);
        else if (lr && !lr.success && Number(lr.__httpStatus || 0) === 429) {
          // Limite de envio do número (cooldown → já há código válido; senão, espera).
          if (toOtpOnCooldown(lr)) return;
          const f = friendlyServerError(lr, 'signupPhone.sendError');
          if (f.seconds) { setResendCountdown(f.seconds); setError(t('otp.waitSeconds', { s: f.seconds })); } else setError(f.text || t(f.key));
          return;
        }
        // 5xx / rede: segue pelo verify_send (o código vale p/ login E cadastro).
      }
      fbConfirmRef.current = null;
      fbIdTokenRef.current = null;
      phoneViaFirebaseRef.current = false;
      let r;
      if ((channel === 'sms' || !channel) && firebasePhoneAvailable()) {
        const fb = await fbSendCode(fullPhone);
        if (fb.ok) {
          phoneViaFirebaseRef.current = true;
          fbConfirmRef.current = fb.confirmation;
          r = { success: true, data: { sms_sent: true } };
        }
      }
      if (!r) { primeWhatsAppOtp(); r = await api.verifySend(fullPhone, channel); } // [2026-10-18 otp-autofill]
      if (!mountedRef.current) return;
      if (r?.success) {
        setResendCountdown(60);
        setOtpProvider(r?.data?.provider || null);
        setSentVia(channel === 'voice' ? 'voice' : 'sms');
        const wa = r?.data?.whatsapp_sent; const sms = r?.data?.sms_sent;
        setOtpChannels((wa === undefined && sms === undefined) ? { wa: true, sms: true } : { wa: !!wa, sms: !!sms });
        if (r?.data?.whatsapp_available === false) setWaUnavailable(true);
        if (stepRef.current !== 'otp') go('otp', 1);
        setCode('');
      } else if (!toOtpOnCooldown(r)) {
        const f = friendlyServerError(r, 'signupPhone.sendError');
        if (f.seconds) { setResendCountdown(f.seconds); setError(t('otp.waitSeconds', { s: f.seconds })); } else setError(f.text || t(f.key));
      }
    } catch {
      if (mountedRef.current) setError(T('login.errorConnection', 'Erro de conexão'));
    } finally { if (mountedRef.current) setBusy(false); }
  }, [phone, fullPhone, accountExists, go, t, T, mountedRef]);

  // ── conferir código (idêntico ao legado) ───────────────────────────────
  const inFlightRef = useRef(false);
  const afterAuthRef = useRef(null);
  const checkOtp = useCallback(async (codeArg) => {
    const cd = typeof codeArg === 'string' ? codeArg : codeRef.current;
    if (cd.length !== 6 || inFlightRef.current) return;
    inFlightRef.current = true;
    setError(''); setBusy(true);
    const bad = (msg, clear = true) => {
      setError(msg);
      if (clear) setCode('');
      setOtpErrorTick((x) => x + 1);
      try { hError(); } catch {}
      setTimeout(() => { try { otpRef.current?.focus(); } catch {} }, 260);
    };
    try {
      const pin = lockRequired ? lockPin : '';
      let r;
      if (phoneViaFirebaseRef.current) {
        if (!fbIdTokenRef.current) {
          const cf = await fbConfirm(fbConfirmRef.current, cd);
          if (!mountedRef.current) return;
          if (!cf.ok) { bad(T('signupPhone.otpInvalid', 'Código incorreto')); return; }
          fbIdTokenRef.current = cf.idToken;
        }
        r = await api.phoneLoginFirebase(fbIdTokenRef.current, pin);
      } else {
        r = await api.phoneLoginVerifyWithPin(fullPhone, cd, pin);
      }
      if (!mountedRef.current) return;
      if (r?.data?.requires_lock && r.data.lock_challenge) { setLockChallenge(String(r.data.lock_challenge)); setLockHasEmail(r.data.has_recovery_email); }
      if (r?.success && r.data?.requires_lock) { setLockRequired(true); return; }
      if (r && !r.success && r.data?.requires_lock) {
        setLockPin('');
        bad(r.message || T('signupPhone.lockPinWrong', 'PIN incorreto'), false);
        return;
      }
      if (r?.success && r.data?.token) {
        if (phoneViaFirebaseRef.current) { fbSignOut(); }
        try { await loginWithToken(r.data.token, r.data.email); } catch {}
        try { require('../../services/nativeTelemetry').markAuthDone('login'); } catch {} // [otp-wa 2026-10-18]
        clearSignupDraft();
        try { hSuccess(); } catch {}
        setIsNewAccount(false);
        setAccountEmail(String(r.data.email || ''));
        setAccountName(String(r.data.name || ''));
        // [2026-10-15 onb-existing] Código conferido → agora sim mostra de quem é a
        // conta ("Bem-vindo de volta" + foto/nome/@) antes das permissões.
        go('welcomeBack', 1);
      } else if (r?.success && r.data?.exists === false && r.data?.verify_token) {
        setVerifyToken(r.data.verify_token);
        go('profile', 1);
      } else {
        const f = friendlyServerError(r, 'signupPhone.otpInvalid');
        if (f.kind === 'network') setError(T('login.errorConnection', 'Erro de conexão'));
        else if (f.kind === 'otp_expired' || f.kind === 'otp_locked') { bad(t(f.key)); setResendCountdown(0); }
        else bad(f.kind === 'rate' ? t(f.key, { s: f.seconds }) : T('signupPhone.otpInvalid', 'Código incorreto'));
      }
    } catch {
      if (mountedRef.current) setError(T('login.errorConnection', 'Erro de conexão'));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [lockRequired, lockPin, fullPhone, loginWithToken, go, t, T, mountedRef]);
  const checkOtpRef = useRef(checkOtp); checkOtpRef.current = checkOtp;
  // [wave14a] PIN desligado pelo código do e-mail → mesmo caminho do login com token.
  const onPinResetLoggedIn = useCallback(async (d) => {
    if (phoneViaFirebaseRef.current) { fbSignOut(); }
    await loginWithToken(d.token, d.email).catch(() => {});
    if (!mountedRef.current) return;
    clearSignupDraft();
    hSuccess();
    setPinResetOpen(false); setLockRequired(false); setLockPin(''); setLockChallenge('');
    setIsNewAccount(false);
    setAccountEmail(String(d.email || ''));
    setAccountName(String(d.name || ''));
    go('welcomeBack', 1);
  }, [loginWithToken, go, mountedRef]);

  useSmsOtpAutofill(step === 'otp', (smsCode) => {
    setCode(smsCode);
    setTimeout(() => { try { checkOtpRef.current?.(smsCode); } catch {} }, 150);
  }, resendCountdown > 0);
  // [2026-10-18 otp-autofill] WhatsApp: one-tap (Android) + clipboard ao voltar + "Abrir WhatsApp".
  const otpAssist = useOtpAutofillAssist({
    active: step === 'otp' && !lockRequired,
    viaWhatsapp: sentVia !== 'voice' && !!otpChannels.wa && !phoneViaFirebaseRef.current,
    provider: otpProvider,
    onCode: (waCode) => {
      setCode(waCode);
      setTimeout(() => { try { checkOtpRef.current?.(waCode); } catch {} }, 150);
    },
    rearmKey: resendCountdown > 0,
  });

  // Teclado numérico aberto no passo do código (autoFocus se perde na transição).
  useEffect(() => {
    if (Platform.OS === 'web' || step !== 'otp') return undefined;
    const tms = [320, 700].map((ms) => setTimeout(() => {
      try { if (!otpRef.current?.isFocused?.()) otpRef.current?.focus(); } catch {}
    }, ms));
    return () => tms.forEach(clearTimeout);
  }, [step]);

  // Android: seletor nativo do Google com o número do chip (Phone Number Hint).
  const hintAskedRef = useRef(false);
  const hintStateRef = useRef({ phone, countryCode }); hintStateRef.current = { phone, countryCode };
  useEffect(() => {
    if (Platform.OS !== 'android' || step !== 'phone' || hintAskedRef.current) return undefined;
    if (hintStateRef.current.phone) return undefined;
    hintAskedRef.current = true;
    let off = false;
    const tm = setTimeout(async () => {
      if (hintStateRef.current.phone) return;
      const num = await requestPhoneHint();
      if (off || !num || !mountedRef.current) return;
      const cur = hintStateRef.current;
      if (cur.phone) return;
      const parsed = parsePhoneInput(num, cur.countryCode, COUNTRIES);
      if (parsed.countryCode !== cur.countryCode) setCountryCode(parsed.countryCode);
      setPhone(parsed.digits);
      try { hSelection(); } catch {}
    }, 450);
    return () => { off = true; clearTimeout(tm); };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── @usuário: verificação em tempo real (igual ao legado) ──────────────
  const autoUserRef = useRef(false);
  const nameCandidates = useMemo(() => usernameCandidates(firstName, lastName), [firstName, lastName]);
  useEffect(() => {
    if (step === 'username' && (!username || autoUserRef.current) && nameCandidates[0] && username !== nameCandidates[0]) {
      autoUserRef.current = true;
      setUsername(nameCandidates[0]);
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const latestUserRef = useRef('');
  const runUsernameCheck = useDebouncedCallback(async (uname) => {
    try {
      const r = await api.checkUsername(uname, signupDomainLabel());
      if (!mountedRef.current || latestUserRef.current !== uname) return;
      const status = Number(r?.__httpStatus || 0);
      if (r?.success) {
        const ok = r.data?.available !== false;
        setUsernameAvailable(ok);
        setUsernameReason(ok ? null : 'taken');
        const sugg = Array.isArray(r.data?.suggestions) ? r.data.suggestions.filter((x) => typeof x === 'string' && !usernameLocalError(x)) : [];
        setUsernameSuggestions(ok ? [] : (sugg.length ? sugg : nameCandidates.filter((x) => x !== uname)).slice(0, 4));
        try { ok ? hSelection() : hError(); } catch {}
      } else if (status === 429 || !r) {
        setUsernameAvailable(null); setUsernameReason(null);
      } else {
        setUsernameAvailable(false); setUsernameReason('chars');
        setUsernameSuggestions(nameCandidates.filter((x) => x !== uname).slice(0, 4));
      }
    } catch {
      if (latestUserRef.current === uname) { setUsernameAvailable(null); setUsernameReason(null); }
    } finally { if (mountedRef.current && latestUserRef.current === uname) setUsernameChecking(false); }
  }, 450);
  useEffect(() => {
    latestUserRef.current = username;
    if (step !== 'username' || !username) {
      setUsernameAvailable(null); setUsernameReason(null); setUsernameSuggestions([]); setUsernameChecking(false);
      return;
    }
    const le = usernameLocalError(username);
    if (le) {
      setUsernameAvailable(le === 'short' ? null : false);
      setUsernameReason(le); setUsernameSuggestions([]); setUsernameChecking(false);
      return;
    }
    setUsernameChecking(true);
    runUsernameCheck(username);
  }, [username, step, runUsernameCheck]);

  // ── criar conta (idêntico ao legado; senha opcional não pedida = servidor gera) ──
  const finishSignup = useCallback(async () => {
    if (!verifyToken) { setError(T('signupPhone.expired', 'Verificação expirou. Recomece.')); go('phone', -1); return; }
    if (!username || usernameAvailable === false || usernameLocalError(username)) return;
    setError(''); setBusy(true);
    try {
      let _ref = ''; try { _ref = await require('../../services/pendingReferral').getPendingRef(); } catch {} // [bia-convite 2026-10-19]
      const r = await api.phoneSignup({ verify_token: verifyToken, username, name, domain: signupDomainLabel(), password: '', ref: _ref });
      if (r?.success && r.data?.email) { try { await markFreshSignup(r.data.email, { skip: ['profile'] }); } catch {} }
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (!mountedRef.current) return;
        if (lr?.success) {
          try { require('../../services/nativeTelemetry').markAuthDone('signup'); } catch {} // [otp-wa 2026-10-18]
          clearSignupDraft();
          if (avatarUri) {
            try {
              const file = Platform.OS === 'web' ? avatarUri : { uri: avatarUri, type: 'image/jpeg', name: 'avatar.jpg' };
              await api.uploadAvatar(file);
            } catch {}
          }
          if (!mountedRef.current) return;
          try { hSuccess(); } catch {}
          setIsNewAccount(true);
          setAccountEmail(String(r.data.email || ''));
          afterAuthRef.current?.(String(r.data.email || ''), true);
        } else {
          setError(lr?.message || T('signupPhone.signupError', 'Falha ao criar conta'));
        }
      } else {
        const f = friendlyServerError(r, 'signupPhone.signupError');
        if (f.kind === 'username') {
          setUsernameAvailable(false); setUsernameReason('taken');
          setUsernameSuggestions(nameCandidates.filter((x) => x !== username).slice(0, 4));
          try { hError(); } catch {}
        }
        setError(f.text || t(f.key));
        if (f.kind === 'expired') { setVerifyToken(''); setCode(''); go('phone', -1); }
      }
    } catch {
      if (mountedRef.current) setError(T('login.errorConnection', 'Erro de conexão'));
    } finally { if (mountedRef.current) setBusy(false); }
  }, [verifyToken, username, usernameAvailable, name, avatarUri, loginWithToken, nameCandidates, go, t, T, mountedRef]);

  // ── depois de autenticar: permissões → restaurar → (pronto) → app ──────
  const navTarget = useCallback(() => '/chat', []);
  const leaveToApp = useCallback(() => {
    setTimeout(() => { if (mountedRef.current) { try { router.replace(navTarget()); } catch {} } }, 120);
  }, [router, navTarget, mountedRef]);

  // [2026-10-16 onb-opening] geração da sondagem: "Abrir agora"/"Tentar novamente"
  // invalidam a anterior (resposta atrasada não arrasta o usuário de volta).
  const probeGenRef = useRef(0);
  const [openPhase, setOpenPhase] = useState('perm'); // 'perm' | 'probe'
  const goRestoreOrFinish = useCallback(async (email, isNew) => {
    go('finishing', 1);
    setOpenPhase('probe');
    const gen = ++probeGenRef.current;
    let r = null;
    try { r = await probeRestore(email); } catch { r = null; }
    if (!mountedRef.current || gen !== probeGenRef.current) return;
    if (r?.kind === 'own') { setRestore(r); go('restore', 1); return; }
    if (r?.kind === 'legacy') { setRestore(r); setLegacyModal('backup'); }
    else if (r?.kind === 'history') { setRestore(r); setLegacyModal('history'); }
    if (isNew) { go('done', 1); return; }
    if (!r) leaveToApp();
  }, [go, leaveToApp, mountedRef]);

  const afterPermissions = useCallback((email, isNew, shown) => {
    if (isNew && shown) { try { markFreshSignup(email, { skip: ['profile', 'friends', 'notifications'] }); } catch {} }
    goRestoreOrFinish(email, isNew);
  }, [goRestoreOrFinish]);

  afterAuthRef.current = async (email, isNew) => {
    setOpenPhase('perm');
    go('finishing', 1);
    let steps = [];
    try { steps = await computePermissionSteps(); } catch { steps = []; }
    if (!mountedRef.current) return;
    if (steps.length) { setPermSteps(steps); setPermIdx(0); go('permissions', 1); return; }
    afterPermissions(email, isNew, false);
  };

  const nextPermission = useCallback(() => {
    if (permIdx + 1 < permSteps.length) {
      setPermIdx(permIdx + 1);
      fade.setValue(reduced ? 1 : 0.0);
      if (!reduced) Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true }).start();
      return;
    }
    afterPermissions(accountEmail, isNewAccount, true);
  }, [permIdx, permSteps, afterPermissions, accountEmail, isNewAccount, fade, reduced]);

  const allowContacts = useCallback(async () => {
    if (permBusy) return;
    setPermBusy(true);
    try {
      const { syncContacts } = require('../../services/contactSync');
      // Aviso de consentimento da loja/LGPD (contactsConsent.*) → prompt do sistema.
      await syncContacts(true, t);
    } catch {}
    if (mountedRef.current) { setPermBusy(false); nextPermission(); }
  }, [permBusy, t, nextPermission, mountedRef]);

  const allowPush = useCallback(async () => {
    if (permBusy) return;
    setPermBusy(true);
    try { require('../../services/pushPrimer').pushPrimerClosed(true); } catch {}
    try {
      const pn = require('../../services/pushNotifications');
      try { pn.diagPushPrimer?.('primer_shown', 'native_onboarding'); } catch {}
      await pn.enablePushFromPrimer();
    } catch {}
    if (mountedRef.current) { setPermBusy(false); nextPermission(); }
  }, [permBusy, nextPermission, mountedRef]);

  const laterPermission = useCallback(() => {
    if (permSteps[permIdx] === 'notifications') {
      try { require('../../services/pushPrimer').recordPushPrimerOffer(); } catch {}
      try { require('../../services/pushNotifications').diagPushPrimer?.('primer_later', 'native_onboarding'); } catch {}
    }
    nextPermission();
  }, [permSteps, permIdx, nextPermission]);

  // ── foto do perfil: câmera/galeria nativas + recorte circular nativo ───
  const pickAvatar = useCallback(async (source) => {
    setPhotoSheet(false);
    try { Keyboard.dismiss(); } catch {}
    try {
      const ImagePicker = require('expo-image-picker');
      const nativeCrop = hasNativeCircleCrop();
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm?.granted) return;
      }
      const opts = { mediaTypes: ['images'], allowsEditing: !nativeCrop, aspect: [1, 1], quality: 0.9 };
      const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (!r || r.canceled || !r.assets?.[0]?.uri) return;
      let uri = r.assets[0].uri;
      if (nativeCrop) {
        try {
          const ME = require('../../modules/expo-media-editor');
          let labels = {};
          try { labels = require('../media/nativeMediaEditor').buildLabels(t); } catch {}
          const res = await ME.open({
            uri, type: 'image', mode: 'edit', cropShape: 'circle', maxDim: 1024, quality: 0.9, labels,
            tools: { crop: true, draw: false, text: false, stickers: false, filters: false, trim: false, mute: false, cover: false },
          });
          if (res?.action === 'cancel') return;
          if (res?.action === 'done' && res.uri) uri = res.uri;
        } catch {}
      }
      if (mountedRef.current) { setAvatarUri(uri); try { hTap('light'); } catch {} }
    } catch { /* permissão negada / seletor falhou — silencioso */ }
  }, [t, mountedRef]);

  const openPhotoOptions = useCallback(() => {
    if (Platform.OS === 'web') { pickAvatar('library'); return; }
    if (Platform.OS === 'ios' && ActionSheetIOS?.showActionSheetWithOptions) {
      const opts = [T('signupPhone.takePhoto', 'Tirar foto'), T('signupPhone.chooseFromGallery', 'Escolher da galeria')];
      if (avatarUri) opts.push(T('nob.removePhoto', 'Remover foto'));
      opts.push(T('common.cancel', 'Cancelar'));
      ActionSheetIOS.showActionSheetWithOptions({
        options: opts,
        cancelButtonIndex: opts.length - 1,
        destructiveButtonIndex: avatarUri ? 2 : undefined,
        userInterfaceStyle: isDark ? 'dark' : 'light',
      }, (i) => {
        if (i === 0) pickAvatar('camera');
        else if (i === 1) pickAvatar('library');
        else if (i === 2 && avatarUri) setAvatarUri(null);
      });
      return;
    }
    setPhotoSheet(true);
  }, [pickAvatar, avatarUri, isDark, T]);

  // ── voltar ─────────────────────────────────────────────────────────────
  const exitToLogin = useCallback(() => {
    try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
    if (onExitToLogin) { onExitToLogin(); return; }
    try { router.replace('/login'); } catch {}
  }, [onExitToLogin, router]);

  const goBack = useCallback(() => {
    if (busy) return;
    setError('');
    const s = stepRef.current;
    if (s === 'phone') {
      if (entry === 'welcome') go('welcome', -1);
      else exitToLogin();
    } else if (s === 'otp') { setLockRequired(false); setLockPin(''); setLockChallenge(''); setCode(''); go('phone', -1); }
    else if (s === 'profile') {
      if (params?.verify_token && params?.step === 'name') exitToLogin();
      else go('otp', -1);
    } else if (s === 'username') go('profile', -1);
  }, [busy, entry, params, go, exitToLogin]);
  const goBackRef = useRef(goBack); goBackRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    if (!['phone', 'otp', 'profile', 'username', 'welcomeBack', 'permissions', 'restore', 'done', 'finishing'].includes(step)) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (['welcomeBack', 'permissions', 'restore', 'done', 'finishing'].includes(stepRef.current)) return true; // conta já autenticada: não volta ao formulário
      try { goBackRef.current?.(); } catch {}
      return true;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [step]);

  // ── UI helpers ─────────────────────────────────────────────────────────
  const fg = colors.text;
  const sub = colors.textSecondary;
  const Primary = useCallback(({ label, onPress, loading, disabled, testID, big }) => (
    <Pressable
      onPress={onPress}
      disabled={!!(loading || disabled)}
      style={({ pressed }) => [st.primary, big ? st.primaryBig : null, { backgroundColor: fg, opacity: disabled ? 0.3 : (pressed ? 0.86 : 1), transform: [{ scale: pressed && !disabled ? 0.985 : 1 }] }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(loading || disabled), busy: !!loading }}
      testID={testID}
    >
      {loading ? <ActivityIndicator color={colors.background} /> : <Text style={[st.primaryText, big ? st.primaryTextBig : null, { color: colors.background }]} maxFontSizeMultiplier={1.3}>{label}</Text>}
    </Pressable>
  ), [fg, colors.background]);
  const Secondary = useCallback(({ label, onPress, disabled, testID }) => (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [st.secondary, { opacity: disabled ? 0.4 : (pressed ? 0.55 : 1) }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      testID={testID}
    >
      <Text style={[st.secondaryText, { color: fg }]} maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  ), [fg]);

  const ErrorLine = error ? (
    <View style={st.errRow} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <IconAlertTriangle size={15} color={colors.error || fg} style={{ marginTop: 2 }} />
      <Text style={[st.errText, { color: colors.error || fg }]}>{error}</Text>
    </View>
  ) : null;

  const langLabel = (LANGUAGES.find((l) => l.code === language) || {}).label || language;

  const openLegal = (doc) => { try { router.push({ pathname: '/legal', params: { doc } }); } catch {} };

  // Texto dos termos com 2 links ({privacy} / {terms}).
  const TermsText = () => {
    const btn = T('nob.start', 'Começar'); // [2026-10-18 onb-telegram] mesmo rótulo do botão
    const tpl = T('nob.terms', 'Leia nossa {privacy}. Toque em “{button}” para aceitar os {terms}.').split('{button}').join(btn);
    const parts = tpl.split(/(\{privacy\}|\{terms\})/);
    return (
      <Text style={[st.terms, { color: sub }]} maxFontSizeMultiplier={1.5}>
        {parts.map((p, i) => {
          if (p === '{privacy}') return <Text key={i} style={[st.link, { color: fg }]} accessibilityRole="link" onPress={() => openLegal('privacy')}>{T('nob.privacyPolicy', 'Política de Privacidade')}</Text>;
          if (p === '{terms}') return <Text key={i} style={[st.link, { color: fg }]} accessibilityRole="link" onPress={() => openLegal('terms')}>{T('nob.termsOfService', 'Termos de Serviço')}</Text>;
          return <Text key={i}>{p}</Text>;
        })}
      </Text>
    );
  };

  // ── passos ─────────────────────────────────────────────────────────────
  let body = null;
  let footer = null;

  if (step === 'welcome') {
    body = (
      // [2026-10-18 onb-telegram] marca animada + 4 cartões deslizáveis (Telegram).
      <View style={st.welcome}>
        <WelcomeIntro fg={fg} bg={colors.background} sub={sub} reduced={reduced} T={T} />
      </View>
    );
    footer = (
      <>
        <TermsText />
        <Primary
          label={T('nob.start', 'Começar')}
          big
          onPress={() => {
            try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
            go('phone', 1);
          }}
          testID="nob-agree"
        />
      </>
    );
  } else if (step === 'phone') {
    const left = Math.max(0, minDigits - phoneDigits.length);
    // [2026-10-16 onb-phone-fit] fonte calculada p/ "+1 (954) 707-7804" nunca cortar:
    // o mesmo tamanho no prefixo e no campo (mesma linha de base).
    const phoneShown = formatPhone(phoneDigits, country.mask);
    const maskPh = (country.mask || '').replace(/#/g, '0');
    const phoneFs = fitPhoneFontSize(phoneRowW ? phoneRowW - 54 : 0, [country.dial + maskPh, country.dial + phoneShown], { max: 28, min: 17 });
    const dialW = Math.ceil(phoneFs * textEm(country.dial) * 1.08) + 2;
    const phoneLh = Math.round(phoneFs * 1.25);
    body = (
      <>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{titles.phone}</Text>
        <Text style={[st.sub, { color: sub }]} maxFontSizeMultiplier={1.5}>{T('onb.phoneHint', 'Enviamos um código para confirmar seu número.')}</Text>
        {resumedDraft && (
          <View style={[st.note, { backgroundColor: colors.surfaceVariant }]}>
            <Text style={[st.noteText, { color: fg }]}>{T('signupPhone.resumed', 'Continuando de onde você parou.')}</Text>
            <Pressable
              onPress={() => { clearSignupDraft(); setResumedDraft(false); setPhone(''); setFirstName(''); setLastName(''); setUsername(''); setAvatarUri(null); reachedRef.current = 'phone'; }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={[st.noteLink, { color: fg }]}>{T('signupPhone.startOver', 'Começar de novo')}</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          onPress={() => { Keyboard.dismiss(); setShowCountry(true); }}
          style={({ pressed }) => [st.countryRow, { borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={`${T('onb.countryLabel', 'País')}: ${countryDisplayName(country, language, t)} ${country.dial}`}
          accessibilityHint={T('login.selectCountry', 'Selecionar país')}
          testID="nob-country"
        >
          <FlagIcon code={country.code} width={30} borderColor={colors.border} textColor={fg} />
          <Text style={[st.countryName, { color: fg }]} numberOfLines={1}>{countryDisplayName(country, language, t)}</Text>
          <IconChevronDown size={18} color={sub} />
        </Pressable>
        <View
          style={[st.phoneRow, { borderBottomColor: phoneValid ? fg : colors.border }]}
          onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w && w !== phoneRowW) setPhoneRowW(w); }}
        >
          <Text
            style={[st.dial, { color: fg, fontSize: phoneFs, lineHeight: phoneLh, width: dialW }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >{country.dial}</Text>
          <View style={[st.vline, { backgroundColor: colors.border }]} />
          <TextInput
            value={phoneShown}
            onChangeText={(text) => {
              const parsed = parsePhoneInput(text, countryCode, COUNTRIES);
              if (parsed.countryCode !== countryCode) { setCountryCode(parsed.countryCode); try { hSelection(); } catch {} }
              setPhone(parsed.digits);
              if (accountExists !== null) setAccountExists(null);
              if (error) setError('');
            }}
            placeholder={(country.mask || '').replace(/#/g, '0')}
            placeholderTextColor={colors.textTertiary}
            keyboardType="phone-pad"
            inputMode="tel"
            textContentType="telephoneNumber"
            autoComplete="tel"
            autoFocus={Platform.OS !== 'android'}
            // [2026-10-16] sem returnKeyType: no iOS 26 o phone-pad desenhava um
            // botão flutuante "Go" sobre o teclado. O "Continuar" já existe.
            // Web (teclado físico): Enter continua confirmando.
            onSubmitEditing={Platform.OS === 'web' ? () => { if (phoneValid && !busy) setConfirmOpen(true); } : undefined}
            style={[st.phoneInput, { color: fg, fontSize: phoneFs, height: phoneLh + 16 }, Platform.OS === 'web' ? { outlineStyle: 'none', lineHeight: phoneLh } : null]}
            accessibilityLabel={`${T('signupPhone.titlePhone', 'Seu telefone')} ${country.dial}`}
            maxFontSizeMultiplier={1}
            testID="nob-phone"
          />
          <View style={st.phoneCheck}>{phoneValid ? <IconCheck size={20} color={fg} strokeWidth={2.6} /> : null}</View>
        </View>
        <Text style={[st.hint, { color: sub }]} accessibilityLiveRegion="polite" testID="nob-phone-hint">
          {phoneDigits.length === 0 ? ' '
            : phoneValid ? fullPhoneFormatted
              : T('nob.digitsLeft', 'Faltam {n} dígitos', { n: left })}
        </Text>
        {ErrorLine}
      </>
    );
    footer = (
      <>
        <Primary label={T('onb.continue', 'Continuar')} onPress={() => { Keyboard.dismiss(); setConfirmOpen(true); }} disabled={!phoneValid} loading={busy} testID="nob-phone-next" />
      </>
    );
  } else if (step === 'otp') {
    const toSms = sentVia === 'voice' || (otpChannels.wa && !otpChannels.sms);
    const chLabel = sentVia === 'voice' ? T('signupPhone.sentVoice', 'Vamos te ligar e ler o código')
      : (otpChannels.wa && otpChannels.sms) ? T('onb.codeChannels', 'Código enviado por WhatsApp e SMS')
        : otpChannels.wa ? T('login.otpSentWhatsapp', 'Enviado pelo WhatsApp.') : T('login.otpSentSms', 'Enviado por SMS.');
    body = (
      <>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{titles.otp}</Text>
        <Text style={[st.sub, { color: sub }]} maxFontSizeMultiplier={1.5}>
          {T('signupPhone.subOtp', 'Enviamos um código de 6 dígitos para')}{' '}
          <Text style={{ color: fg, fontWeight: '700' }}>{fullPhoneFormatted}</Text>
          {'  '}
          <Text style={[st.link, { color: fg }]} accessibilityRole="button" onPress={goBack}>{T('signupPhone.edit', 'Editar')}</Text>
        </Text>
        {accountExists === true && (
          <View style={[st.existCard, { backgroundColor: colors.surfaceVariant }]} accessibilityLiveRegion="polite" testID="nob-existing-account">
            <View style={[st.existIcon, { backgroundColor: fg }]}>
              <IconCheck size={16} color={colors.background} strokeWidth={3} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[st.existTitle, { color: fg }]} maxFontSizeMultiplier={1.4}>{T('nob.existingTitle', 'Número já cadastrado')}</Text>
              <Text style={[st.channelSub, { color: sub }]} maxFontSizeMultiplier={1.5}>{T('nob.existingSub', 'Vamos entrar na sua conta. Digite o código para continuar.')}</Text>
            </View>
          </View>
        )}
        <View style={{ height: 18 }} />
        <OtpCells
          ref={otpRef}
          value={code}
          onChange={(d) => { setCode(d); if (error) setError(''); }}
          onComplete={(d) => { if (!lockRequired) setTimeout(() => { try { checkOtpRef.current?.(d); } catch {} }, 120); }}
          colors={colors}
          errorTick={otpErrorTick}
          disabled={busy && !lockRequired}
          reduced={reduced}
          accessibilityLabel={titles.otp}
          testID="nob-otp"
        />
        <View style={[st.channelCard, { backgroundColor: colors.surfaceVariant }]}>
          {sentVia === 'voice' ? <IconPhone size={17} color={fg} /> : otpChannels.wa ? <IconMessageCircle size={17} color={fg} /> : <IconSmartphone size={17} color={fg} />}
          <View style={{ flex: 1 }}>
            <Text style={[st.channelTitle, { color: fg }]}>{codeAlreadySent ? T('nob.codeAlreadySent', 'Já enviamos um código há pouco. Digite-o abaixo.') : chLabel}</Text>
            <Text style={[st.channelSub, { color: sub }]}>{T('otp.mayTakeMinute', 'Pode levar até 1 minuto para chegar.')}</Text>
          </View>
        </View>
        <OtpAssist assist={otpAssist} colors={{ ...colors, primary: fg, onPrimary: colors.background }} />
        {lockRequired && (
          <View style={{ marginTop: 18 }}>
            <Text style={[st.pinTitle, { color: fg }]}>{T('signupPhone.lockPinTitle', 'Digite seu PIN de segurança')}</Text>
            <Text style={[st.pinSub, { color: sub }]}>{T('signupPhone.lockPinDesc', 'Essa conta tem PIN ativado para proteger contra troca de SIM.')}</Text>
            <TextInput
              value={lockPin}
              onChangeText={(v) => { setLockPin(String(v || '').replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
              keyboardType="number-pad"
              inputMode="numeric"
              secureTextEntry
              maxLength={6}
              autoFocus
              placeholder="••••"
              placeholderTextColor={colors.textTertiary}
              style={[st.pin, { color: fg, borderColor: lockPin ? fg : colors.border, backgroundColor: colors.surfaceVariant }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
              accessibilityLabel={T('signupPhone.lockPinTitle', 'PIN de segurança')}
              onSubmitEditing={() => { if (lockPin.length >= 4) checkOtp(code); }}
            />
            {!!lockChallenge && <ForgotLoginPinLink color={fg} onPress={() => { setError(''); setPinResetOpen(true); }} />}
          </View>
        )}
        {ErrorLine}
        <View style={st.otpActions}>
          <Pressable
            disabled={resendCountdown > 0 || busy}
            onPress={() => sendOtp('sms')}
            accessibilityRole="button"
            accessibilityState={{ disabled: resendCountdown > 0 || busy }}
            style={({ pressed }) => [st.pill, { backgroundColor: resendCountdown > 0 ? 'transparent' : colors.surfaceVariant, opacity: pressed ? 0.7 : 1 }]}
            testID="nob-resend"
          >
            <Text style={[st.pillText, { color: resendCountdown > 0 ? colors.textTertiary : fg }]}>
              {resendCountdown > 0 ? t('onb.resendIn', { s: resendCountdown }) : T('signupPhone.resend', 'Reenviar código')}
            </Text>
          </Pressable>
          {resendCountdown <= 30 && !(waUnavailable && !toSms) && (
            <Pressable
              disabled={busy}
              onPress={() => sendOtp(toSms ? 'force_sms' : 'whatsapp')}
              accessibilityRole="button"
              style={({ pressed }) => [st.pill, { borderWidth: 1.5, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
              testID="nob-switch-channel"
            >
              <Text style={[st.pillText, { color: fg }]}>
                {toSms ? T('signupPhone.sendBySms', 'Não recebi? Enviar por SMS') : T('login.otpViaWhatsapp', 'Receber pelo WhatsApp')}
              </Text>
            </Pressable>
          )}
          {VOICE_OTP_ENABLED && resendCountdown === 0 && (
            <Pressable disabled={busy} onPress={() => sendOtp('voice')} accessibilityRole="button" style={({ pressed }) => [st.pill, { borderWidth: 1.5, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
              <Text style={[st.pillText, { color: fg }]}>{T('signupPhone.callMe', 'Receber código por chamada')}</Text>
            </Pressable>
          )}
        </View>
      </>
    );
    footer = lockRequired ? (
      <Primary label={T('onb.continue', 'Continuar')} onPress={() => checkOtp(code)} loading={busy} disabled={lockPin.length < 4 || code.length !== 6} />
    ) : (busy ? <ActivityIndicator color={fg} style={{ marginBottom: 12 }} /> : null);
  } else if (step === 'profile') {
    body = (
      <>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{titles.profile}</Text>
        <Text style={[st.sub, { color: sub }]} maxFontSizeMultiplier={1.5}>{T('nob.profileSub', 'Adicione seu nome e uma foto (opcional).')}</Text>
        <Pressable
          onPress={openPhotoOptions}
          style={({ pressed }) => [st.avatarWrap, { opacity: pressed ? 0.8 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={avatarUri ? T('fr.profile.changePhoto', c('fr.profile.changePhoto')) : T('signupPhone.pickAvatar', 'Adicionar foto')}
          testID="nob-avatar"
        >
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={[st.avatar, { backgroundColor: colors.surfaceVariant }]} />
          ) : (
            <View style={[st.avatar, { backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }]}>
              <IconUser size={52} color={colors.textTertiary || sub} />
            </View>
          )}
          <View style={[st.avatarBadge, { backgroundColor: fg, borderColor: colors.background }]}>
            <IconCamera size={17} color={colors.background} />
          </View>
        </Pressable>
        <TextInput
          value={firstName}
          onChangeText={(v) => { setFirstName(v); if (error) setError(''); }}
          placeholder={T('signupPhone.firstName', 'Nome')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="words"
          autoComplete="name-given"
          textContentType="givenName"
          returnKeyType="next"
          autoFocus={Platform.OS !== 'web'}
          maxLength={40}
          onSubmitEditing={() => lastNameRef.current?.focus()}
          style={[st.field, { color: fg, borderBottomColor: firstName.trim().length >= 2 ? fg : colors.border }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          accessibilityLabel={T('signupPhone.firstName', 'Nome')}
          testID="nob-first-name"
        />
        <TextInput
          ref={lastNameRef}
          value={lastName}
          onChangeText={setLastName}
          placeholder={T('signupPhone.lastNameOptional', 'Sobrenome (opcional)')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="words"
          autoComplete="name-family"
          textContentType="familyName"
          returnKeyType="next"
          maxLength={40}
          onSubmitEditing={() => { if (firstName.trim().length >= 2) go('username', 1); }}
          style={[st.field, { color: fg, borderBottomColor: colors.border }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          accessibilityLabel={T('signupPhone.lastNameOptional', 'Sobrenome (opcional)')}
          testID="nob-last-name"
        />
        {ErrorLine}
      </>
    );
    footer = (
      <Primary
        label={T('onb.continue', 'Continuar')}
        disabled={firstName.trim().length < 2}
        onPress={() => {
          if (firstName.trim().length < 2) { setError(T('signupPhone.nameTooShort', 'Nome muito curto')); return; }
          const h = nameCandidates[0] || '';
          if (h && (!username || autoUserRef.current)) { autoUserRef.current = true; setUsername(h); }
          go('username', 1);
        }}
        testID="nob-profile-next"
      />
    );
  } else if (step === 'username') {
    const reasonText = {
      taken: T('onb.taken', 'Já está em uso — tente outro'),
      reserved: T('signupPhone.err.usernameReserved', 'Esse @ é reservado.'),
      chars: T('signupPhone.err.usernameInvalid', 'Use letras, números, ponto, - ou _.'),
      edges: T('signupPhone.err.usernameInvalid', 'Use letras, números, ponto, - ou _.'),
      double: T('signupPhone.err.usernameInvalid', 'Use letras, números, ponto, - ou _.'),
      long: T('signupPhone.err.usernameInvalid', 'Use letras, números, ponto, - ou _.'),
      short: T('signupPhone.err.usernameShort', 'Mínimo de 3 caracteres'),
    }[usernameReason] || '';
    const ok = usernameAvailable === true && !usernameChecking;
    body = (
      <>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{titles.username}</Text>
        <Text style={[st.sub, { color: sub }]} maxFontSizeMultiplier={1.5}>{T('signupPhone.subHandle', 'Você ganha um email Chatyy de presente')}</Text>
        <View style={[st.userRow, { borderBottomColor: ok ? fg : (usernameAvailable === false ? (colors.error || fg) : colors.border) }]}>
          <IconAtSign size={20} color={sub} />
          <TextInput
            value={username}
            onChangeText={(v) => { autoUserRef.current = false; setUsername(sanitizeUsernameTyping(v)); if (error) setError(''); }}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            textContentType="username"
            returnKeyType="done"
            autoFocus={Platform.OS !== 'web'}
            maxLength={30}
            onSubmitEditing={() => { if (ok && !busy) finishSignup(); }}
            style={[st.userInput, { color: fg }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
            accessibilityLabel={titles.username}
            testID="nob-username"
          />
          <View style={{ width: 22, alignItems: 'center' }}>
            {usernameChecking ? <ActivityIndicator size="small" color={sub} />
              : ok ? <IconCheck size={20} color={fg} strokeWidth={2.6} />
                : usernameAvailable === false ? <IconX size={18} color={colors.error || fg} /> : null}
          </View>
        </View>
        <Text style={[st.hint, { color: usernameAvailable === false ? (colors.error || fg) : sub }]} accessibilityLiveRegion="polite" testID="nob-username-status">
          {usernameChecking ? T('signupPhone.checking', 'Verificando…')
            : ok ? `${T('onb.available', 'Disponível')} · ${username}@${signupDomainLabel()}`
              : reasonText || (username ? `${username}@${signupDomainLabel()}` : ' ')}
        </Text>
        {usernameSuggestions.length > 0 && (
          <View style={st.chips}>
            {usernameSuggestions.map((s) => (
              <Pressable
                key={s}
                onPress={() => { autoUserRef.current = false; setUsername(s); try { hSelection(); } catch {} }}
                style={({ pressed }) => [st.chip, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`@${s}`}
              >
                <Text style={[st.chipText, { color: fg }]}>@{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {ErrorLine}
      </>
    );
    footer = (
      <>
        <Text style={[st.termsSmall, { color: sub }]}>
          {T('signupPhone.tosLine', 'Ao continuar você concorda com os ')}
          <Text style={[st.link, { color: fg }]} accessibilityRole="link" onPress={() => openLegal('terms')}>{T('signupPhone.tosLink', 'Termos')}</Text>
          {' '}{T('common.and', 'e')}{' '}
          <Text style={[st.link, { color: fg }]} accessibilityRole="link" onPress={() => openLegal('privacy')}>{T('signupPhone.privacyLink', 'Privacidade')}</Text>
        </Text>
        <Primary label={T('signupPhone.finish', 'Criar conta')} onPress={finishSignup} loading={busy} disabled={!ok} testID="nob-create" />
      </>
    );
  } else if (step === 'welcomeBack') {
    // [2026-10-15 onb-existing] Conta existente, código JÁ conferido: mostra de quem é.
    const uname = String(accountEmail || '').split('@')[0] || '';
    const display = (accountName || '').trim() || uname;
    body = (
      <View style={{ alignItems: 'center', marginTop: 24 }} testID="nob-welcome-back">
        <AvatarCircle email={accountEmail} name={display} size={104} />
        <Text style={[st.title, { color: fg, textAlign: 'center', marginTop: 20 }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          {titles.welcomeBack}
        </Text>
        <Text style={[st.wbName, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{display}</Text>
        {uname ? <Text style={[st.sub, { color: sub, textAlign: 'center', marginTop: 2 }]} numberOfLines={1}>@{uname}</Text> : null}
        <Text style={[st.sub, { color: sub, textAlign: 'center', marginTop: 14 }]} maxFontSizeMultiplier={1.5}>{T('nob.welcomeBackSub', 'Essa é a sua conta Chatyy.')}</Text>
      </View>
    );
    footer = (
      <Primary label={T('onb.continue', 'Continuar')} onPress={() => afterAuthRef.current?.(accountEmail, false)} testID="nob-welcome-back-continue" />
    );
  } else if (step === 'permissions') {
    const cur = permSteps[permIdx];
    const isContacts = cur === 'contacts';
    body = (
      <View style={st.permWrap}>
        {permSteps.length > 1 && (
          <Text style={[st.permStep, { color: sub }]}>{t('onb.stepLabel', { n: permIdx + 1, total: permSteps.length })}</Text>
        )}
        <View style={{ alignItems: 'center', marginTop: 8 }}>
          {isContacts
            ? <FriendsArt size={170} fg={fg} bg={colors.background} muted={colors.surfaceVariant} />
            : <BellArt size={170} fg={fg} bg={colors.background} muted={colors.surfaceVariant} />}
        </View>
        <Text style={[st.permTitle, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          {isContacts ? c('fr.friends.title') : c('fr.notif.title')}
        </Text>
        <Text style={[st.permSub, { color: sub }]} maxFontSizeMultiplier={1.5}>
          {isContacts ? c('fr.friends.sub') : c('fr.notif.sub')}
        </Text>
        {isContacts && (
          <Text style={[st.permFine, { color: sub }]} maxFontSizeMultiplier={1.5}>{c('fr.friends.privacy')}</Text>
        )}
        {permIdx === permSteps.length - 1 && (
          <View style={[st.camNote, { backgroundColor: colors.surfaceVariant }]}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <IconCamera size={16} color={fg} />
              <IconMic size={16} color={fg} />
            </View>
            <Text style={[st.camNoteText, { color: sub }]}>{T('nob.camMicNote', 'Câmera e microfone: só pedimos quando você for usar — numa ligação, foto ou áudio.')}</Text>
          </View>
        )}
      </View>
    );
    footer = (
      <>
        <Primary
          label={isContacts ? c('fr.friends.cta') : c('fr.notif.cta')}
          onPress={isContacts ? allowContacts : allowPush}
          loading={permBusy}
          testID={isContacts ? 'nob-perm-contacts' : 'nob-perm-push'}
        />
        <Secondary label={c('fr.notNow')} onPress={laterPermission} disabled={permBusy} testID="nob-perm-later" />
      </>
    );
  } else if (step === 'restore' && restore?.kind === 'own') {
    body = (
      <RestorePanel
        candidate={restore.candidate}
        colors={colors}
        t={t}
        reduced={reduced}
        Primary={Primary}
        Secondary={Secondary}
        onFinished={() => { if (isNewAccount) go('done', 1); else leaveToApp(); }}
      />
    );
  } else if (step === 'finishing' || (step === 'restore' && restore?.kind !== 'own')) {
    // [2026-10-16 onb-opening] esqueleto da lista + marca + status — desenhado
    // em tela cheia fora da coluna (ver <OpeningScreen> no layout).
    body = null;
  } else if (step === 'done') {
    const first = (name || '').trim().split(/\s+/)[0] || '';
    body = (
      <View style={{ alignItems: 'center', marginTop: 12 }}>
        <View style={[st.doneBadge, { backgroundColor: fg }]}>
          <IconCheck size={46} color={colors.background} strokeWidth={3} />
        </View>
        <Text style={[st.title, { color: fg, textAlign: 'center', marginTop: 18 }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          {first ? T('signupPhone.welcomeUser', `Bem-vindo, ${first}!`, { name: first }) : titles.done}
        </Text>
        <Text style={[st.sub, { color: sub, textAlign: 'center' }]}>{T('signupPhone.subDone', 'Sua conta foi criada — bora conversar')}</Text>
        {isNewAccount && <SignupConsentBlock colors={colors} style={{ marginTop: 28 }} />}
      </View>
    );
    footer = (
      <Primary label={T('onb.doneStart', 'Começar a conversar')} onPress={leaveToApp} disabled={!!legacyModal} testID="nob-start" />
    );
  }

  // [2026-10-15 onb-existing] "⋯" discreto: e-mail SÓ p/ conta antiga sem telefone (sem criar conta).
  const MoreBtn = (
    <Pressable
      onPress={() => { Keyboard.dismiss(); setMoreOpen(true); }}
      hitSlop={10}
      style={({ pressed }) => [st.iconBtn, { opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={T('nob.moreOptions', 'Mais opções')}
      testID="nob-more"
    >
      <IconMoreHorizontal size={22} color={sub} />
    </Pressable>
  );

  // ── layout ─────────────────────────────────────────────────────────────
  const showTop = FORM_STEPS.includes(step) || step === 'welcome';
  const formIdx = FORM_STEPS.indexOf(step);
  const padBottom = Math.max(Platform.OS === 'ios' ? 24 : 16, insets.bottom + 12);
  const topPad = Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : (Platform.OS === 'web' ? 12 : 44));

  return (
    <ThreadKeyboardAvoider style={[st.root, { backgroundColor: colors.background }]} bottomInset={padBottom - 12}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
      <View style={[st.column, { paddingTop: topPad }]}>
        {showTop && (
          <View style={st.topBar}>
            {step === 'welcome' ? MoreBtn : (
              <Pressable onPress={goBack} hitSlop={10} style={st.iconBtn} accessibilityRole="button" accessibilityLabel={T('a11y.back', 'Voltar')} testID="nob-back">
                <IconArrowLeft size={22} color={fg} />
              </Pressable>
            )}
            {formIdx >= 0 ? (
              <View style={st.progress} accessible accessibilityLabel={t('onb.stepLabel', { n: formIdx + 1, total: FORM_STEPS.length })}>
                {FORM_STEPS.map((s, i) => (
                  <View key={s} style={[st.seg, { backgroundColor: i <= formIdx ? fg : colors.border }]} />
                ))}
              </View>
            ) : <View style={{ flex: 1 }} />}
            {step === 'welcome' ? (
              <Pressable
                onPress={() => setShowLang(true)}
                hitSlop={8}
                style={({ pressed }) => [st.langBtn, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`${T('nob.language', 'Idioma do app')}: ${langLabel}`}
                testID="nob-language"
              >
                <IconGlobe size={16} color={fg} />
                <Text style={[st.langText, { color: fg }]} numberOfLines={1}>{langLabel}</Text>
              </Pressable>
            ) : (step === 'phone' ? MoreBtn : <View style={st.iconBtn} />)}
          </View>
        )}
        <Animated.View style={{ flex: 1, opacity: fade, transform: [{ translateX: shift }] }}>
          {step === 'welcome' ? (
            <View style={{ flex: 1 }}>{body}</View>
          ) : step === 'restore' ? (
            <View style={[st.scroll, { flex: 1 }]}>{body}</View>
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={st.scroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              showsVerticalScrollIndicator={false}
            >
              {body}
            </ScrollView>
          )}
          {footer ? <View style={[st.footer, { paddingBottom: padBottom }]}>{footer}</View> : <View style={{ height: padBottom }} />}
        </Animated.View>
      </View>

      {(step === 'finishing' || (step === 'restore' && restore?.kind !== 'own')) ? (
        <OpeningScreen
          colors={colors}
          T={T}
          reduced={reduced}
          topPad={topPad}
          bottomPad={padBottom}
          phase={legacyModal ? 'modal' : openPhase}
          onRetry={() => { if (openPhase === 'probe') goRestoreOrFinish(accountEmail, isNewAccount); }}
          onOpenNow={() => {
            probeGenRef.current += 1; // descarta a sondagem em voo
            if (isNewAccount) go('done', 1); else leaveToApp();
          }}
        />
      ) : null}

      <LoginPinResetSheet
        visible={pinResetOpen}
        challenge={lockChallenge}
        hasEmail={lockHasEmail}
        onClose={() => setPinResetOpen(false)}
        onChallengeExpired={() => { setLockRequired(false); setLockPin(''); setLockChallenge(''); setCode(''); }}
        onLoggedIn={onPinResetLoggedIn}
      />
      <CountryPicker
        visible={showCountry}
        onClose={() => setShowCountry(false)}
        onSelect={(cc) => { setCountryCode(cc); setShowCountry(false); setAccountExists(null); if (error) setError(''); }}
        selected={countryCode}
        suggested={[_deviceRegion(), 'BR', 'US', 'PT']}
        colors={colors}
        t={t}
        language={language}
        isDark={isDark}
      />
      <LanguageSheet
        visible={showLang}
        onClose={() => setShowLang(false)}
        language={language}
        onPick={(code) => { setShowLang(false); try { changeLanguage(code); } catch {} }}
        colors={colors}
        t={t}
      />

      {/* "É esse o número correto?" — WhatsApp confirma antes de enviar o código. */}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)} statusBarTranslucent>
        <View style={st.backdrop}>
          <View style={[st.dialog, { backgroundColor: colors.background, borderColor: colors.border }]} accessibilityViewIsModal testID="nob-confirm">
            <Text style={[st.dialogSub, { color: sub }]}>{T('signupPhone.confirmAsk', 'É esse o número correto?')}</Text>
            <Text style={[st.dialogPhone, { color: fg }]} testID="nob-confirm-number">{fullPhoneFormatted}</Text>
            <View style={st.dialogActions}>
              <Pressable onPress={() => setConfirmOpen(false)} style={({ pressed }) => [st.dialogBtn, { opacity: pressed ? 0.6 : 1 }]} accessibilityRole="button" testID="nob-confirm-edit">
                <Text style={[st.dialogBtnText, { color: fg }]}>{T('signupPhone.confirmEdit', 'Editar')}</Text>
              </Pressable>
              <Pressable
                onPress={() => { setConfirmOpen(false); sendOtp('sms'); }}
                style={({ pressed }) => [st.dialogBtn, st.dialogBtnPrimary, { backgroundColor: fg, opacity: pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                testID="nob-confirm-yes"
              >
                <Text style={[st.dialogBtnText, { color: colors.background }]}>{T('common.yes', 'Sim')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={moreOpen} transparent animationType="fade" onRequestClose={() => setMoreOpen(false)} statusBarTranslucent>
        <Pressable style={st.menuBackdrop} onPress={() => setMoreOpen(false)} accessibilityLabel={T('common.close', 'Fechar')}>
          <View
            style={[st.menu, { top: topPad + 44, backgroundColor: colors.background, borderColor: colors.border }, step === 'welcome' ? { left: 12 } : { right: 12 }]}
            accessibilityViewIsModal
            testID="nob-more-menu"
          >
            <Pressable
              onPress={() => { setMoreOpen(false); exitToLogin(); }}
              style={({ pressed }) => [st.menuRow, { backgroundColor: pressed ? colors.surfaceVariant : 'transparent' }]}
              accessibilityRole="button"
              testID="nob-email-login"
            >
              <IconAtSign size={18} color={fg} />
              <Text style={[st.menuText, { color: fg }]} maxFontSizeMultiplier={1.4}>{T('nob.emailLoginLegacy', 'Entrar com e-mail (conta antiga)')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Android: folha câmera/galeria (iOS usa ActionSheet nativo; web abre o seletor de arquivo). */}
      <Modal visible={photoSheet} transparent animationType="slide" onRequestClose={() => setPhotoSheet(false)} statusBarTranslucent>
        <Pressable style={st.sheetBackdrop} onPress={() => setPhotoSheet(false)}>
          <Pressable style={[st.sheet, { backgroundColor: colors.background, paddingBottom: insets.bottom + 12 }]} onPress={() => {}}>
            {[
              ['camera', T('signupPhone.takePhoto', 'Tirar foto')],
              ['library', T('signupPhone.chooseFromGallery', 'Escolher da galeria')],
              ...(avatarUri ? [['remove', T('nob.removePhoto', 'Remover foto')]] : []),
            ].map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => { if (k === 'remove') { setAvatarUri(null); setPhotoSheet(false); } else pickAvatar(k); }}
                style={({ pressed }) => [st.sheetRow, { backgroundColor: pressed ? colors.surfaceVariant : 'transparent' }]}
                accessibilityRole="button"
              >
                <Text style={[st.sheetText, { color: k === 'remove' ? (colors.error || fg) : fg }]}>{label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {legacyModal === 'backup' && Platform.OS !== 'web' ? (() => {
        const RestoreBackupPrompt = require('../RestoreBackupPrompt').default;
        return (
          <RestoreBackupPrompt
            visible
            backups={restore?.backups || []}
            onClose={() => { setLegacyModal(null); if (!isNewAccount) leaveToApp(); }}
          />
        );
      })() : null}
      {legacyModal === 'history' && Platform.OS !== 'web' ? (() => {
        const RestoreHistoryPrompt = require('../RestoreHistoryPrompt').default;
        return (
          <RestoreHistoryPrompt
            visible
            email={restore?.email || accountEmail}
            onClose={() => { setLegacyModal(null); if (!isNewAccount) leaveToApp(); }}
          />
        );
      })() : null}
    </ThreadKeyboardAvoider>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  column: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 48, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  existCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginTop: 16 },
  existIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  existTitle: { fontSize: 15, fontWeight: '700' },
  wbName: { fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 10, paddingHorizontal: 12 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' },
  menu: { position: 'absolute', minWidth: 240, maxWidth: 320, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 6, shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  menuText: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  progress: { flex: 1, flexDirection: 'row', gap: 6, paddingHorizontal: 8 },
  seg: { flex: 1, height: 3, borderRadius: 2 },
  langBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1, maxWidth: 180 },
  langText: { fontSize: 13, fontWeight: '600' },
  scroll: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 },
  footer: { paddingHorizontal: 24, paddingTop: 8, gap: 4 },
  welcome: { flex: 1 },
  welcomeTitle: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, textAlign: 'center', marginTop: 8 },
  welcomeSub: { fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 10, paddingHorizontal: 12 },
  terms: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 14, paddingHorizontal: 8 },
  termsSmall: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginBottom: 10, paddingHorizontal: 8 },
  link: { fontWeight: '700', textDecorationLine: 'underline' },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, lineHeight: 36, marginBottom: 8 },
  sub: { fontSize: 16, lineHeight: 23 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 8, minHeight: 18 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 14 },
  noteText: { flex: 1, fontSize: 13 },
  noteLink: { fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  countryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 22 },
  countryName: { flex: 1, fontSize: 17, fontWeight: '600' },
  phoneRow: { flexDirection: 'row', alignItems: 'center', minHeight: 60, borderBottomWidth: 1.5 },
  dial: { fontSize: 24, fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: 0, includeFontPadding: false },
  vline: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: 10 },
  phoneInput: { flex: 1, minWidth: 0, fontSize: 24, fontWeight: '600', letterSpacing: 0, paddingVertical: 0, paddingHorizontal: 0, fontVariant: ['tabular-nums'], includeFontPadding: false, textAlignVertical: 'center' },
  phoneCheck: { width: 26, alignItems: 'flex-end', justifyContent: 'center' },
  errRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12 },
  errText: { flex: 1, fontSize: 13, lineHeight: 18 },
  primary: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryText: { fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  primaryBig: { height: 56, borderRadius: 16 },
  primaryTextBig: { fontSize: 17 },
  secondary: { height: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  channelCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, marginTop: 14 },
  channelTitle: { fontSize: 14, fontWeight: '700' },
  channelSub: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  otpActions: { alignItems: 'center', gap: 10, marginTop: 18 },
  pill: { paddingVertical: 11, paddingHorizontal: 18, borderRadius: 999, minHeight: 44, justifyContent: 'center' },
  pillText: { fontSize: 14, fontWeight: '700' },
  pinTitle: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  pinSub: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 4, marginBottom: 10 },
  pin: { alignSelf: 'center', width: 180, height: 52, borderRadius: 12, borderWidth: 1.5, textAlign: 'center', fontSize: 22, fontWeight: '700', letterSpacing: 8 },
  avatarWrap: { alignSelf: 'center', marginTop: 24, marginBottom: 18 },
  avatar: { width: 128, height: 128, borderRadius: 64 },
  avatarBadge: { position: 'absolute', right: 2, bottom: 2, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 3 },
  field: { fontSize: 18, paddingVertical: 14, borderBottomWidth: 1.5, marginTop: 6 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: 1.5, marginTop: 22, minHeight: 56 },
  userInput: { flex: 1, minWidth: 0, fontSize: 20, fontWeight: '600', paddingVertical: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: '600' },
  permWrap: { flex: 1, paddingTop: 12 },
  finishing: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120 },
  permStep: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  permTitle: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center', marginTop: 18 },
  permSub: { fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 10, paddingHorizontal: 6 },
  permFine: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 14, paddingHorizontal: 6 },
  camNote: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, padding: 12, marginTop: 22 },
  camNoteText: { flex: 1, fontSize: 12, lineHeight: 17 },
  doneBadge: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  dialog: { width: '100%', maxWidth: 360, borderRadius: 20, padding: 22, borderWidth: StyleSheet.hairlineWidth },
  dialogSub: { fontSize: 15, textAlign: 'center' },
  dialogPhone: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 10, fontVariant: ['tabular-nums'] },
  dialogActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  dialogBtn: { flex: 1, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dialogBtnPrimary: {},
  dialogBtnText: { fontSize: 15, fontWeight: '700' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8 },
  sheetRow: { minHeight: 54, justifyContent: 'center', paddingHorizontal: 24 },
  sheetText: { fontSize: 16, fontWeight: '600' },
});
