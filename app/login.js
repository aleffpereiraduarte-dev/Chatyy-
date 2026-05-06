import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Animated, useWindowDimensions, Modal, FlatList, Pressable, Image, Alert,
  Easing, Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSun, IconMoon, IconAlertTriangle,
  IconEye, IconEyeOff,
  IconMailLogo, IconShield, IconGlobe,
  IconMail, IconMessageSquare, IconCloud,
  IconUsers, IconCheck, IconX, IconPhone, IconLock,
  IconChevronRight, IconChevronDown, IconRefresh,
} from '../components/Icons';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import { LANGUAGES } from '../i18n';
import * as api from '../services/api';
import useDebouncedCallback from '../hooks/useDebouncedCallback';
// COUNTRIES (with masks/maxDigits) used to power format-as-you-type. The
// local COUNTRY_CODES list above (dial-keyed) handles the picker chip; we
// look up the matching mask from the canonical list at typing time.
import { COUNTRIES as COUNTRIES_FULL, formatPhone } from '../constants/countries';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Svg, { Path, Rect, Circle as SvgCircle, Defs, Pattern, Line, RadialGradient, Stop, Mask } from 'react-native-svg';

// Tiny wrapper so haptic calls never throw on web or older devices.
const safeHaptic = (fn) => { try { fn?.(); } catch {} };

/* ─── Premium login — polished, animated, modern ─── */

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState('');
  const [step, setStep] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const { login, completeLoginAfterChallenge, loginWithToken } = useAuth();
  const { colors, isDark, toggle } = useTheme();
  const { t, language, changeLanguage } = useLanguage();
  const [showLangModal, setShowLangModal] = useState(false);
  const router = useRouter();
  const params = useLocalSearchParams();
  const isAddAccount = params.add_account === '1';

  // Deep-link return path: if the user arrived here from a protected URL
  // (?next=/chat-conversation?id=X), bounce back there after login. Guard
  // against open-redirect by only honouring paths that start with '/'.
  const postLoginTarget = (() => {
    const raw = typeof params?.next === 'string' ? params.next : (Array.isArray(params?.next) ? params.next[0] : '');
    if (!raw) return null;
    try {
      const decoded = decodeURIComponent(raw);
      if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
      return decoded;
    } catch { return null; }
  })();
  // Mobile-first: after login, go to /chat (WhatsApp-like entry). Desktop
  // keeps the email-first inbox entry. Kids always land on /chat. Mirrors
  // app/index.js routing so Face ID login doesn't drop mobile users on
  // the email inbox (they kept reporting "Face ID didn't go anywhere"
  // because /inbox looked empty until email sync completed).
  const defaultTarget = (isKids) => {
    if (isKids) return '/chat';
    const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
    const isMobile = Platform.OS !== 'web' || w < 768;
    return isMobile ? '/chat' : '/inbox';
  };
  // Delay navigation by one tick to let the setUser state propagate through
  // AuthContext. _layout.js has a gate that redirects unauthenticated users
  // to /login — if router.replace fires synchronously after setUser, the
  // gate can run on the new route BEFORE it sees the new user (React state
  // batching), kicking users back to /login. Users reported this as
  // "Face ID read but didn't go anywhere". 100ms is imperceptible to users
  // but reliably later than React's commit phase.
  const goAfterLogin = (isKids) => {
    const target = postLoginTarget || defaultTarget(isKids);
    setTimeout(() => {
      if (mountedRef.current) router.replace(target);
    }, 100);
  };
  const { width } = useWindowDimensions();
  const mountedRef = useRef(true);
  const passwordRef = useRef(null);

  // QR Code login state
  const isDesktop = Platform.OS === 'web' && width >= 768;
  // Smart default — WhatsApp pattern: desktop opens straight to QR (pair with
  // your phone), mobile opens to phone-OTP. Email/password becomes the
  // "advanced" tab for legacy accounts. Persists nothing — fresh load each
  // open is fine since there's no logged-in state at this point anyway.
  const [loginMode, setLoginMode] = useState(isDesktop ? 'qr' : 'phone');

  // Phone login state
  // Pre-fill phone if signup-phone bounced this user back here (their
  // number already had an account). Strip the dial code so the input
  // shows just the local digits — country picker shows the dial prefix.
  const [phoneNumber, setPhoneNumber] = useState(() => {
    try {
      const raw = String(params?.phone || '').replace(/[^0-9]/g, '');
      if (!raw) return '';
      // Best-effort strip of country code: if it starts with 55 and is BR-shaped,
      // drop the 55 prefix. For other countries the full number is fine.
      if (raw.startsWith('55') && raw.length >= 12) return raw.slice(2);
      if (raw.startsWith('1') && raw.length === 11) return raw.slice(1); // US/CA
      return raw;
    } catch { return ''; }
  });
  const [phoneCountryCode, setPhoneCountryCode] = useState('+55');
  const [phoneOtp, setPhoneOtp] = useState(['', '', '', '', '', '']);
  const [phoneOtpFocused, setPhoneOtpFocused] = useState(false);
  const [phoneStep, setPhoneStep] = useState('input'); // 'input' or 'otp'
  const [phoneSending, setPhoneSending] = useState(false);
  const [phoneVerifying, setPhoneVerifying] = useState(false);
  const [phoneResendTimer, setPhoneResendTimer] = useState(0);
  // Smart-detect: as the user types a phone, ping the backend to see
  // whether that number already has a Chatyy account so we can swap the
  // CTA copy ("Entrar" vs "Criar conta") and reassure the user that the
  // SMS will reach the right inbox. WhatsApp/iMessage parity.
  const [phoneAccountState, setPhoneAccountState] = useState({ status: 'idle', phone: '' });
  const phoneOtpRefs = useRef([]);
  const phoneResendRef = useRef(null);
  const [qrToken, setQrToken] = useState(null);
  const [qrCountdown, setQrCountdown] = useState(60);
  const [qrStatus, setQrStatus] = useState('idle'); // idle, loading, pending, confirmed, expired
  const [qrScanToken, setQrScanToken] = useState(''); // mobile: paste token to confirm
  const [qrScanLoading, setQrScanLoading] = useState(false);
  const [qrScanMessage, setQrScanMessage] = useState('');
  const [showQrScanner, setShowQrScanner] = useState(false);
  const qrPollRef = useRef(null);
  const qrCountdownRef = useRef(null);

  // Device verification state (Google-style new device check)
  const [verificationStep, setVerificationStep] = useState(null); // null, 'waiting', 'approved', 'denied'
  const [challengeId, setChallengeId] = useState(null);
  const [challengeDeviceInfo, setChallengeDeviceInfo] = useState('');
  const challengePollRef = useRef(null);
  const challengeEmailRef = useRef('');

  // Remember me state
  const [rememberMe, setRememberMe] = useState(true);

  // Biometric login state (native only)
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);
  const isNative = Platform.OS !== 'web';

  // Simple fade-in animation
  const cardFadeAnim = useRef(new Animated.Value(0)).current;

  // Build diagnostic — 5-tap handler state on the version label at the bottom
  // of the login card. Users stuck on phantom-logged-in sessions can tap it
  // to wipe all local auth state in one place.
  const buildTapCountRef = useRef(0);
  const buildLabel = useMemo(() => {
    try {
      const c = require('expo-constants').default;
      const ea = c?.expoConfig || c?.manifest || {};
      const ver = ea.version || '?';
      const ios = ea.ios?.buildNumber || '';
      const and = ea.android?.versionCode || '';
      let ota = '';
      try {
        const Updates = require('expo-updates');
        ota = (Updates?.updateId || '').slice(0, 7) || (Updates?.isEmbeddedLaunch ? 'embedded' : '');
      } catch {}
      return `v${ver} · b${ios || and} · ${ota}`;
    } catch {
      return 'v?';
    }
  }, []);

  // Track which biometric the device uses so we can render the right SVG
  // (Face ID vs Touch ID vs generic fingerprint for Android).
  const [bioType, setBioType] = useState('none'); // 'face' | 'touch' | 'fingerprint' | 'none'

  // Check biometric availability on mount (native only)
  useEffect(() => {
    if (!isNative) return;
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        // Show the button whenever the device has Face ID / Touch ID enrolled,
        // even if there are no saved creds yet. On tap, if no creds exist we
        // just advance to the normal password flow (handled in
        // handleBiometricLogin) — matches Telegram/banking UX where Face ID
        // is always visible, not hidden behind "log in once first".
        if (hasHw && isEnrolled) {
          setBioAvailable(true);
          // Detect biometric kind for icon
          try {
            const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
            const isFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
            const isIris = types.includes(LocalAuthentication.AuthenticationType.IRIS);
            if (isFace) setBioType('face');
            else if (Platform.OS === 'ios') setBioType('touch');
            else setBioType('fingerprint');
          } catch { setBioType(Platform.OS === 'ios' ? 'touch' : 'fingerprint'); }

          // Auto-prompt is reserved for the Email tab — the Phone tab is the
          // default and shouldn't fire Face ID on cold start (user pediu pra
          // não abrir Face ID na home antes de escolher email login).
          // The Face ID button stays available inside the email tab; tapping
          // it triggers handleBiometricLogin manually.
        }
      } catch {}
    })();
  }, []);

  // Ref so the auto-trigger above can call the latest handler without adding
  // it to the useEffect deps (would re-fire on every state change).
  const handleBiometricLoginRef = useRef(null);

  const handleBiometricLogin = useCallback(async () => {
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    setBioLoading(true);
    setError('');
    try {
      // Read saved identifiers BEFORE triggering authenticateAsync — this
      // lets us short-circuit to the normal password flow when we have
      // nothing saved, instead of prompting Face ID on an unknown account.
      const savedEmail = await SecureStore.getItemAsync('bio_email');
      const savedToken = await SecureStore.getItemAsync('bio_token');
      const legacyPassword = !savedToken ? await SecureStore.getItemAsync('bio_password') : null;

      // First time on this device: no saved email. Surface a clear hint so
      // the user knows why Face ID isn't doing anything — silent return left
      // taps on the Face ID button feeling broken. Shake + warning haptic
      // mirror the rest of the auth feedback in this screen.
      if (!savedEmail) {
        setError(t('login.biometricNoCredentials') || 'Entre com email e senha pelo menos uma vez para ativar o Face ID/Touch ID.');
        shake();
        safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
        if (mountedRef.current) setBioLoading(false);
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('login.biometric'),
        cancelLabel: t('login.back'),
        disableDeviceFallback: false,
      });
      // User cancelled or Face ID failed — dismiss silently. iOS already
      // showed "Try again"/fallback UI if the scan actually failed.
      if (!result.success) {
        if (mountedRef.current) setBioLoading(false);
        return;
      }

      if (savedToken) {
        setLoading(true);
        const r = await loginWithToken(savedToken, savedEmail);
        if (!mountedRef.current) return;
        if (r.success) {
          goAfterLogin(r.data?.is_child || isChildAccount());
        } else {
          // Token expired — clear it but keep bio_email. Pre-fill + advance
          // to password step; successful password login refreshes bio_token.
          // DIAGNOSTIC: include the server rejection reason in the error
          // so we can see exactly why the token isn't working (user reports
          // "Face ID pede senha" without knowing why).
          try { await SecureStore.deleteItemAsync('bio_token'); } catch {}
          try { setEmail(savedEmail); setStep(2); } catch {}
          const reason = r?.message ? ` (${r.message.slice(0, 60)})` : '';
          setError((t('login.biometricExpired') || 'Sessão expirada. Digite a senha para reativar o Face ID.') + reason);
        }
      } else if (legacyPassword) {
        setLoading(true);
        const r = await login(savedEmail, legacyPassword);
        if (!mountedRef.current) return;
        if (r.success) {
          try {
            const newToken = api.getToken?.();
            if (newToken) await SecureStore.setItemAsync('bio_token', newToken);
            await SecureStore.deleteItemAsync('bio_password');
          } catch {}
          goAfterLogin(r.data?.is_child || isChildAccount());
        } else {
          try { await SecureStore.deleteItemAsync('bio_password'); } catch {}
          try { setEmail(savedEmail); setStep(2); } catch {}
        }
      } else {
        // Biometric OK but nothing to log in with — advance to password
        // step. Most common cause: first login didn't save the bearer token
        // (api.getToken() returned empty at save-time). User needs to login
        // with password ONCE so the token gets stashed in SecureStore for
        // next time.
        try { setEmail(savedEmail); setStep(2); } catch {}
        setError('Token não salvo. Entre com senha 1x para ativar o Face ID.');
      }
    } catch {
      // Real exception only — user cancellation is the !result.success branch.
      if (!mountedRef.current) return;
      setError(t('login.biometricError'));
      shake();
    } finally {
      if (mountedRef.current) { setBioLoading(false); setLoading(false); }
    }
  }, [t, login, router]);
  // Keep the ref pointing at the latest handler so the cold-start auto-prompt
  // can fire it without stale-closure bugs.
  handleBiometricLoginRef.current = handleBiometricLogin;

  // Step transition + error shake
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  // Simple IG-style entrance: card fade + 12pt slide-up in 200ms parallel.
  // Logo scale-pop is preserved (kept as a lightweight spring) but the
  // 3-stagger choreography + breathing pulse loop were removed — they read
  // as cargo-cult on a login screen and competed for attention with the
  // hero. Keep things calm.
  const logoScaleAnim = useRef(new Animated.Value(0)).current;
  const titleAnim = useRef(new Animated.Value(1)).current; // 1 = shown (no longer animated)
  const cardSlideAnim = useRef(new Animated.Value(12)).current; // 12 = below
  const logoPulseAnim = useRef(new Animated.Value(1)).current; // kept at 1; no pulse loop
  // Telegram-grade breathing: scale 1 → 1.04 → 1 over 2.6s. Layered with the
  // entrance pop (logoScaleAnim) via Animated.multiply so the breath kicks in
  // only after the pop settles. Halo opacity pulses out-of-phase for depth.
  const logoBreathAnim = useRef(new Animated.Value(1)).current;
  const haloAnim = useRef(new Animated.Value(0.5)).current;
  // Two background gradient orbs that drift slowly. Subtle parallax — not
  // looking to be distracting, just adds texture so the screen doesn't
  // feel flat. Orb 1 drifts top-right, orb 2 bottom-left, both ~6s loops.
  const orb1Anim = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const orb2Anim = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // Per-cell scale for the 6-digit OTP. handlePhoneOtpFullChange pops
  // the matching cell from 0.85 → 1 with a tight spring on each new digit
  // so the user gets tactile per-keystroke feedback (Telegram parity).
  const phoneOtpCellAnims = useRef([
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
  ]).current;
  // Success overlay — full-screen tinted layer with a big animated check
  // that pops in after OTP/password validates. Bridges the ~800ms gap
  // between auth completing and the router.replace to /inbox so the user
  // sees a confirmation instead of a frozen screen.
  const [loginSuccess, setLoginSuccess] = useState(false);
  const successAnim = useRef(new Animated.Value(0)).current;
  // Focus ring animations (native — web uses CSS box-shadow transition).
  // Each input row gets its own ring opacity 0→1 in 140ms when focused.
  const emailRingAnim = useRef(new Animated.Value(0)).current;
  const passRingAnim = useRef(new Animated.Value(0)).current;
  // Primary CTA press scale + branded 3-dot pulse loop.
  const ctaScaleAnim = useRef(new Animated.Value(1)).current;
  const dotAnims = useRef([
    new Animated.Value(0.3),
    new Animated.Value(0.3),
    new Animated.Value(0.3),
  ]).current;

  // Animate focus ring opacity on focus state change. Native only — web uses
  // CSS box-shadow transition baked into the style.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Animated.timing(emailRingAnim, {
      toValue: focused === 'email' ? 1 : 0,
      duration: 140, useNativeDriver: true,
    }).start();
    Animated.timing(passRingAnim, {
      toValue: focused === 'pass' ? 1 : 0,
      duration: 140, useNativeDriver: true,
    }).start();
  }, [focused]);


  // 3-dot pulse — staggered loop. Each dot fades 0.3→1→0.3 in 480ms with
  // 120ms stagger so they "wave" left to right. Driven by useNativeDriver
  // so it stays smooth even during heavy JS work (login fetch).
  useEffect(() => {
    const animations = dotAnims.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 120),
          Animated.timing(dot, { toValue: 1, duration: 240, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 240, useNativeDriver: true }),
        ])
      )
    );
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // Single 200ms parallel: card fades in + slides up 12pt. Logo pop runs in
    // parallel so it doesn't block the main entrance.
    Animated.parallel([
      Animated.spring(logoScaleAnim, {
        toValue: 1, tension: 60, friction: 7, useNativeDriver: true,
      }),
      Animated.timing(cardFadeAnim, { toValue: 1, duration: 250, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }),
      Animated.timing(cardSlideAnim, { toValue: 0, duration: 250, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }),
    ]).start(() => {
      // Start ambient loops after the entrance settles (avoids fighting the
      // pop). Breath: 1 → 1.04 → 1 over 2.6s. Halo: opacity sine wave 0.3↔0.7
      // over 2.6s, offset 1.3s so it pulses out-of-phase with the breath.
      Animated.loop(
        Animated.sequence([
          Animated.timing(logoBreathAnim, { toValue: 1.04, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(logoBreathAnim, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ])
      ).start();
      Animated.loop(
        Animated.sequence([
          Animated.timing(haloAnim, { toValue: 0.75, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(haloAnim, { toValue: 0.35, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ])
      ).start();
      // Background orbs drift in opposite slow circles. Both run for the
      // session lifetime — cheap (translate-only, native-driver friendly).
      Animated.loop(
        Animated.sequence([
          Animated.timing(orb1Anim, { toValue: { x: 14, y: -10 }, duration: 5200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(orb1Anim, { toValue: { x: 0, y: 0 }, duration: 5200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      ).start();
      Animated.loop(
        Animated.sequence([
          Animated.timing(orb2Anim, { toValue: { x: -16, y: 12 }, duration: 6400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(orb2Anim, { toValue: { x: 0, y: 0 }, duration: 6400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      ).start();
    });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const animateStep = (next) => {
    // Telegram-grade horizontal slide: full ~140px shift instead of the
    // subtle 30px so the transition feels like the screen is *traveling*
    // forward (next=2) or back (next=1). Outgoing fades + slides off,
    // then the incoming arrives from the opposite side with a spring
    // settle. Ease-out on the outgoing side so it doesn't drag.
    const SHIFT = 140;
    const out = next === 2 ? -SHIFT : SHIFT;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 160, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: out, duration: 160, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }),
    ]).start(() => {
      setStep(next);
      if (next === 1) setError('');
      slideAnim.setValue(-out);
      Animated.parallel([
        Animated.spring(fadeAnim, { toValue: 1, tension: 80, friction: 10, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, tension: 80, friction: 10, useNativeDriver: true }),
      ]).start(() => {
        if (next === 2) passwordRef.current?.focus();
      });
    });
  };

  const shake = () => {
    safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleContinue = () => {
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    const trimmed = email.trim();
    if (!trimmed) { setError(t('login.errorEmail')); shake(); return; }
    if (trimmed.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t('login.errorEmail')); shake(); return;
    }
    setError('');
    animateStep(2);
  };

  const handleLogin = async () => {
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    if (!password) { setError(t('login.errorPassword')); shake(); return; }
    setError('');
    setLoading(true);
    try {
      const fullEmail = email.includes('@') ? email : `${email}@chatyy.com.br`;
      const r = await login(fullEmail, password);
      if (!mountedRef.current) return;
      if (r.success) {
        // Check if device verification is required
        if (r.data?.requires_verification) {
          setChallengeId(r.data.challenge_id);
          setChallengeDeviceInfo(r.data.device_info || '');
          challengeEmailRef.current = fullEmail;
          setVerificationStep('waiting');
          setLoading(false);
          startChallengePoll(r.data.challenge_id, fullEmail);
          return;
        }
        // Save opaque auth token for biometric login (server-revocable).
        // Diagnostic: warn on screen if we're about to save an empty token
        // so users whose Face ID "doesn't work" can tell us — the most
        // common cause of "Face ID asks for password" has been a silently
        // empty bio_token from a login that succeeded without a token in
        // the response body.
        if (Platform.OS !== 'web') {
          try {
            const tok = api.getToken?.() || r.data?.token || r.token;
            await SecureStore.setItemAsync('bio_email', fullEmail);
            if (tok) {
              await SecureStore.setItemAsync('bio_token', tok);
            } else {
              console.warn('[login] bio_token NOT saved — api.getToken() + r.data.token both empty. Face ID will not work until next manual login.');
            }
            // Clean up legacy password if present
            await SecureStore.deleteItemAsync('bio_password').catch(() => {});
          } catch (e) {
            console.warn('[login] SecureStore save failed:', e?.message);
          }
        }
        // Kids go to chat, adults go to inbox
        safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
        const isKids = r.data?.is_child || isChildAccount();
        goAfterLogin(isKids);
      } else {
        // Backend returns "Incorrect email or password" in English + various
        // generic transport errors ("Servidor indisponivel", "Login failed").
        // For any of those, show the translated credential error — only show
        // the raw backend message if it's a specific PT-BR one we don't know.
        const rawMsg = r.message || '';
        const isCredError = /incorrect|invalid|wrong|credencia|senha|password|email/i.test(rawMsg);
        const isGeneric = /servidor|indispon|unavail|connection|login failed|tempo limite/i.test(rawMsg);
        if (!rawMsg || isCredError || isGeneric) {
          setError(t('login.errorCredentials'));
        } else {
          setError(rawMsg);
        }
        shake();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection'));
      shake();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // --- Device verification challenge polling ---
  const startChallengePoll = useCallback((chId, chEmail) => {
    if (challengePollRef.current) clearInterval(challengePollRef.current);
    challengePollRef.current = setInterval(async () => {
      try {
        const r = await api.checkLoginChallenge(chId, chEmail);
        if (!mountedRef.current) return;
        if (r.success && r.data) {
          if (r.data.status === 'approved') {
            clearInterval(challengePollRef.current);
            challengePollRef.current = null;
            setVerificationStep('approved');
            // Complete login with received data
            if (r.data.token) {
              completeLoginAfterChallenge(r.data);
              // Save biometric creds
              if (Platform.OS !== 'web') {
                try {
                  const tok = r.data?.token || api.getToken?.();
                  await SecureStore.setItemAsync('bio_email', chEmail);
                  if (tok) await SecureStore.setItemAsync('bio_token', tok);
                  await SecureStore.deleteItemAsync('bio_password').catch(() => {});
                } catch {}
              }
              setTimeout(() => {
                if (mountedRef.current) router.replace(isChildAccount() ? '/chat' : '/inbox');
              }, 800);
            }
          } else if (r.data.status === 'denied') {
            clearInterval(challengePollRef.current);
            challengePollRef.current = null;
            setVerificationStep('denied');
          }
          // 'pending' — keep polling
        }
      } catch {}
    }, 2000);
  }, [password, completeLoginAfterChallenge, router]);

  // Cleanup challenge poll on unmount
  useEffect(() => {
    return () => {
      if (challengePollRef.current) {
        clearInterval(challengePollRef.current);
        challengePollRef.current = null;
      }
    };
  }, []);

  const handleCancelVerification = useCallback(() => {
    if (challengePollRef.current) {
      clearInterval(challengePollRef.current);
      challengePollRef.current = null;
    }
    setVerificationStep(null);
    setChallengeId(null);
    setChallengeDeviceInfo('');
    setError('');
  }, []);

  const handleRetryDenied = useCallback(() => {
    setVerificationStep(null);
    setChallengeId(null);
    setError('');
  }, []);

  // ── QR Code Login Logic ──
  const generateQR = useCallback(async () => {
    setQrStatus('loading');
    try {
      const res = await api.qrGenerate();
      if (!mountedRef.current) return;
      if (res.success && res.data?.token) {
        setQrToken(res.data.token);
        setQrCountdown(res.data.expires_in || 60);
        setQrStatus('pending');
      } else {
        setQrStatus('idle');
        setError(res.message || 'Failed to generate QR code');
      }
    } catch {
      if (!mountedRef.current) return;
      setQrStatus('idle');
      setError(t('login.errorConnection'));
    }
  }, [t]);

  // Auto-generate QR when switching to QR mode (desktop) - only once
  const qrGeneratedRef = useRef(false);
  useEffect(() => {
    if (loginMode === 'qr' && isDesktop && !qrGeneratedRef.current) {
      qrGeneratedRef.current = true;
      generateQR();
    }
    if (loginMode !== 'qr') qrGeneratedRef.current = false;
  }, [loginMode, isDesktop]);

  // Polling loop for QR check
  useEffect(() => {
    if (qrStatus !== 'pending' || !qrToken) return;
    qrPollRef.current = setInterval(async () => {
      try {
        const res = await api.qrCheck(qrToken);
        if (!mountedRef.current) return;
        if (res.data?.status === 'confirmed') {
          clearInterval(qrPollRef.current);
          clearInterval(qrCountdownRef.current);
          setQrStatus('confirmed');
          // Auto-login with the received auth token
          if (res.data.auth_token && res.data.email) {
            await loginWithToken(res.data.auth_token, res.data.email);
            setTimeout(() => {
              if (mountedRef.current) router.replace(isChildAccount() ? '/chat' : '/inbox');
            }, 800);
          }
        } else if (res.data?.status === 'expired') {
          clearInterval(qrPollRef.current);
          clearInterval(qrCountdownRef.current);
          setQrStatus('expired');
        }
      } catch { /* ignore poll errors */ }
    }, 2000);
    return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
  }, [qrStatus, qrToken, router, loginWithToken]);

  // Countdown timer
  useEffect(() => {
    if (qrStatus !== 'pending') return;
    qrCountdownRef.current = setInterval(() => {
      setQrCountdown(prev => {
        if (prev <= 1) {
          clearInterval(qrCountdownRef.current);
          clearInterval(qrPollRef.current);
          setQrStatus('expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (qrCountdownRef.current) clearInterval(qrCountdownRef.current); };
  }, [qrStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      if (qrCountdownRef.current) clearInterval(qrCountdownRef.current);
    };
  }, []);

  // Mobile: QR confirm (scan/paste token)
  const handleQrScanConfirm = async () => {
    let token = qrScanToken.trim();
    // Extract token from chatyy://qr/{token} URL format
    const match = token.match(/chatyy:\/\/qr\/([a-f0-9]{64})/i);
    if (match) token = match[1];
    // Also support raw URL with token param
    const urlMatch = token.match(/[?&]token=([a-f0-9]{64})/i);
    if (urlMatch) token = urlMatch[1];

    if (!token || token.length !== 64 || !/^[a-f0-9]+$/i.test(token)) {
      setQrScanMessage(t('login.qrScanInvalid'));
      return;
    }
    setQrScanLoading(true);
    setQrScanMessage('');
    try {
      const res = await api.qrConfirm(token);
      if (res.success) {
        setQrScanMessage(t('login.qrScanSuccess'));
        setTimeout(() => {
          if (mountedRef.current) {
            setShowQrScanner(false);
            setQrScanToken('');
            setQrScanMessage('');
          }
        }, 2000);
      } else {
        setQrScanMessage(res.message || t('login.qrScanError'));
      }
    } catch {
      setQrScanMessage(t('login.qrScanError'));
    } finally {
      if (mountedRef.current) setQrScanLoading(false);
    }
  };

  const handleRefreshQR = () => {
    setQrToken(null);
    setQrCountdown(60);
    setError('');
    generateQR();
  };

  // ── Phone Login Handlers ──
  const COUNTRY_CODES = [
    { code: '+55', flag: '\uD83C\uDDE7\uD83C\uDDF7', name: 'Brasil', label: 'BR +55' },
    { code: '+1', flag: '\uD83C\uDDFA\uD83C\uDDF8', name: 'Estados Unidos', label: 'US +1' },
    { code: '+351', flag: '\uD83C\uDDF5\uD83C\uDDF9', name: 'Portugal', label: 'PT +351' },
    { code: '+34', flag: '\uD83C\uDDEA\uD83C\uDDF8', name: 'Espanha', label: 'ES +34' },
    { code: '+52', flag: '\uD83C\uDDF2\uD83C\uDDFD', name: 'Mexico', label: 'MX +52' },
    { code: '+44', flag: '\uD83C\uDDEC\uD83C\uDDE7', name: 'Reino Unido', label: 'UK +44' },
    { code: '+49', flag: '\uD83C\uDDE9\uD83C\uDDEA', name: 'Alemanha', label: 'DE +49' },
    { code: '+33', flag: '\uD83C\uDDEB\uD83C\uDDF7', name: 'Franca', label: 'FR +33' },
    { code: '+39', flag: '\uD83C\uDDEE\uD83C\uDDF9', name: 'Italia', label: 'IT +39' },
    { code: '+81', flag: '\uD83C\uDDEF\uD83C\uDDF5', name: 'Japao', label: 'JP +81' },
    { code: '+54', flag: '\uD83C\uDDE6\uD83C\uDDF7', name: 'Argentina', label: 'AR +54' },
    { code: '+56', flag: '\uD83C\uDDE8\uD83C\uDDF1', name: 'Chile', label: 'CL +56' },
    { code: '+57', flag: '\uD83C\uDDE8\uD83C\uDDF4', name: 'Colombia', label: 'CO +57' },
    { code: '+51', flag: '\uD83C\uDDF5\uD83C\uDDEA', name: 'Peru', label: 'PE +51' },
    { code: '+91', flag: '\uD83C\uDDEE\uD83C\uDDF3', name: 'India', label: 'IN +91' },
    { code: '+86', flag: '\uD83C\uDDE8\uD83C\uDDF3', name: 'China', label: 'CN +86' },
    { code: '+82', flag: '\uD83C\uDDF0\uD83C\uDDF7', name: 'Coreia do Sul', label: 'KR +82' },
    { code: '+61', flag: '\uD83C\uDDE6\uD83C\uDDFA', name: 'Australia', label: 'AU +61' },
    { code: '+7', flag: '\uD83C\uDDF7\uD83C\uDDFA', name: 'Russia', label: 'RU +7' },
    { code: '+27', flag: '\uD83C\uDDFF\uD83C\uDDE6', name: 'Africa do Sul', label: 'ZA +27' },
    { code: '+234', flag: '\uD83C\uDDF3\uD83C\uDDEC', name: 'Nigeria', label: 'NG +234' },
    { code: '+971', flag: '\uD83C\uDDE6\uD83C\uDDEA', name: 'Emirados Arabes', label: 'AE +971' },
    { code: '+966', flag: '\uD83C\uDDF8\uD83C\uDDE6', name: 'Arabia Saudita', label: 'SA +966' },
    { code: '+972', flag: '\uD83C\uDDEE\uD83C\uDDF1', name: 'Israel', label: 'IL +972' },
    { code: '+48', flag: '\uD83C\uDDF5\uD83C\uDDF1', name: 'Polonia', label: 'PL +48' },
    { code: '+31', flag: '\uD83C\uDDF3\uD83C\uDDF1', name: 'Holanda', label: 'NL +31' },
    { code: '+46', flag: '\uD83C\uDDF8\uD83C\uDDEA', name: 'Suecia', label: 'SE +46' },
    { code: '+41', flag: '\uD83C\uDDE8\uD83C\uDDED', name: 'Suica', label: 'CH +41' },
    { code: '+90', flag: '\uD83C\uDDF9\uD83C\uDDF7', name: 'Turquia', label: 'TR +90' },
    { code: '+62', flag: '\uD83C\uDDEE\uD83C\uDDE9', name: 'Indonesia', label: 'ID +62' },
    { code: '+63', flag: '\uD83C\uDDF5\uD83C\uDDED', name: 'Filipinas', label: 'PH +63' },
    { code: '+66', flag: '\uD83C\uDDF9\uD83C\uDDED', name: 'Tailandia', label: 'TH +66' },
    { code: '+84', flag: '\uD83C\uDDFB\uD83C\uDDF3', name: 'Vietna', label: 'VN +84' },
    { code: '+20', flag: '\uD83C\uDDEA\uD83C\uDDEC', name: 'Egito', label: 'EG +20' },
    { code: '+212', flag: '\uD83C\uDDF2\uD83C\uDDE6', name: 'Marrocos', label: 'MA +212' },
    { code: '+598', flag: '\uD83C\uDDFA\uD83C\uDDFE', name: 'Uruguai', label: 'UY +598' },
    { code: '+595', flag: '\uD83C\uDDF5\uD83C\uDDFE', name: 'Paraguai', label: 'PY +595' },
    { code: '+591', flag: '\uD83C\uDDE7\uD83C\uDDF4', name: 'Bolivia', label: 'BO +591' },
    { code: '+593', flag: '\uD83C\uDDEA\uD83C\uDDE8', name: 'Equador', label: 'EC +593' },
    { code: '+58', flag: '\uD83C\uDDFB\uD83C\uDDEA', name: 'Venezuela', label: 'VE +58' },
  ];
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const filteredCountries = useMemo(() => {
    if (!countrySearch) return COUNTRY_CODES;
    const q = countrySearch.toLowerCase();
    return COUNTRY_CODES.filter(c => c.name.toLowerCase().includes(q) || c.code.includes(q) || c.label.toLowerCase().includes(q));
  }, [countrySearch]);

  const handlePhoneSendOtp = async () => {
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    if (cleaned.length < 8) { setError(t('login.phoneInvalid')); shake(); return; }
    setError('');
    setPhoneSending(true);
    try {
      const fullPhone = phoneCountryCode + cleaned;
      const r = await api.requestPhoneOtp(fullPhone);
      if (!mountedRef.current) return;
      // Backend returns success:true with exists:false when the phone has
      // no Chatyy account. Two intents possible: (a) the phone IS the user's
      // and they need to sign up, or (b) they're testing/probing someone
      // else's phone (e.g. a friend who hasn't joined yet). Show an Alert
      // with both options instead of force-routing to signup — this is the
      // WhatsApp/Telegram pattern when you "find a contact" that hasn't
      // installed the app yet. iOS sms: deep link prefills the invite text.
      if (r.success && r.data && r.data.exists === false) {
        setPhoneSending(false);
        const inviteText = t('login.smsInvite') || 'Vamos conversar no Chatyy! https://chatyy.com.br';
        const opts = [
          {
            text: t('login.createAccount') || 'Criar conta com este número',
            onPress: () => {
              try {
                router.push(`/signup-phone?phone=${encodeURIComponent(fullPhone)}&country=${encodeURIComponent(_isoFromDial(phoneCountryCode))}&fromLogin=1`);
              } catch (e) {
                setError(t('login.phoneNoAccount') || 'Conta não encontrada. Crie uma nova com este número.');
                shake();
              }
            },
          },
          {
            text: t('login.inviteViaSms') || 'Convidar via SMS',
            onPress: () => {
              try {
                const _body = encodeURIComponent(inviteText);
                // sms:?addresses=+...&body= works on iOS; Android prefers
                // sms:+...?body=. Try iOS form first, fallback to Android.
                const _url = Platform.OS === 'ios'
                  ? `sms:&addresses=${encodeURIComponent(fullPhone)}&body=${_body}`
                  : `sms:${encodeURIComponent(fullPhone)}?body=${_body}`;
                Linking.openURL(_url).catch(() => {
                  if (Platform.OS === 'web') {
                    try { window.open(`sms:${fullPhone}?body=${_body}`, '_self'); } catch {}
                  }
                });
              } catch {}
            },
          },
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        ];
        try {
          Alert.alert(
            t('login.phoneNotOnChatyy') || 'Este número ainda não tem Chatyy',
            t('login.phoneNotOnChatyyBody') || 'O que você quer fazer?',
            opts
          );
        } catch (e) {
          // Web/headless fallback: legacy behavior — push to signup directly.
          router.push(`/signup-phone?phone=${encodeURIComponent(fullPhone)}&country=${encodeURIComponent(_isoFromDial(phoneCountryCode))}&fromLogin=1`);
        }
        return;
      }
      if (r.success) {
        setPhoneStep('otp');
        setPhoneResendTimer(60);
        if (phoneResendRef.current) clearInterval(phoneResendRef.current);
        phoneResendRef.current = setInterval(() => {
          setPhoneResendTimer(prev => {
            if (prev <= 1) { clearInterval(phoneResendRef.current); return 0; }
            return prev - 1;
          });
        }, 1000);
      } else {
        setError(r.message || t('login.phoneInvalid'));
        shake();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection'));
      shake();
    } finally {
      if (mountedRef.current) setPhoneSending(false);
    }
  };

  // Convert dial code (e.g. "+55") to ISO-2 country code (e.g. "BR") so
  // signup-phone can pre-select the right flag/country in its picker.
  // COUNTRY_CODES rows look like { code: '+55', label: 'BR +55', ... }
  // — parse the ISO-2 prefix from the label. Falls back to 'BR'.
  const _isoFromDial = (dial) => {
    try {
      const found = COUNTRY_CODES.find(c => c.code === dial);
      const m = found?.label?.match(/^([A-Z]{2})\b/);
      return m ? m[1] : 'BR';
    } catch { return 'BR'; }
  };

  const handlePhoneVerifyOtp = async () => {
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    const code = phoneOtp.join('');
    if (code.length !== 6) return;
    setError('');
    setPhoneVerifying(true);
    try {
      const fullPhone = phoneCountryCode + phoneNumber.replace(/[^0-9]/g, '');
      const r = await api.verifyPhoneOtp(fullPhone, code);
      if (!mountedRef.current) return;
      if (r.success && r.data?.token) {
        safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
        await loginWithToken(r.data.token, r.data.email);
        // Success overlay — pops the check, holds, then routes. Spring
        // 0 → 1 over ~360ms, hold ~440ms (covers the existing 800ms gap)
        // before the navigate fires.
        setLoginSuccess(true);
        Animated.spring(successAnim, {
          toValue: 1, friction: 5, tension: 90, useNativeDriver: true,
        }).start();
        setTimeout(() => {
          if (mountedRef.current) router.replace(isChildAccount() ? '/chat' : '/inbox');
        }, 800);
      } else {
        const msg = r.message || t('login.phoneOtpInvalid');
        if (msg.includes('No account')) setError(t('login.phoneNoAccount'));
        else if (msg.includes('expired') || msg.includes('No valid')) setError(t('login.phoneOtpExpired'));
        else setError(msg);
        shake();
        setPhoneOtp(['', '', '', '', '', '']);
        // Auto-refocus the hidden OTP input so retyping works without an
        // extra tap. WhatsApp/Telegram parity. setTimeout 0 lets the reset
        // commit before focus() fires (otherwise it can be eaten).
        setTimeout(() => { try { phoneOtpRefs.current?.[0]?.focus?.(); } catch {} }, 0);
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection'));
      shake();
    } finally {
      if (mountedRef.current) setPhoneVerifying(false);
    }
  };

  // Single-input OTP handler. The hidden TextInput owns the full string,
  // each keystroke / autofill drop / paste comes through here as the WHOLE
  // current value (not delta). Strip non-digits, cap at 6, fan out into the
  // 6-cell display state. Auto-submit when full.
  // Per-cell bounce: when a new digit lands, the cell at that index pops
  // 0.85 → 1.18 → 1 over ~280ms. Telegram-grade tactile feedback so each
  // keystroke feels acknowledged — the OTP screen no longer feels static.
  const handlePhoneOtpFullChange = (raw) => {
    const digits = (raw || '').replace(/\D/g, '').slice(0, 6);
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < digits.length; i++) next[i] = digits[i];
    const prevFilled = phoneOtp.filter(Boolean).length;
    const newFilled = digits.length;
    // Only animate forward (typing). Deletion/clear shouldn't bounce.
    if (newFilled > prevFilled && newFilled > 0) {
      const idx = newFilled - 1;
      const cell = phoneOtpCellAnims[idx];
      if (cell) {
        cell.setValue(0.85);
        Animated.spring(cell, {
          toValue: 1, friction: 4, tension: 140, useNativeDriver: true,
        }).start();
      }
    }
    setPhoneOtp(next);
    if (digits.length === 6) {
      setTimeout(() => handlePhoneVerifyOtp(), 150);
    }
  };

  // Debounced live-check: tells the user "Já tem Chatyy" or "Vamos criar
  // sua conta" before they tap the CTA. Reduces SMS waste on typos and
  // signals the app is paying attention. Uses phone_login_request which
  // is rate-limited but cheap enough to call once per stable input.
  const runPhoneCheck = useDebouncedCallback(async (fullPhone, countryCode) => {
    try {
      setPhoneAccountState({ status: 'checking', phone: fullPhone });
      const r = await api.phoneLoginRequest({ phone: fullPhone, country: _isoFromDial(countryCode), silent: true });
      if (r?.success) {
        const exists = r?.data?.exists !== false;
        setPhoneAccountState({ status: exists ? 'exists' : 'new', phone: fullPhone });
      } else {
        setPhoneAccountState({ status: 'idle', phone: fullPhone });
      }
    } catch {
      setPhoneAccountState({ status: 'idle', phone: fullPhone });
    }
  }, 700);

  useEffect(() => {
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (phoneStep !== 'input' || cleaned.length < 8) {
      setPhoneAccountState({ status: 'idle', phone: '' });
      return;
    }
    const fullPhone = phoneCountryCode + cleaned;
    runPhoneCheck(fullPhone, phoneCountryCode);
  }, [phoneNumber, phoneCountryCode, phoneStep, runPhoneCheck]);

  // Cleanup phone resend timer
  useEffect(() => {
    return () => { if (phoneResendRef.current) clearInterval(phoneResendRef.current); };
  }, []);

  const currentLang = LANGUAGES.find(l => l.code === language);
  const langShort = language.split('-')[0].toUpperCase();

  const displayEmail = email.includes('@') ? email : (email ? `${email}@chatyy.com.br` : '');

  // --- Device Verification Screen ---
  if (verificationStep) {
    return (
      <View style={[s.root, { backgroundColor: colors.authBg }]}>
        <View style={[s.verifyContainer, { backgroundColor: colors.cardBg || colors.surface }]}>
          {verificationStep === 'waiting' && (
            <>
              <View style={[s.verifyIconCircle, { backgroundColor: colors.primary + '15' }]}>
                <IconShield size={48} color={colors.primary} />
              </View>
              <Text style={[s.verifyTitle, { color: colors.text }]}>
                {t('login.verifyTitle')}
              </Text>
              <Text style={[s.verifySubtitle, { color: colors.textSecondary }]}>
                {t('login.verifySubtitle')}
              </Text>
              <View style={[s.verifyInfoBox, { backgroundColor: colors.background || '#f5f5f5' }]}>
                <Text style={[s.verifyInfoLabel, { color: colors.textSecondary }]}>
                  {t('login.verifyDevice')}
                </Text>
                <Text style={[s.verifyInfoValue, { color: colors.text }]}>
                  {challengeDeviceInfo || t('login.verifyUnknownDevice')}
                </Text>
              </View>
              <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 24 }} />
              <Text style={[s.verifyWaiting, { color: colors.textSecondary }]}>
                {t('login.verifyWaiting')}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  handleCancelVerification();
                  router.push('/forgot');
                }}
                style={{ marginTop: 20, padding: 10 }}
              >
                <Text style={{ color: colors.primary, fontSize: 13, textAlign: 'center' }}>
                  Nao tem acesso ao outro dispositivo?{'\n'}
                  <Text style={{ fontWeight: '600' }}>Verificar por SMS, ligacao ou email</Text>
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleCancelVerification} style={[s.verifyBtn, { borderColor: colors.border, marginTop: 8 }]}>
                <Text style={[s.verifyBtnText, { color: colors.textSecondary }]}>
                  {t('login.verifyCancel')}
                </Text>
              </TouchableOpacity>
            </>
          )}
          {verificationStep === 'approved' && (
            <>
              <View style={[s.verifyIconCircle, { backgroundColor: '#10b98115' }]}>
                <IconCheck size={48} color="#10b981" />
              </View>
              <Text style={[s.verifyTitle, { color: colors.text }]}>
                {t('login.verifyApproved')}
              </Text>
              <Text style={[s.verifySubtitle, { color: colors.textSecondary }]}>
                {t('login.verifyApprovedSub')}
              </Text>
              <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 16 }} />
            </>
          )}
          {verificationStep === 'denied' && (
            <>
              <View style={[s.verifyIconCircle, { backgroundColor: '#ef444415' }]}>
                <IconAlertTriangle size={48} color="#ef4444" />
              </View>
              <Text style={[s.verifyTitle, { color: colors.text }]}>
                {t('login.verifyDenied')}
              </Text>
              <Text style={[s.verifySubtitle, { color: colors.textSecondary }]}>
                {t('login.verifyDeniedSub')}
              </Text>
              <TouchableOpacity
                onPress={handleRetryDenied}
                style={[s.verifyBtnPrimary, { backgroundColor: colors.primary }]}
              >
                <Text style={[s.verifyBtnPrimaryText, { color: '#fff' }]}>
                  {t('login.verifyTryAgain')}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  // Branded 3-dot loader — replaces ActivityIndicator inside primary CTAs.
  // Each dot pulses 0.3→1 with 120ms stagger. White on purple buttons; can
  // be tinted via `color` prop for ghost variants.
  const DotLoader = ({ color = '#fff', size = 6 }) => (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <Animated.View
          key={i}
          style={{
            width: size, height: size, borderRadius: size / 2,
            backgroundColor: color, opacity: dotAnims[i],
          }}
        />
      ))}
    </View>
  );

  // Press handlers for primary CTA scale animation. Spring tuned to feel
  // "depressed" — fast scale down, slightly bouncy release.
  const onCtaPressIn = () => {
    Animated.spring(ctaScaleAnim, {
      toValue: 0.985, stiffness: 400, damping: 28, mass: 0.8,
      useNativeDriver: true,
    }).start();
  };
  const onCtaPressOut = () => {
    Animated.spring(ctaScaleAnim, {
      toValue: 1, stiffness: 400, damping: 28, mass: 0.8,
      useNativeDriver: true,
    }).start();
  };

  return (
    <View style={[s.root, { backgroundColor: isDark ? '#0A0A0A' : '#FAFAFA' }]}>

      {/* Tech-grade backdrop layers — faded grid pattern + radial purple wash
          behind the card. Both pointerEvents=none so they never intercept
          input. Single colored circle (low opacity 0.10) reads as "glow"
          without needing a gradient lib. Grid uses SVG <Pattern> with a
          mask that fades from center outward. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
        <Svg width="100%" height="100%" style={{ position: 'absolute' }}>
          <Defs>
            <Pattern id="techGrid" x="0" y="0" width="32" height="32" patternUnits="userSpaceOnUse">
              <Path d="M 32 0 L 0 0 0 32" fill="none" stroke={isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'} strokeWidth="1" />
            </Pattern>
            <RadialGradient id="techGridFade" cx="50%" cy="50%" r="55%">
              <Stop offset="0%" stopColor="#fff" stopOpacity="1" />
              <Stop offset="60%" stopColor="#fff" stopOpacity="0.6" />
              <Stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </RadialGradient>
            <Mask id="techGridMask">
              <Rect x="0" y="0" width="100%" height="100%" fill="url(#techGridFade)" />
            </Mask>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#techGrid)" mask="url(#techGridMask)" />
        </Svg>
        {/* Radial purple wash — single colored circle, low opacity reads as
            soft halo behind the card. */}
        <View style={{
          position: 'absolute',
          width: 600, height: 600, borderRadius: 300,
          backgroundColor: 'rgba(124,58,237,0.10)',
          left: '50%', top: '50%',
          marginLeft: -300, marginTop: -300,
        }} />
        {/* Drifting orb #1 — top-right, slow loop. Translate-only animation
            so it stays cheap and on the native driver. Adds the
            Telegram/WhatsApp "alive" feel without any heavy gradient lib. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 260, height: 260, borderRadius: 130,
            top: -60, right: -60,
            backgroundColor: 'rgba(124,58,237,0.16)',
            transform: [{ translateX: orb1Anim.x }, { translateY: orb1Anim.y }],
          }}
        />
        {/* Drifting orb #2 — bottom-left, opposite phase. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 320, height: 320, borderRadius: 160,
            bottom: -80, left: -80,
            backgroundColor: 'rgba(167,139,250,0.14)',
            transform: [{ translateX: orb2Anim.x }, { translateY: orb2Anim.y }],
          }}
        />
      </View>

      {/* Cancel button for add_account mode */}
      {isAddAccount && (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, left: 16, zIndex: 10 }}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('account.cancel')}
        >
          <View style={[s.topBtn, { backgroundColor: isDark ? '#303134' : '#fff', borderColor: colors.authInputBorder }]}>
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>{t('account.cancel')}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Language selector + Theme toggle — top right */}
      <View style={s.topRightRow}>
        <TouchableOpacity onPress={() => setShowLangModal(true)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Change language">
          <View style={[s.langBtn, { backgroundColor: 'transparent' }]}>
            <IconGlobe size={14} color={isDark ? '#9aa0a6' : '#5f6368'} />
            <Text style={[s.langBtnText, { color: isDark ? '#e8eaed' : '#3c4043' }]}>{langShort}</Text>
            <View style={{ marginLeft: -1 }}>
              <IconChevronDown size={12} color={isDark ? '#9aa0a6' : '#5f6368'} />
            </View>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={toggle} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
          <View style={[s.topBtn, { backgroundColor: 'transparent' }]}>
            {isDark ? <IconSun size={16} color="#fbbf24" /> : <IconMoon size={16} color="#5f6368" />}
          </View>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.center}>
            <Animated.View style={[s.cardWrap, { opacity: cardFadeAnim, transform: [{ translateY: cardSlideAnim }] }]}>
              {/* Google-style card */}
              <View style={[s.card, {
                backgroundColor: isDark ? '#303134' : '#ffffff',
                ...(Platform.OS === 'web' ? {
                  boxShadow: '0 1px 3px 0 rgba(60,64,67,0.15), 0 4px 8px 3px rgba(60,64,67,0.10)',
                } : {
                  shadowColor: '#3c4043',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 6,
                  elevation: 4,
                }),
              }]}>
                <Animated.View style={{
                  opacity: fadeAnim,
                  transform: [{ translateX: slideAnim }, { translateX: shakeAnim }],
                }}>

                  {/* Single Chatyy brand orb — flat solid SVG. No halo, no
                      glow, no shadow. Clean as the rest of the iconography.
                      Entrance scale-pop only (one-time). */}
                  <View style={s.logoRow}>
                    {/* Breathing logo + soft halo. The halo is a larger
                        translucent circle behind the brand orb whose opacity
                        sine-pulses out-of-phase with the breath, giving the
                        Telegram/WhatsApp "alive" feel. The breath multiplies
                        with the entrance scale so they don't fight. */}
                    <Animated.View style={{
                      width: 132, height: 132,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Animated.View pointerEvents="none" style={{
                        position: 'absolute',
                        width: 132, height: 132, borderRadius: 66,
                        backgroundColor: 'rgba(124,58,237,0.22)',
                        opacity: haloAnim,
                        transform: [{ scale: logoBreathAnim }],
                      }} />
                      <Animated.View style={{
                        width: 92, height: 92, borderRadius: 46,
                        backgroundColor: colors.primary,
                        alignItems: 'center', justifyContent: 'center',
                        transform: [
                          { scale: Animated.multiply(logoScaleAnim, logoBreathAnim) },
                        ],
                      }}>
                        <IconMessageSquare size={42} color="#fff" />
                      </Animated.View>
                    </Animated.View>
                    <Animated.View style={{
                      opacity: titleAnim,
                      transform: [{ translateY: titleAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
                      alignItems: 'center',
                    }}>
                      <Text style={{
                        fontSize: 32, fontWeight: '800',
                        color: colors.primary, marginTop: 18,
                        letterSpacing: -0.5,
                      }}>
                        Chatyy
                      </Text>
                      <Text style={{
                        fontSize: 14, fontWeight: '500',
                        color: isDark ? '#9aa0a6' : '#5f6368',
                        marginTop: 4, marginBottom: 4,
                      }}>
                        {t('login.tagline') || 'Tudo está aqui'}
                      </Text>
                    </Animated.View>
                  </View>

                  {/* Tab bar — pill segmented control (iOS style). Pill ativa
                      tem fundo branco/escuro elevado, ícone + label, com
                      subtle shadow. Estilo Apple Settings + Stripe. */}
                  <View style={{
                    flexDirection: 'row',
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(60,64,67,0.06)',
                    borderRadius: 12,
                    padding: 4,
                    marginTop: 24, marginBottom: 18,
                    gap: 4,
                  }}>
                    <TouchableOpacity
                      style={{
                        flex: 1, paddingVertical: 9, borderRadius: 9,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        backgroundColor: loginMode === 'phone' ? (isDark ? '#3a3d41' : '#fff') : 'transparent',
                        ...(loginMode === 'phone' && Platform.OS === 'web' ? { boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(60,64,67,0.18)' } : {}),
                        ...(loginMode === 'phone' && Platform.OS !== 'web' ? {
                          shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
                        } : {}),
                      }}
                      onPress={() => { safeHaptic(() => Haptics.selectionAsync()); setLoginMode('phone'); setError(''); setPhoneStep('input'); setPhoneOtp(['', '', '', '', '', '']); }}
                      activeOpacity={0.7}
                    >
                      <IconPhone size={14} color={loginMode === 'phone' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368')} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: loginMode === 'phone' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }}>
                        {t('login.phoneNumber') || 'Telefone'}
                      </Text>
                    </TouchableOpacity>
                    {isDesktop && (
                      <TouchableOpacity
                        style={{
                          flex: 1, paddingVertical: 9, borderRadius: 9,
                          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                          backgroundColor: loginMode === 'qr' ? (isDark ? '#3a3d41' : '#fff') : 'transparent',
                          ...(loginMode === 'qr' && Platform.OS === 'web' ? { boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(60,64,67,0.18)' } : {}),
                          ...(loginMode === 'qr' && Platform.OS !== 'web' ? {
                            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
                          } : {}),
                        }}
                        onPress={() => { safeHaptic(() => Haptics.selectionAsync()); setLoginMode('qr'); setError(''); setStep(1); }}
                        activeOpacity={0.7}
                      >
                        <IconGlobe size={14} color={loginMode === 'qr' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368')} />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: loginMode === 'qr' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }}>
                          QR
                        </Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={{
                        flex: 1, paddingVertical: 9, borderRadius: 9,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        backgroundColor: loginMode === 'email' ? (isDark ? '#3a3d41' : '#fff') : 'transparent',
                        ...(loginMode === 'email' && Platform.OS === 'web' ? { boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(60,64,67,0.18)' } : {}),
                        ...(loginMode === 'email' && Platform.OS !== 'web' ? {
                          shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
                        } : {}),
                      }}
                      onPress={() => { safeHaptic(() => Haptics.selectionAsync()); setLoginMode('email'); setError(''); setStep(1); }}
                      activeOpacity={0.7}
                    >
                      <IconMailLogo size={14} color={loginMode === 'email' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368')} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: loginMode === 'email' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }}>
                        Email
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* ── PHONE LOGIN ── */}
                  {loginMode === 'phone' ? (
                    <View style={{ paddingTop: 24 }}>
                      {/* Single brand icon stays at the top of the page (the
                          Chatyy orb above the tabs). No second hero here —
                          one icon is enough. */}

                      <Text style={[s.title, { color: isDark ? '#e8eaed' : '#202124', textAlign: phoneStep === 'input' ? 'center' : 'left' }]}>{t('login.phoneTitle')}</Text>
                      <Text style={[s.subtitle, { color: isDark ? '#9aa0a6' : '#5f6368', textAlign: phoneStep === 'input' ? 'center' : 'left', paddingHorizontal: phoneStep === 'input' ? 12 : 0 }]}>
                        {phoneStep === 'otp'
                          ? `${t('login.phoneOtpSubtitle')} ${phoneCountryCode}${phoneNumber}`
                          : t('login.phoneSubtitle')}
                      </Text>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: isDark ? '#3c2020' : '#fce8e6', borderColor: isDark ? '#c5221f' : '#d93025' }]}>
                          <IconAlertTriangle size={14} color={isDark ? '#f28b82' : '#d93025'} />
                          <Text style={[s.errorText, { color: isDark ? '#f28b82' : '#d93025' }]}>{error}</Text>
                        </View>
                      )}

                      {phoneStep === 'input' ? (
                        <>
                          {/* Telegram-style stacked input: country row on top
                              with bottom hairline + dial-code column + number
                              column on the second row, divided by a vertical
                              hairline. No box, no pill, no flag emoji jammed
                              into the field \u2014 calmer and easier to scan. */}
                          {(() => {
                            const _country = COUNTRY_CODES.find(c => c.code === phoneCountryCode);
                            const _countryName = _country?.name || _country?.label || (t('login.selectCountry') || 'Pa\u00EDs');
                            const _hairline = isDark ? '#2a2d31' : '#e5e7eb';
                            const _hairlineActive = colors.primary;
                            const _isFocused = focused === 'phone';
                            return (
                              <View style={{ marginBottom: 16 }}>
                                <TouchableOpacity
                                  onPress={() => { setCountrySearch(''); setShowCountryPicker(true); }}
                                  activeOpacity={0.6}
                                  style={{
                                    flexDirection: 'row', alignItems: 'center',
                                    paddingVertical: 14,
                                    borderBottomWidth: StyleSheet.hairlineWidth,
                                    borderBottomColor: _hairline,
                                  }}
                                >
                                  {/* Country flag emoji — WhatsApp/Telegram pattern.
                                      Renders crisply on iOS/Android (the primary
                                      targets); Windows web falls back to ISO letters
                                      which is still readable. The monospace "BR +55"
                                      experiment was uglier and less recognizable. */}
                                  {_country?.flag ? (
                                    <Text style={{ fontSize: 22, marginRight: 12 }}>
                                      {_country.flag}
                                    </Text>
                                  ) : null}
                                  <Text style={{ flex: 1, fontSize: 16, fontWeight: '500', color: colors.text }}>
                                    {_countryName}
                                  </Text>
                                  <IconChevronRight size={16} color={isDark ? '#9aa0a6' : '#9ca3af'} />
                                </TouchableOpacity>
                                <View style={{
                                  flexDirection: 'row', alignItems: 'center',
                                  borderBottomWidth: _isFocused ? 2 : StyleSheet.hairlineWidth,
                                  borderBottomColor: _isFocused ? _hairlineActive : _hairline,
                                  marginTop: -StyleSheet.hairlineWidth,
                                }}>
                                  <View style={{ width: 64, paddingVertical: 14, paddingRight: 8 }}>
                                    <Text style={{ fontSize: 16, color: colors.text, fontWeight: '500' }}>
                                      {phoneCountryCode}
                                    </Text>
                                  </View>
                                  <View style={{ width: StyleSheet.hairlineWidth, height: 22, backgroundColor: _hairline, marginRight: 8 }} />
                                  {(() => {
                                    // Look up the mask from the canonical COUNTRIES list
                                    // (constants/countries.js) by matching dial. Falls back
                                    // to the BR mask if no match (e.g. country not in the
                                    // canonical list). Used for format-as-you-type.
                                    const _full = COUNTRIES_FULL.find(x => x.dial === phoneCountryCode) || COUNTRIES_FULL[0];
                                    const _mask = _full?.mask || '(##) #####-####';
                                    const _maxDigits = _full?.maxDigits || 15;
                                    return (
                                      <TextInput
                                        style={[{
                                          flex: 1, fontSize: 16, paddingVertical: 14,
                                          color: colors.text,
                                        }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                                        value={formatPhone(phoneNumber, _mask)}
                                        onChangeText={(text) => {
                                          // Smart paste: if user pastes a "+DDI..." number (e.g. from
                                          // a contact card), auto-detect the country and strip the prefix
                                          // so the dial code shown stays in sync with what they pasted.
                                          if (/^\s*\+\d{1,3}/.test(text)) {
                                            const allDigits = text.replace(/\D/g, '');
                                            const match = COUNTRY_CODES.find(c => allDigits.startsWith(c.code.slice(1)));
                                            if (match) {
                                              setPhoneCountryCode(match.code);
                                              const rest = allDigits.slice(match.code.length - 1);
                                              setPhoneNumber(rest);
                                              if (error) setError('');
                                              return;
                                            }
                                          }
                                          // Strip non-digits and cap at the country's maxDigits;
                                          // the mask is re-applied on render via formatPhone().
                                          const digits = text.replace(/\D/g, '').slice(0, _maxDigits);
                                          setPhoneNumber(digits);
                                          if (error) setError('');
                                        }}
                                        keyboardType="phone-pad"
                                        placeholder={_mask ? _mask.replace(/#/g, '0') : t('login.phonePlaceholder')}
                                        placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                                        onFocus={() => setFocused('phone')}
                                        onBlur={() => setFocused('')}
                                        onSubmitEditing={handlePhoneSendOtp}
                                        accessibilityLabel={t('login.phoneNumber')}
                                        autoFocus
                                      />
                                    );
                                  })()}
                                </View>
                              </View>
                            );
                          })()}

                          {/* Smart-detect hint: feedback live de que o app
                              já encontrou (ou não) uma conta pra esse número.
                              Reduz ansiedade e SMS desperdiçado em typo. */}
                          {phoneAccountState.status === 'exists' && phoneAccountState.phone === (phoneCountryCode + phoneNumber.replace(/\D/g, '')) && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 6, marginBottom: 4 }}>
                              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981' }} />
                              <Text style={{ color: '#10b981', fontSize: 13, fontWeight: '600' }}>
                                {t('login.smartHasAccount') || 'Conta encontrada — vamos enviar o código'}
                              </Text>
                            </View>
                          )}
                          {phoneAccountState.status === 'new' && phoneAccountState.phone === (phoneCountryCode + phoneNumber.replace(/\D/g, '')) && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 6, marginBottom: 4 }}>
                              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary }} />
                              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>
                                {t('login.smartNewAccount') || 'Vamos criar sua conta no Chatyy'}
                              </Text>
                            </View>
                          )}

                          <TouchableOpacity
                            style={[s.primaryBtn, {
                              backgroundColor: colors.primary,
                              opacity: phoneSending ? 0.7 : (phoneNumber.replace(/\D/g, '').length < 8 ? 0.5 : 1),
                              width: '100%', alignSelf: 'stretch',
                              alignItems: 'center', justifyContent: 'center',
                              marginTop: 8,
                            }]}
                            onPress={handlePhoneSendOtp}
                            disabled={phoneSending || phoneNumber.replace(/\D/g, '').length < 8}
                            activeOpacity={0.85}
                          >
                            {phoneSending ? (
                              <View style={s.loadingBtnContent}>
                                <DotLoader />
                                <Text style={[s.primaryBtnText, { marginLeft: 10 }]}>{t('login.phoneSendCode')}</Text>
                              </View>
                            ) : (
                              <Text style={s.primaryBtnText}>{t('login.continueCta') || t('login.phoneSendCode')}</Text>
                            )}
                          </TouchableOpacity>

                          {/* Sem botão "Criar conta" aqui — fluxo é
                              automático: tap no CTA chama handlePhoneSendOtp
                              que detecta exists:false e roteia pro signup
                              com phone+country pre-preenchidos. User pediu
                              tela enxuta com só o input + CTA. */}
                        </>
                      ) : (
                        <>
                          {/* OTP — single hidden TextInput overlays the 6
                              boxes (WhatsApp/Telegram pattern). One input is
                              the only way iOS oneTimeCode autofill actually
                              drops all 6 digits at once; multiple maxLength=1
                              boxes silently break SMS autofill (only the
                              focused box gets a digit). The visible boxes are
                              presentational: they read from the same state
                              the hidden input owns. Tap anywhere → focus
                              hidden input → keyboard up. */}
                          <Pressable
                            onPress={() => phoneOtpRefs.current[0]?.focus()}
                            style={{ marginBottom: 20, alignSelf: 'center' }}
                            accessibilityLabel={t('login.phoneOtpInput') || 'Código de 6 dígitos'}
                          >
                            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                              {phoneOtp.map((digit, i) => {
                                const _filled = !!digit;
                                const _focused = phoneOtpFocused && (phoneOtp.findIndex(d => !d) === i || (phoneOtp.every(d => !!d) && i === 5));
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
                                      transform: [{ scale: phoneOtpCellAnims[i] }],
                                    }}
                                  >
                                    <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>
                                      {digit || ''}
                                    </Text>
                                  </Animated.View>
                                );
                              })}
                            </View>
                            <TextInput
                              ref={ref => { phoneOtpRefs.current[0] = ref; }}
                              style={{
                                position: 'absolute',
                                top: 0, left: 0, right: 0, bottom: 0,
                                opacity: 0,
                                color: 'transparent',
                                fontSize: 22,
                                ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'transparent' } : {}),
                              }}
                              value={phoneOtp.join('')}
                              onChangeText={handlePhoneOtpFullChange}
                              onFocus={() => setPhoneOtpFocused(true)}
                              onBlur={() => setPhoneOtpFocused(false)}
                              keyboardType="number-pad"
                              maxLength={6}
                              textContentType="oneTimeCode"
                              autoComplete="sms-otp"
                              autoFocus
                              caretHidden
                              selectTextOnFocus
                              importantForAutofill="yes"
                            />
                          </Pressable>

                          <TouchableOpacity
                            style={[s.primaryBtn, {
                              backgroundColor: colors.primary,
                              opacity: phoneVerifying ? 0.7 : (phoneOtp.join('').length !== 6 ? 0.5 : 1),
                              width: '100%', alignSelf: 'stretch',
                              alignItems: 'center', justifyContent: 'center',
                            }]}
                            onPress={handlePhoneVerifyOtp}
                            disabled={phoneVerifying || phoneOtp.join('').length !== 6}
                            activeOpacity={0.85}
                          >
                            {phoneVerifying ? (
                              <View style={s.loadingBtnContent}>
                                <DotLoader />
                                <Text style={[s.primaryBtnText, { marginLeft: 10 }]}>{t('login.phoneVerify')}</Text>
                              </View>
                            ) : (
                              <Text style={s.primaryBtnText}>{t('login.phoneVerify')}</Text>
                            )}
                          </TouchableOpacity>

                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }}>
                            <TouchableOpacity
                              onPress={() => { setPhoneStep('input'); setPhoneOtp(['', '', '', '', '', '']); setError(''); }}
                              activeOpacity={0.6}
                            >
                              <Text style={[s.linkText, { color: colors.primary }]}>{t('login.phoneChangeNumber')}</Text>
                            </TouchableOpacity>
                            {phoneResendTimer > 0 ? (
                              <Text style={[s.linkText, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>
                                {t('login.phoneResendIn')} {phoneResendTimer}s
                              </Text>
                            ) : (
                              <TouchableOpacity onPress={handlePhoneSendOtp} disabled={phoneSending} activeOpacity={0.6}>
                                <Text style={[s.linkText, { color: colors.primary }]}>{t('login.phoneResend')}</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </>
                      )}
                    </View>

                  ) : loginMode === 'qr' && isDesktop ? (
                    /* ── QR LOGIN ── */
                    <View style={s.qrPanel}>
                      {qrStatus === 'loading' && (
                        <View style={s.qrLoadingWrap}>
                          <ActivityIndicator size="large" color={colors.primary} />
                        </View>
                      )}
                      {qrStatus === 'confirmed' && (
                        <View style={s.qrLoadingWrap}>
                          <Text style={[s.qrConnectedText, { color: colors.primary }]}>
                            {t('login.qrConnected')}
                          </Text>
                          <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 12 }} />
                        </View>
                      )}
                      {(qrStatus === 'pending' || qrStatus === 'expired') && (
                        <>
                          <View style={[s.qrImageWrap, {
                            borderColor: isDark ? '#5f6368' : '#dadce0',
                            backgroundColor: '#ffffff',
                          }]}>
                            {qrStatus === 'pending' && qrToken ? (
                              <Image
                                source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent('chatyy://qr/' + qrToken)}&size=250x250&format=png&margin=8` }}
                                style={s.qrImage}
                                resizeMode="contain"
                              />
                            ) : (
                              <View style={s.qrExpiredOverlay}>
                                <View style={{ marginBottom: 8 }}>
                                  <IconRefresh size={40} color="#9ca3af" />
                                </View>
                                <Text style={{ fontSize: 14, fontWeight: '500', color: isDark ? '#9aa0a6' : '#5f6368' }}>
                                  {t('login.qrExpired')}
                                </Text>
                              </View>
                            )}
                            {qrStatus === 'expired' && (
                              <View style={[s.qrExpiredOverlay, { backgroundColor: 'rgba(255,255,255,0.9)' }]}>
                                <TouchableOpacity onPress={handleRefreshQR} activeOpacity={0.7} style={{ alignItems: 'center', padding: 16 }}>
                                  <View style={{ marginBottom: 8 }}>
                                    <IconRefresh size={36} color={colors.primary} />
                                  </View>
                                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.primary }}>
                                    {t('login.qrRefresh')}
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                          {qrStatus === 'pending' && (
                            <Text style={{ fontSize: 13, marginBottom: 16, textAlign: 'center', color: isDark ? '#9aa0a6' : '#5f6368' }}>
                              {t('login.qrExpires')} {qrCountdown}s
                            </Text>
                          )}
                          <Text style={{ fontSize: 14, textAlign: 'center', marginBottom: 20, lineHeight: 22, color: isDark ? '#9aa0a6' : '#5f6368' }}>
                            {t('login.qrSubtitle')}
                          </Text>
                          <View style={{ alignSelf: 'stretch', paddingHorizontal: 12, gap: 8 }}>
                            <Text style={{ fontSize: 14, lineHeight: 20, color: isDark ? '#e8eaed' : '#202124' }}>1. {t('login.qrStep1')}</Text>
                            <Text style={{ fontSize: 14, lineHeight: 20, color: isDark ? '#e8eaed' : '#202124' }}>2. {t('login.qrStep2')}</Text>
                            <Text style={{ fontSize: 14, lineHeight: 20, color: isDark ? '#e8eaed' : '#202124' }}>3. {t('login.qrStep3')}</Text>
                          </View>
                        </>
                      )}
                      {qrStatus === 'idle' && (
                        <View style={s.qrLoadingWrap}>
                          <ActivityIndicator size="large" color={colors.primary} />
                        </View>
                      )}
                    </View>

                  ) : step === 1 ? (
                    /* ── EMAIL STEP 1 ── */
                    <>
                      <Text style={[s.title, { color: isDark ? '#e8eaed' : '#202124' }]}>{t('login.title')}</Text>
                      <Text style={[s.subtitle, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>
                        {t('login.subtitle')}
                      </Text>

                      {/* IG-style email input — flat 52pt rounded radius 10,
                          label is the static placeholder. Border color toggles
                          on focus. Shake animation applies to just the input
                          row. Focus ring: web uses boxShadow ring-4 in brand
                          purple (animated via CSS transition), native gets a
                          4pt outer View with animated opacity. */}
                      <Animated.View style={{ transform: [{ translateX: shakeAnim }], position: 'relative' }}>
                        {Platform.OS !== 'web' && (
                          <Animated.View pointerEvents="none" style={{
                            position: 'absolute', top: -4, left: -4, right: -4, bottom: -4,
                            borderRadius: 14, backgroundColor: 'rgba(124,58,237,0.18)',
                            opacity: emailRingAnim, zIndex: -1,
                          }} />
                        )}
                        <TextInput
                          style={[s.igInput, {
                            backgroundColor: isDark ? '#262626' : '#FAFAFA',
                            borderColor: focused === 'email'
                              ? (isDark ? '#3A3A3A' : '#A8A8A8')
                              : (isDark ? '#262626' : '#DBDBDB'),
                            color: isDark ? '#e8eaed' : '#202124',
                            ...(Platform.OS === 'web' && focused === 'email'
                              ? { boxShadow: '0 0 0 4px rgba(124,58,237,0.18)' }
                              : {}),
                          }]}
                          value={email}
                          onChangeText={(text) => { setEmail(text); if (error) setError(''); }}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          autoComplete="email"
                          returnKeyType="next"
                          placeholder={t('login.emailPlaceholder')}
                          placeholderTextColor={isDark ? '#7a7a7a' : '#8e8e8e'}
                          onFocus={() => setFocused('email')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleContinue}
                          accessibilityLabel={t('login.emailPlaceholder')}
                        />
                      </Animated.View>

                      {/* Inline error directly under the input. IG kills the
                          banner — surfaces only the field-level message. */}
                      {!!error && (
                        <Text style={{ color: '#ED4956', fontSize: 13, marginTop: 6 }}>{error}</Text>
                      )}

                      {/* Domain hint */}
                      {!email.includes('@') && email.length > 0 && (
                        <Text style={[s.domainHint, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>
                          {t('login.fullEmail')} <Text style={{ fontWeight: '600', color: colors.primary }}>{email}@chatyy.com.br</Text>
                        </Text>
                      )}
                      {!email && (
                        <Text style={[s.domainHint, { color: isDark ? '#9aa0a6' : '#80868b' }]}>
                          {t('login.domainHint')}
                        </Text>
                      )}

                      <TouchableOpacity
                        style={s.forgotLink}
                        activeOpacity={0.6}
                        onPress={() => setShowHelp(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[s.linkText, { color: colors.primary }]}>{t('login.forgotEmail')}</Text>
                      </TouchableOpacity>

                      {/* IG-style stacked CTA — full-width primary, ghost text
                          link below. Drops the split row that paired tiny
                          "Próximo" with a text-link. Disabled state is
                          opacity 0.3 (keeps brand color presence). Press
                          gives a 0.985 scale depression + web-only purple
                          glow. */}
                      <Animated.View style={{ transform: [{ scale: ctaScaleAnim }] }}>
                        <Pressable
                          style={({ pressed }) => [s.igPrimaryBtn, {
                            backgroundColor: colors.primary,
                            opacity: !email.trim() ? 0.3 : 1,
                            ...(Platform.OS === 'web' && pressed && email.trim() ? {
                              boxShadow: '0 8px 24px -8px rgba(124,58,237,0.6)',
                            } : {}),
                          }]}
                          onPress={handleContinue}
                          onPressIn={onCtaPressIn}
                          onPressOut={onCtaPressOut}
                          accessibilityRole="button"
                        >
                          <Text style={s.igPrimaryBtnText}>{t('login.next')}</Text>
                        </Pressable>
                      </Animated.View>
                      <TouchableOpacity
                        onPress={() => { safeHaptic(() => Haptics.selectionAsync()); router.push('/signup-phone'); }}
                        activeOpacity={0.6}
                        style={s.igGhostBtn}
                        accessibilityRole="button"
                      >
                        <Text style={[s.igGhostBtnLabel, { color: colors.primary }]}>{t('login.createAccount') || 'Criar conta'}</Text>
                      </TouchableOpacity>

                      {/* Biometric login (native only) */}
                      {bioAvailable && (
                        <TouchableOpacity
                          style={[s.biometricBtn, {
                            borderColor: colors.primary + '40',
                            backgroundColor: colors.primary + '08',
                          }]}
                          onPress={handleBiometricLogin}
                          disabled={bioLoading}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={
                            bioType === 'face' ? 'Face ID'
                              : bioType === 'touch' ? 'Touch ID'
                              : (t('login.biometric') || 'Biometria')
                          }
                        >
                          {bioLoading ? (
                            <ActivityIndicator color={colors.primary} size="small" />
                          ) : (
                            <>
                              <View style={[s.biometricIcon, { backgroundColor: colors.primary + '18' }]}>
                                {bioType === 'face' ? (
                                  <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
                                    <Path d="M3 7V5a2 2 0 012-2h2" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" />
                                    <Path d="M17 3h2a2 2 0 012 2v2" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" />
                                    <Path d="M21 17v2a2 2 0 01-2 2h-2" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" />
                                    <Path d="M7 21H5a2 2 0 01-2-2v-2" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" />
                                    <SvgCircle cx="9" cy="10" r="0.9" fill={colors.primary} />
                                    <SvgCircle cx="15" cy="10" r="0.9" fill={colors.primary} />
                                    <Path d="M12 10v4" stroke={colors.primary} strokeWidth={1.5} strokeLinecap="round" />
                                    <Path d="M9.5 16c.7.5 1.6.8 2.5.8s1.8-.3 2.5-.8" stroke={colors.primary} strokeWidth={1.5} strokeLinecap="round" />
                                  </Svg>
                                ) : (
                                  <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
                                    <Path d="M12 2a8 8 0 00-8 8v2" stroke={colors.primary} strokeWidth={1.8} strokeLinecap="round" />
                                    <Path d="M20 12v-2a8 8 0 00-12.9-6.3" stroke={colors.primary} strokeWidth={1.8} strokeLinecap="round" />
                                    <Path d="M5.5 17A9 9 0 015 14c0-3.9 3.1-7 7-7s7 3.1 7 7c0 1 .1 2 .3 3" stroke={colors.primary} strokeWidth={1.6} strokeLinecap="round" />
                                    <Path d="M8 14a4 4 0 118 0c0 2-.5 3.5-1 5" stroke={colors.primary} strokeWidth={1.6} strokeLinecap="round" />
                                    <Path d="M12 11v5c0 1 .2 2 .5 3" stroke={colors.primary} strokeWidth={1.6} strokeLinecap="round" />
                                  </Svg>
                                )}
                              </View>
                              <Text style={[s.biometricText, { color: colors.primary, fontWeight: '700' }]}>
                                {bioType === 'face' ? 'Entrar com Face ID'
                                  : bioType === 'touch' ? 'Entrar com Touch ID'
                                  : (t('login.biometric') || 'Entrar com biometria')}
                              </Text>
                            </>
                          )}
                        </TouchableOpacity>
                      )}
                    </>

                  ) : (
                    /* ── EMAIL STEP 2 — PASSWORD ── */
                    <>
                      <Text style={[s.title, { color: isDark ? '#e8eaed' : '#202124' }]}>{t('login.welcome')}</Text>

                      {/* User chip (email with avatar) */}
                      <TouchableOpacity
                        style={[s.userChip, { borderColor: isDark ? '#5f6368' : '#dadce0' }]}
                        onPress={() => animateStep(1)}
                        activeOpacity={0.7}
                      >
                        <View style={[s.userAvatar, { backgroundColor: colors.primary }]}>
                          <Text style={s.userAvatarLetter}>{(email || '?')[0].toUpperCase()}</Text>
                        </View>
                        <Text style={[s.userEmail, { color: isDark ? '#e8eaed' : '#202124' }]} numberOfLines={1}>
                          {displayEmail}
                        </Text>
                        <View style={{ marginLeft: 6 }}>
                          <IconChevronDown size={12} color={isDark ? '#9aa0a6' : '#5f6368'} />
                        </View>
                      </TouchableOpacity>

                      {/* IG-style password input. Eye toggle stays at right.
                          Shake animates only this row. Focus ring matches
                          the email input pattern. */}
                      <Animated.View style={{ transform: [{ translateX: shakeAnim }], position: 'relative' }}>
                        {Platform.OS !== 'web' && (
                          <Animated.View pointerEvents="none" style={{
                            position: 'absolute', top: -4, left: -4, right: -4, bottom: -4,
                            borderRadius: 14, backgroundColor: 'rgba(124,58,237,0.18)',
                            opacity: passRingAnim, zIndex: -1,
                          }} />
                        )}
                        <TextInput
                          ref={passwordRef}
                          style={[s.igInput, {
                            backgroundColor: isDark ? '#262626' : '#FAFAFA',
                            borderColor: focused === 'pass'
                              ? (isDark ? '#3A3A3A' : '#A8A8A8')
                              : (isDark ? '#262626' : '#DBDBDB'),
                            color: isDark ? '#e8eaed' : '#202124',
                            paddingRight: 44,
                            ...(Platform.OS === 'web' && focused === 'pass'
                              ? { boxShadow: '0 0 0 4px rgba(124,58,237,0.18)' }
                              : {}),
                          }]}
                          value={password}
                          onChangeText={(text) => { setPassword(text); if (error) setError(''); }}
                          secureTextEntry={!showPassword}
                          returnKeyType="go"
                          placeholder={t('login.passwordInput')}
                          placeholderTextColor={isDark ? '#7a7a7a' : '#8e8e8e'}
                          onFocus={() => setFocused('pass')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleLogin}
                          accessibilityLabel={t('login.passwordPlaceholder')}
                        />
                        <TouchableOpacity
                          onPress={() => setShowPassword(!showPassword)}
                          style={s.igEyeBtn}
                          activeOpacity={0.6}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                        >
                          {showPassword
                            ? <IconEyeOff size={20} color={isDark ? '#9aa0a6' : '#5f6368'} />
                            : <IconEye size={20} color={isDark ? '#9aa0a6' : '#5f6368'} />}
                        </TouchableOpacity>
                      </Animated.View>

                      {!!error && (
                        <Text style={{ color: '#ED4956', fontSize: 13, marginTop: 6 }}>{error}</Text>
                      )}

                      <TouchableOpacity style={s.forgotLink} activeOpacity={0.6} onPress={() => router.push('/forgot')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={[s.linkText, { color: colors.primary }]}>{t('login.forgotPassword')}</Text>
                      </TouchableOpacity>

                      {/* IG-style stacked CTAs — primary "Entrar" full-width,
                          ghost "Voltar" below. Disabled at opacity 0.3 keeps
                          brand color while signalling state. Loading uses
                          branded 3-dot pulse instead of ActivityIndicator. */}
                      <Animated.View style={{ transform: [{ scale: ctaScaleAnim }] }}>
                        <Pressable
                          style={({ pressed }) => [s.igPrimaryBtn, {
                            backgroundColor: colors.primary,
                            opacity: (loading || !password) ? 0.3 : 1,
                            ...(Platform.OS === 'web' && pressed && password && !loading ? {
                              boxShadow: '0 8px 24px -8px rgba(124,58,237,0.6)',
                            } : {}),
                          }]}
                          onPress={handleLogin}
                          onPressIn={onCtaPressIn}
                          onPressOut={onCtaPressOut}
                          disabled={loading}
                          accessibilityRole="button"
                        >
                          {loading ? (
                            <View style={s.loadingBtnContent}>
                              <DotLoader />
                              <Text style={[s.igPrimaryBtnText, { marginLeft: 10 }]}>{t('login.enter')}</Text>
                            </View>
                          ) : (
                            <Text style={s.igPrimaryBtnText}>{t('login.enter')}</Text>
                          )}
                        </Pressable>
                      </Animated.View>
                      <TouchableOpacity
                        onPress={() => { safeHaptic(() => Haptics.selectionAsync()); animateStep(1); }}
                        style={s.igGhostBtn}
                        activeOpacity={0.6}
                        accessibilityRole="button"
                      >
                        <Text style={[s.igGhostBtnLabel, { color: colors.primary }]}>{t('login.back')}</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </Animated.View>
              </View>

              {/* Tech-grade keyboard hint pill — Vercel/Linear pattern. Web
                  only because mobile users rarely have a hardware ↵ key,
                  and the pill on a touch keyboard reads as decoration. */}
              {Platform.OS === 'web' && (
                <View style={{ marginTop: 32, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{
                    paddingHorizontal: 8, paddingVertical: 3,
                    borderRadius: 4, borderWidth: 1,
                    borderColor: isDark ? '#1F1F22' : '#E5E5E5',
                    backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                  }}>
                    <Text style={{
                      fontFamily: 'Menlo, Consolas, monospace', fontSize: 11,
                      color: isDark ? '#A1A1A6' : '#525252',
                    }}>
                      {'↵'} Enter
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: isDark ? '#A1A1A6' : '#525252' }}>
                    {t('login.keyboardHint') || 'para continuar'}
                  </Text>
                </View>
              )}

              {/* Footer — Privacy / Terms / Help. Scan-QR link removido da
                  página inicial: o flow de QR é uso pós-login (ligar outro
                  device), não primeiro contato. Permanece acessível de
                  dentro do app via Settings → Linked Devices. */}
              <View style={s.footer}>
                {/* (intentionally no Scan QR Code on initial login) */}
                <View style={s.footerLinks}>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowHelp(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>{t('login.help')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: isDark ? '#5f6368' : '#dadce0' }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowPrivacy(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>{t('login.privacy')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: isDark ? '#5f6368' : '#dadce0' }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowTerms(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>{t('login.terms')}</Text>
                  </TouchableOpacity>
                </View>
                {/* Build diagnostic — native build + OTA hash. Tap 5× to nuke
                    the local session (bio_email/bio_token/offline cache) for
                    cases where the app is stuck in a bad hydrated state. */}
                <TouchableOpacity
                  activeOpacity={1}
                  onPress={() => {
                    buildTapCountRef.current = (buildTapCountRef.current || 0) + 1;
                    if (buildTapCountRef.current >= 5) {
                      buildTapCountRef.current = 0;
                      (async () => {
                        try {
                          if (Platform.OS !== 'web') {
                            const SS = require('expo-secure-store');
                            await SS.deleteItemAsync('bio_email').catch(() => {});
                            await SS.deleteItemAsync('bio_token').catch(() => {});
                            await SS.deleteItemAsync('bio_password').catch(() => {});
                            const AS = require('@react-native-async-storage/async-storage').default;
                            await AS.removeItem('chatyy_offline_user').catch(() => {});
                          }
                          api.clearAuthToken?.();
                          Alert.alert('OK', 'Sessao limpa. Feche e abra o app.');
                        } catch {}
                      })();
                    }
                  }}
                  style={{ marginTop: 8, alignSelf: 'center' }}
                  hitSlop={{ top: 10, bottom: 10, left: 20, right: 20 }}
                >
                  <Text style={{ fontSize: 10, color: isDark ? '#5f6368' : '#9aa0a6' }}>
                    {buildLabel}
                  </Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />

      {/* Country code picker modal */}
      <Modal visible={showCountryPicker} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: isDark ? '#1c1c1e' : '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 30 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 0.5, borderBottomColor: isDark ? '#333' : '#e5e5e5' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: isDark ? '#fff' : '#000' }}>{t('login.selectCountry') || 'Selecionar pais'}</Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ fontSize: 16, color: colors.primary, fontWeight: '600' }}>OK</Text>
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
              <TextInput
                style={{ backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: isDark ? '#fff' : '#000' }}
                placeholder={t('login.searchCountry') || 'Buscar pais...'}
                placeholderTextColor={isDark ? '#8e8e93' : '#999'}
                value={countrySearch}
                onChangeText={setCountrySearch}
                autoFocus
              />
            </View>
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: isDark ? '#2c2c2e' : '#f0f0f0',
                    backgroundColor: item.code === phoneCountryCode ? (isDark ? 'rgba(0,122,255,0.15)' : 'rgba(0,122,255,0.08)') : 'transparent' }}
                  onPress={() => { setPhoneCountryCode(item.code); setShowCountryPicker(false); }}
                  activeOpacity={0.6}
                >
                  <Text style={{ fontSize: 24, marginRight: 12 }}>{item.flag}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, color: isDark ? '#fff' : '#000', fontWeight: '500' }}>{item.name}</Text>
                    <Text style={{ fontSize: 13, color: isDark ? '#8e8e93' : '#666' }}>{item.label}</Text>
                  </View>
                  {item.code === phoneCountryCode && <Text style={{ color: colors.primary, fontSize: 18 }}>✓</Text>}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>

      {/* Language picker modal */}
      <Modal
        visible={showLangModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLangModal(false)}
      >
        <Pressable style={s.langOverlay} onPress={() => setShowLangModal(false)}>
          <Pressable style={[s.langModal, {
            backgroundColor: colors.authCardBg,
            borderColor: isDark ? colors.authCardBorder : '#e5e7eb',
            ...(Platform.OS === 'web' ? {
              boxShadow: isDark
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 4px 24px rgba(0,0,0,0.12)',
            } : {
              shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
              shadowOpacity: isDark ? 0.4 : 0.12, shadowRadius: 24, elevation: 12,
            }),
          }]} onPress={() => {}}>
            <Text style={[s.langModalTitle, { color: colors.text }]}>
              {currentLang?.flag} {t('login.footerLanguage') || 'Language'}
            </Text>
            <FlatList
              data={LANGUAGES}
              keyExtractor={item => item.code}
              style={s.langList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[s.langItem, language === item.code && {
                    backgroundColor: colors.primary + '12',
                  }]}
                  onPress={() => { changeLanguage(item.code); setShowLangModal(false); }}
                  activeOpacity={0.6}
                >
                  <Text style={s.langFlag}>{item.flag}</Text>
                  <Text style={[s.langLabel, { color: colors.text }]}>{item.label}</Text>
                  {language === item.code && (
                    <Text style={[s.langCheck, { color: colors.primary }]}>{'\u2713'}</Text>
                  )}
                </TouchableOpacity>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* QR Scanner Modal (mobile — camera + fallback to paste token) */}
      {showQrScanner && Platform.OS !== 'web' && (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setShowQrScanner(false)}
        >
          <LoginQRScannerView
            onScan={async (data) => {
              setShowQrScanner(false);
              let token = data.trim();
              const m1 = token.match(/chatyy:\/\/qr\/([a-f0-9]{64})/i);
              if (m1) token = m1[1];
              const m2 = token.match(/[?&]token=([a-f0-9]{64})/i);
              if (m2) token = m2[1];
              token = token.replace('https://chatyy.com.br/qr/', '').trim();
              if (!token || token.length !== 64 || !/^[a-f0-9]+$/i.test(token)) {
                Alert.alert(t('common.error'), t('login.qrScanInvalid'));
                return;
              }
              try {
                const res = await api.qrConfirm(token);
                if (res?.success) Alert.alert(t('login.qrScanSuccess'));
                else Alert.alert(t('common.error'), res?.message || t('login.qrScanError'));
              } catch { Alert.alert(t('common.error'), t('login.qrScanError')); }
            }}
            onClose={() => setShowQrScanner(false)}
            t={t}
            colors={colors}
            isDark={isDark}
            qrScanToken={qrScanToken}
            setQrScanToken={setQrScanToken}
            qrScanLoading={qrScanLoading}
            onManualConfirm={handleQrScanConfirm}
            qrScanMessage={qrScanMessage}
          />
        </Modal>
      )}
      {showQrScanner && Platform.OS === 'web' && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setShowQrScanner(false)}
        >
          <Pressable style={s.langOverlay} onPress={() => setShowQrScanner(false)}>
            <Pressable style={[s.qrScanModal, {
              backgroundColor: colors.authCardBg,
              borderColor: isDark ? colors.authCardBorder : '#e5e7eb',
            }]} onPress={() => {}}>
              <Text style={[s.qrScanModalTitle, { color: colors.text }]}>
                {t('login.qrScanTitle')}
              </Text>
              <Text style={[s.qrScanModalDesc, { color: colors.textSecondary }]}>
                {t('login.qrScanDesc')}
              </Text>
              <TextInput
                style={[s.qrScanInput, {
                  color: colors.text,
                  borderColor: colors.authInputBorder,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#f9fafb',
                }]}
                value={qrScanToken}
                onChangeText={setQrScanToken}
                placeholder={t('login.qrScanPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              {!!qrScanMessage && (
                <Text style={[s.qrScanMessage, {
                  color: qrScanMessage === t('login.qrScanSuccess') ? '#10b981' : colors.error,
                }]}>
                  {qrScanMessage}
                </Text>
              )}
              <View style={s.qrScanBtnRow}>
                <TouchableOpacity
                  onPress={() => { setShowQrScanner(false); setQrScanToken(''); setQrScanMessage(''); }}
                  style={s.textBtn}
                  activeOpacity={0.7}
                >
                  <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.back')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.primaryBtn, {
                    backgroundColor: colors.primary,
                    opacity: qrScanLoading ? 0.65 : 1,
                  }]}
                  onPress={handleQrScanConfirm}
                  disabled={qrScanLoading}
                  activeOpacity={0.85}
                >
                  {qrScanLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={s.primaryBtnText}>{t('login.qrScanConfirm')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Success overlay — pops a big check after auth, holds for ~440ms,
          then the existing setTimeout routes to /inbox. Telegram-grade
          confirmation: replaces the previous "frozen screen" gap with a
          tactile success cue. Tinted full-screen backdrop fades in via
          successAnim opacity; the check disc springs in via successAnim
          scale. The whole layer is pointerEvents=none below the disc so
          a stray tap can't dismiss / reopen the keyboard. */}
      {loginSuccess ? (
        <Animated.View
          pointerEvents="auto"
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)',
            opacity: successAnim,
            alignItems: 'center', justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <Animated.View style={{
            width: 132, height: 132, borderRadius: 66,
            backgroundColor: '#10b981',
            alignItems: 'center', justifyContent: 'center',
            transform: [{ scale: successAnim }],
            ...Platform.select({
              ios: { shadowColor: '#10b981', shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
              android: { elevation: 14 },
              default: { boxShadow: '0 12px 40px -8px rgba(16,185,129,0.5)' },
            }),
          }}>
            <IconCheck size={64} color="#fff" strokeWidth={3.5} />
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },

  /* Top-right row (lang + theme) */
  topRightRow: {
    position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, right: 16, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  topBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  langBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 36, borderRadius: 18, paddingHorizontal: 10,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  langBtnText: { fontSize: 12, fontWeight: '600' },

  /* Language modal */
  langOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  langModal: {
    width: '90%', maxWidth: 360, maxHeight: '70%',
    borderRadius: 8, borderWidth: 1, overflow: 'hidden',
  },
  langModalTitle: {
    fontSize: 16, fontWeight: '600', textAlign: 'center',
    paddingVertical: 14, paddingHorizontal: 16,
  },
  langList: { maxHeight: 400 },
  langItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 11, paddingHorizontal: 16,
  },
  langFlag: { fontSize: 18, width: 28, textAlign: 'center' },
  langLabel: { fontSize: 14, flex: 1 },
  langCheck: { fontSize: 16, fontWeight: '700' },

  /* Centered layout */
  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 48, minHeight: '100%',
  },
  cardWrap: { width: '100%', maxWidth: 450 },

  /* Card — clean, Google-style */
  card: {
    borderRadius: 16,
    paddingTop: 36, paddingBottom: 28,
    paddingHorizontal: Platform.OS === 'web' ? 40 : 24,
    width: '100%',
  },

  /* Logo — simple, compact */
  logoRow: { alignItems: 'center', marginBottom: 8 },
  logoCircle: {
    width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },

  /* Tab bar — underline style like Google */
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    marginBottom: 0,
  },
  tabItem: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, paddingHorizontal: 8,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  tabText: { fontSize: 13, fontWeight: '600' },

  /* Typography — clean, Google-like */
  title: {
    fontSize: 24, fontWeight: '400', textAlign: 'center', marginBottom: 4,
    ...Platform.select({ web: { fontFamily: "'Google Sans', 'Segoe UI', Roboto, Arial, sans-serif" }, default: {} }),
  },
  subtitle: {
    fontSize: 16, textAlign: 'center', marginBottom: 28, lineHeight: 24,
  },

  /* Error */
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 8, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },

  /* Input — Material Design outlined */
  inputBox: {
    position: 'relative',
    borderWidth: 1, borderRadius: 4,
    ...Platform.select({ web: { transition: 'border-color 0.2s ease' }, default: {} }),
  },
  floatingLabel: {
    position: 'absolute', top: -9, left: 12,
    fontSize: 12, paddingHorizontal: 4, lineHeight: 16,
    ...Platform.select({ web: { pointerEvents: 'none', transition: 'all 0.15s ease' }, default: {} }),
  },
  textInput: {
    fontSize: 16,
    paddingVertical: Platform.OS === 'web' ? 14 : 12,
    paddingHorizontal: 16,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  eyeBtn: {
    position: 'absolute', right: 8, top: 0, bottom: 0,
    justifyContent: 'center', padding: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },

  /* Domain hint */
  domainHint: { fontSize: 12, marginTop: 8, marginBottom: 2, marginLeft: 2, lineHeight: 18 },

  /* User chip */
  userChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    borderRadius: 50, paddingVertical: 4, paddingLeft: 4, paddingRight: 16,
    borderWidth: 1, marginTop: 8, marginBottom: 28,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  userAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  userAvatarLetter: { color: '#fff', fontSize: 12, fontWeight: '600' },
  userEmail: { fontSize: 14, fontWeight: '400', flexShrink: 1 },

  /* Checkbox row */
  checkboxRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 4,
  },
  toggleItem: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  toggleLabel: { fontSize: 13 },
  checkbox: {
    width: 18, height: 18, borderWidth: 2, borderRadius: 2,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { transition: 'all 0.15s ease' }, default: {} }),
  },
  checkmark: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: -1 },

  /* Links */
  forgotLink: { alignSelf: 'flex-start', marginTop: 12, marginBottom: 28 },
  linkText: { fontSize: 14, fontWeight: '600' },

  /* Buttons — Google style */
  btnRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 8,
  },
  textBtn: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 4,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  textBtnLabel: { fontSize: 14, fontWeight: '600' },
  /* Primary button — kept for phone/QR steps that still call s.primaryBtn.
     IG signature: NO shadow, flat. The previous violet box-shadow was
     fighting for attention on a quiet card. */
  primaryBtn: {
    borderRadius: 10, paddingVertical: 13, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', minWidth: 110,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  loadingBtnContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },

  /* IG-style input — flat 50pt rounded, label-as-placeholder. Border color
     toggles via state (RN can't smoothly animate border color natively, so
     simple swap is the canonical choice). */
  igInput: {
    height: 52, borderRadius: 10, borderWidth: 1, paddingHorizontal: 14,
    fontSize: 14, fontWeight: '400',
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'box-shadow 140ms ease' }, default: {} }),
  },
  igEyeBtn: {
    position: 'absolute', right: 6, top: 0, bottom: 0,
    justifyContent: 'center', padding: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },

  /* IG-style primary CTA — full width, 44pt, 8pt radius, no shadow,
     semibold 14pt label. */
  igPrimaryBtn: {
    width: '100%', height: 44, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  igPrimaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  /* Ghost text-link below the primary CTA. */
  igGhostBtn: {
    width: '100%', alignItems: 'center', justifyContent: 'center',
    marginTop: 12, paddingVertical: 6,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  igGhostBtnLabel: { fontSize: 13, fontWeight: '600' },

  /* Footer — bottom of card, clean */
  footer: {
    flexDirection: 'column', alignItems: 'center',
    marginTop: 20, paddingHorizontal: 8, gap: 6,
    paddingBottom: 8,
  },
  footerLinks: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  footerItem: {
    fontSize: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  footerDot: { fontSize: 12 },

  /* QR Code Panel */
  qrPanel: {
    alignItems: 'center', paddingTop: 24, paddingBottom: 8,
  },
  qrLoadingWrap: {
    alignItems: 'center', justifyContent: 'center', height: 280, width: '100%',
  },
  qrConnectedText: {
    fontSize: 20, fontWeight: '600',
  },
  qrImageWrap: {
    width: 260, height: 260, borderRadius: 8, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    marginBottom: 16,
  },
  qrImage: {
    width: 240, height: 240,
  },
  qrExpiredOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },

  /* QR Scanner Modal */
  qrScanModal: {
    width: '90%', maxWidth: 400, borderRadius: 8, borderWidth: 1,
    padding: 24, overflow: 'hidden',
  },
  qrScanModalTitle: {
    fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 8,
  },
  qrScanModalDesc: {
    fontSize: 14, textAlign: 'center', marginBottom: 20, lineHeight: 20,
  },
  qrScanInput: {
    borderWidth: 1, borderRadius: 4, padding: 14, fontSize: 14,
    minHeight: 80, textAlignVertical: 'top',
    marginBottom: 12,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  qrScanMessage: {
    fontSize: 13, textAlign: 'center', marginBottom: 12, fontWeight: '500',
  },
  qrScanBtnRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8,
  },

  /* Biometric login */
  biometricBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 16, paddingVertical: 12, paddingHorizontal: 20,
    borderRadius: 4, borderWidth: 1, gap: 10,
  },
  biometricIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  biometricText: {
    fontSize: 14, fontWeight: '600',
  },

  /* Device verification screen */
  verifyContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, paddingVertical: 48,
  },
  verifyIconCircle: {
    width: 100, height: 100, borderRadius: 50,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
  },
  verifyTitle: {
    fontSize: 24, fontWeight: '400', textAlign: 'center',
    marginBottom: 8,
  },
  verifySubtitle: {
    fontSize: 15, textAlign: 'center', lineHeight: 22,
    marginBottom: 24, paddingHorizontal: 16,
  },
  verifyInfoBox: {
    borderRadius: 8, padding: 16, width: '100%', maxWidth: 360,
    alignItems: 'center',
  },
  verifyInfoLabel: {
    fontSize: 12, fontWeight: '500', marginBottom: 4,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  verifyInfoValue: {
    fontSize: 16, fontWeight: '600',
  },
  verifyWaiting: {
    fontSize: 13, marginTop: 12, textAlign: 'center',
  },
  verifyBtn: {
    marginTop: 32, paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 4, borderWidth: 1,
  },
  verifyBtnText: {
    fontSize: 14, fontWeight: '500',
  },
  verifyBtnPrimary: {
    marginTop: 24, paddingVertical: 14, paddingHorizontal: 32,
    borderRadius: 4,
  },
  verifyBtnPrimaryText: {
    fontSize: 15, fontWeight: '600',
  },
});

// QR Scanner component with camera for login (native only)
function LoginQRScannerView({ onScan, onClose, t, colors, isDark, qrScanToken, setQrScanToken, qrScanLoading, onManualConfirm, qrScanMessage }) {
  const [hasPermission, setHasPermission] = useState(null);
  const [scanned, setScanned] = useState(false);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { Camera } = require('expo-camera');
        const { status } = await Camera.requestCameraPermissionsAsync();
        setHasPermission(status === 'granted');
      } catch {
        setHasPermission(false);
      }
    })();
  }, []);

  const handleBarCodeScanned = ({ data }) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
  };

  // Manual paste mode (fallback)
  if (showManual) {
    return (
      <View style={{ flex: 1, backgroundColor: isDark ? '#0f172a' : '#fff', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: isDark ? '#fff' : '#111', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>
          {t('login.qrScanTitle')}
        </Text>
        <Text style={{ color: isDark ? '#94a3b8' : '#6b7280', fontSize: 14, textAlign: 'center', marginBottom: 20 }}>
          {t('login.qrScanDesc')}
        </Text>
        <TextInput
          style={{
            borderWidth: 1, borderColor: isDark ? '#334155' : '#d1d5db', borderRadius: 12,
            padding: 14, fontSize: 14, color: isDark ? '#fff' : '#111',
            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#f9fafb',
            marginBottom: 12, minHeight: 80, textAlignVertical: 'top',
          }}
          value={qrScanToken}
          onChangeText={setQrScanToken}
          placeholder={t('login.qrScanPlaceholder')}
          placeholderTextColor={isDark ? '#475569' : '#9ca3af'}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {!!qrScanMessage && (
          <Text style={{ color: qrScanMessage.includes('uccess') || qrScanMessage.includes('ucesso') ? '#10b981' : '#ef4444', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
            {qrScanMessage}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
          <TouchableOpacity
            onPress={() => setShowManual(false)}
            style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6' }}
          >
            <Text style={{ color: colors.primary, fontWeight: '600' }}>{t('login.back')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: colors.primary, opacity: qrScanLoading ? 0.65 : 1 }}
            onPress={onManualConfirm}
            disabled={qrScanLoading}
          >
            {qrScanLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('login.qrScanConfirm')}</Text>
            )}
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 16, alignSelf: 'center', padding: 8 }}>
          <Text style={{ color: isDark ? '#94a3b8' : '#6b7280', fontSize: 14 }}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (hasPermission === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={{ color: '#fff', marginTop: 16 }}>{t('login.qrCameraOpening') || 'Opening camera...'}</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', padding: 40 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' }}>
          {t('login.qrCameraPermission') || 'Camera permission required'}
        </Text>
        <Text style={{ color: '#aaa', fontSize: 14, textAlign: 'center', marginTop: 8 }}>
          {t('login.qrCameraPermissionDesc') || 'Allow camera access in Settings to scan QR codes'}
        </Text>
        <TouchableOpacity
          onPress={() => setShowManual(true)}
          style={{ marginTop: 24, padding: 14, backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 32 }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('login.qrManualEntry') || 'Enter code manually'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 16, padding: 12 }}>
          <Text style={{ color: '#aaa', fontWeight: '500' }}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  let CameraComponent;
  try { CameraComponent = require('expo-camera').CameraView; } catch { CameraComponent = null; }

  if (!CameraComponent) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <Text style={{ color: '#fff', fontSize: 16 }}>{t('login.qrCameraUnavailable') || 'Camera not available'}</Text>
        <TouchableOpacity
          onPress={() => setShowManual(true)}
          style={{ marginTop: 24, padding: 14, backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 32 }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('login.qrManualEntry') || 'Enter code manually'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 16, padding: 12 }}>
          <Text style={{ color: '#aaa', fontWeight: '500' }}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraComponent
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: 250, height: 250, borderWidth: 3, borderColor: '#fff', borderRadius: 20, backgroundColor: 'transparent' }} />
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '500', marginTop: 24, textAlign: 'center', paddingHorizontal: 40 }}>
          {t('login.qrScanHint') || 'Point at the QR code on the computer screen'}
        </Text>
      </View>
      <TouchableOpacity onPress={onClose} style={{ position: 'absolute', top: 50, left: 20, padding: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 25 }}>
        <IconX size={24} color="#fff" />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => setShowManual(true)}
        style={{ position: 'absolute', bottom: 50, alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 24, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20 }}
      >
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '500' }}>{t('login.qrManualEntry') || 'Enter code manually'}</Text>
      </TouchableOpacity>
    </View>
  );
}
