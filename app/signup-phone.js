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

import { androidBottomInset, androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  Animated, Platform, ScrollView, Dimensions, Modal,
  Image, ActionSheetIOS, Easing, Pressable, useWindowDimensions, BackHandler, Keyboard,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { HapticsCompat as Haptics } from '../services/haptics'; // [2026-10-11] same API, routed via the shared haptics shim
import * as Localization from 'expo-localization';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Circle as SvgCircle, Line } from 'react-native-svg';
import { useAuthTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { firebasePhoneAvailable, fbSendCode, fbConfirm, fbSignOut } from '../services/firebasePhone';
import { useSmsOtpAutofill, requestPhoneHint } from '../services/smsOtp'; // [2026-10-08 android-otp-shortcuts] [2026-10-15 phone-hint]
import { useOtpAutofillAssist, primeWhatsAppOtp } from '../services/otpAutofill'; // [2026-10-18 otp-autofill]
import OtpAssist from '../components/OtpAssist';
import useDebouncedCallback from '../hooks/useDebouncedCallback';
import useIsMounted from '../hooks/useIsMounted';
import { COUNTRIES, formatPhone, toE164, E164_RE, countryDisplayName } from '../constants/countries'; // [2026-10-06 UX2] countryDisplayName
import { IconArrowLeft, IconArrowRight, IconCheck, IconCheckCircle, IconUser, IconImage, IconAtSign, IconAlertTriangle, IconPhone, IconShield, IconSparkles, IconZap, IconCamera, IconChevronRight, IconLock, IconEye, IconEyeOff, IconX, IconMessageCircle, IconSmartphone, IconUsers } from '../components/Icons';
import SignupIntro from '../components/SignupIntro';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RestoreBackupPrompt from '../components/RestoreBackupPrompt';
import { VOICE_OTP_ENABLED } from '../constants/featureFlags';
import { markFreshSignup } from '../services/firstRun'; // [2026-10-11 funnel-qa]
import NativeOnboardingGate from '../components/nativeOnboarding/NativeOnboardingGate'; // [2026-10-15 native-onboarding]
import { isNativeOnboardingOn } from '../components/nativeOnboarding/flag';
// [2026-10-18 onboarding-native-picker] seletor de país ÚNICO (lista nativa na folha) quando ligado.
import CountryPicker, { onboardingNativePickerOn } from '../components/nativeOnboarding/CountryPicker';
// [2026-10-07 signup-ux] keyboard-controller aware container (falls back to RN
// KeyboardAvoidingView when KC native is absent / on web), draft resume,
// smarter phone/handle/password helpers.
import { ThreadKeyboardAvoider } from '../utils/threadKeyboard';
import SignupPasswordMeter from '../components/signup/SignupPasswordMeter';
import { SignupConsentBlock } from '../components/consent/ConsentOptions'; // [2026-10-13 consent-lgpd]
import LoginPinResetSheet, { ForgotLoginPinLink } from '../components/settings/LoginPinResetSheet';
import {
  loadSignupDraft, saveSignupDraft, clearSignupDraft, parsePhoneInput,
  usernameCandidates, usernameLocalError, sanitizeUsernameTyping, friendlyServerError,
} from '../components/signup/signupSmarts';

const { width: SCREEN_W } = Dimensions.get('window');
// Wide-screen breakpoint — tablet / desktop web. At >=768 we lay the handle
// step's username + password rows side-by-side to halve vertical scroll.
// Updates reactively via the useWindowDimensions hook below.

// Trimmed welcome carousel — Instagram-style, just 2 slides (first + last).
// IG signup has zero intro carousel; we keep just enough to convey brand +
// the headline value prop without burning 3 taps on filler.
// [2026-10-15 native-onboarding] Fluxo novo (components/nativeOnboarding) com
// kill switch globalThis.__chatyy_native_onboarding; desligado / binário antigo /
// crash de render → este fluxo legado, idêntico ao de antes.
export default function SignupPhone() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [nativeOn] = useState(() => isNativeOnboardingOn());
  if (!nativeOn) return <SignupPhoneLegacy />;
  return (
    <NativeOnboardingGate
      entry="phone"
      params={params || {}}
      onExitToLogin={() => {
        try {
          if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
          else router.replace('/login');
        } catch { try { router.replace('/login'); } catch {} }
      }}
      fallback={() => <SignupPhoneLegacy />}
    />
  );
}

function SignupPhoneLegacy() {
  const router = useRouter();
  // Login forwards an unknown phone to /signup-phone?phone=...&country=...
  // so user goes straight from "this number isn't on Chatyy" to creating an
  // account with the same digits already typed (no double-entry friction).
  const params = useLocalSearchParams();
  const { colors, isDark } = useAuthTheme();
  const { t, language } = useLanguage(); // [2026-10-06 UX2] language → nome do país localizado
  const { loginWithToken } = useAuth();
  // Reactive window width for the responsive handle-step layout.
  const { width: _winW } = useWindowDimensions();
  // [2026-10-07 signup-ux] the form now lives in a centered 520pt column on
  // tablet/web, so the old side-by-side @handle|password layout is retired.
  const isWide = false;
  // [2026-10-12 auth-polish] Desktop/tablet web: the flow sits in a centered
  // card on the auth background (same as /login) instead of a full-height
  // column with the CTA stranded ~400px below the field.
  const _wideWeb = Platform.OS === 'web' && _winW >= 768;

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
  //   4. [2026-10-06 UX] the intro carousel was already dismissed on this
  //      device (`chatyy_intro_seen`, written by /login's SignupIntro) →
  //      start at the phone input. Before, tapping "Criar conta" on /login
  //      replayed the whole 5-slide carousel the user had just skipped.
  //      Web reads localStorage synchronously (no flash); native falls back
  //      to the async check below.
  const _introSeenSync = (() => {
    try {
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') return !!localStorage.getItem('chatyy_intro_seen');
    } catch {}
    return false;
  })();
  const _initialStep = (params?.step === 'name' && params?.verify_token)
    ? 'name'
    : (params?.fromLogin === '1' || params?.phone || _introSeenSync)
      ? 'phone'
      : 'welcome';
  const [step, setStep] = useState(_initialStep);
  useEffect(() => {
    if (_initialStep !== 'welcome' || Platform.OS === 'web') return;
    let cancelled = false;
    AsyncStorage.getItem('chatyy_intro_seen').then((seen) => {
      if (!cancelled && seen) setStep((cur) => (cur === 'welcome' ? 'phone' : cur));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    const iso = String(params?.country || '').toUpperCase();
    const dial = (COUNTRIES.find(c => c.code === iso)?.dial || '').replace('+', '');
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
  const codeRef = useRef(''); codeRef.current = code; // [2026-10-07 signup-ux] fresh value for checkOtp
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
  // [otp-wa 2026-10-18] contagem pelo relógio (prazo absoluto) — o setTimeout congela
  // com o app em segundo plano enquanto o usuário vai ler o SMS/WhatsApp.
  const [resendCountdown, _setResendCountdown] = useState(0);
  const resendDeadlineRef = useRef(0);
  const setResendCountdown = useCallback((n) => {
    const s = Math.max(0, Math.round(Number(n) || 0));
    resendDeadlineRef.current = s > 0 ? Date.now() + s * 1000 : 0;
    _setResendCountdown(s);
  }, []);
  // [otp-wa 2026-10-18] número sem WhatsApp (servidor) → esconde "Receber pelo WhatsApp".
  const [waUnavailable, setWaUnavailable] = useState(false);
  // Canal pelo qual o último código saiu ('sms' | 'voice'). [2026-06-19] WhatsApp
  // REMOVIDO do cadastro a pedido do founder — só SMS (Twilio) + ligação (Vonage).
  const [sentVia, setSentVia] = useState('sms');
  // [2026-10-11 funnel-qa] Where the last code ACTUALLY went (verify_send
  // reports whatsapp_sent / sms_sent). The OTP card used to always say
  // "WhatsApp e SMS" — wrong for intl numbers (WhatsApp OR SMS) and for the
  // existing-account path (phone_login_request = SMS only).
  const [otpChannels, setOtpChannels] = useState({ wa: true, sms: true });
  const [otpProvider, setOtpProvider] = useState(null); // [2026-10-18 otp-autofill] twilio|baileys|local
  // Registration-lock (anti-SIM-swap) PIN state. lockRequired flips true when
  // server returns requires_lock=true after a successful OTP verify; the OTP
  // step then renders an extra PIN input below the OTP boxes. lockPin holds
  // the entered 4-6 digits.
  const [lockRequired, setLockRequired] = useState(false);
  // [wave14a 2026-10-16] "Esqueci meu PIN" pré-login (desafio do requires_lock).
  const [lockChallenge, setLockChallenge] = useState('');
  const [lockHasEmail, setLockHasEmail] = useState(undefined);
  const [pinResetOpen, setPinResetOpen] = useState(false);
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
  // [2026-10-13 consent-lgpd] Conta NOVA: a etapa final mostra as 2 opções
  // opcionais (desmarcadas) e só sai com "Começar" — sem auto-redirect.
  const [consentHold, setConsentHold] = useState(false);
  const [restoreBackups, setRestoreBackups] = useState([]);
  const _postSignupNavRef = useRef(null); // { target: '/chat' } deferred until prompt closes
  // Avatar source picker — Instagram/WhatsApp pattern. iOS uses native
  // ActionSheetIOS; Android/Web uses a custom Modal with the same options.
  const [avatarSheetOpen, setAvatarSheetOpen] = useState(false);
  // "No account found" banner — shown when login.js redirects here after a
  // failed phone lookup. Auto-dismisses on first interaction (typing or tap)
  // so the UI doesn't feel sticky. params.fromLogin === '1' is the trigger.
  const [showFromLoginBanner, setShowFromLoginBanner] = useState(() => params?.fromLogin === '1');

  // [2026-10-07 signup-ux] Resume where the user left off. If the app was
  // closed mid-signup we restore country/phone/name/@handle/photo from a local
  // draft (NO secrets: never the OTP, the password or the verify_token — the
  // number is simply re-confirmed by SMS, then name/@ come back pre-filled).
  // Skipped when /login handed us a phone or a verify_token (that wins).
  const [resumedDraft, setResumedDraft] = useState(false);
  const _draftReadyRef = useRef(false);
  const _reachedRef = useRef('phone');
  useEffect(() => {
    if (params?.verify_token || params?.phone) { _draftReadyRef.current = true; return; }
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
        if (d.reached) _reachedRef.current = d.reached;
        setResumedDraft(true);
        setStep((cur) => (cur === 'welcome' ? 'phone' : cur));
      }
      _draftReadyRef.current = true;
    }).catch(() => { _draftReadyRef.current = true; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const _startOver = () => {
    clearSignupDraft();
    setResumedDraft(false);
    setPhone(''); setFirstName(''); setLastName(''); setUsername(''); setAvatarUri(null);
    _reachedRef.current = 'phone';
    try { Haptics.selectionAsync(); } catch {}
  };

  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const resendTimerRef = useRef(null);
  // Hero: scale-pop on entrance + soft breathing halo + icon crossfade on
  // step change. The breathing loop runs at 4s per cycle and only on the
  // outer halo so the brand orb itself stays still — keeps the screen calm
  // but signals the app is alive. Mirrors iMessage's tinted CallKit avatar.
  const heroScale = useRef(new Animated.Value(0.6)).current;
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
  // [2026-10-07 signup-ux] breathing halo loop removed together with the 200px
  // orb hero (B&W premium: compact ink tile + big left-aligned title). Saves a
  // permanent 4s animation loop on every signup step.
  // Focus tracking for the stacked-input hairline-active treatment (login parity).
  const [focused, setFocused] = useState('');
  // OTP per-box refs so paste/backspace can advance focus.
  const otpRefs = useRef([]);
  const lastNameRef = useRef(null);
  const passwordRef = useRef(null); // [2026-10-07 signup-ux] "next" on @handle → password; "next" on first name → last name
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
  // Phone-valid check pop — same spring, fires when the typed number reaches a
  // plausible length for the selected country (WhatsApp parity: a green check
  // confirms "this looks like a real number" before the user even submits).
  const phoneCheckScale = useRef(new Animated.Value(0)).current;
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
  // Firebase Phone Auth (2026-06-18) — same pattern as login.js. See
  // services/firebasePhone.js. Falls back to backend OTP on any failure.
  const fbConfirmRef = useRef(null);
  const fbIdTokenRef = useRef(null);
  const phoneViaFirebaseRef = useRef(false);

  // Build E.164 from country dial + digits (PhoneInput holds digits only).
  const fullPhone = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    return toE164(c.dial, phone);
  }, [countryCode, phone]);

  // Live phone validity — true once the digits reach a plausible length for
  // the selected country AND the composed E.164 passes the format regex. Drives
  // the inline green check + success-tinted hairline on the phone step so the
  // user gets positive feedback the moment the number looks complete. Purely
  // presentational — the CTA's own disabled gate (>= 8 digits) is unchanged.
  const phoneValid = useMemo(() => {
    const c = COUNTRIES.find(x => x.code === countryCode) || COUNTRIES[0];
    const digits = phone.replace(/\D/g, '');
    const min = Math.max(8, (c.maxDigits || 11) - 1);
    return digits.length >= min && E164_RE.test(fullPhone);
  }, [countryCode, phone, fullPhone]);

  // Pop the phone-valid check when validity flips to true; reset otherwise so
  // the next valid transition re-triggers a fresh spring.
  useEffect(() => {
    try {
      if (phoneValid) {
        phoneCheckScale.setValue(0);
        Animated.spring(phoneCheckScale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start();
      } else {
        phoneCheckScale.setValue(0);
      }
    } catch { /* native driver may be unavailable on web in some states */ }
  }, [phoneValid, phoneCheckScale]);

  // Auto-suggest handle from name when entering the handle step. Runs on
  // back-navigate too (vs goName one-shot below). Slug rule: lowercase, strip
  // diacritics, drop chars outside [a-z0-9._], cap at 20.
  // [2026-10-07 signup-ux] smarter slug: "João Silva" → joao.silva (then
  // joaosilva, joao_silva, … as chips if taken). `_usernameAutoRef` = the
  // current handle was suggested by us (not typed), so editing the name and
  // coming back re-suggests instead of keeping a stale handle.
  const _usernameAutoRef = useRef(false);
  const _nameCandidates = useMemo(() => usernameCandidates(firstName, lastName), [firstName, lastName]);
  useEffect(() => {
    if (step === 'handle' && !username && _nameCandidates[0]) {
      _usernameAutoRef.current = true;
      setUsername(_nameCandidates[0]);
    }
  }, [step, username, _nameCandidates]);

  // Resend countdown ticker (60s after each verify_send).
  useEffect(() => {
    if (resendCountdown <= 0) return;
    resendTimerRef.current = setTimeout(() => {
      const dl = resendDeadlineRef.current;
      _setResendCountdown(c => (dl > 0 ? Math.max(0, Math.ceil((dl - Date.now()) / 1000)) : Math.max(0, c - 1)));
    }, 1000);
    return () => clearTimeout(resendTimerRef.current);
  }, [resendCountdown]);

  // [2026-10-07 signup-ux] Persist the non-secret draft (debounced) so a
  // killed app resumes here. `reached` remembers the furthest step.
  useEffect(() => {
    if (!_draftReadyRef.current) return;
    if (step === 'welcome' || step === 'done') return;
    const order = ['phone', 'otp', 'name', 'handle'];
    if (order.indexOf(step) > order.indexOf(_reachedRef.current)) _reachedRef.current = step;
    const id = setTimeout(() => {
      saveSignupDraft({ countryCode, phone, firstName, lastName, username, avatarUri, reached: _reachedRef.current });
    }, 500);
    return () => clearTimeout(id);
  }, [step, countryCode, phone, firstName, lastName, username, avatarUri]);

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
  const _maybePromptRestoreThenGoChat = (opts = {}) => {
    // [2026-10-13 consent-lgpd] hold = conta nova: fica na etapa final (opções de
    // consentimento + "Começar"); fechar o prompt de backup também não navega.
    const _hold = !!opts.hold;
    _postSignupNavRef.current = _hold ? null : { target: '/chat' };
    const _navNow = () => {
      if (_hold) return;
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
  // [2026-10-07 signup-ux] Friendly, translated error text for a failed API
  // response (backend messages are hard-coded pt-BR). See signupSmarts.
  const _errText = (r, fallbackKey) => {
    const f = friendlyServerError(r, fallbackKey);
    return f.text || t(f.key);
  };
  const sendOtp = async (channel = 'sms') => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8 || !E164_RE.test(fullPhone)) { setError(t('login.phoneInvalid') || 'Número inválido'); return; }
    setError(''); setBusy(true);
    if (step !== 'otp') setWaUnavailable(false); // [otp-wa 2026-10-18] número novo → reavalia
    try {
      // 1. Check if account exists (no SMS sent — cheap PG/Maildir lookup).
      //    If it does AND user wasn't routed here from login, surface the
      //    "you already have an account" UX before burning an SMS — the
      //    user clearly arrived at signup by mistake.
      //    fromLogin=1 means they came from login already knowing the
      //    account is missing, so skip this guard.
      if (accountExists === null && step !== 'otp') {
        try {
          primeWhatsAppOtp(); // [2026-10-18 otp-autofill] login_request já envia o código (conta existe)
          const lr = await api.phoneLoginRequest(fullPhone);
          if (mountedRef.current) {
            const exists = !!(lr?.data?.exists);
            setAccountExists(exists);
            // Only auto-redirect when user came to signup directly (not from
            // login). If they're in fromLogin=1 we trust the original
            // routing — but a fresh exists:true is still surfaced via the
            // banner below.
            if (exists && lr?.data?.delivered === false) {
              // [otp-wa 2026-10-18] Conta existe mas NENHUM canal entregou: antes ia
              // para a tela do código esperando algo que nunca chegaria. Fica aqui com
              // o erro do servidor e o tempo real para tentar de novo.
              const _ra = Math.min(3600, Math.max(0, Number(lr?.data?.retry_after || 0)));
              if (_ra > 0) setResendCountdown(_ra);
              setError(lr?.message || t('signupPhone.sendError'));
              setAccountExists(null);
              setBusy(false);
              return;
            }
            if (exists) {
              if (lr?.data?.whatsapp_available === false) setWaUnavailable(true);
              // [2026-10-11 funnel-qa] phone_login_request ALREADY texted the
              // code for an existing account (and armed the 60s per-number
              // cooldown). Bouncing to /login made the user tap "Enviar
              // código" again → 429 "Aguarde 60s" on the very first try, and
              // the SMS they already had was for a screen they had left.
              // WhatsApp parity: same number → same code screen → you're in
              // (checkOtp logs existing accounts in via the token branch).
              // [otp-global 2026-10-15] login_request agora diz o canal real (WhatsApp ou SMS).
              setOtpChannels({ wa: !!lr?.data?.whatsapp_sent, sms: !lr?.data?.whatsapp_sent && lr?.data?.sms_sent !== false });
              setOtpProvider(lr?.data?.provider || null);
              setSentVia('sms');
              setResendCountdown(60);
              setCode('');
              setBusy(false);
              goStep('otp');
              return;
            }
          }
        } catch { /* fall through — assume new */ }
      }
      // 2. Send the actual OTP. Firebase (Google SMS) only for the SMS channel —
      // WhatsApp/voice channels stay on the backend. Falls back to backend SMS
      // if Firebase is unavailable or errors.
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
        // [2026-06-19] Só SMS ou voz no cadastro (WhatsApp removido).
        if (channel === 'voice') setSentVia('voice');
        else setSentVia('sms');
        const _wa = r?.data?.whatsapp_sent; const _sms = r?.data?.sms_sent;
        setOtpChannels((_wa === undefined && _sms === undefined) ? { wa: true, sms: true } : { wa: !!_wa, sms: !!_sms });
        if (r?.data?.whatsapp_available === false) setWaUnavailable(true);
        if (step !== 'otp') goStep('otp');
        setCode('');
      } else {
        // [2026-10-11 funnel-qa] "Aguarde 42s…" → drive the resend timer from
        // the server's cooldown instead of a dead "Reenviar" button.
        const _f = friendlyServerError(r, 'signupPhone.sendError');
        if (_f.seconds) { setResendCountdown(_f.seconds); setError(t('otp.waitSeconds', { s: _f.seconds })); }
        else setError(_f.text || t(_f.key));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally { if (mountedRef.current) setBusy(false); }
  };

  // [2026-10-07 signup-ux] `codeArg` — auto-submit fires from onChangeText via
  // setTimeout, where `code` is still the PREVIOUS render's 5-digit value
  // (stale closure), so the old `code.length !== 6` guard silently returned
  // and auto-submit never worked for typed codes. The fresh digits are now
  // passed in; `_otpInFlightRef` blocks a double submit (auto + CTA tap).
  const _otpInFlightRef = useRef(false);
  // [wave14a] PIN desligado pelo código do e-mail → mesmo fim do login com token.
  const onPinResetLoggedIn = async (d) => {
    if (phoneViaFirebaseRef.current) { fbSignOut(); }
    // [2026-10-21] loginWithToken devolve {success:false} sem lançar.
    let lr = null;
    try { lr = await loginWithToken(d.token, d.email); } catch { lr = null; }
    if (!mountedRef.current) return;
    if (!lr?.success) { setPinResetOpen(false); setError(t('login.errorConnection')); return; }
    setPinResetOpen(false); setLockRequired(false); setLockPin(''); setLockChallenge('');
    clearSignupDraft();
    goStep('done');
    _maybePromptRestoreThenGoChat();
  };

  const checkOtp = async (codeArg) => {
    const code = typeof codeArg === 'string' ? codeArg : codeRef.current;
    if (code.length !== 6) return;
    if (_otpInFlightRef.current) return;
    _otpInFlightRef.current = true;
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
      let r;
      if (phoneViaFirebaseRef.current) {
        // Firebase path: confirm the code once → ID token; reuse it for the
        // PIN re-call (the SMS code is one-time, already consumed).
        if (!fbIdTokenRef.current) {
          const c = await fbConfirm(fbConfirmRef.current, code);
          if (!mountedRef.current) return;
          if (!c.ok) {
            setError(t('signupPhone.otpInvalid') || 'Código incorreto');
            setCode('');
            triggerOtpError();
            setBusy(false);
            return;
          }
          fbIdTokenRef.current = c.idToken;
        }
        r = await api.phoneLoginFirebase(fbIdTokenRef.current, _pin);
      } else {
        r = await api.phoneLoginVerifyWithPin(fullPhone, code, _pin);
      }
      if (!mountedRef.current) return;
      if (r?.data?.requires_lock && r.data.lock_challenge) { setLockChallenge(String(r.data.lock_challenge)); setLockHasEmail(r.data.has_recovery_email); }
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
        if (phoneViaFirebaseRef.current) { fbSignOut(); }
        // Existing account — log in, then probe iCloud / Drive for an
        // existing backup tied to this phone (reinstall scenario). On
        // any probe error or web platform we just navigate immediately.
        // [2026-10-21] não dizer "Tudo pronto" sem sessão: o retorno era ignorado.
        let lr = null;
        try { lr = await loginWithToken(r.data.token, r.data.email); } catch { lr = null; }
        if (!mountedRef.current) return;
        if (!lr?.success) {
          setError(t('login.errorConnection'));
          setBusy(false);
          return;
        }
        try { require('../services/nativeTelemetry').markAuthDone('login'); } catch {} // [otp-wa 2026-10-18]
        clearSignupDraft(); // [2026-10-07 signup-ux]
        goStep('done');
        _maybePromptRestoreThenGoChat();
      } else if (r?.success && r.data?.exists === false && r.data?.verify_token) {
        // New account — proceed to signup steps.
        setVerifyToken(r.data.verify_token);
        goStep('name');
      } else {
        const _f = friendlyServerError(r, 'signupPhone.otpInvalid');
        // [2026-10-11 funnel-qa] A network blip used to read "Código
        // incorreto" (and wiped a correct code). Now: network → keep the
        // digits so one tap on Continuar retries; expired / too many tries →
        // say so and unlock "Reenviar" right away; wrong → clear + shake.
        if (_f.kind === 'network') {
          setError(t('login.errorConnection'));
        } else if (_f.kind === 'otp_expired' || _f.kind === 'otp_locked') {
          setError(t(_f.key));
          setCode('');
          setResendCountdown(0);
          triggerOtpError();
        } else {
          setError(_f.kind === 'rate' ? t(_f.key, { s: _f.seconds }) : (t('signupPhone.otpInvalid') || 'Código incorreto'));
          setCode('');
          triggerOtpError();
        }
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection') || 'Erro de conexão');
    } finally {
      _otpInFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  // [2026-10-08 android-otp-shortcuts] Android SMS User Consent → fill + auto-submit
  // (latest checkOtp via ref; checkOtp itself is in-flight guarded).
  const checkOtpRef = useRef(null);
  checkOtpRef.current = checkOtp;
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
  // [2026-10-15 native-otp] Teclado numérico já aberto no passo do código
  // (autoFocus se perde quando o input monta durante a transição de passo).
  // Kill switch: globalThis.__chatyy_native_otp = false.
  useEffect(() => {
    if (Platform.OS === 'web' || globalThis.__chatyy_native_otp === false || step !== 'otp') return undefined;
    const tms = [320, 700].map((ms) => setTimeout(() => {
      try { const r = otpRefs.current?.[0]; if (r && !(r.isFocused && r.isFocused())) r.focus(); } catch {}
    }, ms));
    return () => tms.forEach(clearTimeout);
  }, [step]);
  // [2026-10-15 phone-hint] Android: seletor nativo do Google com o numero do chip
  // (Phone Number Hint API) — 1 vez por tela, so com o campo vazio. Escolheu ->
  // preenche pais + numero pelo MESMO parsePhoneInput do campo. Binario antigo = no-op.
  const phoneHintAskedRef = useRef(false);
  const phoneHintStateRef = useRef({ phone, countryCode });
  phoneHintStateRef.current = { phone, countryCode };
  useEffect(() => {
    if (Platform.OS !== 'android' || step !== 'phone' || phoneHintAskedRef.current) return undefined;
    if (phoneHintStateRef.current.phone) return undefined;
    phoneHintAskedRef.current = true;
    let off = false;
    const tm = setTimeout(async () => {
      if (phoneHintStateRef.current.phone) return; // rascunho restaurado / ja digitou
      const num = await requestPhoneHint();
      if (off || !num || !mountedRef.current) return;
      const cur = phoneHintStateRef.current;
      if (cur.phone) return; // ja digitou enquanto a folha estava aberta
      const parsed = parsePhoneInput(num, cur.countryCode, COUNTRIES);
      if (parsed.countryCode !== cur.countryCode) setCountryCode(parsed.countryCode);
      setPhone(parsed.digits);
      try { Haptics.selectionAsync(); } catch {}
    }, 400);
    return () => { off = true; clearTimeout(tm); };
  }, [step]);

  const goName = () => {
    const fn = (firstName || '').trim();
    // Telegram requires at least a first name; last name is optional.
    if (fn.length < 2) { setError(t('signupPhone.nameTooShort') || 'Nome muito curto'); return; }
    setError('');
    // Suggest a default handle from the joined name (lowercase, no spaces, no accents).
    // The useEffect above also fills it on back-navigate; this keeps the forward
    // path one-shot so the handle step lands pre-filled on first entry too.
    const handle = _nameCandidates[0] || '';
    if (handle && (!username || _usernameAutoRef.current)) { _usernameAutoRef.current = true; setUsername(handle); }
    goStep('handle');
  };

  // Live username availability check (debounced 600ms — matches Instagram's
  // username field cadence, less spammy than 400ms).
  // [2026-10-07 signup-ux] Local rules first (no request for "jo" / "a..b" /
  // "joao."), then the server. Responses for a handle the user has already
  // typed past are dropped (out-of-order guard). A 429 / network blip leaves
  // the state "unknown" (null) instead of falsely saying "taken".
  // usernameReason: null | 'taken' | 'reserved' | 'short' | 'long' | 'chars' | 'edges' | 'double'
  const [usernameReason, setUsernameReason] = useState(null);
  const _usernameLatestRef = useRef('');
  const runUsernameCheck = useDebouncedCallback(async (uname) => {
    try {
      const r = await api.checkUsername(uname, 'chatyy.com.br');
      if (!mountedRef.current || _usernameLatestRef.current !== uname) return;
      const status = Number(r?.__httpStatus || 0);
      if (r?.success) {
        const ok = r.data?.available !== false;
        setUsernameAvailable(ok);
        setUsernameReason(ok ? null : 'taken');
        const sugg = Array.isArray(r.data?.suggestions) ? r.data.suggestions.filter(x => typeof x === 'string' && !usernameLocalError(x)) : [];
        setUsernameSuggestions(ok ? [] : (sugg.length ? sugg : _nameCandidates.filter(c => c !== uname)));
      } else if (status === 429 || !r) {
        setUsernameAvailable(null); setUsernameReason(null);
      } else {
        setUsernameAvailable(false); setUsernameReason('chars');
        setUsernameSuggestions(_nameCandidates.filter(c => c !== uname));
      }
    } catch {
      if (_usernameLatestRef.current === uname) { setUsernameAvailable(null); setUsernameReason(null); }
    } finally { if (mountedRef.current && _usernameLatestRef.current === uname) setUsernameChecking(false); }
  }, 450);

  useEffect(() => {
    _usernameLatestRef.current = username;
    if (step !== 'handle' || !username) {
      setUsernameAvailable(null); setUsernameReason(null);
      setUsernameSuggestions([]);
      setUsernameChecking(false);
      return;
    }
    const localErr = usernameLocalError(username);
    if (localErr) {
      // "short" while still typing is not an error worth shouting about.
      setUsernameAvailable(localErr === 'short' ? null : false);
      setUsernameReason(localErr);
      setUsernameSuggestions([]);
      setUsernameChecking(false);
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
    if (!username || usernameAvailable === false || usernameLocalError(username)) return;
    // [2026-10-11 funnel-qa] Password is OPTIONAL (WhatsApp has none): the
    // number is the login; phone_signup generates + stores a server password
    // when none is sent. A typed one still needs 8+ chars.
    if (password.length > 0 && password.length < 8) { setError(t('signupPhone.err.passwordShort')); return; }
    setError(''); setBusy(true);
    try {
      let _ref = ''; try { _ref = await require('../services/pendingReferral').getPendingRef(); } catch {} // [bia-convite 2026-10-19]
      const r = await api.phoneSignup({ verify_token: verifyToken, username, name, domain: 'chatyy.com.br', password, ref: _ref });
      if (r?.success && r.data?.email) { try { await markFreshSignup(r.data.email, { skip: ['profile'] }); } catch {} } // name + photo were just asked here
      if (!mountedRef.current) return;
      if (r?.success && r.data?.token) {
        // Hand off via the standard token-login path so the auth state hydrates,
        // tokens persist, push is registered, and the rest of the app comes up
        // with the same guarantees as email login. Mirrors login.js:699.
        const lr = await loginWithToken(r.data.token, r.data.email);
        if (!mountedRef.current) return;
        if (lr?.success) {
          try { require('../services/nativeTelemetry').markAuthDone('signup'); } catch {} // [otp-wa 2026-10-18]
          clearSignupDraft(); // [2026-10-07 signup-ux] account exists now — nothing to resume
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
          setConsentHold(true); // [2026-10-13 consent-lgpd]
          goStep('done');
          // WhatsApp-parity backup-restore prompt: probe iCloud / Drive for
          // existing backups tied to this phone number. If we find ≥1 we
          // defer navigation and let the user pick "Restaurar" vs "Pular".
          // Web + any error path falls back to the immediate router.replace
          // so signup is never blocked by the probe.
          // [2026-10-13 consent-lgpd] conta nova → sem auto-redirect (ver consentHold).
          _maybePromptRestoreThenGoChat({ hold: true });
        } else {
          setError(_errText(lr, 'signupPhone.signupError'));
        }
      } else {
        // [2026-10-07 signup-ux] friendly + actionable: a handle taken in the
        // race window flips the field to "taken" with suggestions; an expired
        // verify_token sends the user back to re-confirm the (pre-filled) number.
        const f = friendlyServerError(r, 'signupPhone.signupError');
        if (f.kind === 'username') {
          setUsernameAvailable(false); setUsernameReason('taken');
          setUsernameSuggestions(_nameCandidates.filter(c => c !== username));
          try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
        }
        setError(f.text || t(f.key));
        if (f.kind === 'expired') { setVerifyToken(''); setCode(''); goStep('phone'); }
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
      // [2026-10-11 android-kav] fecha o teclado do nome ANTES da activity externa
      // (no Android a volta da galeria/câmera deixava altura de teclado fantasma).
      try { Keyboard.dismiss(); } catch {}
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
      // [2026-10-11 android-kav] fecha o teclado do nome ANTES da activity externa
      // (no Android a volta da galeria/câmera deixava altura de teclado fantasma).
      try { Keyboard.dismiss(); } catch {}
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
      setLockRequired(false); setLockPin(''); setLockChallenge('');
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

  // [2026-10-11 funnel-qa] Android hardware back walks the steps backwards
  // (handle → name → code → number) like the on-screen arrow, instead of
  // popping the whole screen and losing the verified number / typed name.
  const goBackRef = useRef(null);
  goBackRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    if (step !== 'otp' && step !== 'name' && step !== 'handle') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      try { goBackRef.current?.(); } catch {}
      return true;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [step, busy]);

  // Welcome carousel — render the SignupIntro component as a separate root
  // (no KeyboardAvoiding/back-bar) so the 5 slides take the full screen,
  // mimicking the telegram-clean mockup. CTA "Começar" advances to phone step.
  if (step === 'welcome') {
    return <SignupIntro onFinish={() => {
      // Persist like /login does so the carousel never replays on this device.
      try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
      goStep('phone');
    }} />;
  }

  // [2026-10-07 signup-ux] Footer bottom padding (home indicator / nav bar).
  // ThreadKeyboardAvoider subtracts (pad - 12) so the CTA rides 12pt above the
  // keyboard frame-by-frame when keyboard-controller is present (native 2.6.0),
  // and falls back to RN KeyboardAvoidingView otherwise. Before, Android had
  // NO keyboard avoidance (behavior undefined + absolute footer) and the CTA
  // sat under the keyboard on edge-to-edge builds.
  const _footerPadBottom = Math.max(Platform.OS === 'ios' ? 30 : 16, _insets.bottom + 12);
  const _topPad = Math.max(_insets.top, Platform.OS === 'android' ? (require('react-native').StatusBar.currentHeight || 24) : (Platform.OS === 'web' ? 12 : 44));
  const AuthCardWrap = _wideWeb ? View : Fragment;
  const _stepOrder = ['phone', 'otp', 'name', 'handle'];
  const _stepIdx = _stepOrder.indexOf(step);
  // CTA disabled (not busy): the step's input isn't complete yet.
  const _ctaOff = !busy && (
    (step === 'phone' && phone.replace(/\D/g, '').length < 8) ||
    (step === 'otp'   && (lockRequired ? lockPin.length < 4 : code.length !== 6)) ||
    (step === 'name'  && (firstName || '').trim().length < 2) ||
    (step === 'handle' && (!username || usernameAvailable !== true || !!usernameLocalError(username) || (password.length > 0 && password.length < 8)))
  );

  return (
    <ThreadKeyboardAvoider
      style={[styles.container, { backgroundColor: _wideWeb ? (colors.authBg || colors.background) : colors.background }, _wideWeb && styles.wideRoot]}
      bottomInset={_footerPadBottom - 12}
    >
      <AuthCardWrap {...(_wideWeb ? { style: [styles.wideCard, { backgroundColor: colors.authCardBg || colors.background, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.08)' }, Platform.OS === 'web' && { boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.30), 0 18px 60px rgba(0,0,0,0.40)' : '0 1px 2px rgba(60,64,67,0.06), 0 6px 20px rgba(17,17,17,0.07), 0 24px 64px rgba(60,64,67,0.10)' }] } : {})}>
      {/* [2026-10-07 signup-ux] One compact top row: back · progress · n/4.
          Replaces progress bar + separate header with a gradient "Chatyy"
          wordmark (≈70pt of chrome) so the question sits higher and the input
          stays above the keyboard on small phones. */}
      {step !== 'done' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: _wideWeb ? 18 : _topPad + 6, paddingBottom: 6, width: '100%', maxWidth: 520, alignSelf: 'center' }}>
          <Animated.View style={{ opacity: backFade }}>
            <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
              <IconArrowLeft size={22} color={colors.text} />
            </TouchableOpacity>
          </Animated.View>
          <View
            style={{ flex: 1, height: 4, flexDirection: 'row', gap: 4 }}
            accessibilityRole="progressbar"
            accessibilityLabel={t('onb.stepLabel', { n: _stepIdx + 1, total: _stepOrder.length })}
            accessibilityValue={{ min: 1, max: _stepOrder.length, now: _stepIdx + 1 }}
          >
            {_stepOrder.map((s2, idx) => (
              <View key={s2} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: idx <= _stepIdx ? colors.text : colors.border }} />
            ))}
          </View>
          <Text style={{ minWidth: 28, textAlign: 'right', fontSize: 13, fontWeight: '700', color: colors.textSecondary, fontVariant: ['tabular-nums'] }}>
            {`${_stepIdx + 1}/${_stepOrder.length}`}
          </Text>
        </View>
      ) : (
        <View style={{ height: _wideWeb ? 24 : _topPad + 12 }} />
      )}

      <ScrollView style={_wideWeb ? { flexGrow: 0, flexShrink: 1 } : { flex: 1 }} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }, { scale: stepScale }], width: '100%' }}>
          {/* Resume banner — the app was closed mid-signup; fields came back
              from the local draft. "Começar de novo" wipes it. */}
          {resumedDraft && step === 'phone' && (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, marginBottom: 18,
              backgroundColor: colors.surfaceVariant, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
            }}>
              <IconCheckCircle size={16} color={colors.text} />
              <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.text }}>
                {t('signupPhone.resumed')}
              </Text>
              <TouchableOpacity onPress={_startOver} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button">
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' }}>
                  {t('signupPhone.startOver')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          {/* Compact ink tile (B&W premium) replaces the 200pt purple orb +
              breathing halos. Hidden on `name` (the avatar picker is the
              visual there) and on `done`. */}
          {step !== 'done' && step !== 'name' && (
            <Animated.View style={{
              width: 52, height: 52, borderRadius: 16, marginBottom: 20,
              backgroundColor: colors.text,
              alignItems: 'center', justifyContent: 'center',
              opacity: heroFade,
              transform: [{ scale: heroScale }],
            }}>
              <Animated.View style={{ opacity: heroIconFade }}>
                {step === 'phone' && (
                  <Svg viewBox="0 0 24 24" width={26} height={26} fill="none">
                    <Rect x="7" y="2.5" width="10" height="19" rx="2.5" stroke={colors.background} strokeWidth={2} fill="none" />
                    <Line x1="10.5" y1="5.5" x2="13.5" y2="5.5" stroke={colors.background} strokeWidth={1.5} strokeLinecap="round" />
                    <SvgCircle cx="12" cy="18.5" r="0.9" fill={colors.background} />
                  </Svg>
                )}
                {step === 'otp' && <IconShield size={24} color={colors.background} />}
                {step === 'handle' && <IconAtSign size={24} color={colors.background} />}
              </Animated.View>
            </Animated.View>
          )}
          {/* One question per screen, big left-aligned type. */}
          {step !== 'done' && (
            <>
              <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{headerTitle}</Text>
              {step === 'otp' ? (
                <Text style={[styles.sub, { color: colors.textSecondary }]}>
                  {t('signupPhone.subOtp') || 'Enviamos um código de 6 dígitos para'}{' '}
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{fullPhoneFormatted}</Text>
                  {'  '}
                  <Text onPress={goBack} style={{ color: colors.text, fontWeight: '700', textDecorationLine: 'underline' }} accessibilityRole="link">
                    {t('signupPhone.edit')}
                  </Text>
                </Text>
              ) : (
                <Text style={[styles.sub, { color: colors.textSecondary }]}>{headerSub}</Text>
              )}
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
                      accessibilityRole="button"
                      accessibilityLabel={t('common.close') || 'Fechar'}
                    >
                      <IconX size={16} color={colors.primary} />
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
                  const _hairline = colors.border;
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
                        accessibilityRole="button"
                        accessibilityLabel={`${t('signupPhone.countryLabel') || 'País'}: ${countryDisplayName(_country, language)} ${_country.dial}`}
                        style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 13, paddingHorizontal: 14,
                          borderRadius: 12,
                          backgroundColor: colors.surfaceVariant,
                          borderWidth: 1,
                          borderColor: colors.border,
                          marginBottom: 4,
                        }}
                      >
                        {/* Country flag emoji — WhatsApp/Telegram pattern. Renders
                            crisply on iOS/Android (the primary targets); on
                            Windows web the OS falls back to two ISO letters,
                            still readable. Monogram chip experiment was uglier
                            and less recognizable than the flag. */}
                        {/* [2026-10-12 first-run polish] ISO monogram chip instead
                            of the flag emoji (no-emoji rule; flags render as
                            tofu boxes on Windows/Linux web). Same chip as the
                            login field's country button. */}
                        <IsoChip code={_country?.code} colors={colors} />
                        <Text style={{ flex: 1, fontSize: 16, fontWeight: '500', color: colors.text }}>
                          {countryDisplayName(_country, language) || (t('login.selectCountry') || 'País')}
                        </Text>
                        <IconChevronRight size={16} color={colors.textTertiary} />
                      </TouchableOpacity>
                      <View style={{
                        flexDirection: 'row', alignItems: 'center',
                        borderBottomWidth: (_isFocused || phoneValid) ? 2 : StyleSheet.hairlineWidth,
                        borderBottomColor: phoneValid ? colors.success : (_isFocused ? _hairlineActive : _hairline),
                        marginTop: -StyleSheet.hairlineWidth,
                      }}>
                        <View style={{ minWidth: 64, paddingVertical: 12, paddingRight: 10 }}>
                          <Text style={{ fontSize: 22, color: colors.text, fontWeight: '600' }}>
                            {_country.dial}
                          </Text>
                        </View>
                        <View style={{ width: StyleSheet.hairlineWidth, height: 22, backgroundColor: _hairline, marginRight: 8 }} />
                        <TextInput
                          style={[{
                            flex: 1, minWidth: 0, fontSize: 22, fontWeight: '600', letterSpacing: 0.3, paddingVertical: 12,
                            color: colors.text,
                          }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                          value={formatPhone(phone, _country.mask)}
                          onChangeText={(text) => {
                            // Extract digits only; the mask is re-applied on render
                            // via formatPhone(). [2026-10-07 signup-ux] parsePhoneInput
                            // also understands a pasted / iOS-autofilled "+1 415…" or
                            // "0055…" (switches the country) and a duplicated dial
                            // code / BR trunk 0, then caps at the country's maxDigits.
                            const parsed = parsePhoneInput(text, countryCode, COUNTRIES);
                            if (parsed.countryCode !== countryCode) {
                              setCountryCode(parsed.countryCode);
                              try { Haptics.selectionAsync(); } catch {}
                            }
                            setPhone(parsed.digits);
                            if (accountExists !== null) setAccountExists(null);
                            if (error) setError('');
                            if (showFromLoginBanner) setShowFromLoginBanner(false);
                          }}
                          textContentType="telephoneNumber"
                          autoComplete="tel"
                          returnKeyType="go"
                          onSubmitEditing={() => { if (phoneValid && !busy) sendOtp(); }}
                          accessibilityLabel={t('signupPhone.titlePhone') || 'Seu telefone'}
                          keyboardType="phone-pad"
                          placeholder={_country.mask ? _country.mask.replace(/#/g, '0') : '11 99999-9999'}
                          placeholderTextColor={colors.textTertiary}
                          onFocus={() => setFocused('phone')}
                          onBlur={() => setFocused('')}
                          autoFocus
                        />
                        {/* Inline valid-number check — springs in when the typed
                            digits look complete for the country. WhatsApp parity:
                            confirms the number before the user taps Continue. */}
                        {phoneValid && (
                          <Animated.View style={{ marginLeft: 8, transform: [{ scale: phoneCheckScale }] }}>
                            <IconCheckCircle size={20} color={colors.success} />
                          </Animated.View>
                        )}
                      </View>
                    </View>
                  );
                })()}
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  padding: 12, borderRadius: 12, marginTop: 4,
                  backgroundColor: isDark ? `${colors.primary}1f` : `${colors.primary}0f`,
                }}>
                  <IconMessageCircle size={18} color={colors.primary} />
                  <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.textSecondary }}>
                    {/* [2026-10-12 auth-polish] was "Enviamos o código por WhatsApp e SMS"
                        — past tense before anything was sent, and wrong when only SMS
                        goes out (Firebase / intl). Same line as the login field. */}
                    {t('login.smartHintPhone')}
                  </Text>
                </View>
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
                      const _otpBg = isDark ? (_filled ? `${colors.primary}26` : colors.surfaceVariant) : (_filled ? `${colors.primary}10` : colors.surfaceVariant);
                      const _otpBorder = _focused ? colors.primary : (_filled ? colors.primary : (colors.border));
                      return (
                        <Animated.View
                          key={i}
                          style={{
                            // [2026-10-07 signup-ux] bigger targets, but never wider than the screen (SE 320pt)
                            width: Math.min(46, Math.floor((Math.min(_winW, 520) - 48 - 40) / 6)), height: 58, borderRadius: 14,
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
                          <Text style={{ fontSize: 26, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] }}>
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
                        setTimeout(() => { try { checkOtp(digits); } catch {} }, 150);
                      }
                    }}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={6}
                    textContentType="oneTimeCode"
                    // [2026-10-12 auth-polish] RN-web passes this through verbatim;
                    // "sms-otp" isn't an HTML token → browsers never offered the code.
                    autoComplete={Platform.OS === 'web' ? 'one-time-code' : 'sms-otp'}
                    autoFocus
                    caretHidden
                    importantForAutofill="yes"
                    accessibilityLabel={t('signupPhone.titleOtp') || 'Digite o código'}
                  />
                </Pressable>
                {/* Canais de envio: o código chega por WhatsApp e SMS (o que vier primeiro). */}
                {sentVia === 'voice' ? (
                  <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 4, lineHeight: 18 }}>
                    {t('signupPhone.sentVoice')}
                  </Text>
                ) : (
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    padding: 12, borderRadius: 14, marginTop: 4,
                    backgroundColor: colors.surfaceVariant,
                    borderWidth: 1, borderColor: colors.border,
                  }}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {otpChannels.wa && (
                        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${colors.primary}1f`, alignItems: 'center', justifyContent: 'center' }}>
                          <IconMessageCircle size={17} color={colors.primary} />
                        </View>
                      )}
                      {(otpChannels.sms || !otpChannels.wa) && (
                        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${colors.primary}1f`, alignItems: 'center', justifyContent: 'center' }}>
                          <IconSmartphone size={17} color={colors.primary} />
                        </View>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
                        {(otpChannels.wa && otpChannels.sms) ? t('onb.codeChannels')
                          : otpChannels.wa ? t('login.otpSentWhatsapp')
                          : t('login.otpSentSms')}
                      </Text>
                      <Text style={{ fontSize: 12, lineHeight: 17, color: colors.textSecondary, marginTop: 2 }}>
                        {accountExists === true ? t('signupPhone.existingAccountOtp')
                          : (otpChannels.wa && otpChannels.sms) ? t('onb.codeChannelsSub') : t('otp.mayTakeMinute')}
                      </Text>
                    </View>
                  </View>
                )}
                <OtpAssist assist={otpAssist} colors={colors} style={{ marginBottom: 6 }} />
                {/* [2026-10-07 signup-ux] "Trocar número" now lives inline in
                    the subtitle ("…para +55 (11) 9… Editar"). */}
                <TouchableOpacity
                  disabled={resendCountdown > 0 || busy}
                  onPress={() => sendOtp('sms')}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: resendCountdown > 0 || busy }}
                  style={{
                    alignSelf: 'center', marginTop: 4,
                    paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999,
                    backgroundColor: resendCountdown > 0 ? 'transparent' : `${colors.primary}14`,
                  }}
                >
                  <Text style={{
                    fontSize: 14, fontWeight: '600',
                    color: resendCountdown > 0 ? colors.textTertiary : colors.primary,
                  }}>
                    {resendCountdown > 0
                      ? t('onb.resendIn', { s: resendCountdown })
                      : t('signupPhone.resend')}
                  </Text>
                </TouchableOpacity>
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
                        borderColor: lockPin ? colors.primary : (colors.border),
                        backgroundColor: colors.surfaceVariant,
                        color: colors.text,
                        textAlign: 'center',
                        fontSize: 22, fontWeight: '700',
                        letterSpacing: 8,
                        ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                      }}
                      value={lockPin}
                      accessibilityLabel={t('signupPhone.lockPinTitle') || 'PIN de segurança'}
                      onChangeText={(v) => { setLockPin((v || '').replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
                      placeholder="••••"
                      placeholderTextColor={colors.textTertiary}
                      keyboardType="number-pad"
                      inputMode="numeric"
                      maxLength={6}
                      secureTextEntry
                      autoFocus
                    />
                    {!!lockChallenge && <ForgotLoginPinLink color={colors.primary} onPress={() => { setError(''); setPinResetOpen(true); }} />}
                  </View>
                )}

                {/* [otp-global 2026-10-15] Trocar de canal após 30 s (o servidor libera a
                    troca em 30 s; reenvio no mesmo canal segue 60 s): chegou pelo WhatsApp
                    (ou ligação) → "Enviar por SMS" (force_sms); chegou por SMS →
                    "Receber pelo WhatsApp" (whatsapp). */}
                {resendCountdown <= 30 && (() => {
                  const _toSms = sentVia === 'voice' || (otpChannels.wa && !otpChannels.sms);
                  if (waUnavailable && !_toSms) return null; // [otp-wa 2026-10-18] sem WhatsApp
                  return (
                  <TouchableOpacity
                    onPress={() => sendOtp(_toSms ? 'force_sms' : 'whatsapp')}
                    disabled={busy}
                    style={{
                      marginTop: 16, paddingVertical: 12, paddingHorizontal: 14,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                      borderRadius: 12, borderWidth: 1.5, borderColor: colors.border,
                      backgroundColor: 'transparent',
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                      {_toSms
                        ? (t('signupPhone.sendBySms') || 'Não recebi? Enviar por SMS')
                        : (t('login.otpViaWhatsapp') || 'Receber pelo WhatsApp')}
                    </Text>
                  </TouchableOpacity>
                  );
                })()}
                {/* Voice fallback (WhatsApp/Telegram parity): após o timer expirar,
                    deixa o user pedir uma chamada onde a Polly Camila lê o
                    código em PT-BR. Para quando o SMS não chega ou caixa lotada. */}
                {VOICE_OTP_ENABLED && resendCountdown === 0 && (
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
              const _hairline = colors.border;
              const _isFirstFocused = focused === 'firstName';
              const _isLastFocused  = focused === 'lastName';
              // Initials preview — when there's no photo yet but the user has
              // started typing, show their initial(s) in the avatar circle
              // instead of the generic person glyph. Updates live as they type,
              // mirroring how WhatsApp/iMessage previews the monogram avatar.
              const _initials = ((firstName || '').trim().charAt(0) + (lastName || '').trim().charAt(0)).toUpperCase();
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
                        backgroundColor: colors.surfaceVariant,
                        borderWidth: avatarUri ? 0 : StyleSheet.hairlineWidth,
                        borderColor: colors.border,
                        overflow: 'visible',
                      }}
                    >
                      {avatarUri ? (
                        <Image
                          source={{ uri: avatarUri }}
                          style={{ width: 96, height: 96, borderRadius: 48 }}
                        />
                      ) : _initials ? (
                        <Text style={{ fontSize: 34, fontWeight: '800', color: colors.primary, letterSpacing: 0.5 }}>
                          {_initials}
                        </Text>
                      ) : (
                        <IconUser size={36} color={colors.textTertiary} />
                      )}
                      {/* Camera-plus glyph — bottom-right corner, brand color. */}
                      <View style={{
                        position: 'absolute', right: -2, bottom: -2,
                        width: 30, height: 30, borderRadius: 15,
                        backgroundColor: colors.primary,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: 2, borderColor: colors.background,
                      }}>
                        <IconCamera size={15} color={colors.onPrimary || '#fff'} />
                      </View>
                    </TouchableOpacity>
                    <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 10 }}>{t('onb.photoHint')}</Text>
                  </View>
                  {/* First name */}
                  <View style={{
                    paddingVertical: 6,
                    borderBottomWidth: _isFirstFocused ? 2 : StyleSheet.hairlineWidth,
                    borderBottomColor: _isFirstFocused ? colors.primary : _hairline,
                  }}>
                    <TextInput
                      style={[{
                        fontSize: 20, fontWeight: '600', paddingVertical: 12, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupPhone.firstName') || 'Nome'}
                      placeholderTextColor={colors.textTertiary}
                      value={firstName}
                      onChangeText={(v) => { setFirstName(v); if (error) setError(''); }}
                      autoCapitalize="words"
                      autoFocus
                      maxLength={50}
                      textContentType="givenName"
                      autoComplete={Platform.OS === 'web' ? 'given-name' : 'name-given'}
                      blurOnSubmit={false}
                      onSubmitEditing={() => { try { lastNameRef.current?.focus?.(); } catch {} }}
                      accessibilityLabel={t('signupPhone.firstName') || 'Nome'}
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
                      ref={lastNameRef}
                      textContentType="familyName"
                      autoComplete={Platform.OS === 'web' ? 'family-name' : 'name-family'}
                      accessibilityLabel={t('signupPhone.lastNameOptional')}
                      style={[{
                        fontSize: 20, fontWeight: '600', paddingVertical: 12, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupPhone.lastNameOptional')}
                      placeholderTextColor={colors.textTertiary}
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
              const _hairlineDefault = colors.border;
              const _isFocused = focused === 'handle';
              const _bottomColor = usernameAvailable === false ? colors.error
                : usernameAvailable === true ? colors.success
                : (_isFocused ? colors.primary : _hairlineDefault);
              const _bottomWidth = (_isFocused || usernameAvailable !== null) ? 2 : StyleSheet.hairlineWidth;
              // Wide-screen (>=768): username + password rows side-by-side.
              // Each takes 50% of the form width with a gap. Suggestions +
              // hint render below the row to keep the layout simple. On
              // narrow screens the rows stack vertically as before.
              const _usernameRow = (
                <View>
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingVertical: 6,
                    borderBottomWidth: _bottomWidth,
                    borderBottomColor: _bottomColor,
                  }}>
                    <IconAtSign size={18} color={_isFocused ? colors.primary : colors.textSecondary} />
                    <TextInput
                      style={[{
                        flex: 1, minWidth: 0, fontSize: 20, fontWeight: '600', paddingVertical: 12, color: colors.text,
                      }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
                      placeholder={t('signupUsername.handlePlaceholder')}
                      placeholderTextColor={colors.textTertiary}
                      value={username}
                      onChangeText={(v) => { _usernameAutoRef.current = false; setUsername(sanitizeUsernameTyping(v)); if (error) setError(''); }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete={Platform.OS === 'web' ? 'username' : 'username-new'}
                      textContentType="username"
                      autoFocus
                      maxLength={30}
                      returnKeyType="next"
                      blurOnSubmit={false}
                      onSubmitEditing={() => { try { passwordRef.current?.focus?.(); } catch {} }}
                      accessibilityLabel={t('signupPhone.titleHandle') || 'Escolha seu @'}
                      onFocus={() => setFocused('handle')}
                      onBlur={() => setFocused('')}
                    />
                    {!isWide && <Text style={{ fontSize: 13, color: colors.textSecondary }}>@chatyy.com.br</Text>}
                    {usernameChecking ? (
                      <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 6 }} />
                    ) : usernameAvailable === true ? (
                      <Animated.View style={{ marginLeft: 6, transform: [{ scale: checkScale }] }}>
                        <IconCheckCircle size={18} color={colors.success} />
                      </Animated.View>
                    ) : usernameAvailable === false ? (
                      <View style={{ marginLeft: 6 }}><IconAlertTriangle size={18} color={colors.error} /></View>
                    ) : null}
                  </View>
                  {isWide && (
                    <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>@chatyy.com.br</Text>
                  )}
                </View>
              );
              // Password block — extracted so we can render it inline next to
              // username on wide screens, or stacked below on narrow.
              const _hl = colors.border;
              const _isFocusedPwd = focused === 'password';
              const _pwdValid = password.length >= 8;
              const _pwdBottomColor = _pwdValid ? colors.success : (_isFocusedPwd ? colors.primary : _hl);
              const _pwdBottomWidth = (_isFocusedPwd || _pwdValid) ? 2 : StyleSheet.hairlineWidth;
              const _passwordRow = (
                <View style={{ marginTop: isWide ? 0 : 24 }}>
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
                      placeholder={t('signupPhone.passwordOptionalPh')}
                      placeholderTextColor={colors.textTertiary}
                      ref={passwordRef}
                      value={password}
                      onChangeText={(v) => { setPassword(v); if (error) setError(''); }}
                      returnKeyType="done"
                      onSubmitEditing={() => { if (!busy && usernameAvailable === true && (password.length === 0 || password.length >= 8)) finishSignup(); }}
                      accessibilityLabel={t('signupPhone.passwordLabel')}
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
                      accessibilityLabel={showPassword ? (t('signupPhone.hidePassword') || 'Ocultar senha') : (t('signupPhone.showPassword') || 'Mostrar senha')}
                    >
                      {showPassword ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
                    </TouchableOpacity>
                    {_pwdValid && (
                      <IconCheckCircle size={18} color={colors.success} style={{ marginLeft: 4 }} />
                    )}
                  </View>
                </View>
              );
              // [2026-10-07 signup-ux] One status line under the handle (full
              // address + state) instead of the tinted preview card; reason-
              // specific copy (taken vs. invalid format); suggestion chips in
              // ink outline; strength meter under the password.
              const _uStatus = (() => {
                if (!username) return null;
                if (usernameChecking) return { text: t('signupPhone.checking'), color: colors.textTertiary };
                if (usernameAvailable === true) return { text: `${username}@chatyy.com.br · ${t('onb.available')}`, color: colors.success };
                if (usernameReason === 'taken') return { text: t('onb.taken'), color: colors.error };
                if (usernameReason === 'short') return { text: t('signupPhone.err.usernameShort'), color: colors.textTertiary };
                if (usernameReason) return { text: t('signupPhone.err.usernameInvalid'), color: colors.error };
                return { text: `${username}@chatyy.com.br`, color: colors.textTertiary };
              })();
              return (
                <>
                  {/* Side-by-side at >=768; stacked below 768. */}
                  <View style={isWide
                    ? { flexDirection: 'row', alignItems: 'flex-start', gap: 16 }
                    : { flexDirection: 'column' }}>
                    <View style={{ flex: isWide ? 1 : undefined }}>
                      {_usernameRow}
                      {!!_uStatus && (
                        <Text style={{ fontSize: 13, fontWeight: '600', marginTop: 8, color: _uStatus.color }} numberOfLines={2} accessibilityLiveRegion="polite">
                          {_uStatus.text}
                        </Text>
                      )}
                      {usernameAvailable === false && usernameSuggestions.length > 0 && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                          {usernameSuggestions.slice(0, 4).map(sg => (
                            <TouchableOpacity
                              key={sg}
                              onPress={() => { _usernameAutoRef.current = false; setUsername(sg); try { Haptics.selectionAsync(); } catch {} }}
                              accessibilityRole="button"
                              style={{
                                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
                                borderWidth: 1, borderColor: colors.text,
                              }}
                            >
                              <Text style={{ fontSize: 13, color: colors.text, fontWeight: '600' }}>@{sg}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                      <Text style={[styles.hint, { color: colors.textTertiary }]}>
                        {t('signupPhone.hintHandle') || 'Esse vai ser seu email no Chatyy também — pra receber e mandar mensagem.'}
                      </Text>
                    </View>
                    <View style={{ flex: isWide ? 1 : undefined }}>
                      {_passwordRow}
                      <SignupPasswordMeter
                        password={password}
                        context={[firstName, lastName, username, phone]}
                        colors={colors}
                        t={t}
                      />
                      <Text style={[styles.hint, { color: colors.textTertiary }]}>
                        {t('signupPhone.passwordOptionalHint')}
                      </Text>
                    </View>
                  </View>
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
                      borderWidth: 2, borderColor: colors.text,
                      opacity: doneScale.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.0, 0.5, 0.0] }),
                      transform: [{ scale: doneScale.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.25] }) }],
                    }} />
                    {/* Soft halo behind the orb — opacity follows scale. */}
                    <Animated.View style={{
                      position: 'absolute',
                      width: 124, height: 124, borderRadius: 62,
                      backgroundColor: colors.surfaceVariant,
                      opacity: doneScale,
                      transform: [{ scale: doneScale.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
                    }} />
                    <Animated.View style={{
                      width: 96, height: 96, borderRadius: 48,
                      backgroundColor: colors.text, // [2026-10-07 signup-ux] ink, B&W premium
                      alignItems: 'center', justifyContent: 'center',
                      transform: [{ scale: doneScale }],
                      shadowColor: '#000', shadowOffset: { width: 0, height: 10 },
                      shadowOpacity: 0.25, shadowRadius: 22, elevation: 10,
                      ...(Platform.OS === 'web' ? { boxShadow: '0 14px 32px rgba(0,0,0,0.25)' } : {}),
                    }}>
                      <IconCheck size={52} color={colors.background} strokeWidth={3} />
                    </Animated.View>
                  </View>
                  {!!_firstName && (
                    <Text style={{ fontSize: 24, fontWeight: '800', marginTop: 18, textAlign: 'center', color: colors.text, letterSpacing: -0.4 }}>
                      {_welcome}
                    </Text>
                  )}
                  {!consentHold && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
                    <IconSparkles size={16} color={colors.primary} />
                    <Text style={{ fontSize: 15, color: colors.textSecondary }}>
                      {t('signupPhone.redirecting') || 'Abrindo seu Chatyy…'}
                    </Text>
                  </View>
                  )}
                  <View style={{ alignSelf: 'stretch', marginTop: 28, gap: 10 }}>
                    {[
                      [IconMessageCircle, t('onb.doneTip1')],
                      [IconPhone, t('onb.doneTip2')],
                      [IconUsers, t('onb.doneTip3')],
                    ].map(([TipIcon, label], i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surfaceVariant }}>
                        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${colors.primary}1f`, alignItems: 'center', justifyContent: 'center' }}>
                          <TipIcon size={17} color={colors.primary} />
                        </View>
                        <Text style={{ flex: 1, fontSize: 14, fontWeight: '500', color: colors.text }}>{label}</Text>
                      </View>
                    ))}
                  </View>
                  {/* [2026-10-13 consent-lgpd] opções opcionais (desmarcadas) depois do
                      aceite dos Termos — só p/ conta nova; grava a prova ao montar. */}
                  {consentHold && (
                    <SignupConsentBlock colors={colors} style={{ marginTop: 24 }} />
                  )}
                  {!showRestorePrompt && (
                    <TouchableOpacity
                      onPress={() => { try { router.replace('/chat'); } catch {} }}
                      activeOpacity={0.85}
                      style={[styles.cta, { alignSelf: 'stretch', marginTop: 24, backgroundColor: colors.primary }]}
                    >
                      <Text style={[styles.ctaText, { color: colors.onPrimary || '#fff' }]}>{t('onb.doneStart')}</Text>
                      <IconArrowRight size={18} color={colors.onPrimary || '#fff'} style={{ marginLeft: 8 }} />
                    </TouchableOpacity>
                  )}
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
                <IconAlertTriangle size={15} color={colors.error} style={{ marginTop: 2 }} />
                <Text style={{ color: colors.error, fontSize: 13, lineHeight: 18, flex: 1 }}>
                  {error}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Primary action button (sticky bottom for the form-like feel) */}
      {step !== 'done' && (
        <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: _wideWeb ? 'transparent' : colors.background, paddingBottom: _wideWeb ? 24 : _footerPadBottom }]}>
          {/* ToS disclaimer — rendered on EVERY step (phone/otp/name/handle)
              so legal consent stays visible up through the moment of account
              creation. Hidden only on `done` (already signed up — no further
              consent needed). Centralized below via the _renderTosFooter
              helper so all four steps share one component. */}
          {/* [2026-10-07 signup-ux] consent shown where it matters — when the
              number is submitted (phone) and at account creation (handle) —
              instead of on all 4 steps. Links open the native /legal screen. */}
          {(step === 'phone' || step === 'handle') && (
            <Text style={{ fontSize: 12, color: colors.textTertiary, textAlign: 'center', marginBottom: 10, lineHeight: 17, paddingHorizontal: 8 }}>
              {t('signupPhone.tosLine') || 'Ao continuar você concorda com os '}
              <Text style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }} accessibilityRole="link" onPress={() => { try { router.push({ pathname: '/legal', params: { doc: 'terms' } }); } catch {} }}>
                {t('signupPhone.tosLink') || 'Termos'}
              </Text>
              {' '}{t('common.and') || 'e'}{' '}
              <Text style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }} accessibilityRole="link" onPress={() => { try { router.push({ pathname: '/legal', params: { doc: 'privacy' } }); } catch {} }}>
                {t('signupPhone.privacyLink') || 'Privacidade'}
              </Text>
              .
            </Text>
          )}
          <TouchableOpacity
            style={[
              styles.cta,
              // [2026-10-12 first-run polish] disabled = neutral fill + muted
              // label (login parity) instead of a 50%-faded black slab.
              _ctaOff
                ? [{ backgroundColor: colors.border }, styles.ctaFlat]
                : { backgroundColor: colors.primary, opacity: busy ? 0.85 : 1 },
            ]}
            disabled={busy ||
              (step === 'phone' && phone.replace(/\D/g, '').length < 8) ||
              (step === 'otp'   && (lockRequired ? lockPin.length < 4 : code.length !== 6)) ||
              (step === 'name'  && (firstName || '').trim().length < 2) ||
              (step === 'handle' && (!username || usernameAvailable !== true || !!usernameLocalError(username) || (password.length > 0 && password.length < 8)))}
            onPress={() => {
              // WhatsApp/Telegram both skip the "is this the right number?"
              // sheet — the OTP screen already shows the number with an Edit
              // link, so the friction wasn't paying for itself.
              if (step === 'phone')  sendOtp();
              else if (step === 'otp')    checkOtp(code);
              else if (step === 'name')   goName();
              else if (step === 'handle') finishSignup();
            }}
            activeOpacity={0.85}
          >
            {busy ? (
              <>
                <ActivityIndicator color={colors.onPrimary || '#fff'} />
                <Text style={[styles.ctaText, { marginLeft: 10, color: colors.onPrimary || '#fff' }]}>
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
                <Text style={[styles.ctaText, { color: _ctaOff ? colors.textTertiary : (colors.onPrimary || '#fff') }]}>
                  {step === 'handle' ? (t('signupPhone.finish') || 'Criar conta')
                  : (t('onb.continue') || 'Continuar')}
                </Text>
                {step !== 'handle' && <IconArrowRight size={18} color={_ctaOff ? colors.textTertiary : (colors.onPrimary || '#fff')} style={{ marginLeft: 8 }} />}
              </>
            )}
          </TouchableOpacity>
          {/* [phone-obrigatorio 2026-10-15] saída p/ cadastro sem telefone REMOVIDA (1 conta = 1 número). */}
        </View>
      )}

      </AuthCardWrap>

      {/* [wave14a 2026-10-16] Esqueci meu PIN (pré-login) */}
      <LoginPinResetSheet
        visible={pinResetOpen}
        challenge={lockChallenge}
        hasEmail={lockHasEmail}
        onClose={() => setPinResetOpen(false)}
        onChallengeExpired={() => { setLockRequired(false); setLockPin(''); setLockChallenge(''); setCode(''); }}
        onLoggedIn={onPinResetLoggedIn}
      />

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
            paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 30 : androidBottomInset(16),
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
              <IconImage size={20} color={colors.text} />
              <Text style={{ fontSize: 16, color: colors.text, fontWeight: '500' }}>
                {t('signupPhone.chooseFromGallery') || 'Abrir galeria'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setAvatarSheetOpen(false)}
              style={{ paddingVertical: 14, paddingHorizontal: 16, marginTop: 4, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}
              activeOpacity={0.6}
            >
              <Text style={{ fontSize: 16, color: colors.textSecondary, fontWeight: '600' }}>
                {t('common.cancel') || 'Cancelar'}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* [2026-10-18 onboarding-native-picker] mesmo seletor do onboarding nativo
          (folha + lista nativa + busca). Kill switch → Modal JS abaixo (igual antes). */}
      {onboardingNativePickerOn() ? (
        <CountryPicker
          visible={showCountryPicker}
          onClose={() => { setShowCountryPicker(false); setCountrySearch(''); }}
          onSelect={(cc) => {
            // não limpa o telefone digitado (padrão WhatsApp)
            setCountryCode(cc);
            setShowCountryPicker(false);
            setCountrySearch('');
          }}
          selected={countryCode}
          suggested={[countryCode, 'BR', 'US', 'PT']}
          colors={colors}
          isDark={isDark}
          t={t}
          language={language}
        />
      ) : (
      /* Country picker — full-screen list with search. Replaces PhoneInput's
          inline picker and matches the login.js modal pattern. */
      <Modal
        visible={showCountryPicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowCountryPicker(false)}
      >
        {/* [2026-10-12 auth-polish] wide web: centered sheet over a scrim (was a
            1440px-wide edge-to-edge list on desktop). Phones unchanged. */}
        <View style={_wideWeb ? { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 } : { flex: 1 }}>
        <View style={_wideWeb
          ? { width: '100%', maxWidth: 520, height: '80%', maxHeight: 720, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.authCardBg || colors.background }
          : { flex: 1, backgroundColor: colors.background }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 16, paddingTop: _wideWeb ? 16 : (Platform.OS === 'ios' ? 56 : androidTopInset(24)), paddingBottom: 12,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
          }}>
            <TouchableOpacity onPress={() => setShowCountryPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
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
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', height: 39, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */,
              }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
              placeholder={t('signup.stepPhone.searchCountry') || 'Buscar'}
              placeholderTextColor={colors.textTertiary}
              accessibilityLabel={t('signup.stepPhone.searchCountry') || 'Buscar'}
              autoCorrect={false}
              value={countrySearch}
              onChangeText={setCountrySearch}
              autoFocus={Platform.OS === 'web'}
            />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 320 }}>
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
                  accessibilityRole="button"
                  accessibilityState={{ selected: c.code === countryCode }}
                  accessibilityLabel={`${countryDisplayName(c, language)} ${c.dial}`}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: 14, paddingHorizontal: 16,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                    backgroundColor: c.code === countryCode ? `${colors.primary}10` : 'transparent',
                  }}
                >
                  <IsoChip code={c.code} colors={colors} />
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }} numberOfLines={1}>{countryDisplayName(c, language)}</Text>
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
                // [2026-10-12 auth-polish] accent-insensitive ("pais"/"mexico"
                // find País/México), "+55" or "55" both match the dial code, and
                // an explicit empty state instead of a blank list.
                const _norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const _q = _norm(countrySearch.trim());
                const _qDial = countrySearch.replace(/[^0-9]/g, '');
                const _hits = COUNTRIES.filter(c =>
                  _norm(c.name).includes(_q) ||
                  _norm(countryDisplayName(c, language)).includes(_q) ||
                  c.code.toLowerCase().includes(_q) ||
                  (!!_qDial && c.dial.replace('+', '').startsWith(_qDial))
                );
                if (!_hits.length) {
                  return (
                    <Text style={{ textAlign: 'center', color: colors.textSecondary, fontSize: 14, paddingVertical: 32, paddingHorizontal: 24 }}>
                      {t('common.noResults') || 'Nenhum resultado encontrado'}
                    </Text>
                  );
                }
                return _hits.map(_renderRow);
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
        </View>
      </Modal>
      )}

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
    </ThreadKeyboardAvoider>
  );
}

// [2026-10-12 first-run polish] Country monogram chip ("BR") — replaces the
// flag emoji in the country row + picker (same look as the login field chip).
function IsoChip({ code, colors }) {
  return (
    <View style={{
      minWidth: 34, height: 24, paddingHorizontal: 6, borderRadius: 7, marginRight: 12,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.authCardBg || colors.surface,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    }}>
      <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: colors.text }}>{String(code || '').toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // [2026-10-12 auth-polish] wide-web card (login parity)
  wideRoot: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, paddingHorizontal: 16 },
  wideCard: { width: '100%', maxWidth: 520, maxHeight: '100%', borderRadius: 24, borderWidth: 1, overflow: 'hidden', paddingTop: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : androidTopInset(24), paddingBottom: 12 },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 20 },
  dot: { width: 28, height: 4, borderRadius: 2 },
  scroll: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 32, width: '100%', maxWidth: 520, alignSelf: 'center' },
  // Telegram/iMessage hero typography: heavy weight, tighter tracking, crisp
  // line-height. The previous 28/-0.6 sat between ranks; this lands the title
  // squarely in "feature hero" territory.
  // [2026-10-07 signup-ux] one question per screen → big left-aligned type.
  title: { fontSize: 32, fontWeight: '800', letterSpacing: -0.9, marginBottom: 10, lineHeight: 38 },
  sub: { fontSize: 16, lineHeight: 23, fontWeight: '400' },
  hint: { fontSize: 12, marginTop: 12, lineHeight: 17 },
  // [2026-10-07 signup-ux] in-flow (not absolute) so the keyboard avoider can
  // lift it; ScrollView above is flex:1.
  footer: {
    width: '100%', maxWidth: 520, alignSelf: 'center',
    paddingHorizontal: 22, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : androidBottomInset(16),
    borderTopWidth: 0, // [2026-10-07 signup-ux] no rule in the centered column
    backgroundColor: 'transparent',
  },
  // [2026-10-12 first-run polish] 50pt / r14 + quiet lift — same CTA as login.
  cta: {
    height: 50, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 1px 2px rgba(0,0,0,0.10), 0 6px 16px rgba(0,0,0,0.12)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
      },
      ios: { shadowColor: '#000000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.14, shadowRadius: 10 },
      android: { elevation: 2 },
    }),
  },
  ctaFlat: Platform.select({
    web: { boxShadow: 'none', cursor: 'default' },
    ios: { shadowOpacity: 0 },
    android: { elevation: 0 },
    default: {},
  }),
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
});
