import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Animated, useWindowDimensions, Modal, FlatList, Pressable, Image, Alert,
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
} from '../components/Icons';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import { LANGUAGES } from '../i18n';
import * as api from '../services/api';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import Svg, { Path, Rect, Circle as SvgCircle } from 'react-native-svg';

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
  const [loginMode, setLoginMode] = useState('email'); // 'email', 'qr', or 'phone'

  // Phone login state
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState('+55');
  const [phoneOtp, setPhoneOtp] = useState(['', '', '', '', '', '']);
  const [phoneStep, setPhoneStep] = useState('input'); // 'input' or 'otp'
  const [phoneSending, setPhoneSending] = useState(false);
  const [phoneVerifying, setPhoneVerifying] = useState(false);
  const [phoneResendTimer, setPhoneResendTimer] = useState(0);
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

          // Only auto-prompt if we actually have saved creds. Otherwise the
          // cold-start prompt would show Face ID for nothing — better to let
          // user tap when they have creds to unlock.
          const hasCreds = await SecureStore.getItemAsync('bio_email');
          if (hasCreds) {
            setTimeout(() => {
              if (mountedRef.current) {
                handleBiometricLoginRef.current?.();
              }
            }, 350);
          }
        }
      } catch {}
    })();
  }, []);

  // Ref so the auto-trigger above can call the latest handler without adding
  // it to the useEffect deps (would re-fire on every state change).
  const handleBiometricLoginRef = useRef(null);

  const handleBiometricLogin = useCallback(async () => {
    setBioLoading(true);
    setError('');
    try {
      // Read saved identifiers BEFORE triggering authenticateAsync — this
      // lets us short-circuit to the normal password flow when we have
      // nothing saved, instead of prompting Face ID on an unknown account.
      const savedEmail = await SecureStore.getItemAsync('bio_email');
      const savedToken = await SecureStore.getItemAsync('bio_token');
      const legacyPassword = !savedToken ? await SecureStore.getItemAsync('bio_password') : null;

      // First time on this device: no saved email. Just let the user type
      // their email. After they log in with password once we save the
      // token and Face ID becomes a real one-tap login.
      if (!savedEmail) {
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

  useEffect(() => {
    mountedRef.current = true;

    // Simple fade-in entrance
    const entrance = Animated.timing(cardFadeAnim, {
      toValue: 1, duration: 350, useNativeDriver: true,
    });
    entrance.start();

    return () => {
      mountedRef.current = false;
      entrance.stop();
    };
  }, []);

  const animateStep = (next) => {
    const out = next === 2 ? -30 : 30;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: out, duration: 120, useNativeDriver: true }),
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
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 40, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleContinue = () => {
    const trimmed = email.trim();
    if (!trimmed) { setError(t('login.errorEmail')); shake(); return; }
    if (trimmed.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t('login.errorEmail')); shake(); return;
    }
    setError('');
    animateStep(2);
  };

  const handleLogin = async () => {
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
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    if (cleaned.length < 8) { setError(t('login.phoneInvalid')); shake(); return; }
    setError('');
    setPhoneSending(true);
    try {
      const fullPhone = phoneCountryCode + cleaned;
      const r = await api.requestPhoneOtp(fullPhone);
      if (!mountedRef.current) return;
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

  const handlePhoneVerifyOtp = async () => {
    const code = phoneOtp.join('');
    if (code.length !== 6) return;
    setError('');
    setPhoneVerifying(true);
    try {
      const fullPhone = phoneCountryCode + phoneNumber.replace(/[^0-9]/g, '');
      const r = await api.verifyPhoneOtp(fullPhone, code);
      if (!mountedRef.current) return;
      if (r.success && r.data?.token) {
        await loginWithToken(r.data.token, r.data.email);
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
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection'));
      shake();
    } finally {
      if (mountedRef.current) setPhoneVerifying(false);
    }
  };

  const handlePhoneOtpChange = (index, value) => {
    if (value.length > 1) value = value.slice(-1);
    if (value && !/^\d$/.test(value)) return;
    const newOtp = [...phoneOtp];
    newOtp[index] = value;
    setPhoneOtp(newOtp);
    if (value && index < 5) {
      phoneOtpRefs.current[index + 1]?.focus();
    }
    // Auto-verify when all 6 digits entered
    if (newOtp.every(d => d !== '') && newOtp.join('').length === 6) {
      setTimeout(() => {
        const code = newOtp.join('');
        if (code.length === 6) handlePhoneVerifyOtp();
      }, 200);
    }
  };

  const handlePhoneOtpKeyPress = (index, key) => {
    if (key === 'Backspace' && !phoneOtp[index] && index > 0) {
      phoneOtpRefs.current[index - 1]?.focus();
    }
  };

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
                <Text style={{ fontSize: 48 }}>{'✓'}</Text>
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

  return (
    <View style={[s.root, { backgroundColor: isDark ? '#202124' : '#f0f4f9' }]}>

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
            <Text style={{ fontSize: 10, color: isDark ? '#9aa0a6' : '#5f6368', marginLeft: -1 }}>{'\u25BE'}</Text>
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
            <Animated.View style={[s.cardWrap, { opacity: cardFadeAnim }]}>
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

                  {/* Logo + brand + slogan */}
                  <View style={s.logoRow}>
                    <View style={[s.logoCircle, { backgroundColor: isDark ? '#394046' : '#f1f3f4' }]}>
                      <IconMailLogo size={32} color={colors.primary} />
                    </View>
                    <Text style={{
                      fontSize: 26, fontWeight: '800',
                      color: colors.primary, marginTop: 10,
                      letterSpacing: 0.3,
                    }}>
                      Chatyy
                    </Text>
                    <Text style={{
                      fontSize: 13, fontWeight: '500',
                      color: isDark ? '#9aa0a6' : '#5f6368',
                      marginTop: 2, marginBottom: 4,
                    }}>
                      {t('login.tagline') || 'Tudo está aqui'}
                    </Text>
                  </View>

                  {/* Tab bar — Email / Phone / QR */}
                  <View style={[s.tabBar, {
                    borderBottomColor: isDark ? '#5f6368' : '#dadce0',
                  }]}>
                    <TouchableOpacity
                      style={[s.tabItem, loginMode === 'email' && { borderBottomColor: colors.primary }]}
                      onPress={() => { setLoginMode('email'); setError(''); setStep(1); }}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.tabText, { color: loginMode === 'email' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }]}>
                        Email
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.tabItem, loginMode === 'phone' && { borderBottomColor: colors.primary }]}
                      onPress={() => { setLoginMode('phone'); setError(''); setPhoneStep('input'); setPhoneOtp(['', '', '', '', '', '']); }}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.tabText, { color: loginMode === 'phone' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }]}>
                        {t('login.phoneNumber')}
                      </Text>
                    </TouchableOpacity>
                    {isDesktop && (
                      <TouchableOpacity
                        style={[s.tabItem, loginMode === 'qr' && { borderBottomColor: colors.primary }]}
                        onPress={() => { setLoginMode('qr'); setError(''); setStep(1); }}
                        activeOpacity={0.7}
                      >
                        <Text style={[s.tabText, { color: loginMode === 'qr' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }]}>
                          QR Code
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* ── PHONE LOGIN ── */}
                  {loginMode === 'phone' ? (
                    <View style={{ paddingTop: 24 }}>
                      <Text style={[s.title, { color: isDark ? '#e8eaed' : '#202124' }]}>{t('login.phoneTitle')}</Text>
                      <Text style={[s.subtitle, { color: isDark ? '#9aa0a6' : '#5f6368' }]}>
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
                          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                            <TouchableOpacity
                              style={[s.inputBox, {
                                borderColor: isDark ? '#5f6368' : '#dadce0',
                                width: 100, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 4,
                              }]}
                              onPress={() => { setCountrySearch(''); setShowCountryPicker(true); }}
                              activeOpacity={0.7}
                            >
                              <Text style={{ fontSize: 18 }}>{COUNTRY_CODES.find(c => c.code === phoneCountryCode)?.flag || ''}</Text>
                              <Text style={{ color: isDark ? '#e8eaed' : '#202124', fontSize: 14, fontWeight: '500' }}>{phoneCountryCode}</Text>
                              <Text style={{ fontSize: 10, color: isDark ? '#9aa0a6' : '#5f6368' }}>{'\u25BC'}</Text>
                            </TouchableOpacity>
                            <View style={[s.inputBox, {
                              flex: 1,
                              borderColor: focused === 'phone' ? colors.primary : (isDark ? '#5f6368' : '#dadce0'),
                              ...(focused === 'phone' ? { borderWidth: 2, margin: -1 } : {}),
                            }]}>
                              <TextInput
                                style={[s.textInput, { color: isDark ? '#e8eaed' : '#202124' }]}
                                value={phoneNumber}
                                onChangeText={(text) => { setPhoneNumber(text.replace(/[^0-9\s()-]/g, '')); if (error) setError(''); }}
                                keyboardType="phone-pad"
                                placeholder={t('login.phonePlaceholder')}
                                placeholderTextColor={isDark ? '#9aa0a6' : '#80868b'}
                                onFocus={() => setFocused('phone')}
                                onBlur={() => setFocused('')}
                                onSubmitEditing={handlePhoneSendOtp}
                                accessibilityLabel={t('login.phoneNumber')}
                              />
                            </View>
                          </View>

                          <View style={s.btnRow}>
                            <View />
                            <TouchableOpacity
                              style={[s.primaryBtn, { backgroundColor: colors.primary, opacity: phoneSending ? 0.7 : 1 }]}
                              onPress={handlePhoneSendOtp}
                              disabled={phoneSending}
                              activeOpacity={0.85}
                            >
                              {phoneSending ? (
                                <View style={s.loadingBtnContent}>
                                  <ActivityIndicator color="#fff" size="small" />
                                  <Text style={[s.primaryBtnText, { marginLeft: 8 }]}>{t('login.phoneSendCode')}...</Text>
                                </View>
                              ) : (
                                <Text style={s.primaryBtnText}>{t('login.phoneSendCode')}</Text>
                              )}
                            </TouchableOpacity>
                          </View>
                        </>
                      ) : (
                        <>
                          {/* OTP 6-digit boxes */}
                          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
                            {phoneOtp.map((digit, i) => (
                              <TextInput
                                key={i}
                                ref={ref => { phoneOtpRefs.current[i] = ref; }}
                                style={[{
                                  width: 44, height: 52, borderRadius: 8, borderWidth: digit ? 2 : 1,
                                  borderColor: digit ? colors.primary : (isDark ? '#5f6368' : '#dadce0'),
                                  backgroundColor: isDark ? '#303134' : '#fff',
                                  textAlign: 'center', fontSize: 22, fontWeight: '600',
                                  color: isDark ? '#e8eaed' : '#202124',
                                }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                                value={digit}
                                onChangeText={(v) => handlePhoneOtpChange(i, v)}
                                onKeyPress={({ nativeEvent }) => handlePhoneOtpKeyPress(i, nativeEvent.key)}
                                keyboardType="number-pad"
                                maxLength={1}
                                selectTextOnFocus
                              />
                            ))}
                          </View>

                          <View style={s.btnRow}>
                            <View />
                            <TouchableOpacity
                              style={[s.primaryBtn, { backgroundColor: colors.primary, opacity: phoneVerifying ? 0.7 : 1 }]}
                              onPress={handlePhoneVerifyOtp}
                              disabled={phoneVerifying || phoneOtp.join('').length !== 6}
                              activeOpacity={0.85}
                            >
                              {phoneVerifying ? (
                                <View style={s.loadingBtnContent}>
                                  <ActivityIndicator color="#fff" size="small" />
                                  <Text style={[s.primaryBtnText, { marginLeft: 8 }]}>{t('login.phoneVerify')}...</Text>
                                </View>
                              ) : (
                                <Text style={s.primaryBtnText}>{t('login.phoneVerify')}</Text>
                              )}
                            </TouchableOpacity>
                          </View>

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
                                <Text style={{ fontSize: 40, color: '#9ca3af', marginBottom: 8 }}>{'\u21BB'}</Text>
                                <Text style={{ fontSize: 14, fontWeight: '500', color: isDark ? '#9aa0a6' : '#5f6368' }}>
                                  {t('login.qrExpired')}
                                </Text>
                              </View>
                            )}
                            {qrStatus === 'expired' && (
                              <View style={[s.qrExpiredOverlay, { backgroundColor: 'rgba(255,255,255,0.9)' }]}>
                                <TouchableOpacity onPress={handleRefreshQR} activeOpacity={0.7} style={{ alignItems: 'center', padding: 16 }}>
                                  <Text style={{ fontSize: 36, color: colors.primary, marginBottom: 8 }}>{'\u21BB'}</Text>
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

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: isDark ? '#3c2020' : '#fce8e6', borderColor: isDark ? '#c5221f' : '#d93025' }]}>
                          <IconAlertTriangle size={14} color={isDark ? '#f28b82' : '#d93025'} />
                          <Text style={[s.errorText, { color: isDark ? '#f28b82' : '#d93025' }]}>{error}</Text>
                        </View>
                      )}

                      {/* Email input — Material Design outlined */}
                      <View style={[
                        s.inputBox,
                        {
                          borderColor: focused === 'email' ? colors.primary : (isDark ? '#5f6368' : '#dadce0'),
                          ...(focused === 'email' ? { borderWidth: 2, margin: -1 } : {}),
                        },
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: isDark ? '#303134' : '#fff' },
                          focused === 'email' || email
                            ? { top: -9, fontSize: 11, fontWeight: '500', color: focused === 'email' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }
                            : { color: 'transparent' },
                        ]}>
                          {t('login.emailPlaceholder')}
                        </Text>
                        <TextInput
                          style={[s.textInput, { color: isDark ? '#e8eaed' : '#202124' }]}
                          value={email}
                          onChangeText={(text) => { setEmail(text); if (error) setError(''); }}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          autoComplete="email"
                          returnKeyType="next"
                          placeholder={focused === 'email' ? '' : t('login.emailPlaceholder')}
                          placeholderTextColor={isDark ? '#9aa0a6' : '#80868b'}
                          onFocus={() => setFocused('email')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleContinue}
                          accessibilityLabel={t('login.emailPlaceholder')}
                        />
                      </View>

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

                      {/* Phone-first signup CTA — WhatsApp pattern. Routes to
                          the new dedicated phone-only signup flow (no password). */}
                      <TouchableOpacity
                        onPress={() => router.push('/signup-phone')}
                        activeOpacity={0.7}
                        style={{
                          marginTop: 14, paddingVertical: 11, paddingHorizontal: 14,
                          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                          borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
                        }}
                        accessibilityRole="button"
                      >
                        <IconPhone size={16} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '700' }}>
                          {t('login.signupWithPhone') || 'Criar conta com telefone'}
                        </Text>
                      </TouchableOpacity>

                      {/* Buttons — Google style: create account left, Next right */}
                      <View style={s.btnRow}>
                        <TouchableOpacity
                          onPress={() => router.push('/signup/step-name')}
                          activeOpacity={0.7}
                          style={s.textBtn}
                          accessibilityRole="button"
                        >
                          <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.createAccount')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.primaryBtn, { backgroundColor: colors.primary }]}
                          onPress={handleContinue}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          <Text style={s.primaryBtnText}>{t('login.next')}</Text>
                        </TouchableOpacity>
                      </View>

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
                        <Text style={{ marginLeft: 6, fontSize: 12, color: isDark ? '#9aa0a6' : '#5f6368' }}>{'\u25BE'}</Text>
                      </TouchableOpacity>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: isDark ? '#3c2020' : '#fce8e6', borderColor: isDark ? '#c5221f' : '#d93025' }]}>
                          <IconAlertTriangle size={14} color={isDark ? '#f28b82' : '#d93025'} />
                          <Text style={[s.errorText, { color: isDark ? '#f28b82' : '#d93025' }]}>{error}</Text>
                        </View>
                      )}

                      {/* Password input — Material Design outlined */}
                      <View style={[
                        s.inputBox,
                        {
                          borderColor: focused === 'pass' ? colors.primary : (isDark ? '#5f6368' : '#dadce0'),
                          ...(focused === 'pass' ? { borderWidth: 2, margin: -1 } : {}),
                        },
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: isDark ? '#303134' : '#fff' },
                          focused === 'pass' || password
                            ? { top: -9, fontSize: 11, fontWeight: '500', color: focused === 'pass' ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368') }
                            : { color: 'transparent' },
                        ]}>
                          {t('login.passwordPlaceholder')}
                        </Text>
                        <TextInput
                          ref={passwordRef}
                          style={[s.textInput, { color: isDark ? '#e8eaed' : '#202124', paddingRight: 48 }]}
                          value={password}
                          onChangeText={(text) => { setPassword(text); if (error) setError(''); }}
                          secureTextEntry={!showPassword}
                          returnKeyType="go"
                          placeholder={focused === 'pass' ? '' : t('login.passwordInput')}
                          placeholderTextColor={isDark ? '#9aa0a6' : '#80868b'}
                          onFocus={() => setFocused('pass')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleLogin}
                          accessibilityLabel={t('login.passwordPlaceholder')}
                        />
                        <TouchableOpacity
                          onPress={() => setShowPassword(!showPassword)}
                          style={s.eyeBtn}
                          activeOpacity={0.6}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                        >
                          {showPassword
                            ? <IconEyeOff size={20} color={isDark ? '#9aa0a6' : '#5f6368'} />
                            : <IconEye size={20} color={isDark ? '#9aa0a6' : '#5f6368'} />}
                        </TouchableOpacity>
                      </View>

                      {/* Show password checkbox */}
                      <View style={s.checkboxRow}>
                        <TouchableOpacity
                          style={s.toggleItem}
                          onPress={() => setShowPassword(!showPassword)}
                          activeOpacity={0.7}
                        >
                          <View style={[s.checkbox, {
                            borderColor: showPassword ? colors.primary : (isDark ? '#9aa0a6' : '#5f6368'),
                            backgroundColor: showPassword ? colors.primary : 'transparent',
                          }]}>
                            {showPassword && <Text style={s.checkmark}>{'\u2713'}</Text>}
                          </View>
                          <Text style={[s.toggleLabel, { color: isDark ? '#e8eaed' : '#202124' }]}>{t('login.showPassword')}</Text>
                        </TouchableOpacity>
                      </View>

                      <TouchableOpacity style={s.forgotLink} activeOpacity={0.6} onPress={() => router.push('/forgot')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={[s.linkText, { color: colors.primary }]}>{t('login.forgotPassword')}</Text>
                      </TouchableOpacity>

                      {/* Buttons */}
                      <View style={s.btnRow}>
                        <TouchableOpacity onPress={() => animateStep(1)} style={s.textBtn} activeOpacity={0.6} accessibilityRole="button">
                          <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.back')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.primaryBtn, {
                            backgroundColor: colors.primary,
                          }, loading && { opacity: 0.7 }]}
                          onPress={handleLogin}
                          disabled={loading}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          {loading ? (
                            <View style={s.loadingBtnContent}>
                              <ActivityIndicator color="#fff" size="small" />
                              <Text style={[s.primaryBtnText, { marginLeft: 8 }]}>{t('login.enter')}...</Text>
                            </View>
                          ) : (
                            <Text style={s.primaryBtnText}>{t('login.enter')}</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </Animated.View>
              </View>

              {/* Footer — Privacy / Terms / Help */}
              <View style={s.footer}>
                {!isDesktop && (
                  <TouchableOpacity
                    activeOpacity={0.6}
                    onPress={() => setShowQrScanner(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ marginBottom: 8 }}
                  >
                    <Text style={[s.linkText, { color: colors.primary, fontSize: 13 }]}>
                      {t('login.qrScanTitle')}
                    </Text>
                  </TouchableOpacity>
                )}
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
  primaryBtn: {
    borderRadius: 12, paddingVertical: 13, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', minWidth: 110,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.15s ease, box-shadow 0.2s ease',
        boxShadow: '0 4px 14px rgba(124, 58, 237, 0.28), 0 1px 2px rgba(0,0,0,0.06)',
      },
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 10 },
      android: { elevation: 4 },
    }),
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  loadingBtnContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },

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
