import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Animated, useWindowDimensions, Modal, FlatList, Pressable, Image, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSun, IconMoon, IconAlertTriangle,
  IconEye, IconEyeOff,
  IconMailLogo, IconShield, IconGlobe,
} from '../components/Icons';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import { LANGUAGES } from '../i18n';
import * as api from '../services/api';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

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
  const { login, completeLoginAfterChallenge } = useAuth();
  const { colors, isDark, toggle } = useTheme();
  const { t, language, changeLanguage } = useLanguage();
  const [showLangModal, setShowLangModal] = useState(false);
  const router = useRouter();
  const params = useLocalSearchParams();
  const isAddAccount = params.add_account === '1';
  const { width } = useWindowDimensions();
  const mountedRef = useRef(true);
  const passwordRef = useRef(null);

  // QR Code login state
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const [loginMode, setLoginMode] = useState('email'); // 'email' or 'qr'
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

  // Biometric login state (native only)
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);
  const isNative = Platform.OS !== 'web';

  // Check biometric availability on mount (native only)
  useEffect(() => {
    if (!isNative) return;
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        const hasCreds = await SecureStore.getItemAsync('bio_email');
        if (hasHw && isEnrolled && hasCreds) setBioAvailable(true);
      } catch {}
    })();
  }, []);

  const handleBiometricLogin = useCallback(async () => {
    setBioLoading(true);
    setError('');
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('login.biometric'),
        cancelLabel: t('login.back'),
        disableDeviceFallback: false,
      });
      if (result.success) {
        const savedEmail = await SecureStore.getItemAsync('bio_email');
        const savedPassword = await SecureStore.getItemAsync('bio_password');
        if (savedEmail && savedPassword) {
          setLoading(true);
          const r = await login(savedEmail, savedPassword);
          if (!mountedRef.current) return;
          if (r.success) {
            router.replace('/inbox');
          } else {
            setError(r.message || t('login.errorCredentials'));
            shake();
          }
        } else {
          setError(t('login.biometricNoCredentials'));
          shake();
        }
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.biometricError'));
      shake();
    } finally {
      if (mountedRef.current) { setBioLoading(false); setLoading(false); }
    }
  }, [t, login, router]);

  // Step transition + error shake
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // ── Premium entrance animated values ──
  const bgAnim = useRef(new Animated.Value(0)).current;
  const logoAnim = useRef(new Animated.Value(0)).current;
  const logoShimmer = useRef(new Animated.Value(0)).current;
  const brandAnim = useRef(new Animated.Value(0)).current;
  const titleAnim = useRef(new Animated.Value(0)).current;
  const subtitleAnim = useRef(new Animated.Value(0)).current;
  const formAnim = useRef(new Animated.Value(0)).current;
  const footerAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  // Orbs: two axes each for organic Lissajous floating + breathing pulse
  const orb1A = useRef(new Animated.Value(0)).current;
  const orb1B = useRef(new Animated.Value(0)).current;
  const orb2A = useRef(new Animated.Value(0)).current;
  const orb2B = useRef(new Animated.Value(0)).current;
  const orb3A = useRef(new Animated.Value(0)).current;
  const orb3B = useRef(new Animated.Value(0)).current;
  const orbPulse1 = useRef(new Animated.Value(0)).current;
  const orbPulse2 = useRef(new Animated.Value(0)).current;
  const orbPulse3 = useRef(new Animated.Value(0)).current;

  // Responsive card padding
  const cardPadding = width < 380 ? 20 : width < 480 ? 28 : 40;

  useEffect(() => {
    mountedRef.current = true;

    // ── Orchestrated entrance (~1.3s total, overlapping phases) ──

    // Phase 1 (0ms): Background orbs softly fade in
    const bgIn = Animated.timing(bgAnim, {
      toValue: 1, duration: 600, useNativeDriver: Platform.OS !== 'web',
    });

    // Phase 2 (80ms): Logo scales from tiny (0.3x) + slight rotation with springy overshoot
    const logoIn = Animated.spring(logoAnim, {
      toValue: 1, tension: 55, friction: 6, useNativeDriver: Platform.OS !== 'web',
    });

    // Phase 3: Brief shimmer/pulse on logo after it lands
    const shimmer = Animated.sequence([
      Animated.timing(logoShimmer, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(logoShimmer, { toValue: 0, duration: 350, useNativeDriver: Platform.OS !== 'web' }),
    ]);

    // Phase 4+: Brand text, title, subtitle, form card, footer cascade
    const brandIn = Animated.spring(brandAnim, {
      toValue: 1, tension: 65, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const titleIn = Animated.spring(titleAnim, {
      toValue: 1, tension: 60, friction: 9, useNativeDriver: Platform.OS !== 'web',
    });
    const subtitleIn = Animated.spring(subtitleAnim, {
      toValue: 1, tension: 55, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const formIn = Animated.spring(formAnim, {
      toValue: 1, tension: 50, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const footerIn = Animated.timing(footerAnim, {
      toValue: 1, duration: 450, useNativeDriver: Platform.OS !== 'web',
    });

    // BG starts immediately; logo at 80ms; after logo spring settles:
    // shimmer + cascade everything else in parallel with staggered delays
    const entrance = Animated.parallel([
      bgIn,
      Animated.sequence([
        Animated.delay(80),
        logoIn,
        Animated.parallel([
          shimmer,
          Animated.sequence([Animated.delay(50), brandIn]),
          Animated.sequence([Animated.delay(120), titleIn]),
          Animated.sequence([Animated.delay(200), subtitleIn]),
          Animated.sequence([Animated.delay(300), formIn]),
          Animated.sequence([Animated.delay(420), footerIn]),
        ]),
      ]),
    ]);
    entrance.start();

    // ── Continuous glow breathing ──
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 3000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0, duration: 3000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    glowLoop.start();

    // ── Organic orb floating: offset sine waves per axis for figure-8 paths ──
    const orbLoops = [];
    const floatOrb = (animA, animB, dA, dB) => {
      const lA = Animated.loop(Animated.sequence([
        Animated.timing(animA, { toValue: 1, duration: dA, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(animA, { toValue: 0, duration: dA, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      const lB = Animated.loop(Animated.sequence([
        Animated.timing(animB, { toValue: 1, duration: dB, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(animB, { toValue: 0, duration: dB, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      lA.start(); lB.start();
      orbLoops.push(lA, lB);
    };
    floatOrb(orb1A, orb1B, 6000, 8000);
    floatOrb(orb2A, orb2B, 7500, 5500);
    floatOrb(orb3A, orb3B, 9000, 6500);

    // ── Orb breathing: opacity pulsing at different rates ──
    const pulseOrb = (anim, dur) => {
      const l = Animated.loop(Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: dur, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(anim, { toValue: 0, duration: dur, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      l.start(); orbLoops.push(l);
    };
    pulseOrb(orbPulse1, 4000);
    pulseOrb(orbPulse2, 5000);
    pulseOrb(orbPulse3, 4500);

    return () => {
      mountedRef.current = false;
      entrance.stop();
      glowLoop.stop();
      orbLoops.forEach(l => l.stop());
    };
  }, []);

  const animateStep = (next) => {
    const out = next === 2 ? -30 : 30;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(slideAnim, { toValue: out, duration: 120, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(() => {
      setStep(next);
      if (next === 1) setError('');
      slideAnim.setValue(-out);
      Animated.parallel([
        Animated.spring(fadeAnim, { toValue: 1, tension: 80, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
        Animated.spring(slideAnim, { toValue: 0, tension: 80, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
      ]).start(() => {
        if (next === 2) passwordRef.current?.focus();
      });
    });
  };

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
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
        // Save credentials for biometric login (native only)
        if (Platform.OS !== 'web') {
          try {
            await SecureStore.setItemAsync('bio_email', fullEmail);
            await SecureStore.setItemAsync('bio_password', password);
          } catch {}
        }
        router.replace('/inbox');
      } else {
        setError(r.message || t('login.errorCredentials'));
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
                  await SecureStore.setItemAsync('bio_email', chEmail);
                  await SecureStore.setItemAsync('bio_password', password);
                } catch {}
              }
              setTimeout(() => {
                if (mountedRef.current) router.replace('/inbox');
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
          if (res.data.auth_token) {
            api.setAuthTokenDirect(res.data.auth_token);
            // Store account info
            if (res.data.email) {
              api.upsertAccount(res.data.email, '', res.data.email.split('@')[0]);
              api.setActiveAccountEmail(res.data.email);
            }
            setTimeout(() => {
              if (mountedRef.current) router.replace('/inbox');
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
  }, [qrStatus, qrToken, router]);

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

  // ── Logo interpolations: scale from 0.3 with slight rotation + shimmer pulse ──
  const logoScale = logoAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const logoRotate = logoAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['-12deg', '3deg', '0deg'] });
  const shimmerScale = logoShimmer.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const shimmerGlow = logoShimmer.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 1, 0.3] });

  // ── Brand text slide-up ──
  const brandTranslateY = brandAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  // ── Title / subtitle smooth slide-up ──
  const titleTranslateY = titleAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] });
  const subtitleTranslateY = subtitleAnim.interpolate({ inputRange: [0, 1], outputRange: [22, 0] });

  // ── Form card slides up with subtle scale ──
  const formTranslateY = formAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  const formScaleVal = formAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });

  // ── Footer slide-up ──
  const footerTranslateY = footerAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  // ── Glow breathing ──
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.85] });
  const glowScale = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] });

  // ── Orb Lissajous paths: organic figure-8 floating ──
  const orb1Y = orb1A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -28, 0] });
  const orb1X = orb1B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 22, 0] });
  const orb2Y = orb2A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 24, 0] });
  const orb2X = orb2B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -18, 0] });
  const orb3Y = orb3A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -22, 0] });
  const orb3X = orb3B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 14, 0] });
  const orb3ScaleVal = orb3A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.15, 1] });

  // ── Orb breathing opacity ──
  const orbOp1 = orbPulse1.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const orbOp2 = orbPulse2.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.95] });
  const orbOp3 = orbPulse3.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

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
    <View style={[s.root, { backgroundColor: colors.authBg }]}>
      {/* Animated floating background orbs with breathing */}
      <Animated.View style={[s.bgDecor, { opacity: bgAnim }]} pointerEvents="none">
        <Animated.View style={[s.bgCircle1, {
          backgroundColor: colors.primary + '0a',
          opacity: orbOp1,
          transform: [{ translateY: orb1Y }, { translateX: orb1X }],
        }]} />
        <Animated.View style={[s.bgCircle2, {
          backgroundColor: colors.primary + '08',
          opacity: orbOp2,
          transform: [{ translateY: orb2Y }, { translateX: orb2X }],
        }]} />
        <Animated.View style={[s.bgCircle3, {
          backgroundColor: (colors.authSuccessGreen || '#10b981') + '08',
          opacity: orbOp3,
          transform: [{ translateY: orb3Y }, { translateX: orb3X }, { scale: orb3ScaleVal }],
        }]} />
      </Animated.View>

      {/* Cancel button for add_account mode */}
      {isAddAccount && (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, left: 16, zIndex: 10 }}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('account.cancel')}
        >
          <View style={[s.themeBtn, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
            borderColor: colors.authInputBorder,
            paddingHorizontal: 12, width: 'auto', borderRadius: 20,
          }]}>
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>{t('account.cancel')}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Language selector + Theme toggle row */}
      <View style={s.topRightRow}>
        <TouchableOpacity
          onPress={() => setShowLangModal(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Change language"
        >
          <View style={[s.langBtn, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
            borderColor: colors.authInputBorder,
            ...(Platform.OS === 'web' ? {
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            } : {
              shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
            }),
          }]}>
            <IconGlobe size={14} color={colors.textSecondary} />
            <Text style={[s.langBtnText, { color: colors.text }]}>{langShort}</Text>
            <Text style={[s.langBtnArrow, { color: colors.textSecondary }]}>{'\u25BE'}</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={toggle}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
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
      </View>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.center}>
            {/* Card wrapper: form slides up with subtle scale */}
            <Animated.View style={[s.cardWrap, {
              opacity: formAnim,
              transform: [{ translateY: formTranslateY }, { scale: formScaleVal }],
            }]}>

              {/* ── Card ── */}
              <View style={[s.card, {
                backgroundColor: colors.authCardBg,
                paddingHorizontal: cardPadding,
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
                <Animated.View style={{
                  opacity: fadeAnim,
                  transform: [{ translateX: slideAnim }, { translateX: shakeAnim }],
                }}>

                  {/* Logo — magical entrance: scale from tiny + rotate + shimmer */}
                  <View style={s.logoRow}>
                    <Animated.View style={{
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 10,
                      opacity: logoAnim,
                      transform: [
                        { scale: logoScale },
                        { rotate: logoRotate },
                      ],
                    }}>
                      <View style={s.logoWrap}>
                        {/* Breathing glow ring */}
                        <Animated.View style={[s.logoGlow, {
                          backgroundColor: colors.primary + '0a',
                          opacity: glowOpacity,
                          transform: [{ scale: glowScale }],
                        }]} />
                        {/* Shimmer pulse overlay */}
                        <Animated.View style={[s.logoGlow, {
                          backgroundColor: colors.primary + '12',
                          opacity: shimmerGlow,
                          transform: [{ scale: shimmerScale }],
                        }]} />
                        <View style={[s.logoCircle, {
                          backgroundColor: isDark ? colors.primary + '15' : '#ffffff',
                          ...(Platform.OS === 'web' ? {
                            boxShadow: isDark
                              ? `0 0 20px ${colors.primary}20, 0 2px 8px rgba(0,0,0,0.2)`
                              : `0 2px 12px ${colors.primary}15, 0 1px 3px rgba(0,0,0,0.06)`,
                          } : {
                            shadowColor: colors.primary,
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: 0.15,
                            shadowRadius: 12,
                            elevation: 4,
                          }),
                        }]}>
                          <IconMailLogo size={32} color={colors.primary} />
                        </View>
                      </View>
                    </Animated.View>
                    {/* Brand text — separate fade-up after logo */}
                    <Animated.Text style={[s.brand, {
                      color: colors.primary,
                      opacity: brandAnim,
                      transform: [{ translateY: brandTranslateY }],
                    }]}>Chatyy</Animated.Text>
                  </View>

                  {/* QR / Email tab toggle (desktop only) */}
                  {isDesktop && (
                    <View style={s.qrTabRow}>
                      <TouchableOpacity
                        style={[s.qrTab, loginMode === 'email' && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
                        onPress={() => { setLoginMode('email'); setError(''); }}
                        activeOpacity={0.7}
                      >
                        <Text style={[s.qrTabText, { color: loginMode === 'email' ? colors.primary : colors.textSecondary }]}>
                          {t('login.emailTab')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[s.qrTab, loginMode === 'qr' && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
                        onPress={() => { setLoginMode('qr'); setError(''); setStep(1); }}
                        activeOpacity={0.7}
                      >
                        <Text style={[s.qrTabText, { color: loginMode === 'qr' ? colors.primary : colors.textSecondary }]}>
                          {t('login.qrTab')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* QR Code login panel (desktop) */}
                  {loginMode === 'qr' && isDesktop ? (
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
                            borderColor: isDark ? colors.authCardBorder : '#e5e7eb',
                            backgroundColor: '#ffffff',
                          }]}>
                            {qrStatus === 'pending' && qrToken ? (
                              <Image
                                source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent('chatyy://qr/' + qrToken)}&size=250x250&format=svg&margin=8` }}
                                style={s.qrImage}
                                resizeMode="contain"
                              />
                            ) : (
                              <View style={s.qrExpiredOverlay}>
                                <Text style={s.qrExpiredIcon}>{'\u21BB'}</Text>
                                <Text style={[s.qrExpiredText, { color: colors.textSecondary }]}>
                                  {t('login.qrExpired')}
                                </Text>
                              </View>
                            )}
                            {qrStatus === 'expired' && (
                              <View style={[s.qrExpiredOverlay, { backgroundColor: 'rgba(255,255,255,0.9)' }]}>
                                <TouchableOpacity onPress={handleRefreshQR} activeOpacity={0.7} style={s.qrRefreshBtn}>
                                  <Text style={s.qrRefreshIcon}>{'\u21BB'}</Text>
                                  <Text style={[s.qrRefreshText, { color: colors.primary }]}>
                                    {t('login.qrRefresh')}
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                          {qrStatus === 'pending' && (
                            <Text style={[s.qrCountdown, { color: colors.textSecondary }]}>
                              {t('login.qrExpires')} {qrCountdown}s
                            </Text>
                          )}
                          <Text style={[s.qrSubtitle, { color: colors.textSecondary }]}>
                            {t('login.qrSubtitle')}
                          </Text>
                          <View style={s.qrSteps}>
                            <Text style={[s.qrStepText, { color: colors.text }]}>1. {t('login.qrStep1')}</Text>
                            <Text style={[s.qrStepText, { color: colors.text }]}>2. {t('login.qrStep2')}</Text>
                            <Text style={[s.qrStepText, { color: colors.text }]}>3. {t('login.qrStep3')}</Text>
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
                    <>
                      {/* Title — smooth slide-up */}
                      <Animated.Text style={[s.title, {
                        color: colors.text,
                        opacity: titleAnim,
                        transform: [{ translateY: titleTranslateY }],
                      }]}>{t('login.title')}</Animated.Text>
                      {/* Subtitle — cascading slide-up */}
                      <Animated.Text style={[s.subtitle, {
                        color: colors.textSecondary,
                        opacity: subtitleAnim,
                        transform: [{ translateY: subtitleTranslateY }],
                      }]}>
                        {t('login.subtitle')}
                      </Animated.Text>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '20' }]}>
                          <IconAlertTriangle size={14} color={colors.error} />
                          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                        </View>
                      )}

                      {/* Email input */}
                      <View style={[
                        s.inputBox,
                        { borderColor: focused === 'email' ? colors.authInputFocusBorder : colors.authInputBorder },
                        focused === 'email' && [s.inputFocused, Platform.OS === 'web' && {
                          boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}`,
                        }],
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: colors.authCardBg },
                          focused === 'email' || email
                            ? [s.floatingLabelUp, { color: focused === 'email' ? colors.authInputFocusBorder : colors.authLabelColor }]
                            : { color: 'transparent' },
                        ]}>
                          {t('login.emailPlaceholder')}
                        </Text>
                        <TextInput
                          style={[s.textInput, { color: colors.text }]}
                          value={email}
                          onChangeText={(text) => { setEmail(text); if (error) setError(''); }}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          autoComplete="email"
                          returnKeyType="next"
                          placeholder={focused === 'email' ? '' : t('login.emailPlaceholder')}
                          placeholderTextColor={colors.textTertiary}
                          onFocus={() => setFocused('email')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleContinue}
                          accessibilityLabel={t('login.emailPlaceholder')}
                        />
                      </View>

                      {/* Domain hint */}
                      {!email.includes('@') && email.length > 0 && (
                        <Text style={[s.domainHint, { color: colors.textSecondary }]}>
                          {t('login.fullEmail')} <Text style={{ fontWeight: '600', color: colors.primary }}>{email}@chatyy.com.br</Text>
                        </Text>
                      )}
                      {!email && (
                        <Text style={[s.domainHint, { color: colors.textTertiary }]}>
                          {t('login.domainHint')}
                        </Text>
                      )}

                      <TouchableOpacity
                        style={s.forgotLink}
                        activeOpacity={0.6}
                        onPress={() => setShowHelp(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[s.forgotText, { color: colors.primary }]}>{t('login.forgotEmail')}</Text>
                      </TouchableOpacity>

                      {/* Smart info section */}
                      <View style={[s.infoBox, {
                        backgroundColor: isDark ? colors.authChipBg : '#f0f7ff',
                        borderColor: isDark ? colors.authChipBorder : colors.primary + '15',
                      }]}>
                        <View style={[s.infoIconWrap, { backgroundColor: colors.primary + '12' }]}>
                          <IconShield size={14} color={colors.primary} />
                        </View>
                        <Text style={[s.infoText, { color: colors.textSecondary }]}>
                          {t('login.security')}
                        </Text>
                      </View>

                      {/* Buttons */}
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
                          style={[s.primaryBtn, {
                            backgroundColor: colors.primary,
                            ...(Platform.OS === 'web' ? {
                              boxShadow: `0 1px 3px ${colors.primary}30, 0 4px 12px ${colors.primary}20`,
                            } : {
                              shadowColor: colors.primary,
                              shadowOffset: { width: 0, height: 2 },
                              shadowOpacity: 0.3,
                              shadowRadius: 8,
                              elevation: 4,
                            }),
                          }]}
                          onPress={handleContinue}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          <Text style={s.primaryBtnText}>{t('login.next')}</Text>
                        </TouchableOpacity>
                      </View>

                      {/* Biometric login button (native only, when credentials saved) */}
                      {bioAvailable && (
                        <TouchableOpacity
                          style={[s.biometricBtn, { borderColor: colors.authInputBorder }]}
                          onPress={handleBiometricLogin}
                          disabled={bioLoading}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={t('login.biometric')}
                        >
                          {bioLoading ? (
                            <ActivityIndicator color={colors.primary} size="small" />
                          ) : (
                            <>
                              <View style={[s.biometricIcon, { backgroundColor: colors.primary + '15' }]}>
                                <Text style={{ fontSize: 22 }}>{Platform.OS === 'ios' ? '\uD83D\uDE42' : '\uD83D\uDD13'}</Text>
                              </View>
                              <Text style={[s.biometricText, { color: colors.primary }]}>{t('login.biometric')}</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      )}
                    </>
                  ) : (
                    <>
                      <Text style={[s.title, { color: colors.text }]}>{t('login.welcome')}</Text>

                      {/* User chip */}
                      <TouchableOpacity
                        style={[s.userChip, {
                          borderColor: colors.authInputBorder,
                          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'transparent',
                        }]}
                        onPress={() => animateStep(1)}
                        activeOpacity={0.7}
                      >
                        <View style={[s.userAvatar, { backgroundColor: colors.primary }]}>
                          <Text style={s.userAvatarLetter}>{(email || '?')[0].toUpperCase()}</Text>
                        </View>
                        <Text style={[s.userEmail, { color: colors.text }]} numberOfLines={1}>
                          {displayEmail}
                        </Text>
                        <Text style={[s.chipArrow, { color: colors.textSecondary }]}>{'\u25BE'}</Text>
                      </TouchableOpacity>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '20' }]}>
                          <IconAlertTriangle size={14} color={colors.error} />
                          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                        </View>
                      )}

                      {/* Password input */}
                      <View style={[
                        s.inputBox,
                        { borderColor: focused === 'pass' ? colors.authInputFocusBorder : colors.authInputBorder },
                        focused === 'pass' && [s.inputFocused, Platform.OS === 'web' && {
                          boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}`,
                        }],
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: colors.authCardBg },
                          focused === 'pass' || password
                            ? [s.floatingLabelUp, { color: focused === 'pass' ? colors.authInputFocusBorder : colors.authLabelColor }]
                            : { color: 'transparent' },
                        ]}>
                          {t('login.passwordPlaceholder')}
                        </Text>
                        <TextInput
                          ref={passwordRef}
                          style={[s.textInput, { color: colors.text, paddingRight: 48 }]}
                          value={password}
                          onChangeText={(text) => { setPassword(text); if (error) setError(''); }}
                          secureTextEntry={!showPassword}
                          returnKeyType="go"
                          placeholder={focused === 'pass' ? '' : t('login.passwordInput')}
                          placeholderTextColor={colors.textTertiary}
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
                            ? <IconEyeOff size={20} color={colors.textSecondary} />
                            : <IconEye size={20} color={colors.textSecondary} />}
                        </TouchableOpacity>
                      </View>

                      {/* Show password checkbox */}
                      <TouchableOpacity
                        style={s.showPassRow}
                        onPress={() => setShowPassword(!showPassword)}
                        activeOpacity={0.7}
                      >
                        <View style={[s.checkbox, {
                          borderColor: showPassword ? colors.primary : colors.authInputBorder,
                          backgroundColor: showPassword ? colors.primary : 'transparent',
                        }]}>
                          {showPassword && <Text style={s.checkmark}>{'\u2713'}</Text>}
                        </View>
                        <Text style={[s.showPassText, { color: colors.text }]}>{t('login.showPassword')}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity style={s.forgotLink} activeOpacity={0.6} onPress={() => router.push('/forgot')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={[s.forgotText, { color: colors.primary }]}>{t('login.forgotPassword')}</Text>
                      </TouchableOpacity>

                      {/* Buttons */}
                      <View style={s.btnRow}>
                        <TouchableOpacity onPress={() => animateStep(1)} style={s.textBtn} activeOpacity={0.6} accessibilityRole="button">
                          <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.back')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.primaryBtn, {
                            backgroundColor: colors.primary,
                            ...(Platform.OS === 'web' ? {
                              boxShadow: `0 1px 3px ${colors.primary}30, 0 4px 12px ${colors.primary}20`,
                            } : {
                              shadowColor: colors.primary,
                              shadowOffset: { width: 0, height: 2 },
                              shadowOpacity: 0.3,
                              shadowRadius: 8,
                              elevation: 4,
                            }),
                          }, loading && { opacity: 0.65 }]}
                          onPress={handleLogin}
                          disabled={loading}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          {loading ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <Text style={s.primaryBtnText}>{t('login.enter')}</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </Animated.View>
              </View>

              {/* Footer */}
              <Animated.View style={[s.footer, {
                opacity: footerAnim,
                transform: [{ translateY: footerTranslateY }],
              }]}>
                <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('login.footerLanguage')}</Text>
                {/* Mobile: Scan QR link */}
                {!isDesktop && (
                  <TouchableOpacity
                    activeOpacity={0.6}
                    onPress={() => setShowQrScanner(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ marginBottom: 8 }}
                  >
                    <Text style={[s.footerItem, s.footerLink, { color: colors.primary, fontWeight: '600', fontSize: 13 }]}>
                      {t('login.qrScanTitle')}
                    </Text>
                  </TouchableOpacity>
                )}
                <View style={s.footerLinks}>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowHelp(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.help')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowPrivacy(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.privacy')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowTerms(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.terms')}</Text>
                  </TouchableOpacity>
                </View>
              </Animated.View>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />

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

      {/* QR Scanner Modal (mobile — paste token to confirm) */}
      <Modal
        visible={showQrScanner}
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
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
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

  /* Top-right row (lang + theme) */
  topRightRow: {
    position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, right: 16, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  themeBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  langBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 36, borderRadius: 18, paddingHorizontal: 10,
    borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  langBtnText: { fontSize: 12, fontWeight: '600' },
  langBtnArrow: { fontSize: 10, marginLeft: -1 },

  /* Language modal */
  langOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  langModal: {
    width: '90%', maxWidth: 360, maxHeight: '70%',
    borderRadius: 16, borderWidth: 1, overflow: 'hidden',
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
    zIndex: 1,
  },
  cardWrap: { width: '100%', maxWidth: 448 },

  /* Card */
  card: {
    borderRadius: 24, paddingTop: 44, paddingBottom: 36,
    width: '100%',
  },

  /* Logo with glow */
  logoRow: { alignItems: 'center', marginBottom: 24 },
  logoWrap: { alignItems: 'center', justifyContent: 'center' },
  logoGlow: {
    position: 'absolute', width: 88, height: 88, borderRadius: 44,
  },
  logoCircle: {
    width: 64, height: 64, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  brand: {
    fontSize: 15, fontWeight: '700', letterSpacing: 0.5,
  },

  title: { fontSize: 24, fontWeight: '400', textAlign: 'center', marginBottom: 2, letterSpacing: -0.2 },
  subtitle: { fontSize: 15, textAlign: 'center', marginBottom: 32, lineHeight: 22 },

  /* Error */
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },

  /* Input */
  inputBox: {
    position: 'relative',
    borderWidth: 1, borderRadius: 12,
    ...Platform.select({ web: { transition: 'all 0.2s ease' }, default: {} }),
  },
  inputFocused: {
    borderWidth: 2,
    margin: -1,
  },
  floatingLabel: {
    position: 'absolute', top: -9, left: 12,
    fontSize: 12, paddingHorizontal: 4, lineHeight: 16,
    ...Platform.select({ web: { transition: 'all 0.15s ease', pointerEvents: 'none' }, default: {} }),
  },
  floatingLabelUp: {
    top: -9, fontSize: 12, fontWeight: '500',
  },
  textInput: {
    fontSize: 16,
    paddingVertical: Platform.OS === 'web' ? 16 : 14,
    paddingHorizontal: 16,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  eyeBtn: {
    position: 'absolute', right: 8, top: 0, bottom: 0,
    justifyContent: 'center', padding: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },

  /* Domain hint */
  domainHint: { fontSize: 13, marginTop: 8, marginBottom: 2, marginLeft: 2, lineHeight: 18 },

  /* User chip */
  userChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    borderRadius: 50, paddingVertical: 4, paddingLeft: 4, paddingRight: 16,
    borderWidth: 1, marginTop: 12, marginBottom: 24,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s ease' }, default: {} }),
  },
  userAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  userAvatarLetter: { color: '#fff', fontSize: 12, fontWeight: '700' },
  userEmail: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  chipArrow: { marginLeft: 6, fontSize: 12 },

  /* Show password */
  showPassRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  checkbox: {
    width: 18, height: 18, borderWidth: 2, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { transition: 'all 0.15s ease' }, default: {} }),
  },
  checkmark: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: -1 },
  showPassText: { fontSize: 14 },

  /* Links */
  forgotLink: { alignSelf: 'flex-start', marginTop: 14, marginBottom: 24 },
  forgotText: { fontSize: 14, fontWeight: '600' },

  /* Info box */
  infoBox: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, padding: 12, marginBottom: 28, borderWidth: 1,
  },
  infoIconWrap: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: { fontSize: 12, flex: 1 },

  /* Buttons */
  btnRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    flexWrap: 'wrap', gap: 8,
  },
  textBtn: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s ease' }, default: {} }),
  },
  textBtnLabel: { fontSize: 14, fontWeight: '600' },
  primaryBtn: {
    borderRadius: 50, paddingVertical: 11, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', minWidth: 100,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600', letterSpacing: 0.2 },

  /* Footer */
  footer: {
    flexDirection: 'column', alignItems: 'center',
    marginTop: 24, paddingHorizontal: 8, gap: 6,
  },
  footerLinks: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  footerItem: { fontSize: 12 },
  footerLink: Platform.OS === 'web' ? { cursor: 'pointer', textDecorationLine: 'underline' } : { textDecorationLine: 'underline' },
  footerDot: { fontSize: 12 },

  /* QR Code Tab Toggle */
  qrTabRow: {
    flexDirection: 'row', justifyContent: 'center', marginBottom: 24, gap: 0,
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  qrTab: {
    paddingVertical: 10, paddingHorizontal: 24,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  qrTabText: { fontSize: 14, fontWeight: '600' },

  /* QR Code Panel */
  qrPanel: {
    alignItems: 'center', paddingBottom: 8,
  },
  qrLoadingWrap: {
    alignItems: 'center', justifyContent: 'center', height: 280, width: '100%',
  },
  qrConnectedText: {
    fontSize: 20, fontWeight: '700',
  },
  qrImageWrap: {
    width: 260, height: 260, borderRadius: 16, borderWidth: 1,
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
  qrExpiredIcon: { fontSize: 40, color: '#9ca3af', marginBottom: 8 },
  qrExpiredText: { fontSize: 14, fontWeight: '500' },
  qrRefreshBtn: {
    alignItems: 'center', padding: 16,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  qrRefreshIcon: { fontSize: 36, color: '#6366f1', marginBottom: 8 },
  qrRefreshText: { fontSize: 14, fontWeight: '600' },
  qrCountdown: {
    fontSize: 13, marginBottom: 16, textAlign: 'center',
  },
  qrSubtitle: {
    fontSize: 15, textAlign: 'center', marginBottom: 20, lineHeight: 22,
  },
  qrSteps: {
    alignSelf: 'stretch', paddingHorizontal: 12, gap: 8,
  },
  qrStepText: {
    fontSize: 14, lineHeight: 20,
  },

  /* QR Scanner Modal (mobile) */
  qrScanModal: {
    width: '90%', maxWidth: 400, borderRadius: 16, borderWidth: 1,
    padding: 24, overflow: 'hidden',
  },
  qrScanModalTitle: {
    fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 8,
  },
  qrScanModalDesc: {
    fontSize: 14, textAlign: 'center', marginBottom: 20, lineHeight: 20,
  },
  qrScanInput: {
    borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 14,
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
    borderRadius: 24, borderWidth: 1, gap: 10,
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
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  verifyTitle: {
    fontSize: 22, fontWeight: '700', textAlign: 'center',
    marginBottom: 8,
  },
  verifySubtitle: {
    fontSize: 15, textAlign: 'center', lineHeight: 22,
    marginBottom: 24, paddingHorizontal: 16,
  },
  verifyInfoBox: {
    borderRadius: 12, padding: 16, width: '100%', maxWidth: 360,
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
    borderRadius: 8, borderWidth: 1,
  },
  verifyBtnText: {
    fontSize: 14, fontWeight: '500',
  },
  verifyBtnPrimary: {
    marginTop: 24, paddingVertical: 14, paddingHorizontal: 32,
    borderRadius: 8,
  },
  verifyBtnPrimaryText: {
    fontSize: 15, fontWeight: '600',
  },
});
