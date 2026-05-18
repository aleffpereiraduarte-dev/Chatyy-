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
  Animated, Platform, KeyboardAvoidingView, ScrollView, Dimensions, Modal,
  Image, ActionSheetIOS, Easing, Pressable, useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Localization from 'expo-localization';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Circle as SvgCircle, Line } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import useDebouncedCallback from '../hooks/useDebouncedCallback';
import useIsMounted from '../hooks/useIsMounted';
import { COUNTRIES, formatPhone } from '../constants/countries';
import { IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle, IconUser, IconAtSign, IconAlertTriangle, IconPhone, IconShield, IconSparkles, IconZap, IconCamera, IconChevronRight, IconLock, IconEye, IconEyeOff } from '../components/Icons';
import SignupIntro from '../components/SignupIntro';
import RestoreBackupPrompt from '../components/RestoreBackupPrompt';

const { width: SCREEN_W } = Dimensions.get('window');
// Wide-screen breakpoint — tablet / desktop web. At >=768 we lay the handle
// step's username + password rows side-by-side to halve vertical scroll.
// Updates reactively via the useWindowDimensions hook below.

// Trimmed welcome carousel — Instagram-style, just 2 slides (first + last).
// IG signup has zero intro carousel; we keep just enough to convey brand +
// the headline value prop without burning 3 taps on filler.
export default function SignupPhone() {
  const router = useRouter();
  // Login forwards an unknown phone to /signup-phone?phone=...&country=...
  // so user goes straight from "this number isn't on Chatyy" to creating an
  // account with the same digits already typed (no double-entry friction).
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { loginWithToken } = useAuth();
  // Reactive window width for the responsive handle-step layout.
  const { width: _winW } = useWindowDimensions();
  const isWide = _winW >= 768;

  // 5 steps: welcome → phone → otp → name → handle → done.
  // welcome is the Telegram-style 5-slide carousel (SignupIntro component).
  // Step routing — what the entry point looks like depends on params:
  //   1. params.step === 'name' + params.verify_token → user already
  //      verified the OTP on /login; jump straight to the name input.
  //      This is the unified flow (2026-05-07): /login sends OTP via
  //      verifySend, verifies via phoneLoginVerify, and on `exists=false`
  //      hands off the verify_token + phone here so the user never sees
  //      the welcome / phone / otp screens again (no duplicate SMS).
  //   2. params.fromLogin === '1' OR params.phone → user came here from
  //      a fallback path that didn't hit (1) — start at the phone input
  //      (skip the carousel, they already dismissed it on /login).
  //   3. otherwise → welcome carousel (first-time signup direct entry).
  const _initialStep = (params?.step === 'name' && params?.verify_token)
    ? 'name'
    : (params?.fromLogin === '1' || params?.phone)
      ? 'phone'
      : 'welcome';
  const [step, setStep] = useState(_initialStep);
  // Safe-area insets to keep the header off the status bar / notch on
  // Android (Pixel center punch-hole, Samsung notch, etc) and the
  // Dynamic Island on iOS. Replaces the static 56/24 paddingTop values
  // which were too small for several Android devices, cutting off the
  // back button + Chatyy logo at the top of the signup flow.
  const _insets = useSafeAreaInsets();
  const [phone, setPhone] = useState(() => {
    // Strip the country dial code when login forwards phone+country (E.164
    // includes DDI; our local phone state stores digits-only without DDI
    // since the country picker carries the dial separately). Without this
    // strip, the phone becomes "55XXXXXXXXX" and `${dial}${phone}` yields
    // a doubled DDI (+555XXXXXXXXX) in fullPhone — confused signup +
    // failed every Telnyx send with bad number.
    const raw = String(params?.phone || '').replace(/[^0-9]/g, '');
    if (!raw) return '';
    // Map common DDI prefixes for the countries we support and strip if
    // the phone starts with that DDI. Falls back to raw digits otherwise.
    const dialMap = {
      BR: '55', US: '1', CA: '1', PT: '351', ES: '34', AR: '54', MX: '52',
      CL: '56', CO: '57', UY: '598', PY: '595', FR: '33', GB: '44', DE: '49', IT: '39',
    };
    const iso = String(params?.country || '').toUpperCase();
    const dial = dialMap[iso];
    if (dial && raw.startsWith(dial)) return raw.slice(dial.length);
    return raw;
  });           // digits only (sem DDI)
  // Auto-detect country from device locale on first mount. Falls back to 'BR'
  // when expo-localization can't resolve a region (web, old devices, etc.).
  // If login forwarded a country param, prefer that (the user's already
  // selected country wins over locale detection).
  const [countryCode, setCountryCode] = useState(() => {
    if (params?.country) return String(params.country).toUpperCase();
    try {
      return Localization.getLocales?.()[0]?.regionCode || Localization.region || 'BR';
    } catch { return 'BR'; }
  }); // PhoneInput espera ISO code
  const [code, setCode] = useState('');
  // Hydrated from params.verify_token when /login forwards us straight to
  // the name step after a successful OTP verify on its side. finishSignup
  // requires verifyToken to be non-empty — without seeding it from params
  // here, the unified flow would dead-end with "Verificação expirou".
  const [verifyToken, setVerifyToken] = useState(() => String(params?.verify_token || ''));
  // Telegram pattern: split into First / Last name (two stacked underline
  // inputs). `name` is the joined value sent to the phone_signup API and
  // used for handle suggestion / welcome message.
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const name = useMemo(() => {
    const f = (firstName || '').trim();
    const l = (lastName || '').trim();
    return l ? `${f} ${l}` : f;
  }, [firstName, lastName]);
  const [avatarUri, setAvatarUri] = useState(null);
  const [username, setUsername] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(null); // null | true | false
  const [usernameSuggestions, setUsernameSuggestions] = useState([]);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  // Registration-lock (anti-SIM-swap) PIN state. lockRequired flips true when
  // server returns requires_lock=true after a successful OTP verify; the OTP
  // step then renders an extra PIN input below the OTP boxes. lockPin holds
  // the entered 4-6 digits.
  const [lockRequired, setLockRequired] = useState(false);
  const [lockPin, setLockPin] = useState('');
  // Country picker modal (Telegram-stacked phone input). The picker shows the
  // full COUNTRIES list with a search box. Replaces the previous PhoneInput
  // component, which jammed flag/dial into the field.
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  // Restore-from-backup prompt state. Surfaced AFTER successful signup
  // (loginWithToken returns ok) when the user's iCloud/Drive already has
  // ≥1 backup tied to this phone number — usually means they reinstalled
  // and signed up again with the same number. Web is excluded (native
  // module is iOS/Android only). Mirrors login.js:478 pattern so the same
  // RestoreBackupPrompt component handles both entry points.
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [restoreBackups, setRestoreBackups] = useState([]);
  const _postSignupNavRef = useRef(null); // { target: '/chat' } deferred until prompt closes
  // Avatar source picker — Instagram/WhatsApp pattern. iOS uses native
  // ActionSheetIOS; Android/Web uses a custom Modal with the same options.
  const [avatarSheetOpen, setAvatarSheetOpen] = useState(false);
  // "No account found" banner — shown when login.js redirects here after a
  // failed phone lookup. Auto-dismisses on first interaction (typing or tap)
  // so the UI doesn't feel sticky. params.fromLogin === '1' is the trigger.
  const [showFromLoginBanner, setShowFromLoginBanner] = useState(() => params?.fromLogin === '1');

  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const resendTimerRef = useRef(null);
  // Hero: scale-pop on entrance + soft breathing halo + icon crossfade on
  // step change. The breathing loop runs at 4s per cycle and only on the
  // outer halo so the brand orb itself stays still — keeps the screen calm
  // but signals the app is alive. Mirrors iMessage's tinted CallKit avatar.
  const heroScale = useRef(new Animated.Value(0.6)).current;
  const heroPulse = useRef(new Animated.Value(0)).current;
  const heroIconFade = useRef(new Animated.Value(1)).current;
  // Whole-hero opacity that drives a true crossfade between steps (fade-out
  // → swap → fade-in). Distinct from heroIconFade (only the inner icon) so
  // the orb + halos also breathe between steps. Telegram polish.
  const heroFade = useRef(new Animated.Value(1)).current;
  // Back-button opacity — fades out briefly on step change, back in once the
  // new step settles. Avoids the "hard cut" feel between phone/otp/name.
  const backFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (step === 'done') return;
    heroScale.setValue(0.6);
    Animated.spring(heroScale, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }).start();
    // Crossfade the icon: fade out → swap (already happened via state) → fade in.
    heroIconFade.setValue(0);
    Animated.timing(heroIconFade, { toValue: 1, duration: 280, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
    // Whole hero soft crossfade — fades from 0.4 back to 1 in 220ms.
    heroFade.setValue(0.4);
    Animated.timing(heroFade, { toValue: 1, duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    // Back button gentle fade so the chevron doesn't snap-pop on step change.
    backFade.setValue(0);
    Animated.timing(backFade, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [step, heroScale, heroIconFade, heroFade, backFade]);
  useEffect(() => {
    if (step === 'done') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(heroPulse, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(heroPulse, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [step, heroPulse]);
  // Focus tracking for the stacked-input hairline-active treatment (login parity).
  const [focused, setFocused] = useState('');
  // OTP per-box refs so paste/backspace can advance focus.
  const otpRefs = useRef([]);
  // Per-box scale animation (1 → 1.08 → 1) when a digit transitions empty→filled.
  const otpBoxScales = useRef(Array.from({ length: 6 }, () => new Animated.Value(1))).current;
  // Horizontal shake on OTP error — WhatsApp/Telegram pattern. translateX
  // peaks at ±10px in 4 quick swings, then settles. After shake, focus
  // jumps back to box 0 so user can retype without an extra tap.
  const otpShake = useRef(new Animated.Value(0)).current;
  const triggerOtpError = () => {
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
    Animated.sequence([
      Animated.timing(otpShake, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: -7,  duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 7,   duration: 50, useNativeDriver: true }),
      Animated.timing(otpShake, { toValue: 0,   duration: 50, useNativeDriver: true }),
    ]).start(() => {
      // Auto-refocus first box so retyping works without an extra tap.
      try { otpRefs.current?.[0]?.focus?.(); } catch {}
    });
  };
  // Big "done" check pop on success.
  const doneScale = useRef(new Animated.Value(0)).current;
  // Username availability check pop — Instagram-style spring from 0 → 1.2 → 1.
  const checkScale = useRef(new Animated.Value(0)).current;
  // OTP caret blink — custom 2x24 caret rendered absolutely inside the focused
  // OTP box. Native TextInput's caret can't be styled and is hidden via
  // caretHidden; this Animated.Value loops 1↔0 every 530ms (matches iOS
  // system caret cadence) so the user sees a real "ready to type" indicator
  // in the focused box. Telegram/iMessage OTP pattern.
  const otpCaretOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (step !== 'otp') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(otpCaretOpacity, { toValue: 0, duration: 530, useNativeDriver: true }),
        Animated.timing(otpCaretOpacity, { toValue: 1, duration: 530, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [step, otpCaretOpacity]);
  useEffect(() => {
    if (step === 'done') {
      doneScale.setValue(0);
      Animated.spring(doneScale, { toValue: 1, friction: 7, tension: 100, useNativeDriver: true }).start();
    }
  }, [step, doneScale]);
  // Single-fire success haptic on done — ref-guarded so re-renders don't repeat it.
  const doneHapticFiredRef = useRef(false);
  useEffect(() => {
    if (step === 'done' && !doneHapticFiredRef.current) {
      doneHapticFiredRef.current = true;
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    }
  }, [step]);
  // Guard against setState after unmount (user can swipe back mid-API-call).
  const mountedRef = useIsMounted();

  // Build E.164 from country dial + digits (PhoneInput holds digits only).
  const fullPhone = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    return `${c.dial}${phone.replace(/\D/g, '')}`;
  }, [countryCode, phone]);

  // Auto-suggest handle from name when entering the handle step. Runs on
  // back-navigate too (vs goName one-shot below). Slug rule: lowercase, strip
  // diacritics, drop chars outside [a-z0-9._], cap at 20.
  useEffect(() => {
    if (step === 'handle' && !username && name) {
      const slug = name.trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9._]/g, '')
        .slice(0, 20);
      if (slug) setUsername(slug);
    }
  }, [step, name, username]);

  // Resend countdown ticker (60s after each verify_send).
  useEffect(() => {
    if (resendCountdown <= 0) return;
    resendTimerRef.current = setTimeout(() => setResendCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(resendTimerRef.current);
  }, [resendCountdown]);

  // Smooth crossfade between steps so the screen feels like one continuous form.
  // Haptic on step advance — WhatsApp/Telegram tactile feel. The `done` step
  // fires its Success notification via a separate useEffect (see below) to
  // guarantee single-fire even on re-mount/render.
  // Subtle scale on the step container — 0.985 → 1 — pairs with the slide
  // and gives the form a "settle into place" feel that pure translateY alone
  // doesn't deliver. Apple/Telegram both use this combo.
  const stepScale = useRef(new Animated.Value(1)).current;
  const goStep = (next) => {
    try {
      if (next !== 'done') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
    const EASE_IN  = Easing.bezier(0.55, 0.06, 0.68, 0.19);
    Animated.parallel([
      Animated.timing(fade,  { toValue: 0,     duration: 180, easing: EASE_IN,  useNativeDriver: true }),
      Animated.timing(slide, { toValue: -22,   duration: 220, easing: EASE_IN,  useNativeDriver: true }),
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

  // After auth (signup or existing-account OTP login) we probe the user's
  // own iCloud / Drive for backups via expo-chat-backup.listBackups(). If
  // we find ≥1 we surface the WhatsApp-style "Encontramos um backup"
  // sheet and defer the router.replace('/chat') until the user picks
  // "Restaurar" or "Pular". Web and any failure mode falls through to the
  // immediate navigation so the prompt is never a blocker.
  const _maybePromptRestoreThenGoChat = () => {
    _postSignupNavRef.current = { target: '/chat' };
    const _navNow = () => {
      setTimeout(() => {
        if (mountedRef.current) { try { router.replace('/chat'); } catch {} }
      }, 600);
    };
    if (Platform.OS === 'web') { _navNow(); return; }
    (async () => {
      try {
        let ChatBackup = null;
        try { ChatBackup = require('expo-chat-backup'); } catch { ChatBackup = null; }
        if (!ChatBackup?.listBackups) { _navNow(); return; }
        const list = await ChatBackup.listBackups();
        if (!mountedRef.current) return;
        if (!Array.isArray(list) || list.length === 0) { _navNow(); return; }
        setRestoreBackups(list);
        setShowRestorePrompt(true);
        // Navigation is now deferred — _handleRestorePromptClose fires it.
      } catch {
        _navNow();
      }
    })();
  };

  const _handleRestorePromptClose = () => {
    setShowRestorePrompt(false);
    const pending = _postSignupNavRef.current;
    _postSignupNavRef.current = null;
    if (!pending?.target) return;
    setTimeout(() => {
      if (mountedRef.current) { try { router.replace(pending.target); } catch {} }
    }, 100);
  };

  // Telegram-style "warm intro" before OTP: ping backend to check if account
  // exists, then frame the OTP screen as "Bem-vindo de volta" (existing) vs
  // "Vamos criar sua conta" (new). Does NOT skip OTP — both flows verify the
  // number via SMS for fraud protection — but the user sees the right framing
  // upfront. Costs one cheap API call (no SMS) before the actual verify_send.
  const [accountExists, setAccountExists] = useState(null); // null | true | false
  const sendOtp = async (channel = 'sms') => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) { setError(t('login.phoneInvalid') || 'Número inválido'); return; }
    setError(''); setBusy(true);
    try {
      // 1. Check if account exists (no SMS sent — cheap PG/Maildir lookup).
      //    If it does AND user wasn't routed here from login, surface the
      //    "you already have an account" UX before burning an SMS — the
      //    user clearly arrived at signup by mistake.
      //    fromLogin=1 means they came from login already knowing the
      //    account is missing, so skip this guard.
      if (accountExists === null && step !== 'otp') {
        try {
          const lr = await api.phoneLoginRequest(fullPhone);
          if (mountedRef.current) {
            const exists = !!(lr?.data?.exists);
            setAccountExists(exists);
            // Only auto-redirect when user came to signup directly (not from
            // login). If they're in fromLogin=1 we trust the original
            // routing — but a fresh exists:true is still surfaced via the
            // banner below.
            if (exists && params?.fromLogin !== '1') {
              setBusy(false);
              setError(t('signupPhone.alreadyHaveAccount') || 'Esse número já tem conta no Chatyy. Vamos fazer login!');
              // Brief pause so the user reads the message, then route.
              setTimeout(() => {
                try {
                  const isoCountry = String(params?.country || countryCode || 'BR').toUpperCase();
                  router.replace(`/login?phone=${encodeURIComponent(fullPhone)}&country=${encodeURIComponent(isoCountry)}`);
                } catch {}
              }, 1500);
              return;
            }
          }
        } catch { /* fall through — assume new */ }
      }
      // 2. Send the actual OTP.
      const r = await api.verifySend(fullPhone, channel);
      if (!mountedRef.current) return;
      if (r?.success) {
        setResendCountdown(60);
        if (step !== 'otp') goStep('otp');
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
      // Telegram-style unified flow: phone_login_verify is the single OTP
      // consumer. Server checks if account exists:
      //   • exists → returns { token, email } → log user in directly
      //   • not exists → returns { exists: false, verify_token } → continue
      //     to name/handle/done. Same OTP, no second SMS.
      // If account has registration_lock, server returns requires_lock=true
      // and we need to surface the PIN gate before re-calling with PIN.
      const _pin = lockRequired ? lockPin : '';
      const r = await api.phoneLoginVerifyWithPin(fullPhone, code, _pin);
      if (!mountedRef.current) return;
      // Account locked — show PIN gate and stop.
      if (r?.success && r.data?.requires_lock) {
        setLockRequired(true);
        setBusy(false);
        return;
      }
      // Bad PIN — server returns success:false with requires_lock flag.
      if (r && !r.success && r.data?.requires_lock) {
        setError(r.message || (t('signupPhone.lockPinWrong') || 'PIN incorreto'));
        setLockPin('');
        triggerOtpError();
        setBusy(false);
        return;
      }
      if (r?.success && r.data?.token) {
        // Existing account — log in, then probe iCloud / Drive for an
        // existing backup tied to this phone (reinstall scenario). On
        // any probe error or web platform we just navigate immediately.
        try { await loginWithToken(r.data.token, r.data.email); } catch {}
        goStep('done');
        _maybePromptRestoreThenGoChat();
      } else if (r?.success && r.data?.exists === false && r.data?.verify_token) {
        // New account — proceed to signup steps.
        setVerifyToken(r.data.verify_token);
        goStep('name');
      } else {
        setError(r?.message || (t('signupPhone.otpInvalid') || 'Código incorreto'));
        setCode('');
        triggerOtpError();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const goName = () => {
    const fn = (firstName || '').trim();
    // Telegram requires at least a first name; last name is optional.
    if (fn.length < 2) { setError(t('signupPhone.nameTooShort') || 'Nome muito curto'); return; }
    setError('');
    // Suggest a default handle from the joined name (lowercase, no spaces, no accents).
    // The useEffect above also fills it on back-navigate; this keeps the forward
    // path one-shot so the handle step lands pre-filled on first entry too.
    const handle = name.trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9._]/g, '').slice(0, 20);
    if (!username) setUsername(handle);
    goStep('handle');
  };

  // Live username availability check (debounced 600ms — matches Instagram's
  // username field cadence, less spammy than 400ms).
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

  // Pop the green check when availability flips to true. Reset to 0 when it
  // flips back to null/false so the next true triggers a fresh pop.
  useEffect(() => {
    try {
      if (usernameAvailable === true) {
        checkScale.setValue(0);
        Animated.spring(checkScale, { toValue: 1, friction: 5, tension: 100, useNativeDriver: true }).start();
      } else {
        checkScale.setValue(0);
      }
    } catch { /* native driver may not be available on web during certain states */ }
  }, [usernameAvailable, checkScale]);

  const finishSignup = async () => {
    if (!verifyToken) { setError(t('signupPhone.expired') || 'Verificação expirou. Recomece.'); goStep('phone'); return; }
    if (!username || usernameAvailable === false) return;
    setError(''); setBusy(true);
    try {
      const r = await api.phoneSignup({ verify_token: verifyToken, username, name, domain: 'chatyy.com.br', password });
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        // Hand off via the standard token-login path so the auth state hydrates,
        // tokens persist, push is registered, and the rest of the app comes up
        // with the same guarantees as email login. Mirrors login.js:699.
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (!mountedRef.current) return;
        if (lr?.success) {
          // Best-effort avatar upload — runs after auth so the bearer token
          // is in place. Failure is swallowed (signup already succeeded).
          if (avatarUri) {
            try {
              const file = Platform.OS === 'web'
                ? avatarUri // web blob/URI — uploadAvatar handles raw URIs too
                : { uri: avatarUri, type: 'image/jpeg', name: 'avatar.jpg' };
              await api.uploadAvatar(file);
            } catch { /* avatar upload best-effort, signup already succeeded */ }
          }
          if (!mountedRef.current) return;
          goStep('done');
          // WhatsApp-parity backup-restore prompt: probe iCloud / Drive for
          // existing backups tied to this phone number. If we find ≥1 we
          // defer navigation and let the user pick "Restaurar" vs "Pular".
          // Web + any error path falls back to the immediate router.replace
          // so signup is never blocked by the probe.
          _maybePromptRestoreThenGoChat();
        } else {
          setError(lr?.message || (t('signupPhone.signupError') || 'Falha ao entrar após criar conta'));
        }
      } else {
        setError(r?.message || (t('signupPhone.signupError') || 'Falha ao criar conta'));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  const headerTitle = {
    welcome: t('signupPhone.titleWelcome') || 'Bem-vindo ao Chatyy',
    phone:   t('signupPhone.titlePhone')   || 'Seu telefone',
    otp:     t('signupPhone.titleOtp')     || 'Digite o código',
    name:    t('signupPhone.titleName')    || 'Como podemos te chamar?',
    handle:  t('signupPhone.titleHandle')  || 'Escolha seu @',
    done:    t('signupPhone.titleDone')    || 'Tudo pronto!',
  }[step];

  // Telegram-style: show the FULL phone number formatted nicely on the OTP
  // screen so the user can verify what they typed. No masking. Format:
  // "+{dial} {grouped digits}" (BR gets the (DD) NNNNN-NNNN treatment, others
  // get a simple grouped string).
  const fullPhoneFormatted = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    const digits = phone.replace(/\D/g, '');
    let grouped = digits;
    if (countryCode === 'BR' && digits.length >= 10) {
      const tail = digits.slice(2);
      const last4 = tail.slice(-4);
      const middle = tail.slice(0, tail.length - 4);
      grouped = `(${digits.slice(0, 2)}) ${middle}-${last4}`;
    } else if (digits.length >= 7) {
      // Generic grouping: split last 4 off, then 3-3-... from the left.
      const last4 = digits.slice(-4);
      const head = digits.slice(0, digits.length - 4);
      grouped = `${head} ${last4}`;
    }
    return `${c.dial} ${grouped}`.trim();
  }, [countryCode, phone]);
  const headerSub = {
    welcome: t('signupPhone.subWelcome') || 'Mensagens, ligações e email — tudo num lugar só',
    phone:   t('signupPhone.subPhone')   || 'Vamos confirmar pra registrar sua conta',
    // Telegram pattern: show the full formatted phone so the user can spot
    // typos before chasing a non-arriving SMS. No masking.
    otp:     `${t('signupPhone.subOtp') || 'Enviamos um código de 6 dígitos para'} ${fullPhoneFormatted}`,
    name:    t('signupPhone.subName')   || 'Esse é o nome que aparece pros amigos',
    handle:  t('signupPhone.subHandle') || 'Você ganha um email Chatyy de presente',
    done:    t('signupPhone.subDone')   || 'Sua conta foi criada — bora conversar',
  }[step];

  // Avatar source helpers (lifted out of the name-step IIFE so the
  // Android/Web fallback Modal can call them too).
  const _launchGalleryAvatar = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'Images',
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!r.canceled && r.assets?.[0]?.uri) {
        setAvatarUri(r.assets[0].uri);
        try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
      }
    } catch { /* user denied permission or picker errored — silent */ }
  };
  const _launchCameraAvatar = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm?.granted) return; // permission denied — silent on signup
      const r = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!r.canceled && r.assets?.[0]?.uri) {
        setAvatarUri(r.assets[0].uri);
        try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
      }
    } catch { /* same: silent */ }
  };

  const goBack = () => {
    setError('');
    // canGoBack() guards: if user landed here via router.replace (e.g. login
    // bounce when phone has no Chatyy account), there's no history to pop —
    // router.back() is a silent no-op. Fall back to router.replace('/login')
    // so the back arrow always feels alive.
    const safeBack = () => {
      try {
        if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
        else router.replace('/login');
      } catch { try { router.replace('/login'); } catch {} }
    };
    if (step === 'done') safeBack();
    else if (step === 'phone')  {
      // If user came from welcome carousel, return to it instead of leaving
      // the screen — preserves the "tour" affordance. If they came from
      // login bounce (params.phone set) we still safeBack to /login.
      if (!params?.phone) goStep('welcome');
      else safeBack();
    }
    else if (step === 'otp')    {
      // Clear the PIN gate state so a fresh OTP doesn't see stale state.
      setLockRequired(false); setLockPin('');
      goStep('phone');
    }
    else if (step === 'name')   {
      // Unified flow: when /login forwarded us straight to name (with
      // verify_token), the otp step has no context — back from name
      // belongs on /login itself, not on a blank otp screen.
      if (params?.verify_token && params?.step === 'name') safeBack();
      else goStep('otp');
    }
    else if (step === 'handle') goStep('name');
  };

  // Welcome carousel — render the SignupIntro component as a separate root
  // (no KeyboardAvoiding/back-bar) so the 5 slides take the full screen,
  // mimicking the telegram-clean mockup. CTA "Começar" advances to phone step.
  if (step === 'welcome') {
    return <SignupIntro onFinish={() => goStep('phone')} />;
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Segmented progress bar — moved ABOVE the header (Telegram pattern).
          User-eye landing zone: the very top of the screen tells them "you
          are at step 2 of 4" before they even read the brand or hero. 4
          segments (phone, otp, name, handle), 3pt tall, 2pt gap. */}
      {step !== 'welcome' && step !== 'done' && (
        <View style={{
          height: 3,
          flexDirection: 'row',
          gap: 2,
          marginHorizontal: 24,
          marginTop: Math.max(_insets.top, Platform.OS === 'android' ? (require('react-native').StatusBar.currentHeight || 24) : 44) + 4,
          marginBottom: 4,
        }}>
          {(() => {
            const order = ['phone', 'otp', 'name', 'handle'];
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

      {/* Header — back button + brand. paddingTop is reduced now that the
          progress bar above already pushes us off the status bar / notch /
          punch-hole. Back button wrapped with Animated.View driven by
          backFade so it gently fades on step change instead of snap-popping. */}
      <View style={[styles.header, { paddingTop: (step !== 'welcome' && step !== 'done') ? 8 : Math.max(_insets.top, Platform.OS === 'android' ? (require('react-native').StatusBar.currentHeight || 24) : 44) + 8 }]}>
        <Animated.View style={{ opacity: backFade }}>
          <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel={t('common.back') || 'Voltar'}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
        </Animated.View>
        <Text style={[styles.brand, {
          color: colors.primary,
          ...(Platform.OS === 'web' ? {
            backgroundImage: 'linear-gradient(135deg, #5B21B6 0%, #7C3AED 60%, #A78BFA 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          } : {}),
        }]}>Chatyy</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }, { scale: stepScale }], width: '100%' }}>
          {/* Welcome → Telegram-style horizontal carousel. Renders 5 slides
              (icon + title + subtitle), swipeable with paging snap. Below the
              pager there are dots showing position. Bottom CTA changes label
              on the last slide ("Começar" vs "Continuar"). */}
          {/* Hide the brand orb on `name` and `handle` steps — those screens
              have their own visual focus (the avatar picker on name, the
              @handle preview on handle). Stacking the big purple orb above
              redundant illustrations created a duplicated-icon look in the
              prints (2026-05-07) and pushed the input fields below the
              keyboard fold. The orb stays on phone + otp where there is no
              competing illustration. */}
          {step !== 'done' && step !== 'name' && step !== 'handle' && (
            <Animated.View style={{ alignItems: 'center', marginBottom: 18, opacity: heroFade }}>
              {/* Telegram-grade hero: single soft halo behind the brand
                  orb. One entrance scale-pop, no breathing pulse, no triple
                  halo. Icon swaps per step but the orb stays brand-purple
                  (calm, recognizable). Mirrors login.js L930-957.
                  Wrapped in Animated.View w/ heroFade so steps crossfade. */}
              <Animated.View style={{
                width: 200, height: 200,
                alignItems: 'center', justifyContent: 'center',
                transform: [{ scale: heroScale }],
              }}>
                {/* Outer halo — biggest, softest, slowest breath. Pulls eye
                    to the orb without blocking content below. Telegram/iMessage
                    hero pattern. */}
                <Animated.View style={{
                  position: 'absolute',
                  width: 200, height: 200, borderRadius: 100,
                  backgroundColor: `${colors.primary}1A`,
                  opacity: heroPulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] }),
                  transform: [{ scale: heroPulse.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.08] }) }],
                }} />
                {/* Middle halo — primary brand glow, in-phase with breath */}
                <Animated.View style={{
                  position: 'absolute',
                  width: 148, height: 148, borderRadius: 74,
                  backgroundColor: `${colors.primary}26`,
                  opacity: heroPulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.9] }),
                  transform: [{ scale: heroPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }],
                }} />
                {/* Crisp inner ring removed 2026-05-07 — print showed it as a
                    distinct 3rd concentric ring around the orb, which read
                    "stacked rings" instead of "soft halo". The two backing
                    halos (200/148) are enough for depth without the busy
                    look. */}
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
                    {/* Phone step: minimalist smartphone outline (line-art).
                        Replaces the heavier IconPhone receiver — cleaner
                        on the brand orb. Other steps keep their lucide
                        icons since they read well at this size. */}
                    {step === 'phone'  && (
                      <Svg viewBox="0 0 24 24" width={44} height={44} fill="none">
                        <Rect x="7" y="2.5" width="10" height="19" rx="2.5" stroke="#fff" strokeWidth={2} fill="none" />
                        <Line x1="10.5" y1="5.5" x2="13.5" y2="5.5" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" />
                        <SvgCircle cx="12" cy="18.5" r="0.9" fill="#fff" />
                      </Svg>
                    )}
                    {step === 'otp'    && <IconShield size={42} color="#fff" />}
                    {step === 'name'   && <IconUser size={42} color="#fff" />}
                    {step === 'handle' && <IconAtSign size={42} color="#fff" />}
                  </Animated.View>
                </View>
              </Animated.View>
            </Animated.View>
          )}
          {/* Title + sub do step central — escondido no welcome (cada slide tem o seu) */}
          {step !== 'welcome' && (
            <>
              <Text style={[styles.title, { color: colors.text, textAlign: 'center' }]}>{headerTitle}</Text>
              <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>{headerSub}</Text>
            </>
          )}

          {/* Step body */}
          <View style={{ marginTop: 24 }}>

            {step === 'phone' && (
              <>
                {/* "No account found" banner — only shown when login.js
                    redirects here after a phone lookup that returned
                    exists:false. Auto-dismisses on first interaction so the
                    UI feels lightweight, not sticky. */}
                {showFromLoginBanner && (
                  <View style={{
                    flexDirection: 'row', alignItems: 'center',
                    backgroundColor: colors.primary + '15',
                    paddingVertical: 12, paddingHorizontal: 12,
                    borderRadius: 10, marginBottom: 16,
                  }}>
                    <Text style={{ flex: 1, color: colors.primary, fontSize: 13, lineHeight: 18, fontWeight: '500' }}>
                      {t('signupPhone.fromLoginBanner') || 'Não encontramos uma conta com esse número. Vamos criar uma.'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => setShowFromLoginBanner(false)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      style={{ marginLeft: 8 }}
                    >
                      <Text style={{ color: colors.primary, fontSize: 18, fontWeight: '600' }}>×</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {/* Telegram-stacked phone input: country row on top with a
                    bottom hairline that opens the picker, then a dial-code
                    column + number column on the second row, divided by a
                    vertical hairline. No box, no pill, no flag jammed in the
                    field — calmer and easier to scan. Mirrors login.js. */}
                {(() => {
                  const _country = COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0];
                  const _hairline = isDark ? '#2a2d31' : '#e5e7eb';
                  const _hairlineActive = colors.primary;
                  const _isFocused = focused === 'phone';
                  return (
                    <View style={{ marginBottom: 16 }}>
                      {/* Floating "Country" mini-label above the row — Material /
                          Telegram pattern. Saves the user from having to guess
                          what the row is for, especially when the country is
                          their default and they haven't tapped to change it. */}
                      <Text style={{
                        fontSize: 11, fontWeight: '600',
                        color: colors.textSecondary, letterSpacing: 0.3,
                        textTransform: 'uppercase', marginBottom: 4,
                      }}>
                        {t('signupPhone.countryLabel') || 'País'}
                      </Text>
                      <TouchableOpacity
                        onPress={() => { setCountrySearch(''); setShowCountryPicker(true); if (showFromLoginBanner) setShowFromLoginBanner(false); }}
                        activeOpacity={0.6}
                        style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 12, paddingHorizontal: 14,
                          borderRadius: 12,
                          backgroundColor: 'rgba(124,58,237,0.08)',
                          borderWidth: 1,
                          borderColor: 'rgba(124,58,237,0.22)',
                          marginBottom: 4,
                        }}
                      >
                        {/* Country flag emoji — WhatsApp/Telegram pattern. Renders
                            crisply on iOS/Android (the primary targets); on
                            Windows web the OS falls back to two ISO letters,
                            still readable. Monogram chip experiment was uglier
                            and less recognizable than the flag. */}
                        <Text style={{ fontSize: 22, marginRight: 12 }}>
                          {_country?.flag || ''}
                        </Text>
                        <Text style={{ flex: 1, fontSize: 16, fontWeight: '500', color: colors.text }}>
                          {_country?.name || (t('login.selectCountry') || 'País')}
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
                            {_country.dial}
                          </Text>
                        </View>
                        <View style={{ width: StyleSheet.hairlineWidth, height: 22, backgroundColor: _hairline, marginRight: 8 }} />
                        <TextInput
                          style={[{
                            flex: 1, fontSize: 16, paddingVertical: 14,
                            color: colors.text,
                          }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                          value={formatPhone(phone, _country.mask)}
                          onChangeText={(text) => {
                            // Extract digits only; the mask is re-applied on render
                            // via formatPhone(). Cap at the country's maxDigits so
                            // typing past the mask doesn't break the formatting.
                            const digits = text.replace(/\D/g, '').slice(0, _country.maxDigits || 15);
                            setPhone(digits);
                            if (error) setError('');
                            if (showFromLoginBanner) setShowFromLoginBanner(false);
                          }}
                          keyboardType="phone-pad"
                          placeholder={_country.mask ? _country.mask.replace(/#/g, '0') : '11 99999-9999'}
                          placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                          onFocus={() => setFocused('phone')}
                          onBlur={() => setFocused('')}
                          autoFocus
                        />
                      </View>
                    </View>
                  );
                })()}
                <Text style={[styles.hint, { color: colors.textTertiary }]}>
                  {t('signupPhone.hintPhone') || 'Vamos enviar um código por SMS e WhatsApp'}
                </Text>
                {/* "Entrar com email" escape hatch — for legacy / pre-2026
                    accounts that signed up before phone-first, the user can
                    bounce to the email tab on /login. WhatsApp/Telegram do
                    this same "use email instead" link on the phone screen. */}
                <TouchableOpacity
                  onPress={() => { try { Haptics.selectionAsync(); } catch {} try { router.replace('/login?tab=email'); } catch {} }}
                  activeOpacity={0.6}
                  style={{ alignSelf: 'center', marginTop: 14, paddingVertical: 8, paddingHorizontal: 14 }}
                  hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                  accessibilityRole="button"
                >
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>
                    {t('signupPhone.loginWithEmail') || 'Entrar com email'}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {step === 'otp' && (
              <>
                {/* OTP 6-digit display — single hidden TextInput overlays the
                    6 visual boxes. Six maxLength=1 inputs silently broke
                    Android sms-otp autofill: the Gboard chip pastes the FULL
                    6-digit code into the focused input, but maxLength=1 drops
                    5 of them on the floor. iOS oneTimeCode also only ever
                    fills the first focused input — so the same single-input
                    pattern fixes both platforms. Mirrors login.js L1700-1762
                    and matches Telegram/WhatsApp. The `Pressable` wraps so
                    tapping any visual box focuses the hidden input.
                    Wrapped in Animated.View so the row can shake on error. */}
                <Pressable
                  onPress={() => otpRefs.current?.[0]?.focus?.()}
                  style={{ marginBottom: 20, alignSelf: 'center' }}
                  accessibilityLabel={t('signupPhone.titleOtp') || 'Código de 6 dígitos'}
                >
                  <Animated.View style={{
                    flexDirection: 'row', justifyContent: 'center',
                    gap: 8,
                    transform: [{ translateX: otpShake }],
                  }}>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const _digit = code[i] || '';
                      const _filled = !!_digit;
                      const _focused = (code.length === i) || (code.length === 6 && i === 5);
                      const _otpBg = isDark ? (_filled ? `${colors.primary}26` : '#1f2229') : (_filled ? `${colors.primary}10` : '#f3f4f6');
                      const _otpBorder = _focused ? colors.primary : (_filled ? colors.primary : (isDark ? '#2a2d31' : '#e5e7eb'));
                      return (
                        <Animated.View
                          key={i}
                          style={{
                            width: 42, height: 50, borderRadius: 10,
                            borderWidth: _focused ? 2 : 1.5,
                            borderColor: _otpBorder,
                            backgroundColor: _otpBg,
                            alignItems: 'center', justifyContent: 'center',
                            transform: [{ scale: otpBoxScales[i] }],
                            ...(_focused && Platform.OS === 'web' ? { boxShadow: `0 0 0 4px ${colors.primary}22` } : {}),
                            ...(_focused && Platform.OS === 'ios' ? { shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.35, shadowRadius: 6 } : {}),
                            ...(_focused && Platform.OS === 'android' ? { elevation: 4 } : {}),
                          }}
                        >
                          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>
                            {_digit}
                          </Text>
                          {/* Custom blinking caret in the focused-empty box —
                              2x24 vertical bar in brand color. Hidden once
                              the box has a digit (no caret on filled boxes,
                              matches iOS keyboard behavior). */}
                          {_focused && !_filled && (
                            <Animated.View
                              pointerEvents="none"
                              style={{
                                position: 'absolute',
                                width: 2, height: 24,
                                backgroundColor: colors.primary,
                                borderRadius: 1,
                                opacity: otpCaretOpacity,
                              }}
                            />
                          )}
                        </Animated.View>
                      );
                    })}
                  </Animated.View>
                  <TextInput
                    ref={ref => { otpRefs.current[0] = ref; }}
                    style={{
                      position: 'absolute',
                      top: 0, left: 0, right: 0, bottom: 0,
                      // opacity:0 silently breaks Gboard's sms-otp chip on
                      // some Android builds — the chip only surfaces when
                      // the focused field is "visible" to the autofill
                      // service. Use color:transparent + caretHidden so
                      // the input is invisible visually but Android still
                      // treats it as a normal autofillable field.
                      color: 'transparent',
                      backgroundColor: 'transparent',
                      fontSize: 22,
                      textAlign: 'center',
                      ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'transparent' } : {}),
                    }}
                    value={code}
                    onChangeText={(raw) => {
                      const digits = (raw || '').replace(/\D/g, '').slice(0, 6);
                      const prevLen = code.length;
                      setCode(digits);
                      // Pulse each newly-filled box. Single-shot per digit.
                      try {
                        for (let j = prevLen; j < digits.length; j++) {
                          const sv = otpBoxScales[j];
                          if (!sv) continue;
                          Animated.sequence([
                            Animated.timing(sv, { toValue: 1.08, duration: 60, useNativeDriver: true }),
                            Animated.timing(sv, { toValue: 1,    duration: 60, useNativeDriver: true }),
                          ]).start();
                        }
                      } catch {}
                      if (digits.length === 6) {
                        // Auto-submit on full code (matches Telegram / iMessage).
                        setTimeout(() => { try { checkOtp(); } catch {} }, 150);
                      }
                    }}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={6}
                    textContentType="oneTimeCode"
                    autoComplete="sms-otp"
                    autoFocus
                    caretHidden
                    importantForAutofill="yes"
                  />
                </Pressable>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <Text style={{ fontSize: 12, color: colors.textTertiary }}>
                    {resendCountdown > 0
                      ? `${t('signupPhone.resendIn') || 'Reenviar em'} ${resendCountdown}s`
                      : ''}
                  </Text>
                  <TouchableOpacity disabled={resendCountdown > 0 || busy} onPress={() => sendOtp('sms')}>
                    <Text style={{
                      fontSize: 13, fontWeight: '600',
                      color: resendCountdown > 0 ? colors.textTertiary : colors.primary,
                    }}>
                      {t('signupPhone.resend') || 'Reenviar código'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {/* Registration-lock PIN gate (anti-SIM-swap). Surfaces only
                    when the account has a 4-6 digit PIN configured and the
                    OTP succeeded — the user must enter the PIN before a
                    bearer token is issued. Defeats SIM-swap attacks where
                    the attacker steals the SMS but never knew the PIN. */}
                {lockRequired && (
                  <View style={{ marginTop: 18, paddingHorizontal: 4 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 6, textAlign: 'center' }}>
                      {t('signupPhone.lockPinTitle') || 'Digite seu PIN de segurança'}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12, textAlign: 'center', lineHeight: 17 }}>
                      {t('signupPhone.lockPinDesc') || 'Essa conta tem PIN ativado para proteger contra troca de SIM.'}
                    </Text>
                    <TextInput
                      style={{
                        alignSelf: 'center',
                        width: 180, height: 52,
                        borderRadius: 12,
                        borderWidth: 1.5,
                        borderColor: lockPin ? colors.primary : (isDark ? '#2a2d31' : '#e5e7eb'),
                        backgroundColor: isDark ? '#1f2229' : '#f3f4f6',
                        color: colors.text,
                        textAlign: 'center',
                        fontSize: 22, fontWeight: '700',
                        letterSpacing: 8,
                        ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                      }}
                      value={lockPin}
                      onChangeText={(v) => { setLockPin((v || '').replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
                      placeholder="••••"
                      placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                      keyboardType="number-pad"
                      inputMode="numeric"
                      maxLength={6}
                      secureTextEntry
                      autoFocus
                    />
                  </View>
                )}

                {/* Voice fallback (WhatsApp/Telegram parity): após o timer expirar,
                    deixa o user pedir uma chamada onde a Polly Camila lê o
                    código em PT-BR. Para quando o SMS não chega ou caixa lotada. */}
                {resendCountdown === 0 && (
                  <TouchableOpacity
                    onPress={() => sendOtp('voice')}
                    disabled={busy}
                    style={{
                      marginTop: 16, paddingVertical: 12, paddingHorizontal: 14,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                      borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
                      backgroundColor: isDark ? `${colors.primary}14` : `${colors.primary}0d`,
                    }}
                    activeOpacity={0.7}
                  >
                    <IconPhone size={16} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '700' }}>
                      {t('signupPhone.callMe') || 'Receber código por chamada'}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            {step === 'name' && (() => {
              // Telegram pattern: TWO stacked underline inputs (First / Last
              // name), each its own hairline-bottom row that turns 2px primary
              // on focus. No box, no surface fill, no leading icon — calmer
              // and matches the real Telegram iOS signup screen.
              const _hairline = isDark ? '#2a2d31' : '#e5e7eb';
              const _isFirstFocused = focused === 'firstName';
              const _isLastFocused  = focused === 'lastName';
              const _pickAvatar = () => {
                // Telegram pattern: 2 options only — Open Gallery / Cancel.
                // Camera + random-avatar dropped (deferred).
                if (Platform.OS === 'ios') {
                  ActionSheetIOS.showActionSheetWithOptions(
                    {
                      options: [
                        t('signupPhone.chooseFromGallery') || 'Abrir galeria',
                        t('common.cancel') || 'Cancelar',
                      ],
                      cancelButtonIndex: 1,
                    },
                    (i) => {
                      if (i === 0) _launchGalleryAvatar();
                    }
                  );
                } else {
                  setAvatarSheetOpen(true);
                }
              };
              return (
                <>
                  {/* Avatar picker — 96x96 circle. WhatsApp/Telegram parity:
                      show a tappable photo circle above the name field so the
                      user can set their picture in the same screen as their
                      name. Empty state = subtle border + IconUser + small
                      camera-plus glyph at the bottom-right corner. */}
                  <View style={{ alignItems: 'center', marginBottom: 18 }}>
                    <TouchableOpacity
                      onPress={_pickAvatar}
                      activeOpacity={0.75}
                      accessibilityLabel={t('signupPhone.pickAvatar') || 'Adicionar foto'}
                      style={{
                        width: 96, height: 96, borderRadius: 48,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: isDark ? '#1f2229' : '#f3f4f6',
                        borderWidth: avatarUri ? 0 : StyleSheet.hairlineWidth,
                        borderColor: isDark ? '#2a2d31' : '#e5e7eb',
                        overflow: 'visible',
                      }}
                    >
                      {avatarUri ? (
                        <Image
                          source={{ uri: avatarUri }}
                          style={{ width: 96, height: 96, borderRadius: 48 }}
                        />
                      ) : (
                        <IconUser size={36} color={isDark ? '#5f6368' : '#9ca3af'} />
                      )}
                      {/* Camera-plus glyph — bottom-right corner, brand color. */}
                      <View style={{
                        position: 'absolute', right: -2, bottom: -2,
                        width: 30, height: 30, borderRadius: 15,
                        backgroundColor: colors.primary,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: 2, borderColor: colors.background,
                      }}>
                        <IconCamera size={15} color="#fff" />
                      </View>
                    </TouchableOpacity>
                  </View>
                  {/* First name */}
                  <View style={{
                    paddingVertical: 6,
                    borderBottomWidth: _isFirstFocused ? 2 : StyleSheet.hairlineWidth,
                    borderBottomColor: _isFirstFocused ? colors.primary : _hairline,
                  }}>
                    <TextInput
                      style={[{
                        fontSize: 16, paddingVertical: 14, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupPhone.firstName') || 'Nome'}
                      placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                      value={firstName}
                      onChangeText={(v) => { setFirstName(v); if (error) setError(''); }}
                      autoCapitalize="words"
                      autoFocus
                      maxLength={50}
                      returnKeyType="next"
                      onFocus={() => setFocused('firstName')}
                      onBlur={() => setFocused('')}
                    />
                  </View>
                  {/* Last name (optional) */}
                  <View style={{
                    marginTop: 8,
                    paddingVertical: 6,
                    borderBottomWidth: _isLastFocused ? 2 : StyleSheet.hairlineWidth,
                    borderBottomColor: _isLastFocused ? colors.primary : _hairline,
                  }}>
                    <TextInput
                      style={[{
                        fontSize: 16, paddingVertical: 14, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupPhone.lastName') || 'Sobrenome'}
                      placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
                      value={lastName}
                      onChangeText={(v) => { setLastName(v); if (error) setError(''); }}
                      autoCapitalize="words"
                      maxLength={50}
                      returnKeyType="done"
                      onFocus={() => setFocused('lastName')}
                      onBlur={() => setFocused('')}
                      onSubmitEditing={goName}
                    />
                  </View>
                </>
              );
            })()}

            {step === 'handle' && (() => {
              // Telegram-stacked handle picker: hairline-bottom input with
              // suffix `@chatyy.com.br` as right adornment + status icon.
              // Border tints red/green for taken/available; primary on focus.
              const _hairlineDefault = isDark ? '#2a2d31' : '#e5e7eb';
              const _isFocused = focused === 'handle';
              const _bottomColor = usernameAvailable === false ? '#ef4444'
                : usernameAvailable === true ? '#22c55e'
                : (_isFocused ? colors.primary : _hairlineDefault);
              const _bottomWidth = (_isFocused || usernameAvailable !== null) ? 2 : StyleSheet.hairlineWidth;
              // Wide-screen (>=768): username + password rows side-by-side.
              // Each takes 50% of the form width with a gap. Suggestions +
              // hint render below the row to keep the layout simple. On
              // narrow screens the rows stack vertically as before.
              const _usernameRow = (
                <View style={{ flex: isWide ? 1 : undefined }}>
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
                      onChangeText={(v) => setUsername(v.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30))}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus
                      maxLength={30}
                      onFocus={() => setFocused('handle')}
                      onBlur={() => setFocused('')}
                    />
                    {!isWide && <Text style={{ fontSize: 13, color: colors.textSecondary }}>@chatyy.com.br</Text>}
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
                  {isWide && (
                    <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>@chatyy.com.br</Text>
                  )}
                </View>
              );
              // Password block — extracted so we can render it inline next to
              // username on wide screens, or stacked below on narrow.
              const _hl = isDark ? '#2a2d31' : '#e5e7eb';
              const _isFocusedPwd = focused === 'password';
              const _pwdValid = password.length >= 8;
              const _pwdBottomColor = _pwdValid ? '#22c55e' : (_isFocusedPwd ? colors.primary : _hl);
              const _pwdBottomWidth = (_isFocusedPwd || _pwdValid) ? 2 : StyleSheet.hairlineWidth;
              const _passwordRow = (
                <View style={{ flex: isWide ? 1 : undefined, marginTop: isWide ? 0 : 18 }}>
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingVertical: 6,
                    borderBottomWidth: _pwdBottomWidth,
                    borderBottomColor: _pwdBottomColor,
                  }}>
                    <IconLock size={18} color={_isFocusedPwd ? colors.primary : colors.textSecondary} />
                    <TextInput
                      style={[{
                        flex: 1, fontSize: 16, paddingVertical: 14, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupPhone.passwordPlaceholder') || 'Mínimo 8 caracteres'}
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
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    >
                      {showPassword ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
                    </TouchableOpacity>
                    {_pwdValid && (
                      <IconCheckCircle size={18} color="#22c55e" style={{ marginLeft: 4 }} />
                    )}
                  </View>
                </View>
              );
              return (
                <>
                  {/* Side-by-side at >=768; stacked below 768. */}
                  <View style={isWide
                    ? { flexDirection: 'row', alignItems: 'flex-start', gap: 16 }
                    : { flexDirection: 'column' }}>
                    {_usernameRow}
                    {_passwordRow}
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
                    {t('signupPhone.hintHandle') || 'Esse vai ser seu email no Chatyy também — pra receber e mandar mensagem.'}
                  </Text>

                  {/* Password hint — outside the row so it spans the form width. */}
                  {(() => {
                    return (
                      <View style={{ marginTop: 8 }}>
                        <Text style={[styles.hint, { color: colors.textTertiary, marginTop: 8 }]}>
                          {t('signupPhone.passwordHint') || 'Use pra entrar pelo email também (IMAP / web). Guarde com carinho.'}
                        </Text>
                      </View>
                    );
                  })()}
                </>
              );
            })()}

            {step === 'done' && (() => {
              const _firstName = (name || '').trim().split(/\s+/)[0] || '';
              const _welcomeRaw = t('signupPhone.welcomeUser', { name: _firstName });
              const _welcome = (_welcomeRaw && _welcomeRaw !== 'signupPhone.welcomeUser')
                ? _welcomeRaw
                : `Bem-vindo, ${_firstName}!`;
              return (
                <View style={{ alignItems: 'center', marginTop: 24 }}>
                  <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                    {/* Expanding ring — derives from the same doneScale spring
                        but inverted so it explodes outward as the check pops in.
                        iMessage / Stripe success-screen vibe. */}
                    <Animated.View style={{
                      position: 'absolute',
                      width: 140, height: 140, borderRadius: 70,
                      borderWidth: 2, borderColor: '#22c55e',
                      opacity: doneScale.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.0, 0.5, 0.0] }),
                      transform: [{ scale: doneScale.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.25] }) }],
                    }} />
                    {/* Soft halo behind the orb — opacity follows scale. */}
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
                      {_welcome}
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

            {/* Inline error — positioned right after the step's body so the
                user sees it directly under the input that triggered the
                failure. Lucide alert icon + colored text, left-aligned per
                step (was center-aligned, which made the message feel like a
                toast). Phone/handle errors gravitate near the field they
                relate to; OTP errors also drive the shake animation above. */}
            {!!error && step !== 'done' && (
              <View style={{
                flexDirection: 'row', alignItems: 'flex-start', gap: 8,
                marginTop: 10, paddingHorizontal: 2,
              }}>
                <IconAlertTriangle size={15} color="#ef4444" style={{ marginTop: 2 }} />
                <Text style={{ color: '#ef4444', fontSize: 13, lineHeight: 18, flex: 1 }}>
                  {error}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Primary action button (sticky bottom for the form-like feel) */}
      {step !== 'done' && (
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          {/* ToS disclaimer — rendered on EVERY step (phone/otp/name/handle)
              so legal consent stays visible up through the moment of account
              creation. Hidden only on `done` (already signed up — no further
              consent needed). Centralized below via the _renderTosFooter
              helper so all four steps share one component. */}
          {step !== 'done' && (
            <Text style={{ fontSize: 11, color: colors.textTertiary, textAlign: 'center', marginBottom: 10, lineHeight: 16, paddingHorizontal: 8 }}>
              {t('signupPhone.tosLine') || 'Ao continuar você concorda com os '}
              <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => { try { require('expo-web-browser').openBrowserAsync('https://chatyy.com.br/terms.html'); } catch {} }}>
                {t('signupPhone.tosLink') || 'Termos'}
              </Text>
              {' '}{t('common.and') || 'e'}{' '}
              <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => { try { require('expo-web-browser').openBrowserAsync('https://chatyy.com.br/privacy.html'); } catch {} }}>
                {t('signupPhone.privacyLink') || 'Privacidade'}
              </Text>
              .
            </Text>
          )}
          <TouchableOpacity
            style={[
              styles.cta,
              {
                backgroundColor: colors.primary,
                opacity: busy ? 0.7 : (
                  (step === 'phone' && phone.replace(/\D/g, '').length < 8) ||
                  (step === 'otp'   && (lockRequired ? lockPin.length < 4 : code.length !== 6)) ||
                  (step === 'name'  && (firstName || '').trim().length < 2) ||
                  (step === 'handle' && (!username || usernameAvailable !== true || password.length < 8))
                ) ? 0.5 : 1,
              },
            ]}
            disabled={busy ||
              (step === 'phone' && phone.replace(/\D/g, '').length < 8) ||
              (step === 'otp'   && (lockRequired ? lockPin.length < 4 : code.length !== 6)) ||
              (step === 'name'  && (firstName || '').trim().length < 2) ||
              (step === 'handle' && (!username || usernameAvailable !== true || password.length < 8))}
            onPress={() => {
              // WhatsApp/Telegram both skip the "is this the right number?"
              // sheet — the OTP screen already shows the number with an Edit
              // link, so the friction wasn't paying for itself.
              if (step === 'phone')  sendOtp();
              else if (step === 'otp')    checkOtp();
              else if (step === 'name')   goName();
              else if (step === 'handle') finishSignup();
            }}
            activeOpacity={0.85}
          >
            {busy ? (
              <>
                <ActivityIndicator color="#fff" />
                <Text style={[styles.ctaText, { marginLeft: 10 }]}>
                  {/* Per-step loading copy — "Enviando..." for the OTP send,
                      "Verificando..." for code check, "Criando conta..." for
                      final signup. Tells the user the spinner means *what*,
                      not just "wait" — Telegram pattern. */}
                  {step === 'phone' ? (t('signupPhone.sending') || 'Enviando...')
                  : step === 'otp' ? (t('signupPhone.verifying') || 'Verificando...')
                  : step === 'handle' ? (t('signupPhone.creating') || 'Criando conta...')
                  : (t('common.loading') || 'Aguarde...')}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.ctaText}>
                  {step === 'handle' ? (t('signupPhone.finish') || 'Criar conta')
                  : (t('common.next') || 'Próximo')}
                </Text>
                {step !== 'handle' && <IconArrowRight size={18} color="#fff" style={{ marginLeft: 8 }} />}
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Avatar source picker (Android/Web fallback). iOS uses native
          ActionSheetIOS; this Modal handles every other platform. Same 3
          options: take photo, choose from gallery, cancel. */}
      <Modal
        visible={avatarSheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAvatarSheetOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setAvatarSheetOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{
            backgroundColor: colors.background,
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 30 : 16,
            paddingHorizontal: 8,
          }}>
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.13)', marginBottom: 8 }} />
            {/* Telegram pattern: 2 options only — Open Gallery / Cancel.
                Camera + random-avatar dropped (deferred). */}
            <TouchableOpacity
              onPress={() => { setAvatarSheetOpen(false); _launchGalleryAvatar(); }}
              style={{ paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}
              activeOpacity={0.6}
            >
              <IconUser size={20} color={colors.text} />
              <Text style={{ fontSize: 16, color: colors.text, fontWeight: '500' }}>
                {t('signupPhone.chooseFromGallery') || 'Abrir galeria'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setAvatarSheetOpen(false)}
              style={{ paddingVertical: 14, paddingHorizontal: 16, marginTop: 4, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isDark ? '#2a2d31' : '#e5e7eb' }}
              activeOpacity={0.6}
            >
              <Text style={{ fontSize: 16, color: colors.textSecondary, fontWeight: '600' }}>
                {t('common.cancel') || 'Cancelar'}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Country picker — full-screen list with search. Replaces PhoneInput's
          inline picker and matches the login.js modal pattern. */}
      <Modal
        visible={showCountryPicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowCountryPicker(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 24, paddingBottom: 12,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? '#2a2d31' : '#e5e7eb',
          }}>
            <TouchableOpacity onPress={() => setShowCountryPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <IconArrowLeft size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
              {t('login.selectCountry') || 'Escolha o país'}
            </Text>
            <View style={{ width: 22 }} />
          </View>
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <TextInput
              style={[{
                fontSize: 15, color: colors.text,
                paddingVertical: 10, paddingHorizontal: 14,
                borderRadius: 10,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
              placeholder={t('signup.stepPhone.searchCountry') || 'Buscar'}
              placeholderTextColor={isDark ? '#5f6368' : '#9ca3af'}
              value={countrySearch}
              onChangeText={setCountrySearch}
              autoFocus={Platform.OS === 'web'}
            />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
            {(() => {
              // Telegram-pattern picker: when there's no search, render a
              // "Suggested" header at the top with the locale-detected country
              // (currently selected) so the user doesn't scroll through 50
              // alphabetical entries to confirm their country. The full list
              // below excludes the suggested country to avoid duplication.
              const _renderRow = (c) => (
                <TouchableOpacity
                  key={c.code + c.dial}
                  onPress={() => {
                    setCountryCode(c.code);
                    // intentionally DO NOT clear phone — user typed digits are
                    // preserved across country swap (WhatsApp pattern)
                    setShowCountryPicker(false);
                    setCountrySearch('');
                  }}
                  activeOpacity={0.6}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: 14, paddingHorizontal: 16,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: isDark ? '#2a2d31' : '#e5e7eb',
                    backgroundColor: c.code === countryCode ? `${colors.primary}10` : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{c.flag}</Text>
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }} numberOfLines={1}>{c.name}</Text>
                  <Text style={{ fontSize: 14, color: colors.textSecondary }}>{c.dial}</Text>
                </TouchableOpacity>
              );
              const _sectionLabel = (text, extra) => (
                <Text style={{
                  fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  color: colors.textTertiary,
                  paddingHorizontal: 16,
                  paddingTop: extra?.top ?? 8, paddingBottom: 6,
                }}>{text}</Text>
              );
              if (countrySearch) {
                const _q = countrySearch.toLowerCase();
                return COUNTRIES.filter(c =>
                  c.name.toLowerCase().includes(_q) ||
                  c.code.toLowerCase().includes(_q) ||
                  c.dial.includes(countrySearch)
                ).map(_renderRow);
              }
              const suggested = COUNTRIES.find(c => c.code === countryCode);
              const rest = COUNTRIES.filter(c => c.code !== countryCode);
              return (
                <>
                  {suggested ? (
                    <>
                      {_sectionLabel(t('signupPhone.countrySuggested') || 'Sugerido')}
                      {_renderRow(suggested)}
                      <View style={{ height: 12 }} />
                      {_sectionLabel(t('signupPhone.countryAll') || 'Todos os países', { top: 4 })}
                    </>
                  ) : null}
                  {rest.map(_renderRow)}
                </>
              );
            })()}
          </ScrollView>
        </View>
      </Modal>

      {/* WhatsApp-style "Encontramos um backup" sheet. Surfaces after auth
          (signup completion OR existing-account OTP login) when the user
          has ≥1 backup in iCloud/Drive. Same component login.js mounts so
          UX is consistent across both entry points. onClose resumes the
          deferred router.replace('/chat'). */}
      <RestoreBackupPrompt
        visible={showRestorePrompt}
        backups={restoreBackups}
        onClose={_handleRestorePromptClose}
        onRestored={() => { /* onClose handles nav after the user taps "Pronto" */ }}
      />
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
  // Telegram/iMessage hero typography: heavy weight, tighter tracking, crisp
  // line-height. The previous 28/-0.6 sat between ranks; this lands the title
  // squarely in "feature hero" territory.
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
    height: 52, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 10px 26px rgba(124,58,237,0.35), 0 2px 6px rgba(124,58,237,0.20)',
        transition: 'transform 140ms ease, box-shadow 140ms ease',
      },
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 14 },
      android: { elevation: 6 },
    }),
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
});
