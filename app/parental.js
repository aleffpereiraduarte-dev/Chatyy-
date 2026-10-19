import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet, Platform, FlatList, Alert, ActivityIndicator, TextInput, ScrollView, Image, Animated, Easing, KeyboardAvoidingView, Modal, Vibration, Dimensions, RefreshControl, Linking, Share, BackHandler, Keyboard } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton, HeaderBackButton } from '../components/nativeHeader'; // [2026-10-08 parental-redesign]
import { useGroupedColors, SettingsGroup, SettingsRow, SettingsSwitchRow } from '../components/settings/SettingsKit'; // [2026-10-08 parental-pages2]
import { SegmentedControl, StepProgress, FieldLabel, FieldHelp, FilledField, MonoTile, BirthDateSheet, useInk } from '../components/parental/ParentalKit'; // [2026-10-08 parental-pages2]
import { ThreadKeyboardAvoider } from '../utils/threadKeyboard'; // [2026-10-08 parental-pages2] CTA acima do teclado
import PressableScale from '../components/PressableScale';
import { Skeleton } from '../components/Skeleton';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlus, IconUser, IconShield, IconChevronRight, IconMessageSquare, IconCamera, IconCheck, IconX, IconAlertCircle, IconFileText, IconBarChart, IconClock, IconLock, IconPhone, IconEye, IconCopy, IconImage, IconHome, IconStar, IconSmartphone, IconSparkles, IconAlertTriangle, IconMoon, IconUsers, IconSearch, IconHeart, IconSmile, IconMapPin, IconPause, IconPlay, IconMoreHorizontal, IconRefresh, IconCalendar } from '../components/Icons';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import * as ImagePicker from 'expo-image-picker';
import AvatarCircle from '../components/AvatarCircle';
import useIsMounted from '../hooks/useIsMounted';
import * as haptics from '../services/haptics';
import ErrorBoundary from '../components/ErrorBoundary';
import NativeSheetDialog from '../components/NativeSheetDialog'; // [2026-10-19 parental-premium] "Mais"/Pedidos = sheet do sistema
import { runAfterNativeSheet } from '../components/NativeSheet';
import { useFamilyColors } from '../components/family/familyUi';
import { ScreenTimeRing, StatusPill, MetaChip, ActionSegments, PausedBanner, VerifyCallout, AddChildCard, SummaryCard, fmtMinutes, agoLabel, parseTs, AMBER } from '../components/parental/ParentalDashKit';

const ACCENT = '#111111';
const STEPS = ['info', 'document', 'verifying', 'credentials'];

// Step gradient configs
const STEP_GRADIENTS = {
  0: { web: 'linear-gradient(145deg, #4F46E5 0%, #111111 40%, #111111 100%)', native: '#111111' },
  1: { web: 'linear-gradient(145deg, #059669 0%, #10B981 40%, #34D399 100%)', native: '#10B981' },
  2: { web: 'linear-gradient(145deg, #111111 0%, #111111 40%, #111111 100%)', native: '#111111' },
  3: { web: 'linear-gradient(145deg, #D97706 0%, #F59E0B 40%, #FBBF24 100%)', native: '#F59E0B' },
};

// Age-appropriate icon
const AGE_ICON = (age) => {
  if (age <= 7) return <IconUser size={16} color="#111111" />;
  if (age <= 9) return <IconUser size={16} color="#3B82F6" />;
  if (age <= 11) return <IconStar size={16} color="#F59E0B" />;
  return <IconStar size={16} color="#111111" />;
};

// Mascot frames for animation (icon components)
const MASCOT_FRAMES_ICONS = ['shield', 'user', 'star', 'heart', 'sparkles', 'smile'];

// Safety facts for verification wait
const SAFETY_FACTS_KEYS = [
  'parental.safetyFact1',
  'parental.safetyFact2',
  'parental.safetyFact3',
  'parental.safetyFact4',
  'parental.safetyFact5',
];

// Verification stages
const VERIFY_STAGE_KEYS = [
  'parental.verifyUploading',
  'parental.verifyAnalyzing',
  'parental.verifyChecking',
  'parental.verifyAlmostDone',
];

// Username suggestions from name
const suggestUsername = (name) => {
  if (!name || name.trim().length < 2) return [];
  const clean = name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const suggestions = [];
  if (parts.length >= 2) {
    suggestions.push(parts[0] + '.' + parts[parts.length - 1]);
    suggestions.push(parts[0] + parts[parts.length - 1].charAt(0));
    suggestions.push(parts[0] + '_' + parts[parts.length - 1]);
  }
  suggestions.push(parts[0] + Math.floor(Math.random() * 100));
  return suggestions.slice(0, 3);
};

// Age-based preset restrictions
// Defaults to the youngest-tier preset when `age` is null/undefined/NaN so
// callers that forget to guard (e.g. accidental render before validation)
// don't crash with `Cannot read property 'screenTime' of undefined`.
const getAgePresets = (age) => {
  const a = Number(age);
  if (!Number.isFinite(a) || a <= 7) return { screenTime: 60, bedtimeStart: '19:30', bedtimeEnd: '07:00', safeSearch: true, contactApproval: true, canSendEmail: false, canDeleteMessages: false };
  if (a <= 9) return { screenTime: 90, bedtimeStart: '20:00', bedtimeEnd: '07:00', safeSearch: true, contactApproval: true, canSendEmail: true, canDeleteMessages: false };
  if (a <= 11) return { screenTime: 120, bedtimeStart: '21:00', bedtimeEnd: '06:30', safeSearch: true, contactApproval: false, canSendEmail: true, canDeleteMessages: true };
  return { screenTime: 180, bedtimeStart: '22:00', bedtimeEnd: '06:00', safeSearch: false, contactApproval: false, canSendEmail: true, canDeleteMessages: true };
};

// Pulsing online dot — Instagram/WhatsApp-style. Each card mounts its own
// instance so animations are independent and clean up on unmount.
//
// `justWentOnline` triggers a one-shot green flash + scale-pop overlay so the
// offline→online transition feels alive instead of silently swapping in.
function OnlineDot({ dark, justWentOnline, ringColor }) {
  const scale = useRef(new Animated.Value(1)).current;
  // Flash overlay: bigger green halo + opacity that pulses ONCE when
  // justWentOnline flips true. Independent from the steady-state pulse loop.
  const flash = useRef(new Animated.Value(0)).current;
  // One-shot scale-pop on the dot itself for the transition.
  const popScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.6, duration: 900, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale]);
  useEffect(() => {
    if (!justWentOnline) return;
    // Reset both animators so the burst replays cleanly even if the user
    // toggles connectivity rapidly. Total duration ≈ 380ms — well under
    // the 400ms cap.
    flash.setValue(1);
    popScale.setValue(0.6);
    Animated.parallel([
      Animated.timing(flash, { toValue: 0, duration: 380, useNativeDriver: true }),
      Animated.spring(popScale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
  }, [justWentOnline, flash, popScale]);
  return (
    <View style={{ position: 'absolute', bottom: 2, right: 2, width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' }}>
      {/* Steady-state pulse — always running while online. */}
      <Animated.View style={{ position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e', opacity: 0.35, transform: [{ scale }] }} />
      {/* Transition flash — bigger ring that fades from 1 → 0 once when
          the avatar just went online. Native driver. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute', width: 14, height: 14, borderRadius: 7,
          backgroundColor: '#22c55e',
          opacity: flash,
          transform: [{ scale: flash.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
        }}
      />
      <Animated.View style={{ transform: [{ scale: popScale }] }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e', borderWidth: 2, borderColor: ringColor || (dark ? '#1c1c1e' : '#fff') }} />
      </Animated.View>
    </View>
  );
}

function ParentalScreenInner() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  // [WAVE 63 #fam-crash] Mount diagnostic — `/parental` is reached from the
  // inbox menu item labelled "Família", so a crash on this screen looks
  // identical to a contacts-tab crash to the user.
  useEffect(() => { try { console.log('[FAMILIA-DIAG][parental][mount]'); } catch {} }, []);
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // [2026-10-08 parental-redesign] erro de carga (sem cache) + sheet "Mais" por filho.
  const [loadError, setLoadError] = useState(false);
  const [moreChild, setMoreChild] = useState(null);
  const insets = useSafeAreaInsets();

  // Per-child enrichments (screen-time, restrictions for bedtime).
  // Keyed by child_email. Loaded lazily when children list arrives.
  const [childMeta, setChildMeta] = useState({}); // { [email]: { screen_time_used, screen_time_limit, bedtime_start, bedtime_end, locked } }

  // Pending unlock requests (red-dot banner at top)
  const [pendingRequests, setPendingRequests] = useState([]);
  // Modal to approve/reject pending requests (banner deep-linked here
  // before but `?tab=requests` doesn't exist in /parental-monitor — bug
  // 2026-05-21 #wave89). Now opens this sheet inline so accept/reject
  // works without navigation.
  const [requestsModal, setRequestsModal] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  // [WAVE 141 #300] Derived from pendingRequests for the red-dot banner.
  // MUST stay at the top with the other hooks — previously this useMemo
  // lived below the `if (showWizard) return …` early return, so opening the
  // wizard (e.g. tapping "Add first child" on the empty state) rendered one
  // fewer hook than the dashboard → React error #300 (hooks-order violation).
  const pendingChildNames = useMemo(() => {
    const names = new Set();
    // Backend may omit `child_name` for older accounts — fall back to the
    // email local-part so the banner never reads as a raw email address.
    (pendingRequests || []).forEach(r => {
      const nm = (r?.child_name || '').trim();
      if (nm) { names.add(nm); return; }
      const em = (r?.child_email || '').trim();
      if (em) {
        const local = em.includes('@') ? em.split('@')[0] : em;
        if (local) names.add(local.charAt(0).toUpperCase() + local.slice(1));
      }
    });
    return Array.from(names);
  }, [pendingRequests]);

  // Heartbeat — drives bedtime countdown + relative-time refresh.
  // Tick once per minute is enough for HH:MM display.
  const [now, setNow] = useState(() => Date.now());

  // AI Summary modal state
  const [summaryModal, setSummaryModal] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState(null);
  const [summaryChild, setSummaryChild] = useState(null);

  // Wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(0);
  const [childName, setChildName] = useState('');
  const [childBirthday, setChildBirthday] = useState('');
  const [childGender, setChildGender] = useState('');
  const [relationship, setRelationship] = useState('');
  // Inline validation errors (GAP 8)
  const [nameError, setNameError] = useState('');
  const [birthdateError, setBirthdateError] = useState('');
  const [verifyMethod, setVerifyMethod] = useState(null); // 'document', 'phone', 'card'
  const [docImage, setDocImage] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newChild, setNewChild] = useState(null);
  const [docVerdict, setDocVerdict] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [verifyStage, setVerifyStage] = useState(0);
  const [safetyFactIdx, setSafetyFactIdx] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);
  const [quickSetup, setQuickSetup] = useState({ bedtime: false, contacts: false, screenTime: false, safeSearch: false, filterAdult: false, filterViolence: false, filterProfanity: false });
  const [suggestedUser, setSuggestedUser] = useState('');
  const [mascotFrame, setMascotFrame] = useState(0);
  // [2026-10-08 parental-pages2] seletor de data + foco do campo nome + cores agrupadas.
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const gw = useGroupedColors();
  const fc = useFamilyColors(); // [2026-10-19 parental-premium]
  const scrollY = useRef(new Animated.Value(0)).current; // título grande recolhível (web)
  const { ink, onInk } = useInk();
  const wizardBackRef = useRef(null);
  // Android: voltar do sistema volta um passo do wizard (antes saía da tela).
  useEffect(() => {
    if (!showWizard || Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { try { wizardBackRef.current?.(); } catch {} return true; });
    return () => { try { sub.remove(); } catch {} };
  }, [showWizard]);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(1)).current;
  const mascotAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const confettiAnims = useRef(Array.from({ length: 20 }, () => ({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    opacity: new Animated.Value(0),
    rotate: new Animated.Value(0),
  }))).current;

  const isMountedRef = useIsMounted();
  const nameInputRef = useRef(null);
  const mascotFrameRef = useRef(0);
  // Track per-child online state so we can fire a one-shot flash + scale-pop
  // animation on the offline→online transition. Keyed by child_email; value
  // is the timestamp of the last detected transition (used as a render cue).
  const prevOnlineRef = useRef(new Map());
  const [onlineFlashes, setOnlineFlashes] = useState({}); // { email: timestamp }

  // Animate step transitions
  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(30);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    // Progress bar animation
    Animated.timing(progressAnim, {
      toValue: (step + 1) / 4,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [step, fadeAnim, slideAnim, progressAnim]);

  // [2026-10-08 parental-pages2] mascote animado saiu do passo 1 (re-render a
  // cada 1.6s sem necessidade) — o wizard agora tem título + campos diretos.

  // Shield pulse animation (step 1)
  useEffect(() => {
    if (step === 1 && showWizard) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [step, showWizard, pulseAnim]);

  // Verification stage progression (step 2)
  useEffect(() => {
    if (step === 2 && showWizard) {
      setVerifyStage(0);
      setSafetyFactIdx(0);
      const stageInterval = setInterval(() => {
        if (!isMountedRef.current) return;
        setVerifyStage(prev => Math.min(prev + 1, 3));
      }, 2500);
      const factInterval = setInterval(() => {
        if (!isMountedRef.current) return;
        setSafetyFactIdx(prev => (prev + 1) % SAFETY_FACTS_KEYS.length);
      }, 4000);
      return () => { clearInterval(stageInterval); clearInterval(factInterval); };
    }
  }, [step, showWizard, isMountedRef]);

  // Confetti explosion (step 3)
  useEffect(() => {
    if (step === 3 && showWizard) {
      setShowConfetti(true);
      if (Platform.OS !== 'web') {
        try { haptics.success(); /* [2026-10-18 polish2] era Vibration.vibrate(100) */ } catch {}
      }
      const screenW = Dimensions.get('window').width;
      const animations = confettiAnims.map((anim, i) => {
        const startX = screenW / 2;
        const endX = (Math.random() - 0.5) * screenW * 1.5;
        const endY = -(Math.random() * 400 + 200);
        anim.x.setValue(0);
        anim.y.setValue(0);
        anim.opacity.setValue(1);
        anim.rotate.setValue(0);
        return Animated.parallel([
          Animated.timing(anim.x, { toValue: endX, duration: 1800 + Math.random() * 800, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(anim.y, { toValue: endY, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(anim.y, { toValue: 600, duration: 1200, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          ]),
          Animated.timing(anim.opacity, { toValue: 0, duration: 2200, useNativeDriver: true }),
          Animated.timing(anim.rotate, { toValue: Math.random() * 10, duration: 2200, useNativeDriver: true }),
        ]);
      });
      Animated.stagger(60, animations).start(() => setShowConfetti(false));
    }
  }, [step, showWizard]);

  // Auto-suggest username when name changes
  useEffect(() => {
    const suggestions = suggestUsername(childName);
    if (suggestions.length > 0) setSuggestedUser(suggestions[0]);
  }, [childName]);

  // Detect offline→online transitions per child. When a child's `online`
  // flips from false to true we stamp `onlineFlashes[email] = Date.now()`,
  // which the OnlineDot reads as a key prop to replay its flash animation.
  useEffect(() => {
    if (!Array.isArray(children) || children.length === 0) return;
    const flashes = { ...onlineFlashes };
    let dirty = false;
    children.forEach(c => {
      const isOn = c.status === 'active' && isOnline(c);
      const wasOn = prevOnlineRef.current.get(c.child_email) || false;
      if (isOn && !wasOn) {
        flashes[c.child_email] = Date.now();
        dirty = true;
      }
      prevOnlineRef.current.set(c.child_email, isOn);
    });
    if (dirty) setOnlineFlashes(flashes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  // Birthdate inline validation (GAP 8): full date entered + age outside 1-18 → error
  useEffect(() => {
    if (!childBirthday) { setBirthdateError(''); return; }
    const m = childBirthday.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) { setBirthdateError(''); return; } // partial input — wait
    const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    if (isNaN(d.getTime())) { setBirthdateError(t('parental.errorBirthdate')); return; }
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age--;
    if (age < 1 || age > 18) setBirthdateError(t('parental.errorBirthdate'));
    else setBirthdateError('');
  }, [childBirthday, t]);

  // Bounce animation for Next button
  const triggerBounce = useCallback(() => {
    Animated.sequence([
      Animated.timing(bounceAnim, { toValue: 0.92, duration: 100, useNativeDriver: true }),
      Animated.spring(bounceAnim, { toValue: 1, friction: 3, tension: 200, useNativeDriver: true }),
    ]).start();
  }, []);

  const loadChildren = useCallback(async () => {
    // Show cached data INSTANTLY (no loading spinner)
    try {
      const c = await getCached('parental_children');
      if (c?.length) { setChildren(c); setLoading(false); }
    } catch {}
    // Refresh from API in background (don't block UI)
    api.parentalListChildren().then(r => {
      if (!isMountedRef.current) return;
      if (r?.success) {
        const list = r.data?.children || [];
        setChildren(list);
        setLoadError(false);
        setCache('parental_children', list, 2592000000).catch(() => {});
      } else {
        setLoadError(true); // [2026-10-08 parental-redesign] só aparece se não houver cache
      }
    }).catch(() => { if (isMountedRef.current) setLoadError(true); }).finally(() => { if (isMountedRef.current) setLoading(false); });
  }, [isMountedRef]);

  // Pending unlock requests — drives the red-dot banner at top of dashboard.
  const loadPendingRequests = useCallback(async () => {
    try {
      const r = await api.parentalPendingRequests('pending');
      if (r?.success && isMountedRef.current) {
        setPendingRequests(Array.isArray(r.data?.requests) ? r.data.requests : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {}
  }, [isMountedRef]);

  // Per-child meta (screen time + bedtime + lock state). Fired in parallel
  // for every active child so quick-action mini-bars + bedtime card render
  // immediately. Best-effort: any failure leaves that child's meta unset.
  const loadChildMeta = useCallback(async (list) => {
    if (!Array.isArray(list) || list.length === 0) return;
    const active = list.filter(c => c.status === 'active');
    await Promise.all(active.map(async (c) => {
      try {
        // [2026-10-19 parental-premium] Só dados que a API entrega de verdade:
        //  - parental_child_today: atividade de hoje (mensagens/chamadas) +
        //    screen_time_minutes ESTIMADO pela atividade (parental_screen_time
        //    é stub que sempre devolve 0 → só cai nele se o today falhar);
        //  - parental_get_restrictions: daily_limit_minutes, bedtime, locked/locked_at;
        //  - parental_get_location: último ping (created_at + bateria).
        const [todayRes, restRes, locRes] = await Promise.all([
          api.parentalChildToday(c.child_email).catch(() => null),
          api.parentalGetRestrictions(c.child_email).catch(() => null),
          api.parentalGetLocation(c.child_email).catch(() => null),
        ]);
        let stRes = null;
        if (!todayRes?.success) stRes = await api.parentalScreenTime(c.child_email).catch(() => null);
        if (!isMountedRef.current) return;
        const td = todayRes?.success ? (todayRes.data || {}) : null;
        const rd = restRes?.success ? (restRes.data || {}) : {};
        const ld = locRes?.success ? locRes.data : null;
        const loc = ld && !Array.isArray(ld) ? (ld.location || ld) : null;
        const hasLoc = !!(loc && loc.latitude != null && loc.longitude != null);
        const usedRaw = td ? td.screen_time_minutes : (stRes?.data?.minutes_today ?? stRes?.data?.used_minutes);
        const lk = rd.locked;
        const meta = {
          screen_time_used: usedRaw == null ? null : Number(usedRaw) || 0,
          screen_time_estimated: !!td,
          screen_time_limit: Number(rd.daily_limit_minutes || rd.screen_time_limit || 0) || 0,
          bedtime_start: rd.bedtime_start || null,
          bedtime_end: rd.bedtime_end || null,
          locked: lk === true || lk === 1 || lk === '1' || lk === 'true',
          locked_at: rd.locked_at || null,
          messages_today: td ? (Number(td.messages_sent || 0) + Number(td.messages_received || 0)) : null,
          calls_today: td ? Number(td.calls_count || 0) : null,
          loc_at: hasLoc ? (loc.created_at || null) : null,
          battery: hasLoc && loc.battery_level != null && Number(loc.battery_level) > 0 ? Number(loc.battery_level) : null,
          has_location: hasLoc,
        };
        setChildMeta(prev => ({ ...prev, [c.child_email]: { ...meta, bonus_today: prev[c.child_email]?.bonus_today || 0 } }));
      } catch {}
    }));
  }, [isMountedRef]);

  // Pull-to-refresh: refresh list + pending + meta in parallel.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    haptics.tap('light');
    try {
      const r = await api.parentalListChildren();
      if (r?.success && isMountedRef.current) {
        const list = r.data?.children || [];
        setChildren(list);
        setLoadError(false);
        setCache('parental_children', list, 2592000000).catch(() => {});
        await Promise.all([loadPendingRequests(), loadChildMeta(list)]);
      }
    } catch {}
    finally { if (isMountedRef.current) setRefreshing(false); }
  }, [isMountedRef, loadPendingRequests, loadChildMeta]);

  useEffect(() => { loadChildren(); loadPendingRequests(); }, [loadChildren, loadPendingRequests]);

  // Refresh meta whenever children list changes.
  useEffect(() => { loadChildMeta(children); }, [children, loadChildMeta]);

  // 60s heartbeat — only run when dashboard is visible (not wizard).
  useEffect(() => {
    if (showWizard) return;
    const id = setInterval(() => { if (isMountedRef.current) setNow(Date.now()); }, 60000);
    return () => clearInterval(id);
  }, [showWizard, isMountedRef]);

  // [2026-10-08 parental-pages2] Sem ícones coloridos: viram segmented control.
  const relationships = [
    { key: 'mae', label: t('parental.relMom') },
    { key: 'pai', label: t('parental.relDad') },
    { key: 'tutor', label: t('parental.relGuardian') },
  ];

  const genders = [
    { key: 'male', label: t('parental.genderBoy') },
    { key: 'female', label: t('parental.genderGirl') },
    { key: 'other', label: t('parental.genderOther') },
  ];

  // Calculate age from birthday
  const getAge = (birthday) => {
    if (!birthday) return null;
    const m = birthday.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age--;
    return age;
  };

  const childAge = getAge(childBirthday);
  const isAgeValid = childAge !== null && childAge >= 6 && childAge <= 13;

  const handleNextStep = async () => {
    triggerBounce();
    if (Platform.OS !== 'web') { try { haptics.selection(); /* [2026-10-07 native-polish] */ } catch {} }

    if (step === 0) {
      if (!childName.trim()) return Alert.alert(t('parental.incomplete'), t('parental.enterChildName'));
      if (!childBirthday || !isAgeValid) return Alert.alert(t('parental.invalidAge'), t('parental.ageRange'));
      if (!relationship) return Alert.alert(t('parental.incomplete'), t('parental.selectRelationship'));
      setCreating(true);
      try {
        const r = await api.parentalCreateChild(childName.trim(), childBirthday.trim());
        if (r.success && r.data) {
          setNewChild(r.data);
          setStep(1);
        } else {
          Alert.alert(t('parental.error'), r.message || t('parental.createError'));
        }
      } catch { Alert.alert(t('parental.error'), t('parental.connectionError')); } finally { setCreating(false); }
    } else if (step === 1) {
      if (verifyMethod === 'document' && !docImage) return Alert.alert('', t('parental.selectDocument'));
      if (verifyMethod === 'phone') {
        // Phone verification - trigger OTP flow
        setStep(2);
        setUploading(true);
        try {
          // Simulate phone verification
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (!isMountedRef.current) return;
          setDocVerdict({ verdict: 'approved', confidence: 0.95, method: 'phone' });
          setStep(3);
          loadChildren();
        } catch { if (isMountedRef.current) { Alert.alert(t('parental.error'), t('parental.verifyError')); setStep(1); } }
        finally { if (isMountedRef.current) setUploading(false); }
        return;
      }
      setStep(2);
      setUploading(true);
      try {
        const r = await api.parentalUploadDocument(newChild.account_id, 'rg', docImage.uri);
        if (!isMountedRef.current) return;
        setDocVerdict(r.data || r);
        setStep(3);
        loadChildren();
      } catch { if (isMountedRef.current) { Alert.alert(t('parental.error'), t('parental.uploadError')); setStep(1); } } finally { if (isMountedRef.current) setUploading(false); }
    }
  };

  const pickDocument = async (useCamera) => {
    const fn = useCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const result = await fn({ mediaTypes: ['images'], quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      setDocImage(result.assets[0]);
    }
  };

  const resetWizard = () => {
    setShowWizard(false);
    setStep(0);
    setChildName('');
    setChildBirthday('');
    setChildGender('');
    setRelationship('');
    setVerifyMethod(null);
    setDocImage(null);
    setNewChild(null);
    setDocVerdict(null);
    setNameError('');
    setBirthdateError('');
    setQuickSetup({ bedtime: false, contacts: false, screenTime: false, safeSearch: false, filterAdult: false, filterViolence: false, filterProfanity: false });
  };

  const openAiSummary = async (child) => {
    setSummaryChild(child);
    setSummaryModal(true);
    setSummaryLoading(true);
    setSummaryData(null);
    try {
      const r = await api.parentalActivitySummary(child.child_email);
      if (r.success) setSummaryData(r.data);
      else setSummaryData({ error: r.message || t('parental.summaryError') });
    } catch { setSummaryData({ error: t('parental.connectionError') }); }
    finally { setSummaryLoading(false); }
  };

  const riskColor = (level) => {
    if (level === 'high') return '#ef4444';
    if (level === 'medium') return '#f59e0b';
    return '#22c55e';
  };

  const riskLabel = (level) => {
    if (level === 'high') return t('parental.riskHigh');
    if (level === 'medium') return t('parental.riskMedium');
    return t('parental.riskLow');
  };

  const statusConfig = {
    pending_verification: { color: '#f59e0b', label: t('parental.pending'), icon: <IconClock size={24} color="#f59e0b" /> },
    active: { color: '#22c55e', label: t('parental.active'), icon: <IconCheck size={24} color="#22c55e" /> },
    suspended: { color: '#ef4444', label: t('parental.suspended'), icon: <IconAlertCircle size={24} color="#ef4444" /> },
    revoked: { color: '#6b7280', label: t('parental.revoked'), icon: <IconX size={24} color="#6b7280" /> },
    graduated: { color: '#111111', label: t('parental.graduated'), icon: <IconStar size={24} color={colors.primary} /> },
  };

  const formatLastActive = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    // Use the heartbeat `now` so the relative time refreshes every minute
    // without forcing the whole list to re-render the underlying card.
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('time.now') || 'agora';
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
  };

  // "Online agora" / "Vista 5 min atrás" subtitle — Instagram-grade.
  // Considers a child online if last_active was within the last 3 minutes.
  const presenceLine = (item) => {
    if (!item.last_active) return '';
    const last = new Date(item.last_active).getTime();
    const diffMin = Math.floor((now - last) / 60000);
    if (diffMin < 3) return t('parental.onlineNow') || 'Online agora';
    if (diffMin < 60) return `${t('parental.lastSeen') || 'Vista'} ${diffMin} min ${t('parental.ago') || 'atrás'}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${t('parental.lastSeen') || 'Vista'} ${diffH}h ${t('parental.ago') || 'atrás'}`;
    const diffD = Math.floor(diffH / 24);
    return `${t('parental.lastSeen') || 'Vista'} ${diffD}d ${t('parental.ago') || 'atrás'}`;
  };

  const isOnline = (item) => {
    if (!item?.last_active) return false;
    const last = new Date(item.last_active).getTime();
    return (now - last) < 3 * 60000;
  };

  // Avatar halo ring. Redesign uses a NEUTRAL monochrome ring (the clean
  // white/gray system) instead of the old rainbow gradient — the AvatarCircle
  // itself is already grayscale. Kept as a function (same call site) so this
  // stays a pure style change.
  const childGradient = (email) => {
    const neutral = isDark ? '#2c2c2e' : '#eef0f1';
    return [neutral, neutral];
  };

  // Bedtime helpers. Backend stores HH:MM strings. Returns whether the kid
  // is currently inside the bedtime window + the end time as Date.
  const parseHHMM = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: parseInt(m[1]), m: parseInt(m[2]) };
  };

  const bedtimeStatus = (meta) => {
    if (!meta) return { active: false };
    const start = parseHHMM(meta.bedtime_start);
    const end = parseHHMM(meta.bedtime_end);
    if (!start || !end) return { active: false };
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const startMin = start.h * 60 + start.m;
    const endMin = end.h * 60 + end.m;
    let active = false;
    // Window can wrap midnight (e.g. 22:00 → 06:00).
    if (startMin <= endMin) active = cur >= startMin && cur < endMin;
    else active = cur >= startMin || cur < endMin;
    if (!active) return { active: false };
    // Compute end as a Date so we can format HH:MM in user's locale.
    const endDate = new Date(d);
    endDate.setSeconds(0, 0);
    if (endMin > cur) endDate.setHours(end.h, end.m, 0, 0);
    else { endDate.setDate(endDate.getDate() + 1); endDate.setHours(end.h, end.m, 0, 0); }
    const minsLeft = Math.max(0, Math.floor((endDate.getTime() - now) / 60000));
    return { active: true, endDate, minsLeft, endLabel: meta.bedtime_end };
  };

  // Open a child's last known location in maps.
  const openChildLocation = useCallback(async (child) => {
    haptics.tap('light');
    try {
      const r = await api.parentalGetLocation(child.child_email);
      const loc = r?.data?.location || r?.data;
      const lat = loc?.latitude ?? loc?.lat;
      const lng = loc?.longitude ?? loc?.lng;
      if (lat == null || lng == null) {
        Alert.alert(t('parental.locationUnavailable') || 'Localização indisponível', t('parental.locationUnavailableDesc') || 'Ainda não recebemos a localização desta criança.');
        return;
      }
      const url = Platform.select({
        ios: `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(child.child_name)}`,
        android: `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(child.child_name)})`,
        default: `https://www.google.com/maps?q=${lat},${lng}`,
      });
      Linking.openURL(url).catch(() => {
        Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`).catch(() => {});
      });
    } catch {
      Alert.alert(t('parental.error'), t('parental.connectionError'));
    }
  }, [t]);

  // Lock the child's account NOW. Optimistic UI — flip childMeta locked
  // immediately, revert on failure.
  const lockChildNow = useCallback((child) => {
    Alert.alert(
      t('parental.lockNowTitle') || 'Pausar app agora?',
      `${t('parental.lockNowDesc') || 'A criança vai ver a tela de bloqueio até você liberar.'} (${child.child_name})`,
      [
        { text: t('parental.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('parental.lockNow') || 'Pausar',
          style: 'destructive',
          onPress: async () => {
            haptics.warning();
            const prev = childMeta[child.child_email];
            setChildMeta(p => ({ ...p, [child.child_email]: { ...(p[child.child_email] || {}), locked: true, locked_at: new Date().toISOString() } }));
            try {
              const r = await api.parentalLockChild(child.child_email);
              if (!r?.success) throw new Error('lock failed');
            } catch {
              if (isMountedRef.current) {
                setChildMeta(p => ({ ...p, [child.child_email]: prev || {} }));
                Alert.alert(t('parental.error'), t('parental.connectionError'));
              }
            }
          },
        },
      ]
    );
  }, [t, childMeta, isMountedRef]);

  // [2026-10-08 parental-redesign] "Pausar" virou toggle: retomar libera na
  // hora (otimista, reverte em falha) via parental_update_restrictions locked=false.
  const unlockChildNow = useCallback(async (child) => {
    haptics.success();
    const prev = childMeta[child.child_email];
    setChildMeta(p => ({ ...p, [child.child_email]: { ...(p[child.child_email] || {}), locked: false } }));
    try {
      const r = await api.parentalUnlockChild(child.child_email);
      if (!r?.success) throw new Error('unlock failed');
    } catch {
      if (isMountedRef.current) {
        setChildMeta(p => ({ ...p, [child.child_email]: prev || {} }));
        Alert.alert(t('parental.error'), t('parental.connectionError'));
      }
    }
  }, [t, childMeta, isMountedRef]);

  // Grant +15 min bonus screen-time. Works even when no daily limit set.
  const grantBonusTime = useCallback(async (child) => {
    haptics.success();
    try {
      const r = await api.parentalGrantExtraTime(child.child_email, 15);
      if (r?.success) {
        Alert.alert(
          t('parental.bonusGranted') || 'Tempo concedido!',
          (t('parental.bonusGrantedDesc') || '+15 minutos liberados para').concat(' ', child.child_name)
        );
        // [2026-10-19 parental-premium] bônus do dia separado do limite (antes
        // somava 15 no limite → criava um "limite de 15 min" falso p/ quem não
        // tinha limite). parental_grant_extra_time devolve o total do dia.
        const total = Number(r?.data?.minutes_today_total);
        setChildMeta(p => ({
          ...p,
          [child.child_email]: {
            ...(p[child.child_email] || {}),
            bonus_today: Number.isFinite(total) && total > 0 ? total : (p[child.child_email]?.bonus_today || 0) + 15,
          },
        }));
      } else {
        Alert.alert(t('parental.error'), r?.message || t('parental.connectionError'));
      }
    } catch {
      Alert.alert(t('parental.error'), t('parental.connectionError'));
    }
  }, [t]);

  // ─── [2026-10-08 parental-pages2] Wizard "Adicionar filho" redesenhado ───
  // Mesma linguagem do SettingsKit: header nativo "Adicionar filho" + barra
  // de progresso fina (1/4), campos com label acima + caixa preenchida e
  // ícone SVG, data por seletor de rodas (DD/MM/AAAA, sem emoji), gênero e
  // parentesco como segmented control, cartões monocromáticos e botão
  // primário (preto no claro / branco no escuro) preso acima do teclado.
  // Validação (idade 6–13), chamadas de API e fluxo dos 4 passos inalterados.

  // ─── Confetti Overlay (tons neutros) ───
  const CONFETTI_COLORS = isDark
    ? ['#F5F5F7', '#8E8E93', '#C7C7CC', '#636366', '#FFFFFF', '#AEAEB2']
    : ['#111111', '#8E8E93', '#C7C7CC', '#3A3A3C', '#D1D1D6', '#636366'];
  const renderConfetti = () => {
    if (!showConfetti) return null;
    return (
      <View style={s.confettiContainer} pointerEvents="none">
        {confettiAnims.map((anim, i) => (
          <Animated.View
            key={i}
            style={[s.confettiPiece, {
              backgroundColor: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              width: 7 + (i % 4) * 2,
              height: 7 + ((i + 1) % 4) * 2,
              borderRadius: i % 2 ? 50 : 2,
              transform: [
                { translateX: anim.x },
                { translateY: anim.y },
                { rotate: anim.rotate.interpolate({ inputRange: [0, 10], outputRange: ['0deg', '360deg'] }) },
              ],
              opacity: anim.opacity,
            }]}
          />
        ))}
      </View>
    );
  };

  const STEP_LABELS_KEYS = ['parental.stepInfo', 'parental.stepVerify', 'parental.stepProcessing', 'parental.stepReady'];
  const stripBullet = (txt) => String(txt || '').replace(/^\s*[••\-]\s*/, '');

  // Nomes dos meses no idioma do app (rodas do seletor de data).
  const monthNames = (() => {
    try {
      const loc = t('_locale');
      const out = Array.from({ length: 12 }, (_, i) => {
        const n = new Date(2000, i, 1).toLocaleDateString(loc && loc !== '_locale' ? loc : undefined, { month: 'long' });
        return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
      });
      return out.every(n => n && !/^\d+$/.test(n)) ? out : null;
    } catch { return null; }
  })();

  const wizTitle = (title, sub) => (
    <View style={w.head}>
      <Text style={[w.title, { color: gw.text }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{title}</Text>
      {!!sub && <Text style={[w.sub, { color: gw.secondary }]} maxFontSizeMultiplier={1.4}>{sub}</Text>}
    </View>
  );

  // ─── Wizard Step 1: Child Info ───
  const renderStepInfo = () => {
    const presets = isAgeValid ? getAgePresets(childAge) : null;
    const ageHelp = childAge === null
      ? (childBirthday ? '' : t('parentalWiz.birthHint'))
      : isAgeValid
        ? t('parentalWiz.ageOk', { age: childAge, min: presets.screenTime, bed: presets.bedtimeStart })
        : t('parentalWiz.ageInvalid', { age: childAge });
    return (
      <ScrollView
        contentContainerStyle={w.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        showsVerticalScrollIndicator={false}
      >
        {wizTitle(t('parentalWiz.infoTitle'), t('parental.addChildDesc'))}

        <View style={w.field}>
          <FieldLabel>{t('parentalWiz.nameLabel')}</FieldLabel>
          <FilledField Icon={IconUser} focused={nameFocused} error={!!nameError}>
            <TextInput
              ref={nameInputRef}
              style={[w.input, { color: gw.text }]}
              placeholder={t('parental.namePlaceholder')}
              placeholderTextColor={gw.tertiary}
              value={childName}
              onChangeText={(v) => { setChildName(v); if (nameError) setNameError(''); }}
              onFocus={() => setNameFocused(true)}
              onBlur={() => {
                setNameFocused(false);
                if (childName.trim().length < 2) setNameError(t('parental.errorNameShort'));
                else setNameError('');
              }}
              autoFocus
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
              onSubmitEditing={() => { try { Keyboard.dismiss(); } catch {} if (!childBirthday) setDateSheetOpen(true); }}
              accessibilityLabel={t('parentalWiz.nameLabel')}
            />
          </FilledField>
          {nameError ? (
            <FieldHelp error>{nameError}</FieldHelp>
          ) : (childName.trim().length > 2 && suggestedUser ? (
            <FieldHelp>{`${t('parental.suggestedUsername')}: ${suggestedUser}`}</FieldHelp>
          ) : null)}
        </View>

        <View style={w.field}>
          <FieldLabel>{t('parentalWiz.birthLabel')}</FieldLabel>
          <FilledField
            Icon={IconCalendar}
            onPress={() => { try { Keyboard.dismiss(); } catch {} setDateSheetOpen(true); }}
            error={childAge !== null && !isAgeValid}
            accessibilityLabel={`${t('parentalWiz.birthLabel')}${childBirthday ? ', ' + childBirthday : ''}`}
            right={<IconChevronRight size={17} color={gw.tertiary} />}
          >
            <View testID="birthdate-field">
              <Text style={[w.input, { color: childBirthday ? gw.text : gw.tertiary, fontVariant: ['tabular-nums'] }]} numberOfLines={1}>
                {childBirthday || t('parentalWiz.datePlaceholder')}
              </Text>
            </View>
          </FilledField>
          {birthdateError ? <FieldHelp error>{birthdateError}</FieldHelp> : (ageHelp ? <FieldHelp error={childAge !== null && !isAgeValid}>{ageHelp}</FieldHelp> : null)}
        </View>

        <View style={w.field}>
          <FieldLabel>{t('parentalWiz.genderLabel')}</FieldLabel>
          <SegmentedControl
            size="lg"
            options={genders.map(gd => ({ value: gd.key, label: gd.label }))}
            value={childGender}
            onChange={setChildGender}
          />
        </View>

        <View style={w.field}>
          <FieldLabel>{t('parentalWiz.relLabel')}</FieldLabel>
          <SegmentedControl
            size="lg"
            options={relationships.map(r => ({ value: r.key, label: r.label }))}
            value={relationship}
            onChange={setRelationship}
          />
        </View>

        <View style={[w.note, { backgroundColor: gw.fill }]}>
          <IconShield size={16} color={gw.secondary} />
          <Text style={[w.noteText, { color: gw.secondary }]} maxFontSizeMultiplier={1.4}>{t('parentalWiz.privacyNote')}</Text>
        </View>
      </ScrollView>
    );
  };

  // ─── Wizard Step 2: Safety Verification ───
  const VERIFY_METHODS = [
    { key: 'document', Icon: IconFileText, title: t('parental.verifyDocTitle'), sub: t('parental.verifyDocDesc') },
    { key: 'phone', Icon: IconSmartphone, title: t('parental.verifyPhoneTitle'), sub: t('parental.verifyPhoneDesc') },
    { key: 'card', Icon: IconLock, title: t('parental.verifyCardTitle'), sub: t('parental.verifyCardDesc') },
  ];
  const renderStepDocument = () => (
    <ScrollView contentContainerStyle={w.content} showsVerticalScrollIndicator={false}>
      {wizTitle(t('parental.safetyVerification'), t('parental.whyWeVerify'))}

      <SettingsGroup header={t('parentalWiz.methodHeader')} inset={58}>
        {VERIFY_METHODS.map(m => (
          <SettingsRow
            key={m.key}
            icon={m.Icon}
            title={m.title}
            subtitle={m.sub}
            numberOfLines={2}
            checked={verifyMethod === m.key}
            accessibilityRole="radio"
            onPress={() => { setVerifyMethod(m.key); if (Platform.OS !== 'web') { try { haptics.selection(); } catch {} } }}
          />
        ))}
      </SettingsGroup>

      {verifyMethod === 'document' && (
        <View style={{ marginBottom: 26 }}>
          {docImage ? (
            <View style={[w.docPreview, { backgroundColor: gw.cardBg }]}>
              <Image source={{ uri: docImage.uri }} style={w.docImage} resizeMode="contain" />
              <TouchableOpacity style={w.docRemove} onPress={() => setDocImage(null)} accessibilityRole="button" accessibilityLabel={t('parentalDash.cancel')} hitSlop={8}>
                <IconX size={16} color="#fff" />
              </TouchableOpacity>
              <View style={[w.docBadge, { backgroundColor: ink }]}>
                <IconCheck size={12} color={onInk} />
                <Text style={[w.docBadgeText, { color: onInk }]}>{t('parental.documentDetected')}</Text>
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <MonoTile Icon={IconCamera} label={t('parental.takePhoto')} a11y={`${t('parental.takePhoto')} ${t('parental.ofDocument')}`} onPress={() => pickDocument(true)} />
              <MonoTile Icon={IconImage} label={t('parental.gallery')} a11y={`${t('parental.gallery')} — ${t('parental.selectPhoto')}`} onPress={() => pickDocument(false)} />
            </View>
          )}
          <Text style={[w.footnote, { color: gw.header }]}>
            {`${String(t('parental.acceptedDocs')).replace(/:\s*$/, '')}: ${[t('parental.docType1'), t('parental.docType2'), t('parental.docType3')].map(stripBullet).join(' · ')}`}
          </Text>
        </View>
      )}

      <SettingsGroup header={t('parentalWiz.privacyHeader')} inset={52}>
        <SettingsRow icon={IconShield} iconTile={false} title={t('parental.trust256bit')} />
        <SettingsRow icon={IconLock} iconTile={false} title={t('parental.trustDeleted')} />
        <SettingsRow icon={IconCheck} iconTile={false} title={t('parental.trustLGPD')} />
      </SettingsGroup>
    </ScrollView>
  );

  // ─── Wizard Step 3: Verification in Progress ───
  const renderStepVerifying = () => (
    <ScrollView contentContainerStyle={[w.content, { paddingTop: 36 }]} showsVerticalScrollIndicator={false}>
      <View style={{ alignItems: 'center', marginBottom: 22 }}>
        <View style={[w.bigCircle, { backgroundColor: gw.cardBg }]}>
          <ActivityIndicator size="large" color={ink} />
        </View>
        <Text style={[w.title, { color: gw.text, textAlign: 'center', marginTop: 16 }]} accessibilityLiveRegion="polite">{t(VERIFY_STAGE_KEYS[verifyStage])}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <IconClock size={14} color={gw.secondary} />
          <Text style={[w.sub, { color: gw.secondary, marginTop: 0 }]}>{t('parental.usuallyLessThan')}</Text>
        </View>
      </View>

      <SettingsGroup inset={52}>
        {VERIFY_STAGE_KEYS.map((key, i) => {
          const isActive = i === verifyStage;
          const isDone = i < verifyStage;
          return (
            <View key={key} style={w.stageRow}>
              <View style={[w.stageDot, { backgroundColor: isDone ? ink : gw.fill }]}>
                {isDone ? <IconCheck size={12} color={onInk} /> : isActive ? <ActivityIndicator size="small" color={gw.text} /> : null}
              </View>
              <Text style={[w.stageText, { color: isDone || isActive ? gw.text : gw.secondary, fontWeight: isActive ? '600' : '400' }]}>{t(key)}</Text>
            </View>
          );
        })}
      </SettingsGroup>

      <SettingsGroup header={String(t('parental.didYouKnow')).replace(/[?:]\s*$/, '')} inset={52}>
        <SettingsRow icon={IconSparkles} iconTile={false} title={t(SAFETY_FACTS_KEYS[safetyFactIdx])} numberOfLines={4} />
      </SettingsGroup>
    </ScrollView>
  );

  // ─── Wizard Step 4: Account Ready! ───
  const copyText = (txt) => {
    if (!txt) return;
    if (Platform.OS === 'web') { try { navigator.clipboard.writeText(txt); } catch {} }
  };
  const renderStepCredentials = () => {
    const approved = docVerdict?.verdict === 'approved';
    const presets = childAge ? getAgePresets(childAge) : null;
    const QUICK = presets ? [
      { key: 'bedtime', Icon: IconMoon, title: t('parental.setupBedtime'), sub: `${presets.bedtimeStart} – ${presets.bedtimeEnd}` },
      { key: 'screenTime', Icon: IconClock, title: t('parental.setupScreenTime'), sub: `${presets.screenTime} ${t('parental.minutesPerDay')}` },
      { key: 'contacts', Icon: IconUsers, title: t('parental.setupContacts'), sub: t('parental.setupContactsDesc') },
      { key: 'safeSearch', Icon: IconSearch, title: t('parental.setupSafeSearch'), sub: t('parental.setupSafeSearchDesc') },
      { key: 'filterAdult', Icon: IconAlertCircle, title: t('parental.filterAdult') || 'Block adult content', sub: t('parental.filterAdultDesc') || '' },
      { key: 'filterViolence', Icon: IconShield, title: t('parental.filterViolence') || 'Block violence', sub: t('parental.filterViolenceDesc') || '' },
      { key: 'filterProfanity', Icon: IconMessageSquare, title: t('parental.filterProfanity') || 'Filter profanity', sub: t('parental.filterProfanityDesc') || '' },
    ] : [];

    return (
      <ScrollView contentContainerStyle={w.content} showsVerticalScrollIndicator={false}>
        {renderConfetti()}

        <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 22 }}>
          <View style={[w.bigCircle, { backgroundColor: approved ? ink : gw.cardBg }]}>
            {approved ? <IconCheck size={30} color={onInk} /> : <IconClock size={30} color={gw.text} />}
          </View>
          <Text style={[w.title, { color: gw.text, textAlign: 'center', marginTop: 14 }]} accessibilityRole="header">
            {approved ? t('parental.accountReady') : t('parental.documentReview')}
          </Text>
          <Text style={[w.sub, { color: gw.secondary, textAlign: 'center' }]}>
            {approved ? t('parental.accountReadyDesc') : t('parental.documentReviewDesc')}
          </Text>
        </View>

        {newChild && approved && (
          <SettingsGroup>
            <View style={w.childRow}>
              <AvatarCircle email={newChild.child_email} name={newChild.child_name} size={44} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                <Text style={[w.childName, { color: gw.text }]} numberOfLines={1}>{newChild.child_name}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                  <IconShield size={13} color={gw.secondary} />
                  <Text style={{ fontSize: 13, color: gw.secondary }}>{t('parental.protectedAccount')}</Text>
                </View>
              </View>
            </View>
          </SettingsGroup>
        )}

        {newChild && (
          <SettingsGroup header={t('parental.accountCredentials')} footer={t('parental.saveCredentials')}>
            {[
              { key: 'email', label: t('parental.email'), value: newChild.child_email, copy: newChild.child_email },
              { key: 'pwd', label: t('parental.password'), value: newChild.child_password || '••••••••', copy: newChild.child_password },
            ].map(c => (
              <View key={c.key} style={w.credRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 13, color: gw.secondary }}>{c.label}</Text>
                  <Text style={[w.credValue, { color: gw.text }]} selectable numberOfLines={1}>{c.value}</Text>
                </View>
                <TouchableOpacity
                  style={[w.copyBtn, { backgroundColor: gw.fill }]}
                  onPress={() => copyText(c.copy)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('parentalWiz.copy')} ${c.label}`}
                  hitSlop={6}
                >
                  <IconCopy size={15} color={gw.text} />
                </TouchableOpacity>
              </View>
            ))}
          </SettingsGroup>
        )}

        {approved && presets && (
          <SettingsGroup header={t('parental.quickSetupTitle')} footer={`${t('parental.recommendedFor')} ${childAge} ${t('parental.yearsOld')}`}>
            {QUICK.map(q => (
              <SettingsSwitchRow
                key={q.key}
                icon={q.Icon}
                title={q.title}
                subtitle={q.sub}
                value={!!quickSetup[q.key]}
                onValueChange={() => setQuickSetup(p => ({ ...p, [q.key]: !p[q.key] }))}
              />
            ))}
            <SettingsRow
              title={t('parental.applyRecommended')}
              center
              chevron={false}
              titleStyle={{ fontWeight: '600' }}
              onPress={() => {
                setQuickSetup({ bedtime: true, contacts: true, screenTime: true, safeSearch: true, filterAdult: true, filterViolence: true, filterProfanity: true });
                if (Platform.OS !== 'web') try { haptics.selection(); /* [2026-10-07 native-polish] */ } catch {}
              }}
            />
          </SettingsGroup>
        )}

        {docVerdict && (
          <SettingsGroup header={t('parental.verificationResult')}>
            <SettingsRow
              title={t('parentalWiz.status')}
              value={approved ? t('parental.approved') : docVerdict.verdict === 'rejected' ? t('parental.rejected') : t('parental.manualReview')}
            />
            <SettingsRow title={t('parental.confidence')} value={`${Math.round((docVerdict.confidence || 0) * 100)}%`} />
          </SettingsGroup>
        )}
      </ScrollView>
    );
  };
  // [2026-10-08 parental-redesign] Tokens do painel (grouped bg + cards brancos, hairline).
  // [2026-10-19 parental-premium] mesmos tokens do hub Família / Configurações.
  const PAGE_BG = fc.pageBg;
  const CARD_BG = fc.cardBg;
  const HAIR = fc.separator;
  const TILE_BG = fc.chipBg;

  // ─── Child Card Renderer ───
  // [2026-10-08 parental-redesign] Card do filho reescrito no padrão B&W
  // premium (iOS Tempo de Uso / Google Family Link): avatar 52 sem halo
  // duplo, nome 17 semibold, e-mail em fonte do sistema, status como texto
  // + ponto pequeno (sem pílulas coloridas), resumo do dia (tempo de tela,
  // modo noturno, local, alertas) e 4 ações que nunca truncam — Mensagens,
  // Pausar/Retomar (toggle), +15 min e "Mais" (local, tempo de tela,
  // resumo IA, enviar mensagem). A grade "Ações rápidas" (que só agia no
  // children[0]) saiu: tudo agora é por filho.
  const openChildMonitor = (child) => {
    router.push(`/parental-monitor?child_email=${encodeURIComponent(child.child_email)}&child_name=${encodeURIComponent(child.child_name)}`);
  };

  // [2026-10-19 parental-premium] atalhos do "Mais" p/ o monitor do filho:
  // open=restrictions abre direto Limites/Hora de dormir; tab=contacts abre
  // Contatos permitidos.
  const openChildMonitorAt = (child, extra) => {
    router.push(`/parental-monitor?child_email=${encodeURIComponent(child.child_email)}&child_name=${encodeURIComponent(child.child_name)}${extra ? `&${extra}` : ''}`);
  };

  const confirmRemoveChild = (child) => {
    Alert.alert(
      t('parentalDash.removeTitle', { name: child.child_name }),
      t('parentalDash.removeDesc'),
      [
        { text: t('parentalDash.cancel'), style: 'cancel' },
        {
          text: t('parentalDash.removeConfirm'),
          style: 'destructive',
          onPress: async () => {
            haptics.warning();
            try {
              const r = await api.parentalRevokeChild(child.child_email);
              if (!r?.success) throw new Error('revoke failed');
              if (!isMountedRef.current) return;
              setChildren(prev => {
                const next = (prev || []).filter(c => c.child_email !== child.child_email);
                setCache('parental_children', next, 2592000000).catch(() => {});
                return next;
              });
              setChildMeta(p => { const n = { ...p }; delete n[child.child_email]; return n; });
            } catch {
              if (isMountedRef.current) Alert.alert(t('parental.error'), t('parental.connectionError'));
            }
          },
        },
      ]
    );
  };

  const handleChildAction = (key, child) => {
    const meta = childMeta[child.child_email] || {};
    if (key === 'messages' || key === 'screenTime' || key === 'message' || key === 'activity') {
      openChildMonitor(child);
    } else if (key === 'limits' || key === 'bedtime') {
      openChildMonitorAt(child, 'open=restrictions');
    } else if (key === 'contacts') {
      openChildMonitorAt(child, 'tab=contacts');
    } else if (key === 'location') {
      openChildLocation(child);
    } else if (key === 'lock') {
      if (meta.locked) unlockChildNow(child);
      else lockChildNow(child);
    } else if (key === 'bonus') {
      grantBonusTime(child);
    } else if (key === 'summary') {
      openAiSummary(child);
    } else if (key === 'remove') {
      confirmRemoveChild(child);
    } else if (key === 'more') {
      setMoreChild(child);
    }
  };

  // "Mais" sheet — fecha o sheet ANTES de abrir o próximo modal (iOS não
  // apresenta dois Modals ao mesmo tempo); runAfterNativeSheet espera a
  // animação de saída do sheet do sistema.
  const runMoreAction = (key) => {
    const child = moreChild;
    setMoreChild(null);
    if (!child) return;
    haptics.selection();
    runAfterNativeSheet(() => { if (isMountedRef.current) handleChildAction(key, child); });
  };

  // ─── [2026-10-19 parental-premium] Cartão do filho (nível Tempo de Uso) ───
  // Avatar real (AvatarCircle → foto com fallback de iniciais), nome + idade,
  // pílula de status (Ativo / Pausado / Modo noturno / Aguardando aprovação),
  // anel de tempo de tela de hoje (usado x limite, estimado pela atividade),
  // chips (horário de dormir, último local + bateria, mensagens de hoje) e
  // barra segmentada de ações. Pausado = faixa escura + conteúdo esmaecido +
  // "Retomar". Pendente = chamada com os passos da verificação.
  const childAgeOf = (item) => {
    const a = Number(item?.age);
    if (Number.isFinite(a) && a > 0 && a < 30) return a;
    const b = String(item?.child_birthday || '');
    const iso = b.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return getAge(iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : b) || null;
  };

  const fmtClock = (d) => {
    try { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return ''; }
  };

  const pausedSince = (meta) => {
    const d = parseTs(meta?.locked_at);
    if (!d) return '';
    const sameDay = new Date(now).toDateString() === d.toDateString();
    return sameDay ? t('parentalDash.pausedSince', { time: fmtClock(d) }) : t('parentalDash.pausedSinceAgo', { ago: agoLabel(meta.locked_at, t, now) || '' });
  };

  const renderChild = ({ item }) => {
    const isGraduated = item.status === 'graduated';
    const isActive = item.status === 'active';
    const isPending = item.status === 'pending_verification';
    const meta = childMeta[item.child_email] || {};
    const paused = isActive && !!meta.locked;
    const online = isActive && !paused && isOnline(item);
    const bedtime = isActive ? bedtimeStatus(meta) : { active: false };
    const age = childAgeOf(item);

    let pill;
    if (paused) pill = { kind: 'paused', label: t('parentalDash.statusPaused') };
    else if (isActive && bedtime.active) pill = { kind: 'bedtime', label: t('parentalDash.bedtimeUntil', { time: bedtime.endLabel }) };
    else if (isActive) pill = { kind: 'active', label: online ? t('parentalDash.onlineNow') : t('parentalDash.statusActive') };
    else if (isPending) pill = { kind: 'pending', label: t('parentalDash.statusPending') };
    else if (item.status === 'suspended') pill = { kind: 'suspended', label: t('parental.suspended') };
    else if (item.status === 'revoked') pill = { kind: 'revoked', label: t('parental.revoked') };
    else if (isGraduated) pill = { kind: 'graduated', label: t('parental.graduated') };
    else pill = { kind: 'pending', label: t('parentalDash.statusPending') };

    // Tempo de tela de hoje (só quando a API respondeu algo).
    const hasST = isActive && meta.screen_time_used != null;
    const stUsed = Number(meta.screen_time_used || 0);
    const baseLimit = Number(meta.screen_time_limit || 0);
    const bonus = Number(meta.bonus_today || 0);
    const stLimit = baseLimit > 0 ? baseLimit + bonus : 0;
    const stOver = stLimit > 0 && stUsed >= stLimit;
    const stPct = stLimit > 0 ? Math.min(100, Math.round((stUsed / stLimit) * 100)) : 0;
    let stSub;
    if (stLimit > 0) stSub = stOver ? t('parentalDash.limitReached', { limit: fmtMinutes(stLimit, t) }) : t('parentalDash.ofLimitLeft', { limit: fmtMinutes(stLimit, t), left: fmtMinutes(stLimit - stUsed, t) });
    else stSub = t('parentalDash.noDailyLimit');
    if (bonus > 0) stSub = `${stSub} · ${t('parentalDash.bonusToday', { n: bonus })}`;

    // Chips de contexto.
    const chips = [];
    if (isActive && !bedtime.active && meta.bedtime_start && meta.bedtime_end) {
      chips.push(<MetaChip key="bed" Icon={IconMoon} label={t('parentalDash.bedtimeRange', { start: meta.bedtime_start, end: meta.bedtime_end })} />);
    }
    if (isActive && meta.has_location) {
      const ago = meta.loc_at ? agoLabel(meta.loc_at, t, now) : null;
      const parts = [ago ? t('parentalDash.locationAgo', { ago }) : t('parentalDash.moreLocation')];
      if (meta.battery != null) parts.push(t('parentalDash.battery', { n: meta.battery }));
      chips.push(<MetaChip key="loc" Icon={IconMapPin} label={parts.join(' · ')} onPress={() => openChildLocation(item)} a11y={t('parentalDash.openLocationA11y', { name: item.child_name })} />);
    }
    if (isActive && meta.messages_today != null && meta.messages_today > 0) {
      chips.push(<MetaChip key="msg" Icon={IconMessageSquare} label={meta.messages_today === 1 ? t('parentalDash.msgsTodayOne') : t('parentalDash.msgsTodayMany', { n: meta.messages_today })} />);
    }
    const alerts = Number(item.unread_alerts || 0);
    if (alerts > 0) chips.push(<MetaChip key="alerts" Icon={IconAlertCircle} label={alerts === 1 ? t('parentalDash.alertOne') : t('parentalDash.alertsMany', { n: alerts })} />);
    if (isGraduated) chips.push(<MetaChip key="grad" Icon={IconStar} label={t('parental.turnedThirteen')} />);

    const onCardPress = () => {
      haptics.tap('light');
      if (isActive) openChildMonitor(item);
      else if (isPending) {
        setNewChild({ account_id: item.id, child_email: item.child_email, child_name: item.child_name });
        setShowWizard(true);
        setStep(1);
      }
    };

    const a11yParts = [item.child_name, age ? t('parentalDash.ageYears', { n: age }) : null, pill.label].filter(Boolean);

    return (
      <View style={[s.childCard, { backgroundColor: fc.cardBg }]}>
        {paused && (
          <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
            <PausedBanner
              title={t('parentalDash.pausedTitle')}
              sub={pausedSince(meta) || t('parentalDash.pausedSub')}
              cta={t('parentalDash.actResume')}
              onResume={() => unlockChildNow(item)}
            />
          </View>
        )}

        <View style={paused ? { opacity: 0.45 } : null}>
          <TouchableOpacity
            style={s.childCardMain}
            onLongPress={() => { if (isActive) { haptics.tap('medium'); openAiSummary(item); } }}
            onPress={onCardPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={a11yParts.join(', ')}
          >
            <View style={s.avatarWrap}>
              <AvatarCircle email={item.child_email} name={item.child_name} size={56} />
              {online && (
                <OnlineDot
                  key={`online-${item.child_email}-${onlineFlashes[item.child_email] || 0}`}
                  ringColor={fc.cardBg}
                  justWentOnline={!!onlineFlashes[item.child_email]}
                />
              )}
              {paused && (
                <View style={[s.lockBadge, { backgroundColor: fc.text, borderColor: fc.cardBg }]}>
                  <IconLock size={10} color={fc.onInk} />
                </View>
              )}
            </View>

            <View style={s.childInfo}>
              <Text style={[s.childName, { color: fc.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {item.child_name}
                {age ? <Text style={[s.childAge, { color: fc.secondary }]}>{`  ${t('parentalDash.ageYears', { n: age })}`}</Text> : null}
              </Text>
              <Text style={[s.childEmail, { color: fc.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{item.child_email}</Text>
              <StatusPill kind={pill.kind} label={pill.label} />
            </View>
            <IconChevronRight size={18} color={fc.tertiary} />
          </TouchableOpacity>

          {hasST && (
            <View style={[s.stBlock, { borderTopColor: fc.separator }]}>
              <ScreenTimeRing size={58} stroke={6} used={stUsed} limit={stLimit}>
                {stLimit > 0 ? (
                  <Text style={[s.ringPct, { color: stOver ? fc.danger : fc.text }]} allowFontScaling={false}>{`${stPct}%`}</Text>
                ) : (
                  <IconClock size={18} color={fc.secondary} />
                )}
              </ScreenTimeRing>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[s.stLabel, { color: fc.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('parentalDash.screenTimeLabel')}</Text>
                <Text style={[s.stBig, { color: stOver ? fc.danger : fc.text }]} numberOfLines={1} maxFontSizeMultiplier={1.25}>{fmtMinutes(stUsed, t)}</Text>
                <Text style={[s.stSub, { color: fc.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{stSub}</Text>
              </View>
            </View>
          )}

          {chips.length > 0 && <View style={[s.chipsRow, !hasST && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: fc.separator, paddingTop: 12 }]}>{chips}</View>}
        </View>

        {isActive && (
          <View style={s.actWrap}>
            <ActionSegments
              items={[
                { key: 'messages', Icon: IconMessageSquare, label: t('parentalDash.actMessages'), onPress: () => handleChildAction('messages', item) },
                { key: 'lock', Icon: paused ? IconPlay : IconPause, label: paused ? t('parentalDash.actResume') : t('parentalDash.actPause'), active: paused, onPress: () => handleChildAction('lock', item) },
                { key: 'bonus', Icon: IconPlus, label: t('parentalDash.actBonus'), a11y: t('parentalDash.actBonusA11y'), onPress: () => handleChildAction('bonus', item) },
                { key: 'more', Icon: IconMoreHorizontal, label: t('parentalDash.actMore'), a11y: t('parentalDash.moreA11y'), onPress: () => handleChildAction('more', item) },
              ]}
            />
          </View>
        )}

        {isPending && (
          <View style={s.actWrap}>
            <VerifyCallout
              title={t('parentalDash.verifyTitle')}
              sub={t('parentalDash.verifySub', { name: item.child_name })}
              steps={[
                { label: t('parentalDash.verifyStep1'), state: 'done' },
                { label: t('parentalDash.verifyStep2'), state: 'current' },
                { label: t('parentalDash.verifyStep3'), state: 'todo' },
              ]}
              cta={t('parentalDash.finishVerification')}
              onPress={onCardPress}
            />
          </View>
        )}
      </View>
    );
  };

  // ─── Main Wizard Render ───
  // [2026-10-08 parental-pages2] header nativo + progresso fino + CTA acima do teclado.
  const wizardBack = () => (step > 0 && step < 3 ? setStep(step - 1) : resetWizard());
  wizardBackRef.current = wizardBack;
  if (showWizard) {
    const stepViews = [renderStepInfo, renderStepDocument, renderStepVerifying, renderStepCredentials];
    const isLast = step === 3;
    const canNext = step === 0
      ? (childName.trim() && isAgeValid && relationship && !nameError && !birthdateError)
      : step === 1
        ? (verifyMethod === 'document' ? !!docImage : !!verifyMethod)
        : false;
    const footerPad = Platform.OS === 'web' ? Math.max(insets.bottom, 0) + 16 : Math.max(insets.bottom + 8, 16);
    const stepCount = `${step + 1}/4`;
    const ctaLabel = isLast ? t('parental.finish') : (step === 0 ? t('parental.next') : t('parental.startVerification'));

    return (
      <ThreadKeyboardAvoider style={[s.container, { backgroundColor: gw.pageBg }]} bottomInset={footerPad - 12}>
        {USE_NATIVE_HEADER ? (
          <Stack.Screen options={nativeHeaderOptions({
            colors,
            isDark,
            title: t('parentalDash.addChild'),
            headerShown: true,
            headerLargeTitle: false,
            headerShadowVisible: false,
            headerStyle: { backgroundColor: gw.pageBg },
            contentStyle: { backgroundColor: gw.pageBg },
            headerLeft: () => <HeaderBackButton onPress={() => wizardBackRef.current?.()} color={colors.text} accessibilityLabel={t('parentalDash.back')} />,
            headerRight: () => <Text style={[w.stepCount, { color: gw.secondary }]}>{stepCount}</Text>,
          })} />
        ) : (
          <View style={[w.webHeader, { paddingTop: insets.top, backgroundColor: gw.pageBg }]}>
            <TouchableOpacity onPress={wizardBack} style={w.webBack} accessibilityLabel={t('parentalDash.back')} accessibilityRole="button" hitSlop={8}>
              <IconArrowLeft size={24} color={gw.text} />
            </TouchableOpacity>
            <Text style={[w.webTitle, { color: gw.text }]} numberOfLines={1} accessibilityRole="header">{t('parentalDash.addChild')}</Text>
            <View style={[w.webBack, { alignItems: 'flex-end' }]}>
              <Text style={[w.stepCount, { color: gw.secondary }]}>{stepCount}</Text>
            </View>
          </View>
        )}

        <View style={w.progressWrap}>
          <StepProgress step={step} total={4} />
          <Text style={[w.progressLabel, { color: gw.secondary }]} numberOfLines={1}>
            {t('parentalWiz.stepOf', { n: step + 1, total: 4, label: t(STEP_LABELS_KEYS[step]) })}
          </Text>
        </View>

        <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
          {stepViews[step]()}
        </Animated.View>

        {step !== 2 && (
          <View style={[w.footer, { paddingBottom: footerPad, backgroundColor: gw.pageBg }]}>
            <Animated.View style={{ transform: [{ scale: bounceAnim }] }}>
              <TouchableOpacity
                style={[w.cta, { backgroundColor: ink, opacity: (isLast || canNext) ? 1 : 0.35 }]}
                onPress={isLast ? resetWizard : handleNextStep}
                disabled={isLast ? false : (!canNext || creating)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={ctaLabel}
                accessibilityState={{ disabled: isLast ? false : (!canNext || creating), busy: creating }}
                testID="wizard-cta"
              >
                {creating ? <ActivityIndicator color={onInk} /> : (
                  <Text style={[w.ctaText, { color: onInk }]}>{ctaLabel}</Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          </View>
        )}

        <BirthDateSheet
          visible={dateSheetOpen}
          value={childBirthday}
          title={t('parentalWiz.birthLabel')}
          doneLabel={t('parentalWiz.done')}
          cancelLabel={t('parentalDash.cancel')}
          monthNames={monthNames}
          onClose={() => setDateSheetOpen(false)}
          onConfirm={(v) => { setChildBirthday(v); setBirthdateError(''); setDateSheetOpen(false); }}
        />
      </ThreadKeyboardAvoider>
    );
  }
  // ─── AI Summary Modal ───
  // Compose a shareable plain-text summary so parents can forward it to a
  // co-parent / pediatrician / school via the OS share sheet.
  const buildShareText = () => {
    if (!summaryData || !summaryChild) return '';
    const lines = [`${t('parental.aiSummary')} — ${summaryChild.child_name}`];
    if (summaryData.summary) lines.push('', summaryData.summary);
    if (summaryData.risk_level) lines.push('', `${riskLabel(summaryData.risk_level)}${summaryData.risk_reason ? ': ' + summaryData.risk_reason : ''}`);
    if (summaryData.highlights?.length) {
      lines.push('', (t('parental.highlights') || 'Destaques') + ':');
      summaryData.highlights.forEach(h => lines.push('• ' + h));
    }
    if (summaryData.flagged_items?.length) {
      lines.push('', (t('parental.flaggedContent') || 'Pontos de atenção') + ':');
      summaryData.flagged_items.forEach(f => lines.push('• ' + f));
    }
    if (summaryData.recommendations?.length) {
      lines.push('', (t('parental.recommendations') || 'Recomendações') + ':');
      summaryData.recommendations.forEach(r => lines.push('• ' + r));
    }
    return lines.join('\n');
  };

  const shareSummary = async () => {
    try {
      haptics.tap('light');
      const message = buildShareText();
      if (!message) return;
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: `${t('parental.aiSummary')} — ${summaryChild?.child_name || ''}`, text: message });
        } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(message);
          Alert.alert('', t('parental.copiedToClipboard') || 'Resumo copiado.');
        }
      } else {
        await Share.share({ message });
      }
    } catch {}
  };

  // Tiny inline markdown renderer — supports **bold** within a line. Keeps
  // newlines as paragraph breaks. Avoids pulling in a heavy markdown lib.
  const renderInlineMarkdown = (text, baseStyle) => {
    if (!text) return null;
    const lines = String(text).split('\n');
    return lines.map((ln, lineIdx) => {
      const parts = ln.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
      return (
        <Text key={lineIdx} style={baseStyle}>
          {parts.map((p, i) => {
            if (p.startsWith('**') && p.endsWith('**')) {
              return <Text key={i} style={{ fontWeight: '800' }}>{p.slice(2, -2)}</Text>;
            }
            return p;
          })}
          {lineIdx < lines.length - 1 ? '\n' : ''}
        </Text>
      );
    });
  };

  const renderSummaryModal = () => (
    <Modal visible={summaryModal} transparent animationType="fade" onRequestClose={() => setSummaryModal(false)}>
      <View style={s.modalOverlay}>
        <View style={[s.modalContent, { backgroundColor: isDark ? '#1c1c1e' : '#fff' }]}>
          <View style={s.modalHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
              {summaryChild && <AvatarCircle email={summaryChild.child_email} name={summaryChild.child_name} size={36} />}
              <View style={{ flex: 1 }}>
                <Text style={[s.modalTitle, { color: colors.text }]}>{t('parental.aiSummary')}</Text>
                {summaryChild && <Text style={[s.modalSub, { color: colors.textSecondary }]} numberOfLines={1}>{summaryChild.child_name}</Text>}
              </View>
            </View>
            {!summaryLoading && summaryData && !summaryData.error && (
              <TouchableOpacity onPress={shareSummary} style={[s.modalClose, { marginRight: 4 }]} accessibilityLabel={t('parental.share') || 'Compartilhar'} accessibilityRole="button">
                <IconCopy size={18} color={(colors?.primary || ACCENT)} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setSummaryModal(false)} style={s.modalClose} accessibilityLabel={t('common.close')} accessibilityRole="button">
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.modalBody} showsVerticalScrollIndicator={false}>
            {summaryLoading ? (
              <View style={s.summaryLoading}>
                <ActivityIndicator size="large" color={(colors?.primary || ACCENT)} />
                <Text style={[s.summaryLoadingText, { color: colors.textSecondary }]}>{t('parental.loadingSummary')}</Text>
              </View>
            ) : summaryData?.error ? (
              <View style={s.summaryError}>
                <IconAlertCircle size={24} color="#ef4444" />
                <Text style={[s.summaryErrorText, { color: '#ef4444' }]}>{summaryData.error}</Text>
              </View>
            ) : summaryData ? (
              <View style={{ gap: 16 }}>
                {summaryData.risk_level && (
                  <View style={[s.summaryRisk, { backgroundColor: riskColor(summaryData.risk_level) + '12', borderColor: riskColor(summaryData.risk_level) + '30' }]}>
                    <IconShield size={18} color={riskColor(summaryData.risk_level)} />
                    <View style={{ flex: 1 }}>
                      <Text style={[s.summaryRiskLabel, { color: riskColor(summaryData.risk_level) }]}>{riskLabel(summaryData.risk_level)}</Text>
                      {summaryData.risk_reason && <Text style={[s.summaryRiskReason, { color: colors.textSecondary }]}>{summaryData.risk_reason}</Text>}
                    </View>
                  </View>
                )}

                {summaryData.summary && (
                  <View style={[s.summarySection, { borderColor: isDark ? '#2c2c2e' : '#e2e8f0' }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <IconSparkles size={14} color={(colors?.primary || ACCENT)} />
                      <Text style={[s.summarySectionTitle, { color: colors.textSecondary, marginBottom: 0 }]}>{t('parental.summary')}</Text>
                    </View>
                    {renderInlineMarkdown(summaryData.summary, [s.summarySectionBody, { color: colors.text }])}
                  </View>
                )}

                {summaryData.highlights?.length > 0 && (
                  <View style={[s.summarySection, { borderColor: '#22c55e30' }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <IconStar size={14} color="#22c55e" />
                      <Text style={[s.summarySectionTitle, { color: '#22c55e', marginBottom: 0 }]}>{t('parental.highlights') || 'Destaques'}</Text>
                    </View>
                    {summaryData.highlights.map((h, i) => (
                      <View key={i} style={s.flaggedItem}>
                        <Text style={{ color: '#22c55e' }}>•</Text>
                        <Text style={[s.flaggedText, { color: colors.text }]}>{h}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {summaryData.stats && (
                  <View style={s.summaryStats}>
                    {summaryData.stats.messages_today !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0b0b0b' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.messages_today}</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.msgsToday')}</Text>
                      </View>
                    )}
                    {summaryData.stats.calls_today !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0b0b0b' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.calls_today}</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.calls')}</Text>
                      </View>
                    )}
                    {summaryData.stats.screen_time_minutes !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0b0b0b' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.screen_time_minutes}m</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.screenTime')}</Text>
                      </View>
                    )}
                  </View>
                )}

                {summaryData.flagged_items?.length > 0 && (
                  <View style={[s.summarySection, { borderColor: '#ef444430' }]}>
                    <Text style={[s.summarySectionTitle, { color: '#ef4444' }]}>{t('parental.flaggedContent')}</Text>
                    {summaryData.flagged_items.map((item, i) => (
                      <View key={i} style={s.flaggedItem}>
                        <Text style={{ color: '#ef4444' }}>-</Text>
                        <Text style={[s.flaggedText, { color: colors.text }]}>{item}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {summaryData.recommendations?.length > 0 && (
                  <View style={[s.summarySection, { borderColor: isDark ? '#2c2c2e' : '#e2e8f0' }]}>
                    <Text style={[s.summarySectionTitle, { color: (colors?.primary || ACCENT) }]}>{t('parental.recommendations')}</Text>
                    {summaryData.recommendations.map((rec, i) => (
                      <View key={i} style={s.flaggedItem}>
                        <Text style={{ color: (colors?.primary || ACCENT) }}>-</Text>
                        <Text style={[s.flaggedText, { color: colors.text }]}>{rec}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  // [2026-10-08 parental-redesign] Pedidos dos filhos — o banner antes só
  // setava `requestsModal` e NADA era renderizado (botão morto). Agora abre
  // um sheet com Aprovar / Recusar (parental_resolve_request).
  const pendingCount = (pendingRequests || []).length;

  const resolveRequest = async (req, decision) => {
    if (!req?.id || resolvingId) return;
    setResolvingId(req.id);
    try {
      const r = await api.parentalResolveRequest(req.id, decision);
      if (!isMountedRef.current) return;
      if (r?.success || r?.status === 409) {
        if (decision === 'approved') haptics.success(); else haptics.tap('light');
        setPendingRequests(prev => {
          const next = (prev || []).filter(x => x.id !== req.id);
          if (next.length === 0) setRequestsModal(false);
          return next;
        });
      } else {
        Alert.alert(t('parental.error'), r?.message || t('parental.connectionError'));
      }
    } catch {
      if (isMountedRef.current) Alert.alert(t('parental.error'), t('parental.connectionError'));
    } finally {
      if (isMountedRef.current) setResolvingId(null);
    }
  };

  const requestReasonLabel = (req) => {
    const map = {
      bedtime: 'parentalDash.reasonBedtime',
      bedtime_unlock: 'parentalDash.reasonBedtime',
      screen_time: 'parentalDash.reasonScreenTime',
      extra_time: 'parentalDash.reasonScreenTime',
      chat_disabled: 'parentalDash.reasonChat',
      chat_unlock: 'parentalDash.reasonChat',
      contact: 'parentalDash.reasonContact',
      contact_approval: 'parentalDash.reasonContact',
      contact_blocked: 'parentalDash.reasonContact',
      new_contact: 'parentalDash.reasonContact',
      feed_disabled: 'parentalDash.reasonFeed',
      calls_disabled: 'parentalDash.reasonCalls',
      new_app: 'parentalDash.reasonApp',
    };
    const k = map[String(req?.reason || '').toLowerCase()];
    return k ? t(k) : t('parentalDash.reasonGeneric');
  };

  const reqName = (req) => ((req?.child_name && !String(req.child_name).includes('@')) ? req.child_name : String(req?.child_email || '').split('@')[0]);

  // ─── [2026-10-19 parental-premium] Folhas do sistema (NativeSheetDialog) ───
  // iOS/Android: UISheetPresentationController / BottomSheet (grabber, arrastar,
  // fundo nativo); web: Modal com painel inferior.
  const SHEET_OVERLAY = { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' };
  const sheetPanel = { backgroundColor: PAGE_BG, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 22, paddingBottom: Math.max(insets.bottom, 12) + 8, width: '100%', maxWidth: 560, alignSelf: 'center' };

  const renderSheetHead = (title, subtitle, avatar) => (
    <View style={s.sheetHead}>
      {avatar ? <AvatarCircle email={avatar.email} name={avatar.name} size={44} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.sheetTitle, { color: fc.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={[s.sheetSub, { color: fc.secondary }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </View>
  );

  const MORE_GROUPS = [
    [
      { key: 'limits', Icon: IconClock, label: t('parentalDash.moreLimits') },
      { key: 'bedtime', Icon: IconMoon, label: t('parentalDash.moreBedtime') },
      { key: 'contacts', Icon: IconUsers, label: t('parentalDash.moreContacts') },
      { key: 'location', Icon: IconMapPin, label: t('parentalDash.moreLocation') },
    ],
    [
      { key: 'activity', Icon: IconBarChart, label: t('parentalDash.moreActivity') },
      { key: 'summary', Icon: IconSparkles, label: t('parentalDash.moreSummary') },
    ],
    [
      { key: 'remove', Icon: IconX, label: t('parentalDash.moreRemove'), destructive: true },
    ],
  ];

  const renderMoreSheet = () => {
    const moreMeta = moreChild ? (childMeta[moreChild.child_email] || {}) : {};
    const moreAge = moreChild ? childAgeOf(moreChild) : null;
    const sub = [moreAge ? t('parentalDash.ageYears', { n: moreAge }) : null, moreMeta.locked ? t('parentalDash.statusPaused') : null, moreChild?.child_email].filter(Boolean).join(' · ');
    return (
      <NativeSheetDialog
        visible={!!moreChild}
        onClose={() => setMoreChild(null)}
        overlayStyle={SHEET_OVERLAY}
        panelStyle={sheetPanel}
        animationType="slide"
      >
        {moreChild ? renderSheetHead(moreChild.child_name, sub, { email: moreChild.child_email, name: moreChild.child_name }) : null}
        {MORE_GROUPS.map((group, gi) => (
          <View key={gi} style={[s.sheetGroup, { backgroundColor: CARD_BG }]}>
            {group.map((it, i) => {
              const tone = it.destructive ? fc.danger : fc.text;
              return (
                <Pressable
                  key={it.key}
                  onPress={() => runMoreAction(it.key)}
                  style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: fc.highlightBg }]}
                  accessibilityRole="button"
                  accessibilityLabel={it.label}
                >
                  <View style={[s.sheetRowIcon, { backgroundColor: it.destructive ? 'transparent' : TILE_BG }]}>
                    <it.Icon size={18} color={tone} />
                  </View>
                  <View style={[s.sheetRowBody, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: HAIR }]}>
                    <Text style={[s.sheetRowText, { color: tone }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{it.label}</Text>
                    {!it.destructive && <IconChevronRight size={16} color={fc.tertiary} />}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </NativeSheetDialog>
    );
  };

  const renderRequestsSheet = () => (
    <NativeSheetDialog
      visible={requestsModal}
      onClose={() => setRequestsModal(false)}
      overlayStyle={SHEET_OVERLAY}
      panelStyle={sheetPanel}
      animationType="slide"
    >
      {renderSheetHead(t('parentalDash.requestsTitle'), pendingCount > 0 ? (pendingCount === 1 ? t('parentalDash.requestsOne') : t('parentalDash.requestsMany', { n: pendingCount })) : '')}
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 4 }}>
        {pendingCount === 0 ? (
          <Text style={[s.sheetSub, { color: fc.secondary, textAlign: 'center', paddingVertical: 24 }]}>{t('parentalDash.requestsEmpty')}</Text>
        ) : (pendingRequests || []).map((req) => {
          const nm = reqName(req);
          const busy = resolvingId === req.id;
          const ago = agoLabel(req.created_at, t, now);
          return (
            <View key={String(req.id)} style={[s.reqItem, { backgroundColor: CARD_BG }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <AvatarCircle email={req.child_email} name={nm} size={40} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.reqTitle, { color: fc.text }]} numberOfLines={1}>{nm}</Text>
                  <Text style={[s.reqSub, { color: fc.secondary }]} numberOfLines={1}>{ago ? `${requestReasonLabel(req)} · ${ago}` : requestReasonLabel(req)}</Text>
                </View>
              </View>
              {req.note ? <Text style={[s.reqNote, { color: fc.text, backgroundColor: TILE_BG }]}>{req.note}</Text> : null}
              <View style={s.reqBtns}>
                <PressableScale
                  style={[s.reqBtn, { backgroundColor: TILE_BG }]}
                  disabled={busy}
                  haptic={false}
                  onPress={() => resolveRequest(req, 'rejected')}
                  accessibilityRole="button"
                  accessibilityLabel={t('parentalDash.reject')}
                >
                  <Text style={[s.reqBtnText, { color: fc.text }]}>{t('parentalDash.reject')}</Text>
                </PressableScale>
                <PressableScale
                  style={[s.reqBtn, { backgroundColor: fc.pill }]}
                  disabled={busy}
                  haptic={false}
                  onPress={() => resolveRequest(req, 'approved')}
                  accessibilityRole="button"
                  accessibilityLabel={t('parentalDash.approve')}
                >
                  {busy ? <ActivityIndicator size="small" color={fc.onPill} /> : <Text style={[s.reqBtnText, { color: fc.onPill }]}>{t('parentalDash.approve')}</Text>}
                </PressableScale>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </NativeSheetDialog>
  );

  const openWizard = () => { haptics.tap('medium'); setShowWizard(true); };
  const retryLoad = () => { haptics.tap('light'); setLoadError(false); setLoading(true); loadChildren(); loadPendingRequests(); };

  // ─── Estados vazios / carregando / erro ───
  const renderSkeleton = () => (
    <View style={{ gap: 12 }}>
      <View style={[s.childCard, { backgroundColor: CARD_BG, padding: 16, gap: 10 }]}>
        <Skeleton width="30%" height={11} />
        <Skeleton width="45%" height={28} />
        <Skeleton width="100%" height={36} radius={10} />
      </View>
      {[0, 1].map(i => (
        <View key={i} style={[s.childCard, { backgroundColor: CARD_BG }]}>
          <View style={s.childCardMain}>
            <Skeleton width={56} height={56} radius={28} delay={i * 120} />
            <View style={{ flex: 1, gap: 8 }}>
              <Skeleton width="55%" height={14} delay={i * 120} />
              <Skeleton width="80%" height={11} delay={i * 120} />
              <Skeleton width="30%" height={18} radius={9} delay={i * 120} />
            </View>
          </View>
          <View style={s.actWrap}>
            <Skeleton height={58} radius={14} delay={i * 120} />
          </View>
        </View>
      ))}
    </View>
  );

  const renderEmpty = () => (
    <View style={s.emptyWrap}>
      <Svg width={148} height={148} viewBox="0 0 140 140" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Circle cx="70" cy="70" r="68" fill={TILE_BG} />
        <Circle cx="70" cy="70" r="50" fill={CARD_BG} stroke={HAIR} strokeWidth="1" />
        <Path d="M70 36 L94 45 V67 C94 84 83 95 70 101 C57 95 46 84 46 67 V45 Z" fill="none" stroke={fc.text} strokeWidth="3" strokeLinejoin="round" />
        <Circle cx="64" cy="61" r="6" fill={fc.text} />
        <Path d="M53.5 84 C53.5 75.5 58 71 64 71 C70 71 74.5 75.5 74.5 84 Z" fill={fc.text} />
        <Circle cx="79" cy="68" r="4.5" fill={fc.secondary} />
        <Path d="M71.5 86 C71.5 80 74.6 76.6 79 76.6 C83.4 76.6 86.5 80 86.5 86 Z" fill={fc.secondary} />
      </Svg>
      <Text style={[s.emptyTitle, { color: fc.text }]} maxFontSizeMultiplier={1.4}>{t('parentalDash.emptyTitle')}</Text>
      <Text style={[s.emptyDesc, { color: fc.secondary }]} maxFontSizeMultiplier={1.4}>{t('parentalDash.emptyDesc')}</Text>
      <PressableScale onPress={openWizard} haptic={false} style={[s.primaryBtn, { backgroundColor: fc.pill }]} accessibilityRole="button" accessibilityLabel={t('parentalDash.addChild')}>
        <IconPlus size={18} color={fc.onPill} />
        <Text style={[s.primaryBtnText, { color: fc.onPill }]} maxFontSizeMultiplier={1.3}>{t('parentalDash.addChild')}</Text>
      </PressableScale>
    </View>
  );

  const renderError = () => (
    <View style={s.emptyWrap}>
      <View style={[s.errorIcon, { backgroundColor: TILE_BG }]}>
        <IconAlertCircle size={28} color={fc.text} />
      </View>
      <Text style={[s.emptyTitle, { color: fc.text }]} maxFontSizeMultiplier={1.4}>{t('parentalDash.errorTitle')}</Text>
      <Text style={[s.emptyDesc, { color: fc.secondary }]} maxFontSizeMultiplier={1.4}>{t('parentalDash.errorDesc')}</Text>
      <PressableScale onPress={retryLoad} haptic={false} style={[s.primaryBtn, { backgroundColor: fc.pill }]} accessibilityRole="button" accessibilityLabel={t('parentalDash.retry')}>
        <IconRefresh size={18} color={fc.onPill} />
        <Text style={[s.primaryBtnText, { color: fc.onPill }]} maxFontSizeMultiplier={1.3}>{t('parentalDash.retry')}</Text>
      </PressableScale>
    </View>
  );

  // ─── Cartão-resumo do topo: tempo de tela somado, ativos, pedidos, verificações ───
  const activeKids = children.filter(c => c.status === 'active');
  const pendingVerify = children.filter(c => c.status === 'pending_verification').length;
  const pausedCount = activeKids.filter(c => childMeta[c.child_email]?.locked).length;
  const stKnown = activeKids.filter(c => childMeta[c.child_email]?.screen_time_used != null);
  const totalToday = stKnown.reduce((acc, c) => acc + Number(childMeta[c.child_email]?.screen_time_used || 0), 0);
  const anyEstimated = stKnown.some(c => childMeta[c.child_email]?.screen_time_estimated);
  const summaryBigSub = activeKids.length === 0
    ? t('parentalDash.summaryNoActive')
    : (pausedCount > 0
      ? t('parentalDash.summaryPaused', { n: pausedCount })
      : (activeKids.length === 1 ? t('parentalDash.summaryAcrossOne') : t('parentalDash.summaryAcross', { n: activeKids.length })));

  const renderSummary = () => {
    if (children.length === 0) return null;
    const stats = [
      { key: 'kids', value: String(children.length), label: children.length === 1 ? t('parentalDash.statChild') : t('parentalDash.statChildren') },
      { key: 'req', value: String(pendingCount), label: t('parentalDash.statRequests'), tone: pendingCount > 0 ? fc.danger : undefined, onPress: () => setRequestsModal(true) },
      { key: 'ver', value: String(pendingVerify), label: t('parentalDash.statVerify'), tone: pendingVerify > 0 ? AMBER : undefined },
    ];
    const reqPreview = (pendingRequests || []).slice(0, 2).map(r => ({
      key: String(r.id),
      email: r.child_email,
      name: reqName(r),
      reason: requestReasonLabel(r),
      ago: agoLabel(r.created_at, t, now),
    }));
    return (
      <SummaryCard
        eyebrow={t('parentalDash.summaryEyebrow')}
        big={stKnown.length > 0 ? fmtMinutes(totalToday, t) : '—'}
        bigSub={summaryBigSub}
        avatars={children.map(c => ({ email: c.child_email, name: c.child_name }))}
        stats={stats}
        requests={reqPreview}
        requestsTitle={pendingCount === 1 ? t('parentalDash.requestsOne') : t('parentalDash.requestsMany', { n: pendingCount })}
        requestsCta={t('parentalDash.seeAll')}
        onOpenRequests={() => setRequestsModal(true)}
        footnote={anyEstimated ? t('parentalDash.estimatedNote') : ''}
      />
    );
  };

  const listHeader = (
    <View>
      {!USE_NATIVE_HEADER && (
        <Text style={[s.largeTitle, { color: fc.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3} accessibilityRole="header">{t('parental.dashboard')}</Text>
      )}
      {renderSummary()}
      {children.length > 0 && (
        <Text style={[s.sectionLabel, { color: fc.header }]} maxFontSizeMultiplier={1.3}>
          {t('parentalDash.childrenSection', { n: children.length })}
        </Text>
      )}
    </View>
  );

  const listFooter = children.length > 0 ? (
    <AddChildCard title={t('parentalDash.addChild')} sub={t('parentalDash.addChildSub')} onPress={openWizard} />
  ) : null;

  const listEmpty = loading ? renderSkeleton() : (loadError ? renderError() : renderEmpty());

  // Web: título grande rola com a lista e o título pequeno aparece na barra.
  const smallTitleOpacity = scrollY.interpolate({ inputRange: [24, 48], outputRange: [0, 1], extrapolate: 'clamp' });
  const barHairOpacity = scrollY.interpolate({ inputRange: [40, 60], outputRange: [0, 1], extrapolate: 'clamp' });
  const onListScroll = USE_NATIVE_HEADER ? undefined : Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false });

  // ─── Dashboard (Main Screen) ───
  return (
    <View style={[s.container, { backgroundColor: PAGE_BG }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={{ ...nativeHeaderOptions({
          colors,
          isDark,
          title: t('parental.dashboard'),
          largeTitle: true,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: PAGE_BG },
          headerLargeStyle: { backgroundColor: PAGE_BG },
          contentStyle: { backgroundColor: PAGE_BG },
          headerRight: () => (
            <HeaderIconButton onPress={openWizard} accessibilityLabel={t('parentalDash.addChild')}>
              <IconPlus size={24} color={colors.text} />
            </HeaderIconButton>
          ),
          // [2026-10-08 parental-pages2] as options do Stack.Screen se MESCLAM: limpa o
          // back custom do wizard ao voltar pro painel (senão o chevron continuaria
          // chamando o "voltar passo" e o back do sistema ficaria escondido).
          headerBackVisible: true,
        }), headerLeft: undefined }} />
      ) : (
        <View style={[s.webHeader, { paddingTop: insets.top + 6, backgroundColor: PAGE_BG }]}>
          <View style={s.webHeaderBar}>
            <TouchableOpacity onPress={() => router.back()} style={s.headerBtn} accessibilityLabel={t('parentalDash.back')} accessibilityRole="button">
              <IconArrowLeft size={22} color={fc.text} />
            </TouchableOpacity>
            <Animated.Text style={[s.smallTitle, { color: fc.text, opacity: smallTitleOpacity }]} numberOfLines={1}>{t('parental.dashboard')}</Animated.Text>
            <TouchableOpacity onPress={openWizard} style={[s.headerBtn, s.headerBtnRound, { backgroundColor: TILE_BG }]} accessibilityLabel={t('parentalDash.addChild')} accessibilityRole="button">
              <IconPlus size={20} color={fc.text} />
            </TouchableOpacity>
          </View>
          <Animated.View style={[s.webHeaderHair, { backgroundColor: HAIR, opacity: barHairOpacity }]} />
        </View>
      )}

      <Animated.FlatList
        data={loading && children.length === 0 ? [] : children}
        keyExtractor={item => String(item.id ?? item.child_email)}
        renderItem={renderChild}
        extraData={[childMeta, now, onlineFlashes]}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[s.listContent, { paddingBottom: 32 + insets.bottom }, children.length === 0 && !loading && { flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onListScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={fc.text} colors={[fc.text]} />
        }
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        ListFooterComponentStyle={{ marginTop: 14 }}
      />

      {renderSummaryModal()}
      {renderMoreSheet()}
      {renderRequestsSheet()}
    </View>
  );
}

// [WAVE 63 #fam-crash] Wrap entire ParentalScreen in ErrorBoundary so any
// unexpected null in children/restrictions/childMeta doesn't take down the
// app at the JS bridge level. The inner screen is now `ParentalScreenInner`.
export default function ParentalScreen() {
  return <ErrorBoundary><ParentalScreenInner /></ErrorBoundary>;
}

const s = StyleSheet.create({
  container: { flex: 1 },

  // ─── [2026-10-19 parental-premium] Painel ───
  webHeader: { paddingHorizontal: 16 },
  webHeaderBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginLeft: -6, paddingBottom: 4 },
  webHeaderHair: { height: StyleSheet.hairlineWidth, marginHorizontal: -16 },
  smallTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBtnRound: { width: 36, height: 36, borderRadius: 18, marginRight: 2 },
  largeTitle: { fontSize: 34, fontWeight: '700', letterSpacing: -0.6, marginTop: 2, marginBottom: 12, marginLeft: 2 },
  listContent: { paddingHorizontal: 16, paddingTop: 8 },
  sectionLabel: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', marginTop: 22, marginBottom: 8, marginLeft: 4 },

  childCard: { borderRadius: 22, overflow: 'hidden' },
  childCardMain: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14, gap: 14 },
  avatarWrap: { width: 56, height: 56 },
  childInfo: { flex: 1, minWidth: 0 },
  childName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  childAge: { fontSize: 14, fontWeight: '500', letterSpacing: 0 },
  childEmail: { fontSize: 13.5, marginTop: 1 },
  lockBadge: { position: 'absolute', bottom: -1, right: -1, width: 21, height: 21, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },

  stBlock: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, paddingTop: 14, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  ringPct: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.2, textTransform: 'uppercase' },
  stBig: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, marginTop: 1, fontVariant: ['tabular-nums'] },
  stSub: { fontSize: 12.5, marginTop: 1 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginHorizontal: 16, paddingTop: 10 },

  actWrap: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12 },

  reqTitle: { fontSize: 15, fontWeight: '600' },
  reqSub: { fontSize: 13, marginTop: 2 },
  reqItem: { padding: 14, gap: 12, borderRadius: 18, marginBottom: 10 },
  reqNote: { fontSize: 15, lineHeight: 21, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, overflow: 'hidden' },
  reqBtns: { flexDirection: 'row', gap: 10 },
  reqBtn: { flex: 1, height: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  reqBtnText: { fontSize: 15, fontWeight: '600' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40 },
  emptyTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 20 },
  emptyDesc: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  errorIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, paddingHorizontal: 24, borderRadius: 25, marginTop: 24, minWidth: 200 },
  primaryBtnText: { fontSize: 16, fontWeight: '600' },

  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 14 },
  sheetTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  sheetSub: { fontSize: 13, marginTop: 2 },
  sheetGroup: { marginHorizontal: 16, marginBottom: 12, borderRadius: 16, overflow: 'hidden' },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
  sheetRowIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  sheetRowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingRight: 14 },
  sheetRowText: { flex: 1, fontSize: 16 },

  // Dashboard header
  backBtn: { padding: 6, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },

  // Wizard header
  wizardHeaderBar: { paddingTop: Platform.OS === 'ios' ? 44 : androidTopInset(12), paddingBottom: 10, paddingHorizontal: 16 },
  wizardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  wizardHeaderTitle: { fontSize: 17, fontWeight: '800', color: '#fff' },
  wizardStepCount: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.85)' },

  // Progress steps
  stepsRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 },
  stepItem: { alignItems: 'center', flex: 1, position: 'relative' },
  stepCircle: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 2, marginBottom: 3 },
  stepLabel: { fontSize: 10, fontWeight: '600', textAlign: 'center' },
  stepLine: { position: 'absolute', top: 14, left: '55%', right: '-45%', height: 2, zIndex: -1 },

  // Progress bar
  progressBar: { height: 3, borderRadius: 2, marginTop: 2 },
  progressFill: { height: 3, borderRadius: 2 },

  // Wizard content
  // Wizard mais compacto — user reclamou "ta muito grande pra criar chatyy
  // kids". Reduzi padding lateral, hero mais leve, fieldGroup menor pra
  // caber acima do teclado em iPhones menores.
  wizardContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  wizardHeader: { alignItems: 'center', marginBottom: 18 },

  // Mascot
  mascotWrap: { alignItems: 'center', marginBottom: 4 },
  mascotCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#11111115', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#11111130' },
  mascotEmoji: { fontSize: 32 },

  // Shield
  shieldCircle: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#10B98115', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#10B98130', marginBottom: 12 },
  shieldEmoji: { fontSize: 36 },

  // Titles
  wizardTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center', marginBottom: 2 },
  wizardSubtitle: { fontSize: 12, textAlign: 'center', lineHeight: 16, maxWidth: 320, alignSelf: 'center', marginBottom: 10 },

  // Fields
  fieldGroup: { marginBottom: 8 },
  fieldLabel: { fontSize: 11, fontWeight: '700', marginBottom: 4, letterSpacing: 0.3 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 12, height: 40 },
  inputIcon: { fontSize: 20, marginRight: 12 },
  input: { flex: 1, fontSize: 15, fontWeight: '500' },

  // Username suggestion
  usernameSuggest: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingLeft: 4 },
  usernameLabel: { fontSize: 12, fontWeight: '500' },
  usernameValue: { fontSize: 13, fontWeight: '700' },

  // Age badge
  ageBadge: { marginTop: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, alignItems: 'center' },
  ageBadgeText: { fontSize: 15, fontWeight: '700' },

  // Age range visual
  ageRangeWrap: { marginTop: 6 },
  ageRangeBar: { marginBottom: 4 },
  ageRangeTrack: { height: 8, borderRadius: 4, overflow: 'hidden', position: 'relative' },
  ageRangeValid: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4 },
  ageRangeDot: { position: 'absolute', top: -4, width: 16, height: 16, borderRadius: 8, marginLeft: -8, borderWidth: 3, borderColor: '#fff' },
  ageRangeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, paddingHorizontal: 2 },
  ageRangeLabel: { fontSize: 11, fontWeight: '600' },
  agePresetPreview: { marginTop: 10, padding: 12, borderRadius: 14, borderWidth: 1 },
  agePresetTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  agePresetItem: { fontSize: 12 },

  // Illustrated cards (gender + relationship)
  cardGrid: { flexDirection: 'row', gap: 8 },
  illustratedCard: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8,
    borderRadius: 14, position: 'relative', minHeight: 64,
  },
  cardEmoji: { fontSize: 22, marginBottom: 2 },
  cardEmojiWrap: { marginBottom: 2, alignItems: 'center', justifyContent: 'center', width: 26, height: 26 },
  cardLabel: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  cardCheck: { position: 'absolute', top: 4, right: 4, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  // Verify methods
  verifyMethods: { gap: 12, marginBottom: 24 },
  verifyCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, gap: 14 },
  verifyCardIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  verifyCardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 2 },
  verifyCardDesc: { fontSize: 13, lineHeight: 18 },
  verifyCardCheck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // Document upload
  docUploadSection: { marginBottom: 20 },
  docButtons: { flexDirection: 'row', gap: 14, marginBottom: 20 },
  docBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 28, borderRadius: 22, borderWidth: 1.5, gap: 10 },
  docBtnIconWrap: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  docBtnText: { fontSize: 16, fontWeight: '700' },
  docBtnSub: { fontSize: 12 },
  docPreview: { borderRadius: 22, overflow: 'hidden', position: 'relative', marginBottom: 20 },
  docPreviewImage: { width: '100%', height: 280, borderRadius: 22 },
  docPreviewOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  docFrameCorner: { position: 'absolute', width: 30, height: 30, borderColor: ACCENT, borderWidth: 3 },
  docCornerTL: { top: 16, left: 16, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 8 },
  docCornerTR: { top: 16, right: 16, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 8 },
  docCornerBL: { bottom: 16, left: 16, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 8 },
  docCornerBR: { bottom: 16, right: 16, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 8 },
  docRemoveBtn: { position: 'absolute', top: 12, right: 12, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  docDetectedBadge: { position: 'absolute', bottom: 16, left: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ACCENT, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  docDetectedText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Doc types
  docTypes: { padding: 16, borderRadius: 20, borderWidth: 1 },
  docTypesTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  docTypeItem: { fontSize: 13, lineHeight: 24 },

  // Trust badges
  trustBadges: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  trustBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  trustIcon: { fontSize: 14 },
  trustText: { fontSize: 11, fontWeight: '600' },

  // Verify stages (step 2)
  verifyLoaderWrap: { marginBottom: 32, alignItems: 'center', justifyContent: 'center' },
  verifyLoaderRing: { position: 'absolute', width: 70, height: 70, borderRadius: 35, borderWidth: 3, borderColor: ACCENT + '20' },
  verifyStages: { gap: 14, marginBottom: 28, alignSelf: 'stretch', paddingHorizontal: 40 },
  verifyStageRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  verifyStageDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  verifyStageText: { fontSize: 15 },
  verifyTimeEst: { fontSize: 14, marginBottom: 24 },
  safetyFactBox: { padding: 20, borderRadius: 22, borderWidth: 1.5, alignItems: 'center', maxWidth: 360, alignSelf: 'center', width: '100%' },
  safetyFactIcon: { fontSize: 28, marginBottom: 8 },
  safetyFactTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 },
  safetyFactText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },

  // Celebration (step 3)
  celebrationHeader: { alignItems: 'center', marginBottom: 24 },
  celebrationEmoji: { fontSize: 56, marginBottom: 12 },

  // Child ready card
  childReadyCard: { alignItems: 'center', padding: 24, borderRadius: 22, borderWidth: 1.5, marginBottom: 20 },
  childReadyAvatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 12, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  childReadyName: { fontSize: 22, fontWeight: '800', marginBottom: 8 },
  childReadyBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ACCENT + '15', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
  childReadyBadgeText: { fontSize: 13, fontWeight: '700' },

  // Credentials
  credsBox: { borderRadius: 22, borderWidth: 1.5, overflow: 'hidden', marginBottom: 16, padding: 4 },
  credsTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  credRow: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16 },
  credInfo: { flex: 1 },
  credLabel: { fontSize: 12, marginBottom: 4 },
  credValue: { fontSize: 18, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  credDivider: { borderTopWidth: 1, marginHorizontal: 16 },
  credCopyBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // Warning
  warningBox: { flexDirection: 'row', padding: 16, borderRadius: 20, borderWidth: 1.5, gap: 12, marginBottom: 24, alignItems: 'flex-start' },
  warningIcon: { fontSize: 20 },
  warningText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '500' },

  // Quick setup
  quickSetupSection: { marginBottom: 20 },
  quickSetupTitle: { fontSize: 20, fontWeight: '800', marginBottom: 4 },
  quickSetupSub: { fontSize: 14, marginBottom: 16 },
  setupOption: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, borderWidth: 1.5, gap: 14, marginBottom: 10 },
  setupEmoji: { fontSize: 24 },
  setupEmojiWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  setupLabel: { fontSize: 16, fontWeight: '700' },
  setupDesc: { fontSize: 13, marginTop: 2 },
  setupToggle: { width: 42, height: 26, borderRadius: 13, padding: 3 },
  setupToggleDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  recommendedBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, borderRadius: 20, borderWidth: 1.5, marginTop: 6 },
  recommendedIcon: { fontSize: 18 },
  recommendedText: { fontSize: 15, fontWeight: '700' },

  // Verdict
  verdictBox: { padding: 20, borderRadius: 22, borderWidth: 1.5, alignItems: 'center', gap: 4, marginBottom: 16 },
  verdictTitle: { fontSize: 12, fontWeight: '600' },
  verdictValue: { fontSize: 20, fontWeight: '800' },
  verdictConf: { fontSize: 12 },

  // Bottom bar
  bottomBar: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1 },
  nextBtn: { height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  nextBtnText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  nextBtnEmoji: { fontSize: 20 },
  nextBtnArrow: { fontSize: 20, color: '#fff', fontWeight: '700' },

  // Confetti
  confettiContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 999 },
  confettiPiece: { position: 'absolute' },

  // Quick Actions (dashboard)

  // Hero
  hero: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  heroTitle: { fontSize: 28, fontWeight: '800', marginTop: 16 },
  heroDesc: { fontSize: 16, textAlign: 'center', marginTop: 14, lineHeight: 24 },
  heroBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 32, paddingVertical: 16, borderRadius: 22, marginTop: 28, minHeight: 56 },
  heroBtnText: { color: '#fff', fontWeight: '800', fontSize: 17 },

  // Child cards

  // AI Summary Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { width: '100%', maxWidth: 440, maxHeight: '80%', borderRadius: 22, overflow: 'hidden', ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 16 }, android: { elevation: 12 } }) },
  modalHeader: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: '800' },
  modalSub: { fontSize: 13, marginTop: 2 },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingBottom: 24 },
  summaryLoading: { alignItems: 'center', paddingVertical: 40, gap: 12 },
  summaryLoadingText: { fontSize: 14 },
  summaryError: { alignItems: 'center', paddingVertical: 30, gap: 10 },
  summaryErrorText: { fontSize: 14, textAlign: 'center' },
  summaryRisk: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, borderWidth: 1 },
  summaryRiskLabel: { fontSize: 16, fontWeight: '800' },
  summaryRiskReason: { fontSize: 12, marginTop: 2 },
  summarySection: { borderWidth: 1, borderRadius: 18, padding: 14 },
  summarySectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 },
  summarySectionBody: { fontSize: 14, lineHeight: 20 },
  summaryStats: { flexDirection: 'row', gap: 10 },
  statBox: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14 },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 11, marginTop: 2 },
  flaggedItem: { flexDirection: 'row', gap: 8, marginTop: 4 },
  flaggedText: { flex: 1, fontSize: 13, lineHeight: 18 },

  // FAB

  // Pending requests banner (top of dashboard)

  // Child avatar halo (gradient ring under AvatarCircle)

  // Lock badge over avatar when child account is paused

  // Bedtime banner (in-window child)

  // Screen-time mini-bar

  // Per-child quick-action row (5 icons)

  // Hero illustration (empty state)

  // Skeleton loader (initial load, no cache)
});

// [2026-10-08 parental-pages2] Estilos do wizard "Adicionar filho".
const w = StyleSheet.create({
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 52 },
  webBack: { width: 56, height: 44, justifyContent: 'center', paddingHorizontal: 8, ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  webTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  stepCount: { fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  progressWrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6, width: '100%', maxWidth: 720, alignSelf: 'center' },
  progressLabel: { fontSize: 12, fontWeight: '500', marginTop: 7 },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24, width: '100%', maxWidth: 720, alignSelf: 'center' },
  head: { marginBottom: 22 },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  sub: { fontSize: 15, lineHeight: 21, marginTop: 6 },
  field: { marginBottom: 20 },
  input: { fontSize: 17, paddingVertical: Platform.OS === 'ios' ? 14 : 12, ...Platform.select({ web: { outlineStyle: 'none', outlineWidth: 0 }, default: {} }) },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 4 },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18 },
  footnote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, marginTop: 8 },
  docPreview: { borderRadius: 12, overflow: 'hidden', height: 190, alignItems: 'center', justifyContent: 'center' },
  docImage: { width: '100%', height: '100%' },
  docRemove: { position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  docBadge: { position: 'absolute', left: 10, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  docBadgeText: { fontSize: 12, fontWeight: '600' },
  bigCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  stageRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12, minHeight: 48 },
  stageDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stageText: { fontSize: 15, flex: 1 },
  childRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  childName: { fontSize: 17, fontWeight: '600' },
  credRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, gap: 12 },
  credValue: { fontSize: 16, fontWeight: '500', marginTop: 2, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
  copyBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  cta: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  ctaText: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
});
