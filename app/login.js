import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Animated, useWindowDimensions, Modal, FlatList, Pressable, Image, Alert,
  Easing, Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useAuthTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSun, IconMoon, IconAlertTriangle,
  IconEye, IconEyeOff,
  IconMailLogo, IconShield, IconGlobe,
  IconMail, IconMessageCircle, IconMessageSquare, IconCloud,
  IconUsers, IconCheck, IconX, IconPhone, IconLock,
  IconChevronRight, IconChevronDown, IconRefresh,
} from '../components/Icons';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';
import SignupIntro from '../components/SignupIntro';
import RestoreBackupPrompt from '../components/RestoreBackupPrompt';
import OwnBackupRestorePrompt from '../components/OwnBackupRestorePrompt';
import RestoreHistoryPrompt from '../components/RestoreHistoryPrompt';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { LANGUAGES } from '../i18n';
import { PASSKEYS_ENABLED } from '../constants/featureFlags';
import * as api from '../services/api';
import { firebasePhoneAvailable, fbSendCode, fbConfirm, fbSignOut } from '../services/firebasePhone';
import { useSmsOtpAutofill } from '../services/smsOtp'; // [2026-10-08 android-otp-shortcuts]
import { getDeviceId as getE2eDeviceId, getDevicePublicKey as getE2eDevicePublicKey } from '../services/e2e';
import AsyncStorage from '@react-native-async-storage/async-storage';
// COUNTRIES (with masks/maxDigits) used to power format-as-you-type. The
// local COUNTRY_CODES list above (dial-keyed) handles the picker chip; we
// look up the matching mask from the canonical list at typing time.
import { COUNTRIES as COUNTRIES_FULL, formatPhone } from '../constants/countries';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Svg, { Path, Rect, Circle as SvgCircle, Defs, Pattern, Line, RadialGradient, Stop, Mask } from 'react-native-svg';
// [2026-10-07 login-ux] Smart single-field login (phone / e-mail / @usuário),
// remembered accounts, inline notices, keyboard-aware scroll.
import { tap as hTap, selection as hSelection, success as hSuccess } from '../services/haptics';
import { onNetworkChange } from '../services/networkInfo';
import AvatarCircle from '../components/AvatarCircle';
import PressableScale from '../components/PressableScale';
import SmartIdentifierField from '../components/login/SmartIdentifierField';
import RememberedAccounts, { BiometricGlyph } from '../components/login/RememberedAccounts';
import LoginNotice, { SuggestionChip } from '../components/login/LoginNotice';
import LoginKeyboardScroll from '../components/login/LoginKeyboardScroll';
import {
  classifyIdentifier, normalizeLoginEmail, isPlausibleEmail, identifierHints,
  suggestEmailFix, splitInternational, detectDefaultCountry, passwordHints,
  loadLastIdentifier, saveLastIdentifier, forgetLastIdentifier,
} from '../components/login/loginSmart';

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
  // Forced first-login password change (admin-provisioned mailbox w/ temp pwd).
  const [forcePwChange, setForcePwChange] = useState(false);
  const pendingGoRef = useRef(null);
  const { login, completeLoginAfterChallenge, loginWithToken, removeAccount } = useAuth();
  // ── [2026-10-07 login-ux] smart identifier + device-aware state ──
  const [identifier, setIdentifier] = useState('');
  const [online, setOnline] = useState(true);
  const [capsLockOn, setCapsLockOn] = useState(false); // web only (real CapsLock state)
  const [pwHint, setPwHint] = useState(''); // shown after a failed password attempt
  const [remembered, setRemembered] = useState([]); // [{ email, name, token }]
  const [useAnother, setUseAnother] = useState(false); // user chose "Entrar com outra conta"
  const [busyEmail, setBusyEmail] = useState(''); // remembered row doing a one-tap login
  const [bioReadyEmail, setBioReadyEmail] = useState(''); // Face ID usable for THIS email
  const [otpChannelNote, setOtpChannelNote] = useState(''); // "Enviamos por WhatsApp e SMS"
  const identifierRef = useRef(null);
  const goToPasswordRef = useRef(null);
  const { colors, isDark, toggle } = useAuthTheme();
  const insets = useSafeAreaInsets();
  const { t, language, changeLanguage } = useLanguage();
  const [showLangModal, setShowLangModal] = useState(false);
  const router = useRouter();
  const params = useLocalSearchParams();
  const isAddAccount = params.add_account === '1';

  // When re-logging into an existing account from the account switcher, the
  // email is passed as ?email=... so the user only has to type the password.
  // [2026-10-07 login-ux] Was setEmail+setStep(2) only — but loginMode stayed
  // 'phone' on mobile, so the password step never rendered and the user saw
  // the phone form instead. goToPasswordRef switches mode + step together.
  useEffect(() => {
    const pre = typeof params?.email === 'string' ? params.email : (Array.isArray(params?.email) ? params.email[0] : '');
    if (isAddAccount && pre) {
      try { goToPasswordRef.current?.(normalizeLoginEmail(pre)); } catch {}
    }
  }, [isAddAccount, params?.email]);

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

  // After a successful login, decide whether to surface the
  // RestoreBackupPrompt before navigating. "New device" heuristic, in order:
  //   1. AsyncStorage(@chatyy_skip_restore) !== '1'  (user never tapped Pular)
  //   2. MMKV(restore_prompted:<email>) is empty     (not asked this session)
  //   3. SQLite dbGetConversations().length === 0    (no local chats yet)
  //   4. EITHER api.chatBackupList() returns ≥1 server-hosted backup
  //      OR     expo-chat-backup.listBackups() returns ≥1 iCloud/Drive backup
  //
  // Server-hosted path is preferred (always reachable — backend stores the
  // CYB2 blob under sha256(email)/, the Wave-7 path). Drive/iCloud remains
  // a secondary mirror for users who configured OAuth.
  //
  // If any check fails / throws, we navigate normally — restore is an
  // opt-in enhancement, never a blocker.
  const maybePromptRestoreThenGo = useCallback(async (isKids, accountEmail) => {
    const target = postLoginTarget || defaultTarget(isKids);
    pendingNavRef.current = { target };

    // Maybe offer the full-history download prompt BEFORE navigating away. Two
    // gates: (a) user not dismissed the offer this install via
    // @chatyy_skip_history (separate from @chatyy_skip_restore so the CYB2
    // backup prompt and the full-history prompt have independent never-show
    // toggles), (b) services/fullHistorySync.isBootstrapNeeded() returns true
    // (i.e. local SQLite is materially short of what the server has).
    const maybeShowHistoryPromptThenNav = async (emailLc) => {
      if (Platform.OS === 'web') { return false; }
      try {
        const skip = await AsyncStorage.getItem('@chatyy_skip_history');
        if (skip === '1') return false;
        const api = require('../services/api');
        const { isBootstrapNeeded } = require('../services/fullHistorySync');
        const needs = await isBootstrapNeeded(api.apiCall, emailLc);
        if (!needs) return false;
        setHistoryPromptEmail(emailLc);
        setShowHistoryPrompt(true);
        return true;
      } catch { return false; }
    };

    const doNav = async () => {
      // Try the history prompt first — if it pops, we DON'T nav yet (the
      // prompt's onClose will resume nav). If it doesn't pop, proceed.
      const emailLc = (accountEmail || '').toLowerCase().trim();
      if (emailLc) {
        const shown = await maybeShowHistoryPromptThenNav(emailLc);
        if (shown) return;
      }
      setTimeout(() => {
        if (mountedRef.current) router.replace(target);
      }, 100);
    };

    // [2026-10-09 own-backup] Backup E2E no servidor do Chatyy (principal):
    // aparelho sem a chave desta conta + backup no servidor → oferece
    // "Restaurar backup de DD/MM (N mensagens)". Também no web. Nunca bloqueia.
    try {
      const ob = require('../services/ownBackup');
      const cand = await Promise.race([
        ob.findRestoreCandidate(accountEmail),
        new Promise((res) => setTimeout(() => res(null), 6000)),
      ]);
      if (cand && mountedRef.current) { setOwnRestore(cand); return; }
    } catch {}

    if (Platform.OS === 'web') { doNav(); return; }

    try {
      // Gate 1 — global "never ask again" flag.
      const skipped = await AsyncStorage.getItem('@chatyy_skip_restore');
      if (skipped === '1') { doNav(); return; }

      // Gate 2 — per-account "already prompted this install" flag (MMKV
      // mirror keyed by email). Prevents reshowing on every cold-start after
      // the user already declined (or restored) for this account.
      let email = (accountEmail || '').toLowerCase().trim();
      if (!email) {
        try { email = (api.getActiveAccountEmail?.() || '').toLowerCase().trim(); } catch {}
      }
      let mmkv = null;
      try {
        const { MMKV } = require('react-native-mmkv');
        mmkv = new MMKV({ id: 'chatyy-backup' });
        if (email) {
          const v = mmkv.getString(`restore_prompted:${email}`);
          if (v === '1') { doNav(); return; }
        }
      } catch { /* mmkv unavailable — fall through and ask anyway */ }

      // Gate 3 — local SQLite already has conversations? skip.
      let convs = null;
      try {
        const dbMod = require('../services/db');
        if (typeof dbMod.dbGetConversations === 'function') {
          convs = await dbMod.dbGetConversations(true);
        }
      } catch {
        try {
          const localDb = require('../services/localDb');
          if (typeof localDb.getConversations === 'function') {
            convs = await localDb.getConversations();
          }
        } catch { /* db not initialised — treat as empty */ }
      }
      if (Array.isArray(convs) && convs.length > 0) { doNav(); return; }

      // Gate 4 — fetch the server-hosted backup list. This is the primary
      // path because the backend always has the blob (Wave-7 stores under
      // chat-backups/sha256(email)/). Drive/iCloud auth may not be set up.
      let serverBackups = [];
      try {
        const resp = await api.chatBackupList();
        // apiCall unwraps to either { backups: [...] } or { data:{ backups } }.
        const list = resp?.backups || resp?.data?.backups || [];
        serverBackups = Array.isArray(list) ? list : [];
      } catch { serverBackups = []; }

      // Fallback — try the native module (expo-chat-backup) for iCloud/Drive
      // backups when no server-hosted blob exists. Same UI either way.
      let cloudBackups = [];
      if (serverBackups.length === 0) {
        try {
          const ChatBackup = require('expo-chat-backup');
          cloudBackups = await ChatBackup.listBackups();
        } catch { cloudBackups = []; }
      }

      const merged = serverBackups.length > 0
        // Server-hosted backups — normalise to the shape RestoreBackupPrompt
        // already renders (filename + createdAt + size), tag with `source`
        // so the restore handler knows which path to call.
        ? serverBackups.map((b) => ({
            source: 'server',
            id: b.id,
            filename: `backup-${b.id}.enc`,
            createdAt: b.created_at,
            size: b.size_bytes || 0,
          }))
        : (Array.isArray(cloudBackups) ? cloudBackups.map((b) => ({ source: 'cloud', ...b })) : []);

      if (merged.length === 0) { doNav(); return; }

      // Mark prompted — write BEFORE showing so even if the user kills the
      // app mid-prompt we don't pester them next launch. They can still
      // hit "Restaurar conversas" manually from /chat-backup.
      try { if (mmkv && email) mmkv.set(`restore_prompted:${email}`, '1'); } catch {}

      setRestoreBackups(merged);
      setShowRestorePrompt(true);
      // Navigation deferred — fires inside handleRestorePromptClose below.
    } catch {
      doNav();
    }
  }, [postLoginTarget, router]);

  // Closes the restore prompt and resumes the deferred navigation.
  const handleRestorePromptClose = useCallback(() => {
    setShowRestorePrompt(false);
    const pending = pendingNavRef.current;
    pendingNavRef.current = null;
    if (!pending?.target) return;
    setTimeout(() => {
      if (mountedRef.current) router.replace(pending.target);
    }, 100);
  }, [router]);
  const { width } = useWindowDimensions();
  const mountedRef = useRef(true);
  const passwordRef = useRef(null);

  // QR Code login state
  const isDesktop = Platform.OS === 'web' && width >= 768;
  // Smart default — WhatsApp pattern: desktop opens straight to QR (pair with
  // your phone), mobile opens to phone-OTP. Email/password becomes the
  // "advanced" tab for legacy accounts. Persists nothing — fresh load each
  // open is fine since there's no logged-in state at this point anyway.
  // [2026-10-07 login-ux] 'smart' = single identifier field (phone / e-mail /
  // @usuário). 'phone' now only hosts the OTP step, 'email' only the password
  // step — both are reached FROM 'smart'. Desktop still opens on QR.
  const [loginMode, setLoginMode] = useState(isDesktop ? 'qr' : 'smart');

  // Telegram-style intro carousel — ONLY shown on the very first visit
  // per device. Once user dismisses (or completes), persist a flag so
  // subsequent app/browser opens skip the carousel and go straight to the
  // phone entry (which is the actual login surface). Skipped on desktop
  // (QR primary) and when adding a new account from Settings.
  const [showIntro, setShowIntro] = useState(false);
  useEffect(() => {
    if (isDesktop || isAddAccount) return;
    let cancelled = false;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem('chatyy_intro_seen');
        if (!cancelled && !seen) setShowIntro(true);
      } catch {
        if (!cancelled) setShowIntro(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isDesktop, isAddAccount]);
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
  }, []);

  // Phone login state
  // Pre-fill phone if signup-phone bounced this user back here (their
  // number already had an account). Strip the dial code so the input
  // shows just the local digits — country picker shows the dial prefix.
  const [phoneNumber, setPhoneNumber] = useState(() => {
    try {
      const raw = String(params?.phone || '').replace(/[^0-9]/g, '');
      if (!raw) return '';
      if (raw.length >= 11) { const sp = splitInternational('+' + raw); if (sp && sp.national.length >= 8) return sp.national; }
      // Best-effort strip of country code: if it starts with 55 and is BR-shaped,
      // drop the 55 prefix. For other countries the full number is fine.
      if (raw.startsWith('55') && raw.length >= 12) return raw.slice(2);
      if (raw.startsWith('1') && raw.length === 11) return raw.slice(1); // US/CA
      return raw;
    } catch { return ''; }
  });
  // Default DDI from the device locale (pt-BR → +55, en-US → +1, es-MX → +52)
  // instead of always +55. A "+…" bounce from signup-phone wins.
  const [phoneCountryCode, setPhoneCountryCode] = useState(() => {
    try {
      const raw = String(params?.phone || '').replace(/[^0-9]/g, '');
      if (raw.length >= 11) { const sp = splitInternational('+' + raw); if (sp) return sp.country.dial; }
    } catch {}
    try { return detectDefaultCountry().dial; } catch { return '+55'; }
  });
  const [phoneOtp, setPhoneOtp] = useState(['', '', '', '', '', '']);
  const [phoneOtpFocused, setPhoneOtpFocused] = useState(false);
  const [phoneStep, setPhoneStep] = useState('input'); // 'input' or 'otp'
  // Registration-lock (anti-SIM-swap) PIN gate. When the OTP succeeds but the
  // account has a lock configured, server returns requires_lock=true and we
  // surface a 6-digit input on top of the OTP step. The PIN field is shown
  // when phoneRequiresLock is true; OTP step otherwise.
  const [phoneRequiresLock, setPhoneRequiresLock] = useState(false);
  const [phoneLockPin, setPhoneLockPin] = useState('');
  const [phoneSending, setPhoneSending] = useState(false);
  const [phoneVerifying, setPhoneVerifying] = useState(false);
  const [phoneResendTimer, setPhoneResendTimer] = useState(0);
  const phoneOtpRefs = useRef([]);
  const phoneResendRef = useRef(null);
  // Firebase Phone Auth (2026-06-18): when available (native), the OTP is sent
  // by Google/Firebase and confirmed client-side. fbConfirmRef holds the
  // confirmation between send→verify; fbIdTokenRef holds the ID token after
  // confirm so the registration-lock PIN re-call can reuse it (the SMS code is
  // one-time and already consumed). phoneViaFirebaseRef flags which path this
  // attempt used so verify routes correctly. Falls back to backend OTP on any
  // failure — see handlePhoneSendOtp / handlePhoneVerifyOtp.
  const fbConfirmRef = useRef(null);
  const fbIdTokenRef = useRef(null);
  const phoneViaFirebaseRef = useRef(false);
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

  // Card opacity — starts visible (1) so the form is ALWAYS rendered even
  // if the entrance animation fails to fire (some prod iOS builds have
  // native-driver hiccups that leave Animated values pinned at the initial
  // value, which made the whole login content invisible — user reported
  // 2026-05-07). Entrance fade-in animation removed; it was cosmetic and
  // the cost of breaking the form is way higher than the benefit.
  const cardFadeAnim = useRef(new Animated.Value(1)).current;

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

  const hasHwRef = useRef(false);
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
          hasHwRef.current = true;
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
      // Returning users with stored Face ID creds skip the intro carousel —
      // it's onboarding for first-time users only. Without this, anyone
      // who'd already logged in on this device would have to dismiss 5
      // slides every time they hit /login (annoying after 1st launch).
      try {
        const savedEmail = await SecureStore.getItemAsync('bio_email');
        if (savedEmail) setShowIntro(false);
        // [2026-10-07 login-ux] Quick unlock is offered ONLY when it can
        // actually work: enrolled biometrics + bio_email + the per-account
        // bearer twin (handleBiometricLogin refuses the global token without
        // it). Before, the button showed for everyone and mostly answered
        // "Token não salvo" — explicit logout wipes bio_email/bio_token.
        if (savedEmail && hasHwRef.current) {
          const { bioTokenKeyFor } = require('../context/BiometricContext');
          const k = bioTokenKeyFor(savedEmail);
          const tok = k ? await SecureStore.getItemAsync(k) : null;
          if (tok && mountedRef.current) setBioReadyEmail(String(savedEmail));
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
      let savedToken = await SecureStore.getItemAsync('bio_token');
      // P1: bind the bearer to the identity it was minted for. The global
      // `bio_token` is a single device-wide slot; when a per-account twin
      // (`bio_token:<email>`) exists, prefer it and refuse the global token
      // if it doesn't match — otherwise a stale global pair could unlock a
      // DIFFERENT account than `bio_email` claims.
      try {
        if (savedEmail) {
          const { bioTokenKeyFor } = require('../context/BiometricContext');
          const k = bioTokenKeyFor(savedEmail);
          if (k) {
            const perAccountTok = await SecureStore.getItemAsync(k);
            if (perAccountTok) {
              // Trust the per-account twin as the source of truth.
              savedToken = perAccountTok;
            } else if (savedToken) {
              // No twin for this email but a global token exists — it may have
              // been minted for a different identity. Drop it and require a
              // password so the next success re-binds the per-account token.
              savedToken = null;
            }
          }
        }
      } catch {}
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
          saveLastIdentifier(savedEmail);
          showSuccessPop();
          goAfterLogin(r.data?.is_child || isChildAccount());
        } else {
          // Token expired — clear it but keep bio_email. Pre-fill + advance
          // to password step; successful password login refreshes bio_token.
          // DIAGNOSTIC: include the server rejection reason in the error
          // so we can see exactly why the token isn't working (user reports
          // "Face ID pede senha" without knowing why).
          try { await SecureStore.deleteItemAsync('bio_token'); } catch {}
          // Drop the per-account twin too so the dead bearer can't be retried.
          try {
            const { bioTokenKeyFor } = require('../context/BiometricContext');
            const k = bioTokenKeyFor(savedEmail);
            if (k) await SecureStore.deleteItemAsync(k);
          } catch {}
          try { goToPasswordRef.current?.(savedEmail); } catch {}
          setBioReadyEmail('');
          // [2026-10-07 login-ux] friendly copy only — the raw server reason
          // used to be appended here (diagnostic) and read as an error code.
          setError(t('login.biometricExpired'));
        }
      } else if (legacyPassword) {
        setLoading(true);
        const r = await login(savedEmail, legacyPassword);
        if (!mountedRef.current) return;
        if (r.success) {
          try {
            const newToken = api.getToken?.();
            if (newToken) {
              await SecureStore.setItemAsync('bio_token', newToken);
              // Re-bind the per-account twin for the just-authenticated email.
              try {
                const { bioTokenKeyFor } = require('../context/BiometricContext');
                const k = bioTokenKeyFor(savedEmail);
                if (k) await SecureStore.setItemAsync(k, newToken);
              } catch {}
            }
            await SecureStore.deleteItemAsync('bio_password');
          } catch {}
          goAfterLogin(r.data?.is_child || isChildAccount());
        } else {
          try { await SecureStore.deleteItemAsync('bio_password'); } catch {}
          try { goToPasswordRef.current?.(savedEmail); } catch {}
        }
      } else {
        // Biometric OK but nothing to log in with — advance to password
        // step. Most common cause: first login didn't save the bearer token
        // (api.getToken() returned empty at save-time). User needs to login
        // with password ONCE so the token gets stashed in SecureStore for
        // next time.
        try { goToPasswordRef.current?.(savedEmail); } catch {}
        setError(t('login.biometricNotSaved'));
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
  // Initialize at 1 (final scale), not 0 — same problem as cardFadeAnim:
  // if the spring entrance fails to fire under iOS prod native driver, the
  // orb stays at scale 0 = invisible. Brand orb is critical, so skip the
  // entrance pop animation and render at full size from the first frame.
  const logoScaleAnim = useRef(new Animated.Value(1)).current;
  const titleAnim = useRef(new Animated.Value(1)).current; // 1 = shown (no longer animated)
  const cardSlideAnim = useRef(new Animated.Value(0)).current; // 0 = settled (was 12; same risk as cardFadeAnim — keep at final)
  const logoPulseAnim = useRef(new Animated.Value(1)).current; // kept at 1; no pulse loop
  // Telegram-grade breathing: scale 1 → 1.04 → 1 over 2.6s. Layered with the
  // entrance pop (logoScaleAnim) via Animated.multiply so the breath kicks in
  // only after the pop settles. Halo opacity pulses out-of-phase for depth.
  const logoBreathAnim = useRef(new Animated.Value(1)).current;
  const haloAnim = useRef(new Animated.Value(0.5)).current;
  // Face ID / Touch ID button press scale — spring 1 → 0.92 → 1 on press.
  // Mirrors iOS native tap feedback so the biometric tile feels alive even
  // before the system Face ID sheet appears. Used by handleBiometricLogin
  // press handler. Refs (not useRef().current) so the IIFE that renders the
  // button can grab the same Animated.Value across re-renders.
  const bioBtnScaleRef = useRef(new Animated.Value(1));
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

  // Restore-from-backup prompt state. Surfaced after a successful login
  // when (1) we have no local chat data, AND (2) the user has not
  // dismissed the prompt before, AND (3) listBackups() returns >= 1
  // backup from iCloud/Google Drive. See components/RestoreBackupPrompt.
  // Web is opt-out (the native module is iOS/Android only).
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [restoreBackups, setRestoreBackups] = useState([]);
  const [ownRestore, setOwnRestore] = useState(null); // [2026-10-09 own-backup]
  // Full-history download prompt (#1240 2026-05-20) — fires AFTER the backup
  // prompt path. Different from RestoreBackupPrompt: that one decrypts a
  // .CYB2 blob from iCloud/Drive. This one walks chat_messages page by page
  // and pulls EVERY old text + media into the local SQLite store, so the
  // user can re-open the app offline tomorrow and see all 5-year-old photos.
  const [showHistoryPrompt, setShowHistoryPrompt] = useState(false);
  const [historyPromptEmail, setHistoryPromptEmail] = useState('');
  const pendingNavRef = useRef(null); // { target: '/inbox' | '/chat' } to run after the prompt closes
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
    ]).start();
    // [2026-10-07 login-ux] Ambient loops (logo breath, halo pulse, two
    // drifting orbs) removed together with the orb hero — 4 infinite
    // animations for the whole time the login was open, for decoration.

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // [2026-10-07 login-ux] Content swap between smart → password / OTP.
  // The state change is applied IMMEDIATELY (the old animateStep only switched
  // step inside the animation-finished callback — if the native driver
  // hiccuped, the screen never advanced). The motion is cosmetic and starts
  // from a visible value (opacity 0.6), so a stuck Animated value can never
  // hide the form.
  const swapTo = (apply, dir = 1) => {
    try { apply(); } catch {}
    slideAnim.setValue(22 * dir);
    fadeAnim.setValue(0.6);
    Animated.parallel([
      Animated.spring(slideAnim, { toValue: 0, tension: 90, friction: 13, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };

  const goToPassword = (em) => {
    swapTo(() => {
      setEmail(em);
      setPassword('');
      setShowPassword(false);
      setPwHint('');
      setError('');
      setStep(2);
      setLoginMode('email');
    }, 1);
    setTimeout(() => { try { passwordRef.current?.focus(); } catch {} }, 280);
  };
  goToPasswordRef.current = goToPassword;

  const backToSmart = () => {
    hSelection();
    swapTo(() => {
      // Keep what the user typed so "voltar" is never destructive. Came from
      // the remembered list (row tap, nothing typed)? → back to the list.
      if (loginMode === 'email' && email) {
        const fromRoster = !identifier && remembered.some(a => a.email === email);
        if (!fromRoster) {
          if (!identifier) setIdentifier(email);
          setUseAnother(true);
        }
      }
      setLoginMode('smart');
      setStep(1);
      setError('');
      setPwHint('');
      setPhoneStep('input');
      setPhoneOtp(['', '', '', '', '', '']);
      setPhoneRequiresLock(false);
      setPhoneLockPin('');
      setOtpChannelNote('');
    }, -1);
  };

  // Big check pop between "auth OK" and the route change (password, Face ID,
  // remembered-account and OTP logins all use it now).
  const showSuccessPop = () => {
    try {
      hSuccess();
      setLoginSuccess(true);
      successAnim.setValue(0.6);
      Animated.spring(successAnim, { toValue: 1, friction: 6, tension: 110, useNativeDriver: true }).start();
      // Never let the (touch-blocking) overlay outlive a navigation that
      // didn't happen (restore prompt, route guard bounce…).
      setTimeout(() => { if (mountedRef.current) setLoginSuccess(false); }, 2500);
    } catch {}
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

  // [2026-10-07 login-ux] Single smart entry: phone → OTP, e-mail / @handle
  // → password. Replaces the separate phone form + "Entrar com email" step 1.
  const handleSmartContinue = () => {
    hTap('light');
    const raw = identifier;
    const kind = classifyIdentifier(raw);
    if (kind === 'empty') {
      setError(t('login.errorIdentifierEmpty'));
      shake();
      try { identifierRef.current?.focus(); } catch {}
      return;
    }
    if (kind === 'phone') {
      let dial = phoneCountryCode;
      let national = String(raw).replace(/\D/g, '');
      if (String(raw).trim().startsWith('+')) {
        const sp = splitInternational(raw);
        if (!sp) { setError(t('login.phoneInvalid')); shake(); return; }
        dial = sp.country.dial;
        national = sp.national;
      }
      national = national.replace(/^0+/, '');
      if (national.length < 8 || !/^\+[1-9]\d{7,14}$/.test(dial + national)) {
        setError(t('login.phoneInvalid')); shake(); return;
      }
      if (!online) { setError(t('login.errorOffline')); shake(); return; }
      setPhoneCountryCode(dial);
      setPhoneNumber(national);
      handlePhoneSendOtp('sms', { dial, national });
      return;
    }
    const em = normalizeLoginEmail(raw);
    if (!isPlausibleEmail(em)) { setError(t('login.errorEmailInvalid')); shake(); return; }
    setError('');
    goToPassword(em);
  };

  // One tap on a remembered account: Face ID (if bound to it) → stored session
  // (other accounts still signed in on this device) → password prefilled.
  const handleRememberedSelect = async (acc) => {
    if (!acc?.email || busyEmail) return;
    setError('');
    if (bioAvailable && bioReadyEmail && bioReadyEmail === acc.email) {
      handleBiometricLogin();
      return;
    }
    if (acc.token && online) {
      setBusyEmail(acc.email);
      try {
        const r = await loginWithToken(acc.token, acc.email);
        if (!mountedRef.current) return;
        if (r?.success) {
          saveLastIdentifier(acc.email);
          showSuccessPop();
          goAfterLogin(r.data?.is_child || isChildAccount());
          return;
        }
      } catch {}
      finally { if (mountedRef.current) setBusyEmail(''); }
    }
    goToPassword(acc.email);
  };

  // "Remover deste aparelho": drops the roster row (AuthContext.removeAccount
  // also revokes a still-stored bearer server-side), the Face ID binding and
  // the remembered identifier if they point at this account.
  const handleRememberedRemove = async (acc) => {
    hSelection();
    const em = acc?.email;
    if (!em) return;
    setRemembered(prev => prev.filter(a => a.email !== em));
    try { await removeAccount?.(em); } catch { try { api.removeStoredAccount?.(em); } catch {} }
    try {
      const last = await loadLastIdentifier();
      if (last && last.toLowerCase() === em.toLowerCase()) forgetLastIdentifier();
    } catch {}
    if (Platform.OS !== 'web' && bioReadyEmail === em) {
      try {
        const { bioTokenKeyFor } = require('../context/BiometricContext');
        const k = bioTokenKeyFor(em);
        if (k) await SecureStore.deleteItemAsync(k);
        await SecureStore.deleteItemAsync('bio_email');
        await SecureStore.deleteItemAsync('bio_token');
      } catch {}
      setBioReadyEmail('');
    }
  };

  // ── [2026-10-07 login-ux] device-aware effects ──
  // Remembered accounts (multi-account roster: email+name; token only for
  // accounts still signed in). Native loads the roster from SecureStore
  // asynchronously at module init → read again shortly after mount.
  useEffect(() => {
    let alive = true;
    const read = () => {
      try {
        const list = api.getStoredAccounts?.() || [];
        const seen = new Set();
        const out = [];
        for (const a of (Array.isArray(list) ? list : [])) {
          const em = typeof a?.email === 'string' ? a.email.trim() : '';
          if (!em || !em.includes('@')) continue;
          const k = em.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ email: em, name: typeof a.name === 'string' ? a.name : '', token: typeof a.token === 'string' ? a.token : '' });
        }
        return out.slice(0, 4);
      } catch { return []; }
    };
    const apply = () => { if (alive) setRemembered(read()); };
    apply();
    const tm = setTimeout(apply, 600);
    return () => { alive = false; clearTimeout(tm); };
  }, []);

  // Prefill the identifier: signup bounce (?phone=) > last successful identifier.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (phoneNumber) { if (alive) setIdentifier(phoneNumber); return; }
      if (isAddAccount) return;
      const last = await loadLastIdentifier();
      if (!alive || !last) return;
      if (last.startsWith('+')) {
        const sp = splitInternational(last);
        if (sp) { setPhoneCountryCode(sp.country.dial); setIdentifier(sp.national); return; }
      }
      setIdentifier(prev => prev || last);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Offline banner — the old screen only said "Erro de conexão" after a tap.
  useEffect(() => {
    let off = null;
    try { off = onNetworkChange((st) => { if (mountedRef.current) setOnline(st?.isConnected !== false); }); } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);

  // Web: real Caps Lock state (KeyboardEvent.getModifierState). Native has no
  // API for it — there we only hint AFTER a failed attempt (passwordHints).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const h = (e) => {
      try { if (typeof e?.getModifierState === 'function') setCapsLockOn(!!e.getModifierState('CapsLock')); } catch {}
    };
    document.addEventListener('keydown', h);
    document.addEventListener('keyup', h);
    return () => { document.removeEventListener('keydown', h); document.removeEventListener('keyup', h); };
  }, []);

  // ── Passkey (WebAuthn) login — FLAG-GATED, default OFF. ────────────────────
  // The button that calls this is only rendered when PASSKEYS_ENABLED is true
  // (constants/featureFlags.js). The native passkey bridge (react-native-passkey)
  // is NOT installed yet, so we lazy-require it inside try/catch: a missing
  // module can NEVER crash the bundle — it just shows a graceful notice. When the
  // dep + build + associated-domains land, flip the flag and this path is live.
  // Backend ceremony endpoints: /api/passkeys.php (passkey_login_begin/finish).
  const handlePasskeyLogin = async () => {
    if (!PASSKEYS_ENABLED) return; // hard guard — never runs while gated off
    try {
      // [2026-10-09 passkeys] services/passkeys.js: native module checked with
      // requireOptionalNativeModule at call time (absent in the current binary
      // → graceful notice). E-mail optional: empty field = usernameless sign-in
      // (the system sheet lists this device's chatyy.com.br passkeys).
      const pk = require('../services/passkeys');
      if (!pk.isPasskeySupported()) { setError(t('login.passkeyUnavailable')); return; }
      const typed = String(email || '').trim();
      const fullEmail = typed ? normalizeLoginEmail(typed) : '';
      if (typed && (!fullEmail || !fullEmail.includes('@'))) { setError(t('login.errorEmail')); shake(); return; }

      setLoading(true);
      const res = await pk.loginWithPasskey(fullEmail);
      if (!res.ok) {
        if (res.reason === 'cancelled') return;
        if (res.reason === 'none') { setError(t('login.passkeyNone')); return; }
        if (res.reason === 'unavailable') { setError(t('login.passkeyUnavailable')); return; }
        setError(t('login.passkeyError')); shake();
        return;
      }
      // Adopt the minted bearer via the SAME path biometric/QR login uses.
      const r = await loginWithToken(res.token, res.email);
      if (!mountedRef.current) return;
      if (r?.success) {
        goAfterLogin(r.data?.is_child || isChildAccount());
      } else {
        setError(r?.message || t('login.passkeyError')); shake();
      }
    } catch (e) {
      setError(t('login.passkeyError')); shake();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (loading) return; // return-key + button double fire
    hTap('light');
    if (!password) { setError(t('login.errorPassword')); shake(); return; }
    if (!online) { setError(t('login.errorOffline')); shake(); return; }
    setError('');
    setPwHint('');
    setLoading(true);
    try {
      // [2026-10-07 login-ux] trim/whitespace/case-normalised identifier
      // (Dovecot lowercases on auth; a trailing space used to fail as
      // "senha incorreta"). The password is NEVER altered.
      const fullEmail = normalizeLoginEmail(email);
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
              // P1: per-account twin so this bearer can only unlock the
              // identity it was minted for (`bio_token:<email>`).
              try {
                const { bioTokenKeyFor } = require('../context/BiometricContext');
                const k = bioTokenKeyFor(fullEmail);
                if (k) await SecureStore.setItemAsync(k, tok);
              } catch {}
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
        saveLastIdentifier(fullEmail);
        const isKids = r.data?.is_child || isChildAccount();
        // Admin-provisioned mailbox with a temporary password: force the user
        // to set a new one before entering the app. Session/token are already
        // live (login succeeded), so change_password authenticates fine.
        if (r.data?.must_change_password) {
          pendingGoRef.current = () => maybePromptRestoreThenGo(isKids, fullEmail);
          setForcePwChange(true);
          setLoading(false);
          return;
        }
        showSuccessPop();
        maybePromptRestoreThenGo(isKids, fullEmail);
      } else {
        // Backend returns "Incorrect email or password" in English + various
        // generic transport errors ("Servidor indisponivel", "Login failed").
        // For any of those, show the translated credential error — only show
        // the raw backend message if it's a specific PT-BR one we don't know.
        const rawMsg = r.message || '';
        // [2026-10-07 login-ux] Rate limit first (its text also contains
        // "senha"/"email" and was shown as a wrong-password error). Wrong
        // credentials stay ONE generic message — never says which part failed.
        const isRateLimited = /too many|muitas tentativas|aguarde|try again later|bloquead|rate.?limit/i.test(rawMsg);
        const isCredError = /incorrect|invalid|wrong|credencia|senha|password|email/i.test(rawMsg);
        const isGeneric = /servidor|indispon|unavail|connection|login failed|tempo limite/i.test(rawMsg);
        if (isRateLimited) {
          setError(t('login.errorRateLimited'));
        } else if (!rawMsg || isCredError || isGeneric) {
          setError(t('login.errorCredentials'));
          // Smart, local-only hints about the most common self-inflicted
          // failures. Nothing here comes from the server.
          const ph = passwordHints(password);
          if (Platform.OS === 'web' && capsLockOn) setPwHint(t('login.hintCapsLock'));
          else if (ph.allCaps) setPwHint(t('login.hintAllCaps'));
          else if (ph.outerSpace) setPwHint(t('login.hintPasswordSpace'));
        } else {
          setError(rawMsg);
        }
        shake();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(online ? t('login.errorConnection') : t('login.errorOffline'));
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
            // Complete login with received data. GUARD: only proceed when the
            // approval carries a real, NON-EMPTY STRING bearer. A truthy-but-
            // non-string token (object/number) or an empty string would have
            // slipped through the old `if (r.data.token)` check and produced
            // a ghost "logged-in" session whose every API call 401s. On a bad
            // token, surface an error and let the user retry instead of
            // navigating into a dead session.
            const challengeToken =
              r.data && typeof r.data.token === 'string' ? r.data.token.trim() : '';
            if (!challengeToken) {
              setVerificationStep(null);
              setError(t('login.errorConnection') || 'Não foi possível concluir o login. Tente novamente.');
              shake();
              return;
            }
            // completeLoginAfterChallenge returns {success,data}; only persist
            // biometric creds + navigate when it actually completed.
            const cr = await completeLoginAfterChallenge(r.data);
            if (!mountedRef.current) return;
            if (!cr || cr.success === false) {
              setVerificationStep(null);
              setError(cr?.message || t('login.errorConnection') || 'Não foi possível concluir o login.');
              shake();
              return;
            }
            // Save biometric creds
            if (Platform.OS !== 'web') {
              try {
                const tok = challengeToken || api.getToken?.();
                await SecureStore.setItemAsync('bio_email', chEmail);
                if (tok) {
                  await SecureStore.setItemAsync('bio_token', tok);
                  // P1: per-account twin (`bio_token:<email>`).
                  try {
                    const { bioTokenKeyFor } = require('../context/BiometricContext');
                    const k = bioTokenKeyFor(chEmail);
                    if (k) await SecureStore.setItemAsync(k, tok);
                  } catch {}
                }
                await SecureStore.deleteItemAsync('bio_password').catch(() => {});
              } catch {}
            }
            setTimeout(() => {
              if (mountedRef.current) maybePromptRestoreThenGo(isChildAccount(), chEmail);
            }, 800);
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
            // Stage 2: this web/desktop surface just got paired. Generate
            // (or load) the per-device X25519 keypair + uuid, and publish
            // the pubkey so the phone can encrypt envelopes targeting
            // this device in future. Fire-and-forget — non-fatal if the
            // network call fails; phone will re-fetch on next foreground.
            try {
              const did = await getE2eDeviceId();
              const pub = await getE2eDevicePublicKey();
              const kind = Platform.OS === 'web' ? 'web' : Platform.OS;
              api.chatDeviceKeyPublish(did, pub, kind).catch(() => {});
            } catch (e) { /* non-fatal */ }
            setTimeout(() => {
              if (mountedRef.current) maybePromptRestoreThenGo(isChildAccount(), res.data.email);
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
  // Amplia o seletor com todos os países de constants/countries.js (DDIs únicos,
  // pois este seletor é chaveado por DDI).
  {
    const _have = new Set(COUNTRY_CODES.map(c => c.code));
    for (const c of COUNTRIES_FULL) {
      if (_have.has(c.dial)) continue;
      _have.add(c.dial);
      COUNTRY_CODES.push({ code: c.dial, flag: c.flag, name: c.name, label: `${c.code} ${c.dial}` });
    }
  }
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const filteredCountries = useMemo(() => {
    if (!countrySearch) return COUNTRY_CODES;
    const q = countrySearch.toLowerCase();
    return COUNTRY_CODES.filter(c => c.name.toLowerCase().includes(q) || c.code.includes(q) || c.label.toLowerCase().includes(q));
  }, [countrySearch]);

  // [2026-10-07 login-ux] `override` = { dial, national } from the smart field
  // (React state set in the same tick isn't readable yet). channel 'backend'
  // skips Firebase and asks OUR verify_send, which in BR delivers the SAME
  // code by WhatsApp AND SMS (intl: WhatsApp first, SMS fallback) — this is
  // the "Receber pelo WhatsApp" option on the code screen.
  const handlePhoneSendOtp = async (channel = 'sms', override = null) => {
    if (phoneSending) return;
    hTap('light');
    const dialUse = (override && override.dial) || phoneCountryCode;
    const cleaned = String((override && override.national) ?? phoneNumber).replace(/[^0-9]/g, '').replace(/^0+/, '');
    if (cleaned.length < 8 || !/^\+[1-9]\d{7,14}$/.test(dialUse + cleaned)) { setError(t('login.phoneInvalid')); shake(); return; }
    if (!online) { setError(t('login.errorOffline')); shake(); return; }
    setError('');
    setPhoneSending(true);
    try {
      const fullPhone = dialUse + cleaned;
      // Unified flow (user feedback 2026-05-07): just send the SMS — don't
      // pre-flight an exists check that interrupts with "não encontramos
      // sua conta, vamos criar uma" before the OTP screen. After the user
      // types the code, phoneLoginVerify decides:
      //   • exists=true   → returns token → log in
      //   • exists=false  → returns verify_token → continue to signup name
      //                     step with phone+verify_token pre-filled
      // verifySend is the bare SMS endpoint (no exists gating). The
      // exists-aware "Já tem conta" / "Vamos criar" copy still surfaces
      // via the debounced phoneAccountState helper text underneath the
      // input, so the user has the affordance without a forced redirect.
      // onPress handlers pass the synthetic event as the first arg — coerce
      // anything that isn't a known channel string back to 'sms'. The voice
      // channel asks Vonage to PLACE A CALL that reads the code aloud (PT-BR
      // Polly), so it must skip Firebase and go straight to the backend OTP.
      const backendOnly = channel === 'backend';
      const ch = (channel === 'voice' || channel === 'force_sms') ? channel : 'sms';
      // Firebase Phone Auth first for SMS (Google sends it — best BR
      // deliverability). Reset any prior attempt's state, then try Firebase;
      // fall back to the backend OTP endpoint (Vonage) if Firebase is
      // unavailable or errors. Voice never uses Firebase (no voice channel
      // there) — it always goes to the backend so Vonage rings the number.
      fbConfirmRef.current = null;
      fbIdTokenRef.current = null;
      phoneViaFirebaseRef.current = false;
      let r;
      if (ch === 'sms' && !backendOnly && firebasePhoneAvailable()) {
        const fb = await fbSendCode(fullPhone);
        if (fb.ok) {
          phoneViaFirebaseRef.current = true;
          fbConfirmRef.current = fb.confirmation;
          r = { success: true };
        }
      }
      if (!r) r = await api.verifySend(fullPhone, ch);
      if (!mountedRef.current) return;
      if (r.success) {
        // Tell the user WHERE the code went (verify_send reports both flags).
        const wa = !!r.data?.whatsapp_sent; const sms = !!r.data?.sms_sent;
        setOtpChannelNote(
          phoneViaFirebaseRef.current ? t('login.otpSentSms')
            : (wa && sms) ? t('login.otpSentBoth')
            : wa ? t('login.otpSentWhatsapp')
            : sms ? t('login.otpSentSms') : ''
        );
        setPhoneOtp(['', '', '', '', '', '']);
        if (loginMode !== 'phone') {
          swapTo(() => { setLoginMode('phone'); setPhoneStep('otp'); }, 1);
        } else {
          setPhoneStep('otp');
        }
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
      const fullPhone = phoneCountryCode + phoneNumber.replace(/[^0-9]/g, '').replace(/^0+/, '');
      // Unified verify (user feedback 2026-05-07): same OTP code resolves
      // both branches in one call. Server returns either a bearer token
      // (existing account → log in) or a verify_token (new account → go
      // straight to the name step in /signup-phone, skipping welcome +
      // phone + otp since we already have phone+verify_token). No
      // intermediate "não encontramos sua conta" screen.
      // If a registration_lock is set on the account, server returns
      // requires_lock=true and we surface the PIN input. Pass the PIN
      // back when the user enters it.
      const _pin = phoneRequiresLock ? phoneLockPin : '';
      let r;
      if (phoneViaFirebaseRef.current) {
        // Firebase path: confirm the typed code once → ID token; on the PIN
        // re-call reuse the stored token (the SMS code is already consumed).
        if (!fbIdTokenRef.current) {
          const c = await fbConfirm(fbConfirmRef.current, code);
          if (!mountedRef.current) return;
          if (!c.ok) {
            // Mistyped/expired code is a normal recoverable error; anything
            // else means Firebase itself failed — surface as wrong code so the
            // user can resend (which re-runs send and may fall back to backend).
            setError(t('login.phoneOtpInvalid'));
            shake();
            setPhoneOtp(['', '', '', '', '', '']);
            setTimeout(() => { try { phoneOtpRefs.current?.[0]?.focus?.(); } catch {} }, 0);
            setPhoneVerifying(false);
            return;
          }
          fbIdTokenRef.current = c.idToken;
        }
        r = await api.phoneLoginFirebase(fbIdTokenRef.current, _pin);
      } else {
        r = await api.phoneLoginVerifyWithPin(fullPhone, code, _pin);
      }
      if (!mountedRef.current) return;
      // Account has registration lock — show PIN input and stop here.
      if (r.success && r.data?.requires_lock) {
        setPhoneRequiresLock(true);
        // Don't shake — this is a normal branch, not an error.
        setPhoneVerifying(false);
        return;
      }
      // Bad PIN — server returns success:false with requires_lock flag.
      if (!r.success && r.data?.requires_lock) {
        setError(r.message || (t('login.phoneLockPinWrong') || 'PIN incorreto'));
        setPhoneLockPin('');
        shake();
        setPhoneVerifying(false);
        return;
      }
      if (r.success && r.data?.token) {
        // The Chatyy bearer is now the real session — drop the Firebase one.
        if (phoneViaFirebaseRef.current) { fbSignOut(); }
        await loginWithToken(r.data.token, r.data.email);
        saveLastIdentifier(fullPhone);
        showSuccessPop();
        setTimeout(() => {
          if (mountedRef.current) maybePromptRestoreThenGo(isChildAccount(), r.data.email);
        }, 800);
        return;
      }
      if (r.success && r.data?.exists === false && r.data?.verify_token) {
        // New account path — jump to the name step with verify_token in
        // hand. signup-phone reads `step` and `verify_token` params and
        // mounts directly at the name input.
        safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
        try {
          const url = `/signup-phone?phone=${encodeURIComponent(fullPhone)}&country=${encodeURIComponent(_isoFromDial(phoneCountryCode))}&verify_token=${encodeURIComponent(r.data.verify_token)}&step=name`;
          router.replace(url);
        } catch {
          setError(t('login.errorConnection'));
          shake();
        }
        return;
      }
      const msg = r.message || t('login.phoneOtpInvalid');
      if (msg.includes('expired') || msg.includes('No valid')) setError(t('login.phoneOtpExpired'));
      else setError(msg);
      shake();
      setPhoneOtp(['', '', '', '', '', '']);
      setTimeout(() => { try { phoneOtpRefs.current?.[0]?.focus?.(); } catch {} }, 0);
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
      // [2026-10-08 android-otp-shortcuts] via ref: this closure's
      // handlePhoneVerifyOtp still sees the PREVIOUS phoneOtp (stale state →
      // code.length !== 6 → silent no-op). The ref is the post-render one.
      setTimeout(() => { try { phoneVerifyRef.current?.(); } catch {} }, 150);
    }
  };
  const phoneVerifyRef = useRef(null);
  phoneVerifyRef.current = handlePhoneVerifyOtp;
  // [2026-10-08 android-otp-shortcuts] Android SMS User Consent → fill + auto-submit.
  // Re-arms when a (re)send starts the 60s cooldown.
  useSmsOtpAutofill(loginMode === 'phone' && phoneStep === 'otp', (code) => handlePhoneOtpFullChange(code), phoneResendTimer > 0);

  // [2026-10-07 login-ux] REMOVED the debounced "Conta encontrada / Vamos
  // criar" live-check. It called api.phoneLoginRequest({phone,…}) with an
  // OBJECT (api signature is (phone)) → backend 400 on every pause, so it never
  // showed anything. Worse, "fixing" it would be harmful: phone_login_request
  // SENDS an OTP and arms the per-number 60s cooldown, so each debounce would
  // text the user and the real "Continuar" tap would hit "aguarde 60s".

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
                  {t('login.verifyNoAccess')}{'\n'}
                  <Text style={{ fontWeight: '600' }}>{t('login.verifyAltMethods')}</Text>
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
              <View style={[s.verifyIconCircle, { backgroundColor: colors.success + '15' }]}>
                <IconCheck size={48} color={colors.success} />
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
              <View style={[s.verifyIconCircle, { backgroundColor: colors.error + '15' }]}>
                <IconAlertTriangle size={48} color={colors.error} />
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
                <Text style={[s.verifyBtnPrimaryText, { color: colors.onPrimary || '#fff' }]}>
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

  // Telegram-style intro carousel for first-time users on mobile —
  // matches the approved /mockups/login-unified.html flow. Onboarding
  // happens BEFORE the phone form so users understand what Chatyy is
  // before being asked for their number. SignupIntro handles its own
  // SafeAreaView + dots + CTA; on finish we just flip the flag.
  if (showIntro) {
    return <SignupIntro onFinish={dismissIntro} />;
  }

  // ── [2026-10-07 login-ux] derived view state (plain consts — after the
  // early returns above, so NO hooks below this line) ──
  const idKind = classifyIdentifier(identifier);
  const idHints = identifierHints(identifier);
  const emailSuggestion = idKind === 'email' ? suggestEmailFix(identifier) : null;
  const idSoftHint = (idKind === 'email' || idKind === 'username')
    ? (idHints.hasInnerSpace ? t('login.hintInnerSpace')
      : idHints.hasOuterSpace ? t('login.hintOuterSpace')
      : idHints.hasUppercase ? t('login.hintUppercase') : '')
    : '';
  const showAccounts = remembered.length > 0 && !useAnother && !isAddAccount;
  const bioKind = bioType === 'face' ? 'face' : 'finger';
  const bioMethodLabel = bioType === 'face' ? 'Face ID' : bioType === 'touch' ? 'Touch ID' : t('login.biometricShort');
  const bioUsable = isNative && bioAvailable && !!bioReadyEmail;
  const bioInRoster = bioUsable && remembered.some(a => a.email === bioReadyEmail);
  const showBioQuick = bioUsable && !bioInRoster && !isAddAccount;
  const rosterSorted = bioInRoster
    ? [...remembered].sort((a, b) => (a.email === bioReadyEmail ? -1 : b.email === bioReadyEmail ? 1 : 0))
    : remembered;
  const rememberedForEmail = remembered.find(a => a.email.toLowerCase() === String(email || '').toLowerCase());
  const displayName = String(rememberedForEmail?.name || '').trim();
  const _cc = COUNTRIES_FULL.find(x => x.dial === phoneCountryCode) || COUNTRIES_FULL[0];
  const smartCountry = { iso: _isoFromDial(phoneCountryCode), dial: phoneCountryCode, mask: _cc?.mask, maxDigits: _cc?.maxDigits || 15 };
  const phoneDisplay = `${phoneCountryCode} ${formatPhone(String(phoneNumber || ''), _cc?.mask) || phoneNumber}`;
  const otpWentViaWhatsapp = otpChannelNote === t('login.otpSentBoth') || otpChannelNote === t('login.otpSentWhatsapp');
  const openForgot = () => {
    hSelection();
    const em = normalizeLoginEmail(email);
    router.push(em ? `/forgot?email=${encodeURIComponent(em)}` : '/forgot');
  };

  const renderPrimary = ({ label, onPress, busy, disabled }) => {
    const off = !!disabled && !busy;
    return (
      <Animated.View style={{ transform: [{ scale: ctaScaleAnim }], marginTop: 18 }}>
        <Pressable
          onPress={onPress}
          onPressIn={onCtaPressIn}
          onPressOut={onCtaPressOut}
          disabled={!!busy || off}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !!busy || off, busy: !!busy }}
          style={({ pressed }) => [s.igPrimaryBtn, {
            marginTop: 0, height: 54, borderRadius: 14,
            backgroundColor: off ? colors.border : colors.primary,
            opacity: pressed && !off ? 0.9 : 1,
          }, off && Platform.select({
            web: { boxShadow: 'none', cursor: 'default' },
            ios: { shadowOpacity: 0 },
            android: { elevation: 0 },
            default: {},
          })]}
        >
          {busy ? (
            <View style={s.loadingBtnContent}>
              <DotLoader color={colors.onPrimary || '#fff'} />
              <Text style={[s.igPrimaryBtnText, { marginLeft: 10, color: colors.onPrimary || '#fff' }]}>{label}</Text>
            </View>
          ) : (
            <Text style={[s.igPrimaryBtnText, { color: off ? colors.textTertiary : colors.onPrimary }]}>{label}</Text>
          )}
        </Pressable>
      </Animated.View>
    );
  };

  const renderBack = (onPress, label) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label || t('login.back')}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{
        alignSelf: 'flex-start', width: 40, height: 40, borderRadius: 20,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.surfaceVariant, marginBottom: 14,
      }}
    >
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M15 18l-6-6 6-6" stroke={colors.text} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </TouchableOpacity>
  );

  // Clean brand hero — solid mark + wordmark + tagline. Replaces the 200pt
  // orb with 2 halos + 4 perpetual loops (breath/halo/2 drifting orbs) that
  // kept the JS/UI thread busy for the whole time the screen was open.
  const renderHero = (compact = false) => (
    <View style={{ alignItems: 'center', marginBottom: compact ? 20 : 28 }}>
      <View style={{
        width: compact ? 52 : 68, height: compact ? 52 : 68, borderRadius: compact ? 16 : 22,
        // [2026-10-08 login-appicon] real app icon instead of a generic glyph
        backgroundColor: '#ffffff', overflow: Platform.OS === 'android' ? 'hidden' : 'visible',
        alignItems: 'center', justifyContent: 'center',
        ...Platform.select({
          web: { boxShadow: isDark ? 'none' : '0 10px 28px rgba(17,17,17,0.16)' },
          ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: isDark ? 0 : 0.16, shadowRadius: 16 },
          android: { elevation: isDark ? 0 : 5 },
          default: {},
        }),
      }}>
        <Image
          source={require('../assets/icon.png')}
          style={{ width: compact ? 52 : 68, height: compact ? 52 : 68, borderRadius: compact ? 16 : 22 }}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      </View>
      <Text accessibilityRole="header" style={{ fontSize: compact ? 26 : 32, fontWeight: '800', letterSpacing: -1, color: colors.text, marginTop: compact ? 12 : 16 }}>
        Chatyy
      </Text>
      <Text style={{ fontSize: 15, lineHeight: 21, color: colors.textSecondary, marginTop: 4, textAlign: 'center' }}>
        {t('login.tagline')}
      </Text>
    </View>
  );

  const renderDivider = () => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 22, marginBottom: 14 }}>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textTertiary, letterSpacing: 0.4 }}>{t('login.or')}</Text>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
    </View>
  );

  const renderSecondary = (label, onPress) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      style={{
        height: 52, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.authCardBg || 'transparent',
        ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{label}</Text>
    </TouchableOpacity>
  );

  // ── SMART ENTRY ── phone / e-mail / @usuário in ONE field.
  const renderSmart = () => (
    <View>
      {!isDesktop && renderHero(false)}
      {!online && <LoginNotice tone="offline" text={t('login.offlineBanner')} colors={colors} style={{ marginBottom: 16 }} />}

      {showBioQuick && (
        <PressableScale
          onPress={handleBiometricLogin}
          disabled={bioLoading}
          haptic="light"
          scaleTo={0.98}
          accessibilityRole="button"
          accessibilityLabel={t('login.bioContinue', { method: bioMethodLabel })}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16,
            borderWidth: Platform.OS === 'web' ? 1 : 0.5, borderColor: colors.border,
            backgroundColor: colors.authCardBg || colors.surface, marginBottom: 18,
          }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            {bioLoading
              ? <ActivityIndicator color={colors.onPrimary || '#fff'} size="small" />
              : <BiometricGlyph kind={bioKind} color={colors.onPrimary || '#fff'} size={22} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{t('login.bioContinue', { method: bioMethodLabel })}</Text>
            <Text numberOfLines={1} style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>{bioReadyEmail}</Text>
          </View>
        </PressableScale>
      )}

      {showAccounts ? (
        <>
          <RememberedAccounts
            accounts={rosterSorted}
            onSelect={handleRememberedSelect}
            onRemove={handleRememberedRemove}
            onUseAnother={() => {
              hSelection();
              setError('');
              swapTo(() => setUseAnother(true), 1);
              setTimeout(() => { try { identifierRef.current?.focus(); } catch {} }, 280);
            }}
            colors={colors}
            t={t}
            busyEmail={busyEmail}
            bioEmail={bioUsable ? bioReadyEmail : ''}
            bioKind={bioKind}
          />
          {!!error && <LoginNotice tone="error" text={error} colors={colors} style={{ marginTop: 12 }} />}
        </>
      ) : (
        <>
          <Text accessibilityRole="header" style={[s.title, { color: colors.text }]}>{t('login.smartTitle')}</Text>
          <Text style={[s.subtitle, { color: colors.textSecondary }]}>{t('login.smartSubtitle')}</Text>

          <SmartIdentifierField
            value={identifier}
            onChangeText={(v) => { setIdentifier(v); if (error) setError(''); }}
            country={smartCountry}
            onPressCountry={() => { hSelection(); setCountrySearch(''); setShowCountryPicker(true); }}
            onInternationalDetected={(sp) => { hSelection(); setPhoneCountryCode(sp.country.dial); }}
            onSubmitEditing={handleSmartContinue}
            inputRef={identifierRef}
            colors={colors}
            t={t}
            invalid={!!error}
            autoFocus={isDesktop || (Platform.OS !== 'web' && !identifier)}
            showKindHint={!error && !emailSuggestion && !idSoftHint}
          />

          {!!emailSuggestion && !error && (
            <View style={{ marginTop: 10 }}>
              <SuggestionChip
                label={t('login.didYouMean', { domain: emailSuggestion.split('@')[1] })}
                onPress={() => { hSelection(); setIdentifier(emailSuggestion); }}
                colors={colors}
              />
            </View>
          )}
          {!!idSoftHint && !emailSuggestion && !error && (
            <LoginNotice tone="hint" text={idSoftHint} colors={colors} style={{ marginTop: 6 }} />
          )}
          {!!error && <LoginNotice tone="error" text={error} colors={colors} style={{ marginTop: 10 }} />}

          {renderPrimary({
            label: idKind === 'phone' ? t('login.sendCodeCta') : t('login.continueCta'),
            onPress: handleSmartContinue,
            busy: phoneSending,
            disabled: idKind === 'empty',
          })}

          {remembered.length > 0 && !isAddAccount && useAnother && (
            <TouchableOpacity
              onPress={() => { hSelection(); setError(''); swapTo(() => setUseAnother(false), -1); }}
              activeOpacity={0.6}
              accessibilityRole="button"
              style={s.igGhostBtn}
            >
              <Text style={[s.igGhostBtnLabel, { color: colors.text, fontSize: 14 }]}>{t('login.backToAccounts')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => { hSelection(); router.push('/forgot?find=1'); }}
            activeOpacity={0.6}
            accessibilityRole="button"
            style={s.igGhostBtn}
          >
            <Text style={[s.igGhostBtnLabel, { color: colors.textSecondary, fontSize: 14 }]}>{t('login.forgotEmail')}</Text>
          </TouchableOpacity>
        </>
      )}

      {!isAddAccount && (
        <>
          {renderDivider()}
          {renderSecondary(t('login.createAccount'), () => { hSelection(); router.push('/signup-phone'); })}
          {/* [2026-10-09 signup-nophone] /signup-username (sem telefone) só abria pela URL. */}
          <TouchableOpacity
            onPress={() => { hSelection(); router.push('/signup-username'); }}
            activeOpacity={0.6}
            accessibilityRole="link"
            hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
            style={[s.igGhostBtn, { marginTop: 4 }]}
            testID="login-signup-nophone"
          >
            <Text style={[s.igGhostBtnLabel, { color: colors.textSecondary, fontSize: 14 }]}>{t('login.createAccountNoPhone')}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  // ── PASSWORD ── (e-mail / @usuário path)
  const renderPassword = () => (
    <View>
      {renderBack(backToSmart)}
      <View style={{ alignItems: 'center', marginBottom: 20 }}>
        {rememberedForEmail ? (
          <AvatarCircle name={displayName || email} email={email} size={72} />
        ) : (
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: colors.onPrimary || '#fff', fontSize: 28, fontWeight: '800' }}>{(email || '?')[0].toUpperCase()}</Text>
          </View>
        )}
        <Text accessibilityRole="header" style={[s.title, { color: colors.text, marginTop: 14, marginBottom: 6 }]} numberOfLines={1}>
          {displayName ? t('login.helloName', { name: displayName.split(' ')[0] }) : t('login.welcomeBack')}
        </Text>
        <TouchableOpacity
          onPress={backToSmart}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('login.changeAccount')}
          style={[s.userChip, { marginTop: 0, marginBottom: 0, paddingLeft: 14, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
        >
          <Text style={[s.userEmail, { color: colors.text }]} numberOfLines={1}>{email}</Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginLeft: 8 }}>{t('login.change')}</Text>
        </TouchableOpacity>
      </View>

      {!online && <LoginNotice tone="offline" text={t('login.offlineBanner')} colors={colors} style={{ marginBottom: 14 }} />}

      {/* Keychain / Autofill anchor: iOS + Chrome pair the saved password with
          the username field in the SAME form. Invisible, not focusable, hidden
          from screen readers. If the user picks another saved credential from
          the QuickType bar, iOS fills this too → we follow that account. */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
        <TextInput
          value={email}
          onChangeText={(v) => { const n = normalizeLoginEmail(v); if (n && isPlausibleEmail(n) && n !== email) setEmail(n); }}
          textContentType="username"
          autoComplete="username"
          importantForAutofill="yes"
          autoCapitalize="none"
          autoCorrect={false}
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
          style={{ width: 1, height: 1 }}
        />
      </View>

      <View style={{ position: 'relative' }}>
        <TextInput
          ref={passwordRef}
          style={[s.igInput, {
            height: 56, borderRadius: 14, fontSize: 17,
            backgroundColor: colors.surfaceVariant,
            borderWidth: focused === 'pass' || error ? 1.5 : 1,
            borderColor: error ? colors.error : (focused === 'pass' ? colors.text : colors.authInputBorder),
            color: colors.text,
            paddingRight: 52,
            ...(Platform.OS === 'web' && focused === 'pass' ? { boxShadow: `0 0 0 4px ${error ? colors.error : colors.text}14` } : {}),
          }]}
          value={password}
          onChangeText={(text) => { setPassword(text); if (error) setError(''); if (pwHint) setPwHint(''); }}
          secureTextEntry={!showPassword}
          textContentType="password"
          autoComplete={Platform.OS === 'android' ? 'password' : 'current-password'}
          importantForAutofill="yes"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="go"
          enterKeyHint="go"
          placeholder={t('login.passwordInput')}
          placeholderTextColor={colors.textTertiary}
          onFocus={() => setFocused('pass')}
          onBlur={() => setFocused('')}
          onSubmitEditing={handleLogin}
          accessibilityLabel={t('login.passwordPlaceholder')}
        />
        <TouchableOpacity
          onPress={() => { hSelection(); setShowPassword(v => !v); }}
          style={[s.igEyeBtn, { right: 4, width: 44, alignItems: 'center' }]}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? t('login.hidePassword') : t('login.showPassword')}
        >
          {showPassword
            ? <IconEyeOff size={20} color={colors.textSecondary} />
            : <IconEye size={20} color={colors.textSecondary} />}
        </TouchableOpacity>
      </View>

      {focused === 'pass' && capsLockOn && !error && (
        <LoginNotice tone="warning" text={t('login.hintCapsLock')} colors={colors} compact style={{ marginTop: 10 }} />
      )}
      {!!error && (
        <LoginNotice
          tone="error"
          text={error}
          actionLabel={error === t('login.errorCredentials') ? t('login.forgotPassword') : undefined}
          onAction={openForgot}
          colors={colors}
          style={{ marginTop: 10 }}
        />
      )}
      {!!pwHint && <LoginNotice tone="hint" text={pwHint} colors={colors} style={{ marginTop: 6 }} />}

      <TouchableOpacity
        style={[s.forgotLink, { alignSelf: 'flex-end', marginTop: 6, marginBottom: 0 }]}
        activeOpacity={0.6}
        onPress={openForgot}
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
        accessibilityRole="link"
      >
        <Text style={[s.linkText, { color: colors.text }]}>{t('login.forgotPassword')}</Text>
      </TouchableOpacity>

      {renderPrimary({ label: t('login.enter'), onPress: handleLogin, busy: loading, disabled: !password })}

      {bioUsable && bioReadyEmail === email && (
        <TouchableOpacity
          onPress={handleBiometricLogin}
          disabled={bioLoading || loading}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={[s.igGhostBtn, { flexDirection: 'row', gap: 8 }]}
        >
          {bioLoading ? <ActivityIndicator size="small" color={colors.text} /> : <BiometricGlyph kind={bioKind} color={colors.text} size={18} />}
          <Text style={[s.igGhostBtnLabel, { color: colors.text, fontSize: 14 }]}>{t('login.bioContinue', { method: bioMethodLabel })}</Text>
        </TouchableOpacity>
      )}

      {/* Passkey (WebAuthn) login — FLAG-GATED (PASSKEYS_ENABLED, default
          false) until react-native-passkey ships in a build. */}
      {PASSKEYS_ENABLED && (
        <TouchableOpacity
          onPress={handlePasskeyLogin}
          style={s.igGhostBtn}
          activeOpacity={0.6}
          disabled={loading}
          accessibilityRole="button"
        >
          <Text style={[s.igGhostBtnLabel, { color: colors.text }]}>{t('login.passkeyCta')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // ── OTP ── (phone path; code by SMS / WhatsApp)
  const renderOtp = () => (
    <View>
      {renderBack(backToSmart, t('login.phoneChangeNumber'))}
      <View style={{ alignItems: 'center', marginBottom: 4 }}>
        <View style={{ width: 60, height: 60, borderRadius: 20, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <IconMessageCircle size={26} color={colors.text} />
        </View>
        <Text accessibilityRole="header" style={[s.title, { color: colors.text }]}>{t('login.otpTitle')}</Text>
        <Text style={[s.subtitle, { color: colors.textSecondary, marginBottom: otpChannelNote ? 4 : 22 }]}>
          {t('login.phoneOtpSubtitle')}{' '}
          <Text style={{ fontWeight: '700', color: colors.text }}>{phoneDisplay}</Text>
        </Text>
        {!!otpChannelNote && (
          <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 20, textAlign: 'center' }}>{otpChannelNote}</Text>
        )}
      </View>
      {!online && <LoginNotice tone="offline" text={t('login.offlineBanner')} colors={colors} style={{ marginBottom: 14 }} />}
      {!!error && <LoginNotice tone="error" text={error} colors={colors} style={{ marginBottom: 14 }} />}
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
                                const _otpBg = isDark ? (_filled ? `${colors.primary}26` : colors.surfaceVariant) : (_filled ? `${colors.primary}10` : colors.surfaceVariant);
                                const _otpBorder = _focused ? colors.primary : (_filled ? colors.primary : (colors.border));
                                return (
                                  <Animated.View
                                    key={i}
                                    style={{
                                      width: 42, height: 52, borderRadius: 12,
                                      borderWidth: _focused ? 2 : 1.5,
                                      borderColor: _otpBorder,
                                      backgroundColor: _otpBg,
                                      alignItems: 'center', justifyContent: 'center',
                                      transform: [{ scale: phoneOtpCellAnims[i] }],
                                      ...(_focused && Platform.OS === 'web' ? { boxShadow: `0 0 0 4px ${colors.primary}22` } : {}),
                                      ...(_focused && Platform.OS === 'ios' ? { shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.35, shadowRadius: 6 } : {}),
                                      ...(_focused && Platform.OS === 'android' ? { elevation: 4 } : {}),
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
                                // opacity:0 silently broke Gboard's sms-otp
                                // chip on some Android builds — the autofill
                                // service skips fully-transparent fields. Use
                                // color/background:transparent + caretHidden
                                // so the input is invisible but Android still
                                // treats it as a normal autofillable field
                                // (reported 2026-05-08).
                                color: 'transparent',
                                backgroundColor: 'transparent',
                                fontSize: 22,
                                ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'transparent' } : {}),
                              }}
                              value={phoneOtp.join('')}
                              onChangeText={handlePhoneOtpFullChange}
                              onFocus={() => setPhoneOtpFocused(true)}
                              onBlur={() => setPhoneOtpFocused(false)}
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

                          {/* Registration-lock PIN gate (anti-SIM-swap).
                              Surfaces ONLY when the OTP succeeded but the
                              account has a PIN set — server returned
                              requires_lock=true. The PIN is a 4-6 digit
                              second factor the legitimate owner chose at
                              account creation time, so a SIM-swap attacker
                              who hijacks the OTP still can't pass this gate. */}
                          {phoneRequiresLock && (
                            <View style={{ marginBottom: 16, paddingHorizontal: 4 }}>
                              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 6, textAlign: 'center' }}>
                                {t('login.phoneLockPinTitle') || 'Digite seu PIN de segurança'}
                              </Text>
                              <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 12, textAlign: 'center', lineHeight: 17 }}>
                                {t('login.phoneLockPinDesc') || 'Essa conta tem PIN ativado para proteger contra troca de SIM.'}
                              </Text>
                              <TextInput
                                style={{
                                  alignSelf: 'center',
                                  width: 180, height: 52,
                                  borderRadius: 12,
                                  borderWidth: 1.5,
                                  borderColor: phoneLockPin ? colors.primary : (colors.border),
                                  backgroundColor: colors.surfaceVariant,
                                  color: colors.text,
                                  textAlign: 'center',
                                  fontSize: 22, fontWeight: '700',
                                  letterSpacing: 8,
                                  ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                                }}
                                value={phoneLockPin}
                                onChangeText={(v) => { setPhoneLockPin((v || '').replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
                                placeholder="••••"
                                placeholderTextColor={colors.textTertiary}
                                keyboardType="number-pad"
                                inputMode="numeric"
                                maxLength={6}
                                secureTextEntry
                                autoFocus
                              />
                            </View>
                          )}

                          <TouchableOpacity
                            style={[s.primaryBtn, {
                              backgroundColor: colors.primary,
                              opacity: phoneVerifying ? 0.7 : (
                                phoneRequiresLock
                                  ? (phoneLockPin.length < 4 ? 0.5 : 1)
                                  : (phoneOtp.join('').length !== 6 ? 0.5 : 1)
                              ),
                              width: '100%', alignSelf: 'stretch',
                              alignItems: 'center', justifyContent: 'center',
                            }]}
                            onPress={handlePhoneVerifyOtp}
                            disabled={phoneVerifying || (
                              phoneRequiresLock
                                ? (phoneLockPin.length < 4)
                                : (phoneOtp.join('').length !== 6)
                            )}
                            activeOpacity={0.85}
                          >
                            {phoneVerifying ? (
                              <View style={s.loadingBtnContent}>
                                <DotLoader color={colors.onPrimary || '#fff'} />
                                <Text style={[s.primaryBtnText, { marginLeft: 10, color: colors.onPrimary || '#fff' }]}>{t('login.phoneVerify')}</Text>
                              </View>
                            ) : (
                              <Text style={[s.primaryBtnText, { color: colors.onPrimary || '#fff' }]}>{phoneRequiresLock ? (t('login.phoneLockPinSubmit') || 'Confirmar PIN') : t('login.phoneVerify')}</Text>
                            )}
                          </TouchableOpacity>

                          {/* (generic "Código enviado por WhatsApp e SMS" row removed —
                              it was false on the Firebase SMS-only path; the header
                              now states the REAL channel from verify_send.) */}
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }}>
                            <TouchableOpacity
                              onPress={backToSmart}
                              activeOpacity={0.6}
                            >
                              <Text style={[s.linkText, { color: colors.primary }]}>{t('login.phoneChangeNumber')}</Text>
                            </TouchableOpacity>
                            {/* [2026-06-23] Reenviar SEMPRE tocável: o cronômetro é um
                                setInterval que congela quando o app vai pro background
                                (o user minimiza pra esperar o SMS), então gatear o botão
                                pelo timer prendia o user. O cooldown REAL é no servidor
                                (enforcePhoneOtpSendLimit) — se tocar cedo, ele responde
                                "aguarde Xs". O contador vira só uma dica entre parênteses. */}
                            <TouchableOpacity onPress={() => handlePhoneSendOtp('sms')} disabled={phoneSending} activeOpacity={0.6}>
                              <Text style={[s.linkText, { color: colors.primary }]}>
                                {t('login.phoneResend')}{phoneResendTimer > 0 ? ` (${phoneResendTimer}s)` : ''}
                              </Text>
                            </TouchableOpacity>
                          </View>

                          {/* [2026-10-07 login-ux] WhatsApp option: our verify_send
                              delivers the SAME code by WhatsApp (+ SMS in BR). Hidden
                              when the last send already went through WhatsApp. */}
                          {!otpWentViaWhatsapp && (
                            <TouchableOpacity
                              onPress={() => handlePhoneSendOtp('backend')}
                              disabled={phoneSending}
                              activeOpacity={0.7}
                              accessibilityRole="button"
                              style={{
                                alignSelf: 'center', marginTop: 20,
                                flexDirection: 'row', alignItems: 'center', gap: 8,
                                paddingVertical: 11, paddingHorizontal: 18, minHeight: 44,
                                borderRadius: 999, borderWidth: 1, borderColor: colors.border,
                                opacity: phoneSending ? 0.5 : 1,
                              }}
                            >
                              <IconMessageCircle size={16} color={colors.text} />
                              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{t('login.otpViaWhatsapp')}</Text>
                            </TouchableOpacity>
                          )}

                          {/* Fallback por ligação REMOVIDO (2026-06-26): o SMS agora vai
                              pelo Firebase (Google), que entrega bem no BR — não precisa
                              mais oferecer "receber por chamada" no login. */}
    </View>
  );

  const smartTabActive = loginMode !== 'qr';

  return (
    <View style={[s.root, { backgroundColor: colors.authBg }]}>

      {/* Desktop only: faint grid behind the card (static — the drifting orbs
          and purple wash were removed with the hero loops). */}
      {isDesktop && <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
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
      </View>}

      {/* Cancel button for add_account mode */}
      {isAddAccount && (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: insets.top + 12, left: 16, zIndex: 10 }}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('account.cancel')}
        >
          {/* [2026-10-07 login-ux] was s.topBtn (fixed 44pt width) → "Cancelar" overflowed. */}
          <View style={{ height: 44, paddingHorizontal: 14, borderRadius: 22, justifyContent: 'center', backgroundColor: colors.surfaceVariant }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('account.cancel')}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Language selector + Theme toggle — top right */}
      <View style={[s.topRightRow, { top: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => setShowLangModal(true)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Change language">
          <View style={[s.langBtn, { backgroundColor: 'transparent' }]}>
            <IconGlobe size={14} color={colors.textSecondary} />
            <Text style={[s.langBtnText, { color: colors.text }]}>{langShort}</Text>
            <View style={{ marginLeft: -1 }}>
              <IconChevronDown size={12} color={colors.textSecondary} />
            </View>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={toggle} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={isDark ? t('a11y.switchToLight') : t('a11y.switchToDark')}>
          <View style={[s.topBtn, { backgroundColor: 'transparent' }]}>
            {isDark ? <IconSun size={16} color={colors.warning} /> : <IconMoon size={16} color={colors.textSecondary} />}
          </View>
        </TouchableOpacity>
      </View>

      <LoginKeyboardScroll
        contentContainerStyle={s.scroll}
        bottomOffset={110}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
          <View style={[s.center, !isDesktop && {
            // Mobile: anchor to the TOP (below the lang/theme row) so the
            // keyboard never pushes the form out of view.
            justifyContent: 'flex-start',
            paddingTop: insets.top + 64,
            paddingBottom: 24 + insets.bottom,
          }]}>
            <View style={[s.cardWrap, isDesktop && { maxWidth: 460 }]}>
              <View style={[s.card, isDesktop ? {
                backgroundColor: colors.authCardBg,
                borderWidth: 1,
                borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17, 17, 17,0.08)',
                borderRadius: 24,
                paddingTop: 40, paddingBottom: 32,
                paddingHorizontal: Platform.OS === 'web' ? 44 : 24,
                ...(Platform.OS === 'web' ? {
                  boxShadow: isDark
                    ? '0 2px 8px rgba(0,0,0,0.30), 0 18px 60px rgba(0,0,0,0.40)'
                    : '0 1px 2px rgba(60,64,67,0.06), 0 6px 20px rgba(17, 17, 17,0.07), 0 24px 64px rgba(60,64,67,0.10)',
                } : {}),
              } : {
                backgroundColor: 'transparent',
                paddingTop: 0, paddingBottom: 8, paddingHorizontal: 8,
              }]}>
                {isDesktop && renderHero(true)}

                {/* Desktop: QR (pair with your phone) | Telefone ou e-mail */}
                {isDesktop && (
                  <View style={{
                    flexDirection: 'row',
                    backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(60,64,67,0.05)',
                    borderRadius: 14, padding: 4, marginBottom: 24, gap: 4,
                  }}>
                    {[
                      { key: 'qr', label: t('login.tabQr'), Icon: IconGlobe },
                      { key: 'smart', label: t('login.tabPhoneEmail'), Icon: IconPhone },
                    ].map(({ key, label, Icon }) => {
                      const active = key === 'qr' ? !smartTabActive : smartTabActive;
                      return (
                        <TouchableOpacity
                          key={key}
                          onPress={() => {
                            hSelection();
                            setError('');
                            if (key === 'qr') { setLoginMode('qr'); setStep(1); }
                            else if (!smartTabActive) { setLoginMode('smart'); setStep(1); }
                          }}
                          activeOpacity={0.7}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: active }}
                          style={{
                            flex: 1, paddingVertical: 11, borderRadius: 10,
                            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                            backgroundColor: active ? colors.surface : 'transparent',
                            ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease, box-shadow 160ms ease', cursor: 'pointer' } : {}),
                            ...(active && Platform.OS === 'web' ? { boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.45)' : '0 1px 4px rgba(60,64,67,0.16)' } : {}),
                          }}
                        >
                          <Icon size={14} color={active ? colors.text : colors.textSecondary} />
                          <Text style={{ fontSize: 13, fontWeight: '700', color: active ? colors.text : colors.textSecondary }}>{label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                <Animated.View style={{
                  opacity: fadeAnim,
                  transform: [{ translateX: slideAnim }, { translateX: shakeAnim }],
                }}>
                  {loginMode === 'qr' && isDesktop ? (
                    (() => {
                      // Framed QR container — rounded card with a subtle border,
                      // generous inner padding, and four brand-purple corner
                      // accents (Telegram/banking-app "scan-here" framing). The
                      // QR image, skeleton, and expired/connected states all
                      // share this single frame so the panel never looks empty.
                      const frameSize = 248;
                      const cornerColor = colors.primary;
                      const cornerLen = 26;
                      const cornerThick = 3;
                      const Corner = ({ pos }) => {
                        const base = { position: 'absolute', width: cornerLen, height: cornerLen };
                        const v = { position: 'absolute', width: cornerThick, height: cornerLen, backgroundColor: cornerColor, borderRadius: cornerThick };
                        const h = { position: 'absolute', width: cornerLen, height: cornerThick, backgroundColor: cornerColor, borderRadius: cornerThick };
                        const map = {
                          tl: { top: -1, left: -1 }, tr: { top: -1, right: -1 },
                          bl: { bottom: -1, left: -1 }, br: { bottom: -1, right: -1 },
                        };
                        const isTop = pos[0] === 't';
                        const isLeft = pos[1] === 'l';
                        return (
                          <View pointerEvents="none" style={[base, map[pos]]}>
                            <View style={[v, isLeft ? { left: 0 } : { right: 0 }, isTop ? { top: 0 } : { bottom: 0 }]} />
                            <View style={[h, isTop ? { top: 0 } : { bottom: 0 }, isLeft ? { left: 0 } : { right: 0 }]} />
                          </View>
                        );
                      };
                      const stepRow = (n, text) => (
                        <View key={n} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                          <View style={{
                            width: 24, height: 24, borderRadius: 12, marginTop: 1,
                            alignItems: 'center', justifyContent: 'center',
                            backgroundColor: colors.primary + (isDark ? '2E' : '1A'),
                          }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>{n}</Text>
                          </View>
                          <Text style={{ flex: 1, fontSize: 14, lineHeight: 21, color: colors.text }}>{text}</Text>
                        </View>
                      );
                      return (
                    <View style={s.qrPanel}>
                      {(qrStatus === 'loading' || qrStatus === 'idle') && (
                        <View style={{
                          width: frameSize, height: frameSize, borderRadius: 20,
                          borderWidth: 1, borderColor: colors.border,
                          backgroundColor: colors.background,
                          alignItems: 'center', justifyContent: 'center', marginBottom: 22,
                        }}>
                          <ActivityIndicator size="large" color={colors.primary} />
                          <Text style={{ marginTop: 14, fontSize: 13, color: colors.textSecondary }}>
                            {t('login.qrLoading') || t('login.loading') || '...'}
                          </Text>
                        </View>
                      )}
                      {qrStatus === 'confirmed' && (
                        <View style={{
                          width: frameSize, height: frameSize, borderRadius: 20,
                          borderWidth: 1, borderColor: colors.primary + (isDark ? '40' : '30'),
                          backgroundColor: colors.primary + (isDark ? '14' : '0D'),
                          alignItems: 'center', justifyContent: 'center', marginBottom: 22, padding: 24,
                        }}>
                          <Text style={[s.qrConnectedText, { color: colors.primary, textAlign: 'center' }]}>
                            {t('login.qrConnected')}
                          </Text>
                          <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 14 }} />
                        </View>
                      )}
                      {(qrStatus === 'pending' || qrStatus === 'expired') && (
                        <>
                          <View style={{
                            width: frameSize, height: frameSize, borderRadius: 20,
                            borderWidth: 1, borderColor: colors.border,
                            backgroundColor: '#ffffff',
                            alignItems: 'center', justifyContent: 'center',
                            marginBottom: 18, padding: 16,
                            ...(Platform.OS === 'web' ? { boxShadow: isDark ? '0 6px 18px rgba(0,0,0,0.35)' : '0 6px 18px rgba(60,64,67,0.08)' } : {}),
                          }}>
                            {/* corner accents */}
                            <Corner pos="tl" /><Corner pos="tr" /><Corner pos="bl" /><Corner pos="br" />
                            {qrStatus === 'pending' && qrToken ? (
                              <Image
                                source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent('chatyy://qr/' + qrToken)}&size=250x250&format=png&margin=8` }}
                                style={{ width: frameSize - 48, height: frameSize - 48 }}
                                resizeMode="contain"
                              />
                            ) : (
                              <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                                <View style={{ marginBottom: 8 }}>
                                  <IconRefresh size={40} color="#9ca3af" />
                                </View>
                                <Text style={{ fontSize: 14, fontWeight: '500', color: '#5f6368' }}>
                                  {t('login.qrExpired')}
                                </Text>
                              </View>
                            )}
                            {qrStatus === 'expired' && (
                              <View style={[s.qrExpiredOverlay, { backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 20 }]}>
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
                            <View style={{
                              flexDirection: 'row', alignItems: 'center', gap: 6,
                              paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
                              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(60,64,67,0.06)',
                              marginBottom: 22,
                            }}>
                              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary }} />
                              <Text style={{ fontSize: 12, fontWeight: '500', color: colors.textSecondary }}>
                                {t('login.qrExpires')} {qrCountdown}s
                              </Text>
                            </View>
                          )}
                          <Text style={{ fontSize: 14, textAlign: 'center', marginBottom: 18, lineHeight: 22, color: colors.textSecondary }}>
                            {t('login.qrSubtitle')}
                          </Text>
                          <View style={{ alignSelf: 'stretch', gap: 14 }}>
                            {stepRow(1, t('login.qrStep1'))}
                            {stepRow(2, t('login.qrStep2'))}
                            {stepRow(3, t('login.qrStep3'))}
                          </View>
                        </>
                      )}
                    </View>
                      );
                    })()
                  ) : loginMode === 'phone' && phoneStep === 'otp' ? (
                    renderOtp()
                  ) : loginMode === 'email' && step === 2 && !!email ? (
                    renderPassword()
                  ) : (
                    renderSmart()
                  )}
                </Animated.View>
              </View>

              {/* Tech-grade keyboard hint pill — Vercel/Linear pattern. Web
                  only because mobile users rarely have a hardware ↵ key,
                  and the pill on a touch keyboard reads as decoration. */}
              {Platform.OS === 'web' && isDesktop && (
                <View style={{ marginTop: 32, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{
                    paddingHorizontal: 8, paddingVertical: 3,
                    borderRadius: 4, borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                  }}>
                    <Text style={{
                      fontFamily: 'Menlo, Consolas, monospace', fontSize: 11,
                      color: colors.textSecondary,
                    }}>
                      {'↵'} Enter
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                    {t('login.keyboardHint') || 'para continuar'}
                  </Text>
                </View>
              )}

              {/* Footer — Help / Privacy / Terms (+ build label, 5-tap reset).
                  [2026-10-07 login-ux] now on mobile too: the phone login had
                  no way to reach Help/Privacy/Terms before signing in. */}
              <View style={s.footer}>
                {/* (intentionally no Scan QR Code on initial login) */}
                <View style={s.footerLinks}>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowHelp(true)} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}>
                    <Text style={[s.footerItem, { color: colors.textSecondary }]}>{t('login.help')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authInputBorder }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowPrivacy(true)} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}>
                    <Text style={[s.footerItem, { color: colors.textSecondary }]}>{t('login.privacy')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authInputBorder }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowTerms(true)} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}>
                    <Text style={[s.footerItem, { color: colors.textSecondary }]}>{t('login.terms')}</Text>
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
                            // Clear the per-account twin for whatever email is
                            // currently bound BEFORE wiping bio_email.
                            try {
                              const lastEmail = await SS.getItemAsync('bio_email').catch(() => null);
                              if (lastEmail) {
                                const { bioTokenKeyFor } = require('../context/BiometricContext');
                                const k = bioTokenKeyFor(lastEmail);
                                if (k) await SS.deleteItemAsync(k).catch(() => {});
                              }
                            } catch {}
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
                  <Text style={{ fontSize: 10, color: colors.textTertiary }}>
                    {buildLabel}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
      </LoginKeyboardScroll>

      <ChangePasswordModal
        visible={forcePwChange}
        forced
        onChanged={() => {
          setForcePwChange(false);
          const go = pendingGoRef.current; pendingGoRef.current = null;
          if (go) go();
        }}
        onClose={() => {}}
      />
      <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />

      {/* Country code picker modal */}
      <Modal visible={showCountryPicker} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.authCardBg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 30 + insets.bottom }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 0.5, borderBottomColor: colors.border }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{t('login.selectCountry') || 'Selecionar pais'}</Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ fontSize: 16, color: colors.primary, fontWeight: '600' }}>OK</Text>
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
              <TextInput
                style={{ backgroundColor: colors.surfaceVariant, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text }}
                placeholder={t('login.searchCountry') || 'Buscar pais...'}
                placeholderTextColor={colors.textTertiary}
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
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: colors.borderLight,
                    backgroundColor: item.code === phoneCountryCode ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,17,0.06)') : 'transparent' }}
                  onPress={() => { hSelection(); setPhoneCountryCode(item.code); setShowCountryPicker(false); setTimeout(() => { try { identifierRef.current?.focus(); } catch {} }, 250); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.code === phoneCountryCode }}
                  activeOpacity={0.6}
                >
                  {/* [2026-10-07 login-ux] ISO badge instead of the flag emoji
                      (founder rule: no emoji in UI; flags also render as letters
                      on Windows web anyway). */}
                  <View style={{ width: 40, height: 28, borderRadius: 8, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: colors.text, letterSpacing: 0.4 }}>{(item.label || '').slice(0, 2)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, color: colors.text, fontWeight: '500' }}>{item.name}</Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{item.label}</Text>
                  </View>
                  {item.code === phoneCountryCode && <IconCheck size={18} color={colors.primary} />}
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
            borderColor: colors.border,
            ...(Platform.OS === 'web' ? {
              boxShadow: isDark
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 4px 24px rgba(0,0,0,0.12)',
            } : {
              shadowColor: colors.shadow, shadowOffset: { width: 0, height: 8 },
              shadowOpacity: isDark ? 0.4 : 0.12, shadowRadius: 24, elevation: 12,
            }),
          }]} onPress={() => {}}>
            <Text style={[s.langModalTitle, { color: colors.text }]}>
              {t('login.footerLanguage')}
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
                  <Text style={[s.langFlag, { fontSize: 11, fontWeight: '800', color: colors.textSecondary }]}>{String(item.code || '').split('-')[0].toUpperCase()}</Text>
                  <Text style={[s.langLabel, { color: colors.text }]}>{item.label}</Text>
                  {language === item.code && (
                    <IconCheck size={16} color={colors.text} />
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
              borderColor: colors.border,
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
                  backgroundColor: colors.surfaceVariant,
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
                  color: qrScanMessage === t('login.qrScanSuccess') ? colors.success : colors.error,
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
                    <ActivityIndicator color={colors.onPrimary || '#fff'} size="small" />
                  ) : (
                    <Text style={[s.primaryBtnText, { color: colors.onPrimary || '#fff' }]}>{t('login.qrScanConfirm')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Restore-from-backup prompt — surfaces on new-device login when
          the user has chat backups in iCloud (iOS) / Google Drive (Android)
          but no local SQLite data yet. See components/RestoreBackupPrompt. */}
      <OwnBackupRestorePrompt
        visible={!!ownRestore}
        candidate={ownRestore}
        onClose={() => { setOwnRestore(null); handleRestorePromptClose(); }}
      />
      <RestoreBackupPrompt
        visible={showRestorePrompt}
        backups={restoreBackups}
        onClose={handleRestorePromptClose}
        onRestored={() => { /* no-op — onClose still fires after the user taps "Pronto" and that handles navigation */ }}
      />

      {/* Full-history download prompt (#1240, 2026-05-20). Fires only when
          no cloud/server CYB2 backup was found AND services/fullHistorySync
          says the local DB is materially shorter than what the server has.
          Tap "Baixar agora" runs forceFullHistoryDownload() with the
          includeAllMedia override; "Mais tarde" persists @chatyy_skip_history
          so we don't pester again. */}
      <RestoreHistoryPrompt
        visible={showHistoryPrompt}
        email={historyPromptEmail}
        onClose={() => {
          setShowHistoryPrompt(false);
          // Persist skip so a future cold-start doesn't pop the modal again.
          // (User can still re-trigger from Settings → Storage.)
          try { AsyncStorage.setItem('@chatyy_skip_history', '1').catch(() => {}); } catch {}
          const pending = pendingNavRef.current;
          pendingNavRef.current = null;
          if (pending?.target) {
            setTimeout(() => {
              if (mountedRef.current) router.replace(pending.target);
            }, 100);
          }
        }}
      />

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
            backgroundColor: colors.primary,
            alignItems: 'center', justifyContent: 'center',
            transform: [{ scale: successAnim }],
            ...Platform.select({
              ios: { shadowColor: '#000', shadowOpacity: isDark ? 0 : 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
              android: { elevation: 14 },
              default: { boxShadow: '0 12px 40px -8px rgba(0,0,0,0.35)' },
            }),
          }}>
            <IconCheck size={64} color={colors.onPrimary || '#fff'} strokeWidth={3.5} />
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
    position: 'absolute', top: Platform.OS === 'ios' ? 54 : androidTopInset(16), right: 16, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  // [2026-10-06 UX] 44pt minimum tap target (Apple HIG / WCAG 2.5.8) — were 36.
  topBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  langBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 44, borderRadius: 22, paddingHorizontal: 12,
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

  /* Typography — bold brand voice, matched 1:1 with the signup flow
     (app/signup-phone.js → title 30/800, -0.8). Login used to run a
     lighter Google-Sans 24/400 which read as a different product next to
     cadastro; unifying the weight/size makes the two flows feel like one
     app. */
  title: {
    fontSize: 28, fontWeight: '800', textAlign: 'center', marginBottom: 8,
    letterSpacing: -0.7, lineHeight: 34,
  },
  subtitle: {
    fontSize: 15, textAlign: 'center', marginBottom: 24, lineHeight: 22,
    letterSpacing: 0.1,
  },

  /* Error */
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 13, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '600' },

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
  userAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  userAvatarLetter: { color: '#fff', fontSize: 13, fontWeight: '700' },
  userEmail: { fontSize: 14, fontWeight: '500', flexShrink: 1 },

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
  forgotLink: { alignSelf: 'flex-start', marginTop: 12, marginBottom: 28, minHeight: 44, justifyContent: 'center' },
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
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', minWidth: 110,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  loadingBtnContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },

  /* IG-style input — flat 50pt rounded, label-as-placeholder. Border color
     toggles via state (RN can't smoothly animate border color natively, so
     simple swap is the canonical choice). */
  igInput: {
    height: 54, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16,
    fontSize: 15, fontWeight: '400',
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'box-shadow 140ms ease, border-color 140ms ease' }, default: {} }),
  },
  igEyeBtn: {
    position: 'absolute', right: 6, top: 0, bottom: 0,
    justifyContent: 'center', padding: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },

  /* IG-style primary CTA — full width, 46pt, 10pt radius, branded purple
     shadow for premium presence. semibold 14pt label. */
  igPrimaryBtn: {
    width: '100%', height: 52, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 10,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        boxShadow: '0 8px 22px rgba(17, 17, 17,0.35), 0 2px 6px rgba(17, 17, 17,0.20)',
        transition: 'transform 140ms ease, box-shadow 140ms ease',
      },
      ios: { shadowColor: '#111111', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 14 },
      android: { elevation: 6 },
    }),
  },
  igPrimaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  /* Ghost text-link below the primary CTA. */
  igGhostBtn: {
    width: '100%', alignItems: 'center', justifyContent: 'center',
    marginTop: 12, paddingVertical: 6, minHeight: 44,
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
    alignItems: 'center', paddingTop: 28, paddingBottom: 12,
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
    marginTop: 16, paddingVertical: 14, paddingHorizontal: 20,
    borderRadius: 14, borderWidth: 1, gap: 10,
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
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>
          {t('login.qrScanTitle')}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center', marginBottom: 20 }}>
          {t('login.qrScanDesc')}
        </Text>
        <TextInput
          style={{
            borderWidth: 1, borderColor: colors.border, borderRadius: 12,
            padding: 14, fontSize: 14, color: colors.text,
            backgroundColor: colors.surfaceVariant,
            marginBottom: 12, minHeight: 80, textAlignVertical: 'top',
          }}
          value={qrScanToken}
          onChangeText={setQrScanToken}
          placeholder={t('login.qrScanPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {!!qrScanMessage && (
          <Text style={{ color: qrScanMessage.includes('uccess') || qrScanMessage.includes('ucesso') ? colors.success : colors.error, fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
            {qrScanMessage}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
          <TouchableOpacity
            onPress={() => setShowManual(false)}
            style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: colors.surfaceVariant }}
          >
            <Text style={{ color: colors.primary, fontWeight: '600' }}>{t('login.back')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: colors.primary, opacity: qrScanLoading ? 0.65 : 1 }}
            onPress={onManualConfirm}
            disabled={qrScanLoading}
          >
            {qrScanLoading ? (
              <ActivityIndicator color={colors.onPrimary || '#fff'} size="small" />
            ) : (
              <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '600' }}>{t('login.qrScanConfirm')}</Text>
            )}
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 16, alignSelf: 'center', padding: 8 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{t('common.cancel')}</Text>
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
          style={{ marginTop: 24, padding: 14, backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 32 }}
        >
          <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '600' }}>{t('login.qrManualEntry') || 'Enter code manually'}</Text>
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
          style={{ marginTop: 24, padding: 14, backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 32 }}
        >
          <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '600' }}>{t('login.qrManualEntry') || 'Enter code manually'}</Text>
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
