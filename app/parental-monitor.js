// [2026-10-08 parental-pages2] Monitor do filho redesenhado no padrão B&W
// premium do resto do app (SettingsKit): header NATIVO com avatar + nome +
// "Visto há X · Offline/Online" (sai o bloco preto com escudo solto), card de
// resumo (tempo de tela vs limite com barra fina, liberar/pausar, +15 min),
// 4 ações monocromáticas (Localizar, Mensagens, Pausar, Mais), abas como
// segmented control nativo, listas agrupadas e empty states compactos.
// Vermelho só p/ alerta/destrutivo. Loaders/handlers/API inalterados.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, ScrollView, TextInput, Alert, Animated, AppState, RefreshControl, Linking, BackHandler, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconMessageSquare, IconPhone, IconPhoneOff, IconShield, IconEye, IconLock, IconClock, IconBarChart, IconX, IconPlus, IconUser, IconUsers, IconMail, IconTrash, IconAlertTriangle, IconFilter, IconSparkles, IconHeart, IconImage, IconVideo, IconZap, IconMapPin, IconPause, IconPlay, IconMoreHorizontal, IconRefresh, IconSliders, IconMoon, IconSmartphone } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import PressableRow from '../components/PressableRow';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton } from '../components/nativeHeader';
import { useGroupedColors, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsCardContent, useSettingsInputStyle } from '../components/settings/SettingsKit';
import { SegmentedControl, MonoTile, CompactEmpty, ActionSheet, useInk } from '../components/parental/ParentalKit';
import NativeSwitch from '../components/NativeSwitch';
import * as api from '../services/api';
import ErrorBoundary from '../components/ErrorBoundary';
import { getCached, setCache } from '../services/cache';
import useIsMounted from '../hooks/useIsMounted';
import * as haptics from '../services/haptics';

const TIME_LIMITS = [
  { value: 30, label: '30 min' },
  { value: 60, label: '1h' },
  { value: 120, label: '2h' },
  { value: 180, label: '3h' },
  { value: 240, label: '4h' },
  { value: 0, label: null }, // unlimited - label set from i18n
];

// ─── Helpers (top-level so renders don't reallocate) ───

const safeDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return isNaN(x.getTime()) ? null : x;
};
const fmtTime = (d) => { const x = safeDate(d); return x ? x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const minsAgo = (d) => {
  const x = safeDate(d);
  if (!x) return null;
  const diff = Math.floor((Date.now() - x.getTime()) / 60000);
  return diff < 0 ? 0 : diff;
};
const fmtRelative = (d, t) => {
  const m = minsAgo(d);
  if (m === null) return '';
  if (m < 1) return t ? t('parentalMon.now') : 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const days = Math.floor(h / 24);
  return `${days} d`;
};
// 74 → "1 h 14 min"; 45 → "45 min"; 120 → "2 h".
const fmtDur = (mins) => {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};

// Skeleton block — minimal shimmer used while a tab loads.
function Skel({ w = '100%', h = 14, mt = 0, br = 8, dark }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 700, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  const bg = anim.interpolate({ inputRange: [0, 1], outputRange: [dark ? '#1c1c1e' : '#e5e5ea', dark ? '#2c2c2e' : '#f2f2f7'] });
  return <Animated.View style={{ width: w, height: h, marginTop: mt, borderRadius: br, backgroundColor: bg }} />;
}

function TabSkeleton({ dark }) {
  return (
    <View style={{ padding: 16 }}>
      <Skel dark={dark} h={150} br={12} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {[0, 1, 2, 3].map(i => <View key={i} style={{ flex: 1 }}><Skel dark={dark} h={64} br={12} /></View>)}
      </View>
      <Skel dark={dark} h={34} br={9} mt={20} />
      <Skel dark={dark} h={14} w="35%" mt={24} />
      <Skel dark={dark} h={56} br={12} mt={8} />
      <Skel dark={dark} h={56} br={12} mt={8} />
    </View>
  );
}

// Risk indicators for Contacts tab.
const isUnknownContact = (c) => !c?.name || /^\+?\d{6,}$/.test(String(c?.name || ''));
const isNewThisWeek = (c) => {
  const x = safeDate(c?.first_seen || c?.created_at);
  return x ? (Date.now() - x.getTime()) < 7 * 24 * 3600 * 1000 : false;
};

function ParentalMonitorScreenInner() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const childEmail = params.child_email;
  const childName = params.child_name || childEmail?.split('@')[0] || t('parental.child');
  const mounted = useIsMounted();

  // 4 monitor tabs + restrictions sheet entry
  const [tab, setTab] = useState('today');
  const [showRestrictions, setShowRestrictions] = useState(false);

  // Existing datasets
  const [chats, setChats] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [calls, setCalls] = useState([]);
  const [restrictions, setRestrictions] = useState({});
  const [screenTime, setScreenTime] = useState(null);
  const [whitelist, setWhitelist] = useState([]);

  // New datasets (graceful-degraded — backend may not return data yet)
  const [todayData, setTodayData] = useState(null);
  const [weekData, setWeekData] = useState(null);
  const [monitorContacts, setMonitorContacts] = useState([]);
  const [activity, setActivity] = useState([]);
  const [aiSummary, setAiSummary] = useState(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [newContact, setNewContact] = useState('');
  const [sosLoading, setSosLoading] = useState(false);
  const [contactBusy, setContactBusy] = useState({}); // email -> 'approving'|'blocking'
  // [2026-10-08 parental-pages2] UI nova: sheet "Mais", pausar/liberar, +15 min, timeline.
  const [moreOpen, setMoreOpen] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  const [bonusBusy, setBonusBusy] = useState(false);
  const [bonusMinutes, setBonusMinutes] = useState(0);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const g = useGroupedColors();
  const { ink, onInk } = useInk();
  const insets = useSafeAreaInsets();

  const slideAnim = useRef(new Animated.Value(0)).current;

  // Saved-msg + debounce timers we have to clean up on unmount.
  const updateDebounceRef = useRef(null);
  const pendingRestrictionsRef = useRef(null);
  const savedTimerRef = useRef(null);

  // ─── Data Loaders ───

  const loadChats = useCallback(async () => {
    try { const c = await getCached('parental_chats_' + childEmail); if (c?.length && mounted.current) setChats(c); } catch {}
    try {
      const r = await api.parentalChildChats(childEmail);
      if (!mounted.current) return;
      if (r?.success) { setChats(r.data?.chats || []); setCache('parental_chats_' + childEmail, r.data?.chats || [], 2592000000).catch(() => {}); }
    } catch {}
  }, [childEmail, mounted]);

  const loadAlerts = useCallback(async () => {
    try { const c = await getCached('parental_alerts_' + childEmail); if (c?.length && mounted.current) setAlerts(c); } catch {}
    try {
      const r = await api.parentalAlerts(childEmail);
      if (!mounted.current) return;
      if (r?.success) { setAlerts(r.data?.alerts || []); setCache('parental_alerts_' + childEmail, r.data?.alerts || [], 2592000000).catch(() => {}); }
    } catch {}
  }, [childEmail, mounted]);

  const loadCalls = useCallback(async () => {
    try {
      const r = await api.parentalCallHistory(childEmail);
      if (!mounted.current) return;
      if (r?.success) setCalls(r.data?.calls || []);
    } catch {}
  }, [childEmail, mounted]);

  const loadRestrictions = useCallback(async () => {
    try {
      const r = await api.parentalGetRestrictions(childEmail);
      if (!mounted.current) return;
      // Backend returns restrictions either nested (data.restrictions) or at
      // the data root depending on version — tolerate both so the toggles
      // hydrate instead of rendering an empty (all-defaults) sheet.
      if (r?.success) setRestrictions(r?.data?.restrictions || r?.data || {});
    } catch {}
  }, [childEmail, mounted]);

  const loadScreenTime = useCallback(async () => {
    try {
      const r = await api.parentalScreenTime(childEmail);
      if (!mounted.current) return;
      if (r?.success) setScreenTime(r.data || null);
    } catch {}
  }, [childEmail, mounted]);

  const loadWhitelist = useCallback(async () => {
    try {
      const r = await api.parentalContactWhitelist(childEmail);
      if (!mounted.current) return;
      if (r?.success) setWhitelist(r.data?.contacts || []);
    } catch {}
  }, [childEmail, mounted]);

  const loadToday = useCallback(async () => {
    try {
      const r = await api.parentalChildToday(childEmail);
      if (!mounted.current) return;
      if (r?.success) setTodayData(r.data || null);
    } catch {}
  }, [childEmail, mounted]);

  const loadWeek = useCallback(async () => {
    try {
      const r = await api.parentalChildWeek(childEmail);
      if (!mounted.current) return;
      if (r?.success) setWeekData(r.data || null);
    } catch {}
  }, [childEmail, mounted]);

  const loadMonitorContacts = useCallback(async () => {
    try {
      const r = await api.parentalChildContacts(childEmail);
      if (!mounted.current) return;
      if (r?.success) setMonitorContacts(r.data?.contacts || []);
    } catch {}
  }, [childEmail, mounted]);

  const loadActivity = useCallback(async () => {
    try {
      const r = await api.parentalChildActivity(childEmail);
      if (!mounted.current) return;
      if (r?.success) setActivity(r.data?.activity || r.data?.events || []);
    } catch {}
  }, [childEmail, mounted]);

  const loadAiSummary = useCallback(async () => {
    // Try the dedicated summary endpoint first; fall back to existing
    // parental_activity_summary which already returns risk/summary/flags.
    try {
      const r = await api.parentalSummary(childEmail);
      if (!mounted.current) return;
      if (r?.success) { setAiSummary(r.data || null); return; }
    } catch {}
    try {
      const r2 = await api.parentalActivitySummary(childEmail);
      if (!mounted.current) return;
      if (r2?.success) setAiSummary(r2.data || null);
    } catch {}
  }, [childEmail, mounted]);

  const loadAll = useCallback(async () => {
    await Promise.all([
      loadChats(), loadAlerts(), loadCalls(), loadRestrictions(),
      loadScreenTime(), loadWhitelist(),
      loadToday(), loadWeek(), loadMonitorContacts(), loadActivity(), loadAiSummary(),
    ]);
  }, [loadChats, loadAlerts, loadCalls, loadRestrictions, loadScreenTime, loadWhitelist, loadToday, loadWeek, loadMonitorContacts, loadActivity, loadAiSummary]);

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => { if (mounted.current) setLoading(false); });
  }, [loadAll, mounted]);

  // Refresh on background→foreground (parent comes back to the screen).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mounted.current && !loading) {
        // Light refresh — don't block UI; loaders are idempotent.
        loadAll();
      }
    });
    return () => { try { sub.remove(); } catch {} };
  }, [loadAll, loading, mounted]);

  // Tab change crossfade
  useEffect(() => {
    slideAnim.setValue(0);
    Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 80, friction: 12 }).start();
  }, [tab, slideAnim]);

  // Cleanup all timers on unmount (prevents setState-after-unmount + leaks).
  useEffect(() => {
    return () => {
      if (updateDebounceRef.current) { clearTimeout(updateDebounceRef.current); updateDebounceRef.current = null; }
      if (savedTimerRef.current) { clearTimeout(savedTimerRef.current); savedTimerRef.current = null; }
    };
  }, []);

  // ─── Pull to refresh ───
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadAll(); } finally { if (mounted.current) setRefreshing(false); }
  }, [loadAll, mounted]);

  // ─── Restriction Helpers ───

  const updateRestriction = (key, value) => {
    const updated = { ...restrictions, [key]: value };
    setRestrictions(updated);
    pendingRestrictionsRef.current = updated;
    if (updateDebounceRef.current) clearTimeout(updateDebounceRef.current);
    setSaving(true);
    updateDebounceRef.current = setTimeout(async () => {
      updateDebounceRef.current = null;
      const payload = pendingRestrictionsRef.current;
      try {
        await api.parentalUpdateRestrictions(childEmail, payload);
        if (!mounted.current) return;
        setSavedMsg(t('parental.saved'));
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => { if (mounted.current) setSavedMsg(''); }, 2000);
        // Immediately re-pull the authoritative restrictions so the child
        // device reflects the new limits without waiting for the next
        // AppState foreground refresh. Idempotent + best-effort.
        loadRestrictions?.();
      } catch {
        loadRestrictions?.();
      } finally {
        if (mounted.current) setSaving(false);
      }
    }, 500);
  };

  const handleAddContact = async () => {
    const email = newContact.trim().toLowerCase();
    if (!email || !email.includes('@')) return Alert.alert('', t('parental.contactEmail'));
    try {
      await api.parentalAddContact(childEmail, email);
      if (!mounted.current) return;
      setNewContact('');
      loadWhitelist();
    } catch {}
  };

  const handleRemoveContact = (contactEmail) => {
    Alert.alert(t('parental.removeContact'), contactEmail, [
      { text: t('parental.cancel'), style: 'cancel' },
      { text: t('parental.confirm'), onPress: async () => {
        try {
          await api.parentalRemoveContact(childEmail, contactEmail);
          if (mounted.current) loadWhitelist();
        } catch {}
      }},
    ]);
  };

  const handleApproveContact = async (contactEmail) => {
    setContactBusy(b => ({ ...b, [contactEmail]: 'approving' }));
    try {
      await api.parentalApproveContact(childEmail, contactEmail);
      if (!mounted.current) return;
      setMonitorContacts(prev => prev.map(c => c.email === contactEmail ? { ...c, approval_status: 'approved' } : c));
    } catch {} finally {
      if (mounted.current) setContactBusy(b => { const { [contactEmail]: _, ...rest } = b; return rest; });
    }
  };
  const handleBlockContact = async (contactEmail) => {
    setContactBusy(b => ({ ...b, [contactEmail]: 'blocking' }));
    try {
      await api.parentalBlockContact(childEmail, contactEmail);
      if (!mounted.current) return;
      setMonitorContacts(prev => prev.map(c => c.email === contactEmail ? { ...c, approval_status: 'blocked' } : c));
    } catch {} finally {
      if (mounted.current) setContactBusy(b => { const { [contactEmail]: _, ...rest } = b; return rest; });
    }
  };

  // ─── [2026-10-08 parental-pages2] Ações do card de resumo / tiles ───

  // Android: botão voltar fecha a tela de restrições antes de sair do monitor.
  useEffect(() => {
    if (!showRestrictions || Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setShowRestrictions(false); return true; });
    return () => { try { sub.remove(); } catch {} };
  }, [showRestrictions]);

  const isLocked = restrictions.locked === true || restrictions.locked === 1 || restrictions.locked === '1';

  const setLocked = async (next) => {
    if (lockBusy) return;
    setLockBusy(true);
    const prev = restrictions.locked;
    setRestrictions(r => ({ ...r, locked: next }));
    try {
      const r = next ? await api.parentalLockChild(childEmail) : await api.parentalUnlockChild(childEmail);
      if (!r?.success) throw new Error('lock failed');
      if (next) { try { haptics.warning(); } catch {} } else { try { haptics.success(); } catch {} }
    } catch {
      if (mounted.current) {
        setRestrictions(r => ({ ...r, locked: prev }));
        Alert.alert(t('parental.error'), t('parental.connectionError'));
      }
    } finally {
      if (mounted.current) setLockBusy(false);
    }
  };

  // Pausar pede confirmação (a criança fica bloqueada); retomar é imediato.
  const toggleLock = (next) => {
    if (!next) { setLocked(false); return; }
    Alert.alert(
      t('parental.lockNowTitle') || 'Pausar app agora?',
      `${t('parental.lockNowDesc') || 'A criança vai ver a tela de bloqueio até você liberar.'} (${childName})`,
      [
        { text: t('parental.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('parental.lockNow') || 'Pausar', style: 'destructive', onPress: () => setLocked(true) },
      ]
    );
  };

  const grantBonus = async () => {
    if (bonusBusy) return;
    setBonusBusy(true);
    try {
      const r = await api.parentalGrantExtraTime(childEmail, 15);
      if (!mounted.current) return;
      if (r?.success) {
        try { haptics.success(); } catch {}
        setBonusMinutes(b => b + 15);
        Alert.alert(
          t('parental.bonusGranted') || 'Tempo concedido!',
          (t('parental.bonusGrantedDesc') || '+15 minutos liberados para').concat(' ', childName)
        );
      } else {
        Alert.alert(t('parental.error'), r?.message || t('parental.connectionError'));
      }
    } catch {
      if (mounted.current) Alert.alert(t('parental.error'), t('parental.connectionError'));
    } finally {
      if (mounted.current) setBonusBusy(false);
    }
  };

  // Localizar: abre o último local conhecido no app de mapas (antes era um
  // Alert com coordenadas cruas). Aceita os 2 formatos do backend.
  const locateChild = async () => {
    if (sosLoading) return;
    setSosLoading(true);
    try { haptics.tap('light'); } catch {}
    try {
      const r = await api.parentalGetLocation(childEmail);
      if (!mounted.current) return;
      const loc = r?.data?.location || r?.data || {};
      const lat = Number(loc.latitude ?? loc.lat);
      const lng = Number(loc.longitude ?? loc.lng);
      if (!r?.success || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        Alert.alert(
          t('parental.locationUnavailable') || 'Localização indisponível',
          t('parental.locationUnavailableDesc') || 'Não foi possível obter a localização.'
        );
        return;
      }
      const label = encodeURIComponent(childName || '');
      const url = Platform.select({
        ios: `https://maps.apple.com/?ll=${lat},${lng}&q=${label}`,
        android: `geo:${lat},${lng}?q=${lat},${lng}(${label})`,
        default: `https://www.google.com/maps?q=${lat},${lng}`,
      });
      Linking.openURL(url).catch(() => { Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`).catch(() => {}); });
    } catch {
      if (mounted.current) Alert.alert(t('parental.error') || 'Error', t('parental.connectionError') || 'Connection error');
    } finally { if (mounted.current) setSosLoading(false); }
  };

  const onMoreSelect = (key) => {
    setMoreOpen(false);
    if (key === 'restrictions') setTimeout(() => { if (mounted.current) setShowRestrictions(true); }, Platform.OS === 'ios' ? 250 : 0);
    else if (key === 'refresh') onRefresh();
  };

  // ─── Tab Config (4 monitor tabs) ───

  const pendingContacts = monitorContacts.filter(c => c.approval_status === 'pending').length;
  const tabs = [
    { value: 'today', label: t('parentalMon.tabToday') },
    { value: 'week', label: t('parentalMon.tabWeek') },
    { value: 'apps', label: t('parentalMon.tabApps') },
    { value: 'contacts', label: t('parentalMon.tabContacts'), badge: pendingContacts },
  ];

  // ─── Derived (Today) ───

  const todayMinutes = todayData?.today_minutes ?? screenTime?.today_minutes ?? 0;
  const dailyLimit = restrictions.daily_limit_minutes || 0;
  const effLimit = dailyLimit > 0 ? dailyLimit + bonusMinutes : 0;
  const todayProgress = effLimit > 0 ? Math.min(todayMinutes / Math.max(effLimit, 1), 1) : 0;
  const overLimit = effLimit > 0 && todayMinutes >= effLimit;
  const lastSeenAt = todayData?.last_seen_at || screenTime?.last_seen_at;
  const lastSeenMins = minsAgo(lastSeenAt);
  const isOnline = todayData?.online === true || (lastSeenMins !== null && lastSeenMins < 5);
  const currentApp = todayData?.current_app || 'Chatyy';
  const todayTopContacts = (todayData?.top_contacts || screenTime?.top_contacts || []).slice(0, 3);
  const aiCards = useMemo(() => {
    const out = [];
    if (aiSummary?.summary) out.push({ id: 'summary', title: aiSummary.summary, risk: aiSummary.risk_level || 'info', flags: aiSummary.flags || [] });
    (aiSummary?.flags || []).slice(0, 2).forEach((f, i) => out.push({ id: 'flag_' + i, title: typeof f === 'string' ? f : (f?.title || ''), risk: 'warning' }));
    return out.slice(0, 3);
  }, [aiSummary]);

  // "Online agora" / "Visto há 42 min · Offline" / "Offline" (+ "· Pausado").
  const statusLine = (() => {
    let s;
    if (isOnline) s = t('parentalMon.onlineUsing', { app: currentApp });
    else if (lastSeenMins !== null) {
      const seen = lastSeenMins < 60
        ? t('parentalDash.seenMin', { n: Math.max(1, lastSeenMins) })
        : lastSeenMins < 1440
          ? t('parentalDash.seenHour', { n: Math.floor(lastSeenMins / 60) })
          : t('parentalDash.seenDay', { n: Math.floor(lastSeenMins / 1440) });
      s = `${seen} · ${t('parentalMon.offline')}`;
    } else s = t('parentalMon.offline');
    if (isLocked) s += ` · ${t('parentalDash.statusPaused')}`;
    return s;
  })();

  // Activity timeline (mais recente primeiro).
  const timelineEvents = useMemo(() => {
    const events = (activity && activity.length) ? [...activity] : [];
    if (!events.length && chats?.length) {
      // Build a minimal pseudo-timeline from last messages — keeps the tab
      // useful even before the activity endpoint ships.
      const now = Date.now();
      chats.slice(0, 8).forEach((c, i) => {
        if (c?.last_message_at || c?.last_message) {
          events.push({
            id: 'chat_' + (c.id || i),
            type: 'chat_message',
            label: c.last_message || (c.name || ''),
            target: c.name || c.email,
            created_at: c.last_message_at || new Date(now - i * 600000).toISOString(),
          });
        }
      });
    }
    return events
      .filter(ev => safeDate(ev.created_at || ev.ts))
      .sort((a, b) => new Date(b.created_at || b.ts) - new Date(a.created_at || a.ts));
  }, [activity, chats]);

  // ─── Derived (Week) ───
  const weekDays = useMemo(() => {
    // Prefer week endpoint, else compose from screenTime.weekly + calls/chats counts.
    if (weekData?.days?.length) return weekData.days;
    const baseWeekly = screenTime?.weekly || [];
    return baseWeekly.map(d => ({
      day: d.day,
      minutes: d.minutes || 0,
      messages: d.messages || 0,
      calls: d.calls || 0,
    }));
  }, [weekData, screenTime]);
  const weekTotalMinutes = weekDays.reduce((s, d) => s + (d.minutes || 0), 0);
  const lastWeekTotalMinutes = weekData?.last_week_minutes ?? null;
  const weekTrend = (lastWeekTotalMinutes !== null && lastWeekTotalMinutes > 0)
    ? Math.round(((weekTotalMinutes - lastWeekTotalMinutes) / lastWeekTotalMinutes) * 100)
    : null;

  // ─── Derived (Apps / features) ───
  const appsBreakdown = useMemo(() => {
    const f = todayData?.feature_usage || weekData?.feature_usage || screenTime?.feature_usage || {};
    return [
      { key: 'chat',   label: t('parentalMon.areaChat'),   value: f.chat ?? f.messages ?? screenTime?.today_minutes ?? 0, Icon: IconMessageSquare },
      { key: 'status', label: t('parentalMon.areaStatus'), value: f.status ?? 0, Icon: IconImage },
      { key: 'reels',  label: t('parentalMon.areaReels'),  value: f.reels ?? 0, Icon: IconVideo },
      { key: 'feed',   label: t('parentalMon.areaFeed'),   value: f.feed ?? 0, Icon: IconHeart },
      { key: 'calls',  label: t('parentalMon.areaCalls'),  value: f.calls ?? calls.length, Icon: IconPhone },
    ];
  }, [todayData, weekData, screenTime, calls, t]);
  const appsMax = Math.max(...appsBreakdown.map(a => Number(a.value) || 0), 1);

  const dayShort = (i) => t('parentalMon.day' + i);

  // ─── Shared row pieces ───

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={g.text} colors={[g.text]} />;

  const MutedIcon = ({ Icon, danger }) => (
    <View style={[s.mutedIcon, { backgroundColor: danger ? 'rgba(239,68,68,0.12)' : g.fill }]}>
      <Icon size={16} color={danger ? g.destructive : g.text} />
    </View>
  );

  // ─── Render: Summary card + actions (topo do monitor) ───

  const renderSummary = () => (
    <View>
      <View style={[s.card, { backgroundColor: g.cardBg }]}>
        <View style={s.sumTop}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[s.caption, { color: g.secondary }]} maxFontSizeMultiplier={1.4}>{t('parentalMon.screenTimeToday')}</Text>
            <View style={s.sumValueRow}>
              <Text style={[s.sumValue, { color: overLimit ? g.destructive : g.text }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.3}>{fmtDur(todayMinutes)}</Text>
              {effLimit > 0 && (
                <Text style={[s.sumOf, { color: g.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('parentalMon.ofLimit', { limit: fmtDur(effLimit) })}</Text>
              )}
            </View>
          </View>
          <Pressable
            onPress={grantBonus}
            disabled={bonusBusy}
            style={({ pressed }) => [s.bonusBtn, { backgroundColor: g.fill, opacity: pressed || bonusBusy ? 0.6 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={t('parentalDash.actBonusA11y')}
            hitSlop={6}
          >
            {bonusBusy ? <ActivityIndicator size="small" color={g.text} /> : <IconPlus size={15} color={g.text} />}
            <Text style={[s.bonusText, { color: g.text }]} maxFontSizeMultiplier={1.3}>{t('parentalMon.addMinutes')}</Text>
          </Pressable>
        </View>
        {effLimit > 0 && (
          <View style={[s.track, { backgroundColor: g.fill }]}>
            <View style={[s.trackFill, { width: `${Math.max(todayProgress * 100, todayMinutes > 0 ? 2 : 0)}%`, backgroundColor: overLimit ? g.destructive : ink }]} />
          </View>
        )}
        <Text style={[s.sumFoot, { color: overLimit ? g.destructive : g.secondary }]} maxFontSizeMultiplier={1.4}>
          {effLimit > 0
            ? (overLimit ? t('parentalMon.limitReached') : t('parentalMon.remaining', { time: fmtDur(effLimit - todayMinutes) }))
            : t('parentalMon.noLimit')}
        </Text>
        <View style={[s.hair, { backgroundColor: g.separator }]} />
        <View style={s.lockRow}>
          <View style={{ marginRight: 12 }}><MutedIcon Icon={isLocked ? IconLock : IconSmartphone} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[s.rowTitle, { color: g.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{isLocked ? t('parentalMon.accessPaused') : t('parentalMon.accessAllowed')}</Text>
            <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.4}>{isLocked ? t('parentalMon.accessPausedSub') : t('parentalMon.accessAllowedSub')}</Text>
          </View>
          <NativeSwitch value={!isLocked} onValueChange={(v) => toggleLock(!v)} disabled={lockBusy} accessibilityLabel={t('parentalMon.appAccess')} />
        </View>
      </View>

      <View style={s.actRow}>
        <MonoTile Icon={IconMapPin} label={t('parentalMon.actLocate')} onPress={locateChild} busy={sosLoading} disabled={sosLoading} />
        <MonoTile Icon={IconMessageSquare} label={t('parentalDash.actMessages')} onPress={() => { try { haptics.tap('light'); } catch {} setTab('contacts'); }} badge={pendingContacts} />
        <MonoTile Icon={isLocked ? IconPlay : IconPause} label={isLocked ? t('parentalDash.actResume') : t('parentalDash.actPause')} active={isLocked} onPress={() => toggleLock(!isLocked)} disabled={lockBusy} />
        <MonoTile Icon={IconMoreHorizontal} label={t('parentalDash.actMore')} a11y={t('parentalDash.moreA11y')} onPress={() => setMoreOpen(true)} />
      </View>
    </View>
  );

  // ─── Render: Today Tab ───

  const renderTodayTab = () => {
    const shown = showAllTimeline ? timelineEvents : timelineEvents.slice(0, 12);
    return (
      <View>
        {aiCards.length > 0 && (
          <SettingsGroup header={t('parental.aiSummary')} inset={60}>
            {aiCards.map(card => {
              const danger = card.risk === 'high';
              return (
                <View key={card.id} style={s.listRow} accessibilityLabel={card.title}>
                  <View style={{ marginRight: 12 }}><MutedIcon Icon={danger ? IconAlertTriangle : IconSparkles} danger={danger} /></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.rowTitle, { color: g.text }]} numberOfLines={4} maxFontSizeMultiplier={1.4}>{card.title}</Text>
                    {!!card.flags?.length && (
                      <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={1}>{card.flags.slice(0, 3).map(f => (typeof f === 'string' ? f : f?.title || '')).join(' · ')}</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </SettingsGroup>
        )}

        {todayTopContacts.length > 0 && (
          <SettingsGroup header={t('parental.mostContacted')} inset={64}>
            {todayTopContacts.map((c, idx) => (
              <View key={c.email || idx} style={s.listRow}>
                <AvatarCircle name={c.name || c.email} email={c.email} size={36} />
                <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                  <Text style={[s.rowTitle, { color: g.text }]} numberOfLines={1}>{c.name || c.email}</Text>
                  <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={1}>{t('parentalMon.msgsCount', { n: c.message_count || c.count || 0 })}</Text>
                </View>
              </View>
            ))}
          </SettingsGroup>
        )}

        {timelineEvents.length === 0 ? (
          <View style={{ marginBottom: 26 }}>
            <Text style={[s.groupHeader, { color: g.header }]}>{t('parentalMon.timeline').toUpperCase()}</Text>
            <CompactEmpty Icon={IconClock} title={t('parentalMon.noActivity')} subtitle={t('parentalMon.noActivitySub', { name: childName })} />
          </View>
        ) : (
          <SettingsGroup header={t('parentalMon.timeline')} inset={60}>
            {shown.map((ev, i) => {
              const cfg = activityIconFor(ev.type, t);
              const when = fmtTime(ev.created_at || ev.ts);
              return (
                <View key={ev.id || i} style={s.listRow} accessibilityLabel={`${cfg.label}: ${ev.label || ev.target || ''} ${when}`}>
                  <View style={{ marginRight: 12 }}><MutedIcon Icon={cfg.Icon} danger={cfg.danger} /></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.rowTitle, { color: g.text }]} numberOfLines={1}>
                      {cfg.label}{ev.target ? <Text style={{ color: g.secondary }}>{` · ${ev.target}`}</Text> : null}
                    </Text>
                    {!!ev.label && ev.label !== ev.target && (
                      <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={2}>{ev.label}</Text>
                    )}
                  </View>
                  <Text style={[s.rowValue, { color: g.secondary }]}>{when}</Text>
                </View>
              );
            })}
            {timelineEvents.length > shown.length && (
              <SettingsRow title={t('parentalMon.showAll', { n: timelineEvents.length })} onPress={() => setShowAllTimeline(true)} center chevron={false} titleStyle={{ fontWeight: '600' }} />
            )}
          </SettingsGroup>
        )}
      </View>
    );
  };

  // ─── Render: Week Tab ───

  const renderWeekTab = () => {
    const days7 = weekDays.length === 7 ? weekDays : (() => {
      // Pad to 7 — current weekday last.
      const seq = Array.from({ length: 7 }).map((_, i) => ({ day: i, minutes: 0, messages: 0, calls: 0 }));
      weekDays.forEach(d => { const i = typeof d.day === 'number' ? d.day : 0; seq[i] = { ...seq[i], ...d }; });
      return seq;
    })();
    const maxBar = Math.max(...days7.map(d => d.minutes || 0), 1);
    const totalMessages = days7.reduce((acc, d) => acc + (d.messages || 0), 0);
    const totalCalls = days7.reduce((acc, d) => acc + (d.calls || 0), 0);
    const todayIdx = new Date().getDay();

    return (
      <View>
        <View style={[s.card, { backgroundColor: g.cardBg, marginBottom: 26 }]}>
          <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
            <Text style={[s.caption, { color: g.secondary }]}>{t('parentalMon.thisWeek')}</Text>
            <View style={s.sumValueRow}>
              <Text style={[s.sumValue, { color: g.text }]} numberOfLines={1}>{fmtDur(weekTotalMinutes)}</Text>
              {weekTrend !== null && (
                <Text style={[s.sumOf, { color: g.secondary }]} numberOfLines={1} accessibilityLabel={t('parentalMon.vsLastWeek', { pct: (weekTrend > 0 ? '+' : '') + weekTrend })}>
                  {t('parentalMon.vsLastWeek', { pct: (weekTrend > 0 ? '+' : '') + weekTrend })}
                </Text>
              )}
            </View>
            <Text style={[s.rowSub, { color: g.secondary, marginTop: 2 }]}>{t('parentalMon.weekCounts', { msgs: totalMessages, calls: totalCalls })}</Text>
          </View>
          <View style={s.barChart}>
            {days7.map((item, idx) => {
              const barHeight = Math.max(((item.minutes || 0) / maxBar) * 110, 4);
              const isToday = idx === todayIdx;
              return (
                <View key={idx} style={s.barCol} accessibilityLabel={`${dayShort(idx)}: ${fmtDur(item.minutes)}`}>
                  <View style={[s.bar, { height: barHeight, backgroundColor: isToday ? ink : (g.isDark ? '#3A3A3C' : '#D1D1D6') }]} />
                  <Text style={[s.barLabel, { color: isToday ? g.text : g.secondary, fontWeight: isToday ? '700' : '500' }]}>{dayShort(idx)}</Text>
                </View>
              );
            })}
          </View>
        </View>

        <SettingsGroup header={t('parentalMon.byDay')}>
          {days7.map((d, idx) => (
            <SettingsRow
              key={idx}
              title={dayShort(idx)}
              subtitle={t('parentalMon.dayCounts', { msgs: d.messages || 0, calls: d.calls || 0 })}
              value={d.minutes > 0 ? fmtDur(d.minutes) : '—'}
            />
          ))}
        </SettingsGroup>
      </View>
    );
  };

  // ─── Render: Apps Tab ───

  const renderAppsTab = () => {
    const hours = (todayData?.active_hours || screenTime?.active_hours || []).slice(0, 6);
    return (
      <View>
        <SettingsGroup header={t('parentalMon.byArea')} inset={60}>
          {appsBreakdown.map((a) => {
            const pct = (Number(a.value) || 0) / appsMax;
            return (
              <View key={a.key} style={s.listRow} accessibilityLabel={`${a.label}: ${a.value}`}>
                <View style={{ marginRight: 12 }}><MutedIcon Icon={a.Icon} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={[s.rowTitle, { color: g.text, flex: 1 }]} numberOfLines={1}>{a.label}</Text>
                    <Text style={[s.rowValue, { color: g.secondary }]}>{a.value}</Text>
                  </View>
                  <View style={[s.track, { backgroundColor: g.fill, marginTop: 8, height: 4 }]}>
                    <View style={[s.trackFill, { width: `${Math.max(pct * 100, (Number(a.value) || 0) > 0 ? 3 : 0)}%`, backgroundColor: ink }]} />
                  </View>
                </View>
              </View>
            );
          })}
        </SettingsGroup>

        {hours.length > 0 && (
          <SettingsGroup header={t('parental.mostActive')}>
            <SettingsCardContent>
              <View style={s.hoursGrid}>
                {hours.map((h, i) => (
                  <View key={i} style={[s.hourChip, { backgroundColor: i === 0 ? ink : g.fill }]}>
                    <Text style={[s.hourText, { color: i === 0 ? onInk : g.text }]}>{String(h.hour).padStart(2, '0')}:00</Text>
                    <Text style={[s.hourPct, { color: i === 0 ? onInk : g.secondary }]}>{Math.round((h.percentage || 0) * 100)}%</Text>
                  </View>
                ))}
              </View>
            </SettingsCardContent>
          </SettingsGroup>
        )}
      </View>
    );
  };

  // ─── Render: Contacts Tab ───

  const renderContactItem = (item) => {
    const newThisWeek = isNewThisWeek(item);
    const unknown = isUnknownContact(item);
    const ageUnknown = item.age_known === false;
    const status = item.approval_status; // 'approved' | 'pending' | 'blocked'
    const busy = contactBusy[item.email];
    const tags = [];
    if (status === 'approved') tags.push({ k: 'ok', label: t('parentalMon.approved') });
    if (status === 'blocked') tags.push({ k: 'bl', label: t('parentalMon.blocked'), danger: true });
    if (status === 'pending') tags.push({ k: 'pe', label: t('parentalMon.pendingApproval') });
    if (newThisWeek) tags.push({ k: 'nw', label: t('parentalMon.newThisWeek') });
    if (unknown) tags.push({ k: 'un', label: t('parentalMon.unknown'), danger: true });
    if (ageUnknown) tags.push({ k: 'ag', label: t('parentalMon.ageUnknown') });
    const name = item.name || item.email || t('parental.unknown');
    return (
      <PressableRow
        key={String(item.email || item.conversation_id)}
        onPress={() => router.push(`/parental-child-chat?child_email=${encodeURIComponent(childEmail)}&conversation_id=${encodeURIComponent(item.conversation_id || '')}&chat_name=${encodeURIComponent(item.name || item.email || '')}`)}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${t('parentalMon.msgsCount', { n: item.message_count || 0 })}`}
      >
        <View style={[s.listRow, { alignItems: 'flex-start' }]}>
          <AvatarCircle name={item.name || item.email} email={item.email} size={40} />
          <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[s.rowTitle, { color: g.text, flex: 1, fontWeight: '600' }]} numberOfLines={1}>{name}</Text>
              <Text style={[s.rowValue, { color: g.secondary }]}>{item.last_interaction_at ? fmtRelative(item.last_interaction_at, t) : ''}</Text>
            </View>
            <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={1}>{t('parentalMon.msgsCount', { n: item.message_count || 0 })}</Text>
            {tags.length > 0 && (
              <View style={s.tagRow}>
                {tags.map(tg => (
                  <View key={tg.k} style={[s.tag, { backgroundColor: tg.danger ? 'rgba(239,68,68,0.12)' : g.fill }]}>
                    <Text style={[s.tagText, { color: tg.danger ? g.destructive : g.text }]}>{tg.label}</Text>
                  </View>
                ))}
              </View>
            )}
            {status !== 'approved' && status !== 'blocked' && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Pressable
                  onPress={(e) => { e?.stopPropagation?.(); handleApproveContact(item.email); }}
                  disabled={!!busy}
                  style={({ pressed }) => [s.inlineBtn, { backgroundColor: ink, opacity: pressed ? 0.7 : 1 }]}
                  accessibilityLabel={`${t('parentalDash.approve')} ${name}`}
                  accessibilityRole="button"
                >
                  {busy === 'approving' ? <ActivityIndicator size="small" color={onInk} /> : <Text style={[s.inlineBtnText, { color: onInk }]}>{t('parentalDash.approve')}</Text>}
                </Pressable>
                <Pressable
                  onPress={(e) => { e?.stopPropagation?.(); handleBlockContact(item.email); }}
                  disabled={!!busy}
                  style={({ pressed }) => [s.inlineBtn, { backgroundColor: g.fill, opacity: pressed ? 0.7 : 1 }]}
                  accessibilityLabel={`${t('parentalMon.block')} ${name}`}
                  accessibilityRole="button"
                >
                  {busy === 'blocking' ? <ActivityIndicator size="small" color={g.destructive} /> : <Text style={[s.inlineBtnText, { color: g.destructive }]}>{t('parentalMon.block')}</Text>}
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </PressableRow>
    );
  };

  const renderContactsTab = () => {
    // Merge backend contacts + chats fallback so the list is never empty.
    const data = monitorContacts.length
      ? monitorContacts
      : chats.map(c => ({
          email: c.email || c.peer_email || ('chat_' + c.id),
          name: c.name,
          conversation_id: c.id,
          message_count: c.total_messages,
          last_interaction_at: c.last_message_at,
        }));
    if (!data.length) {
      return (
        <View style={{ marginBottom: 26 }}>
          <Text style={[s.groupHeader, { color: g.header }]}>{t('parentalMon.interactions').toUpperCase()}</Text>
          <CompactEmpty Icon={IconUsers} title={t('parentalMon.noContacts')} subtitle={t('parentalMon.noContactsSub', { name: childName })} />
        </View>
      );
    }
    return (
      <SettingsGroup header={t('parentalMon.interactions')} footer={t('parentalMon.contactsHint')} inset={68}>
        {data.map(renderContactItem)}
      </SettingsGroup>
    );
  };

  // ─── Render: Restrições (sub-tela) ───

  const inputStyle = useSettingsInputStyle();
  const timeLimitIndex = TIME_LIMITS.findIndex(tl => tl.value === (restrictions.daily_limit_minutes || 0));
  const currentLimit = TIME_LIMITS[timeLimitIndex >= 0 ? timeLimitIndex : TIME_LIMITS.length - 1].value;
  const limitOptions = TIME_LIMITS.map(tl => ({ value: tl.value, label: tl.value === 0 ? t('parental.unlimited') : tl.label }));

  const renderRestrictions = () => (
    <View>
      {(saving || !!savedMsg) && (
        <View style={s.saveRow}>
          {saving ? <ActivityIndicator size="small" color={g.secondary} /> : null}
          <Text style={[s.rowSub, { color: g.secondary, marginTop: 0 }]}>{saving ? t('parental.saving') : savedMsg}</Text>
        </View>
      )}

      <SettingsGroup header={t('parental.restrictions')}>
        <SettingsSwitchRow icon={IconMail} title={t('parental.canSendEmail')} value={restrictions.can_send_email !== false} onValueChange={(v) => updateRestriction('can_send_email', v)} />
        <SettingsSwitchRow icon={IconTrash} title={t('parental.canDeleteMessages')} value={restrictions.can_delete_messages !== false} onValueChange={(v) => updateRestriction('can_delete_messages', v)} />
        <SettingsSwitchRow icon={IconLock} title={t('parental.canChangePassword')} value={restrictions.can_change_password !== false} onValueChange={(v) => updateRestriction('can_change_password', v)} />
      </SettingsGroup>

      <SettingsGroup header={t('parentalMon.screenTime')}>
        <SettingsPickerRow
          icon={IconClock}
          title={t('parental.dailyLimit')}
          options={limitOptions}
          value={currentLimit}
          onChange={(v) => updateRestriction('daily_limit_minutes', v)}
          cancelLabel={t('parental.cancel')}
        />
      </SettingsGroup>

      <SettingsGroup header={t('parental.bedtime')}>
        <SettingsCardContent>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={[s.inputLabel, { color: g.secondary }]}>{t('parental.bedtimeStart')}</Text>
              <TextInput
                style={[inputStyle, s.timeInput]}
                value={restrictions.bedtime_start || '22:00'}
                onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_start: v }))}
                onBlur={() => updateRestriction('bedtime_start', restrictions.bedtime_start || '22:00')}
                placeholder="22:00" placeholderTextColor={g.secondary} keyboardType="numbers-and-punctuation" maxLength={5}
                accessibilityLabel={t('parental.bedtimeStart')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.inputLabel, { color: g.secondary }]}>{t('parental.bedtimeEnd')}</Text>
              <TextInput
                style={[inputStyle, s.timeInput]}
                value={restrictions.bedtime_end || '07:00'}
                onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_end: v }))}
                onBlur={() => updateRestriction('bedtime_end', restrictions.bedtime_end || '07:00')}
                placeholder="07:00" placeholderTextColor={g.secondary} keyboardType="numbers-and-punctuation" maxLength={5}
                accessibilityLabel={t('parental.bedtimeEnd')}
              />
            </View>
          </View>
        </SettingsCardContent>
      </SettingsGroup>

      <SettingsGroup header={t('parental.whitelist')} inset={60}>
        <SettingsCardContent>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={[inputStyle, { flex: 1 }]}
              value={newContact} onChangeText={setNewContact} placeholder={t('parental.contactEmail')} placeholderTextColor={g.secondary}
              keyboardType="email-address" autoCapitalize="none" onSubmitEditing={handleAddContact}
              accessibilityLabel={t('parental.contactEmail')}
            />
            <Pressable onPress={handleAddContact} style={({ pressed }) => [s.addBtn, { backgroundColor: ink, opacity: pressed ? 0.7 : 1 }]} accessibilityLabel={t('parental.addContact')} accessibilityRole="button">
              <IconPlus size={18} color={onInk} />
            </Pressable>
          </View>
        </SettingsCardContent>
        {whitelist.length === 0 ? (
          <SettingsRow title={t('parental.noContacts')} titleStyle={{ color: g.secondary, fontSize: 14 }} />
        ) : whitelist.map((contact, idx) => (
          <View key={contact.email || idx} style={s.listRow}>
            <View style={{ marginRight: 12 }}><MutedIcon Icon={IconUser} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.rowTitle, { color: g.text }]} numberOfLines={1}>{contact.name || contact.email}</Text>
              {!!contact.name && <Text style={[s.rowSub, { color: g.secondary }]} numberOfLines={1}>{contact.email}</Text>}
            </View>
            <Pressable onPress={() => handleRemoveContact(contact.email)} hitSlop={10} accessibilityLabel={`${t('parental.removeContact')} ${contact.email}`} accessibilityRole="button" style={s.removeBtn}>
              <IconX size={16} color={g.destructive} />
            </Pressable>
          </View>
        ))}
      </SettingsGroup>

      <SettingsGroup header={t('parental.contentFilters') || 'Content filters'}>
        <SettingsSwitchRow icon={IconShield} title={t('parental.filterAdult') || 'Block adult content'} value={restrictions.filter_adult !== false} onValueChange={(v) => updateRestriction('filter_adult', v)} />
        <SettingsSwitchRow icon={IconAlertTriangle} title={t('parental.filterViolence') || 'Block violence'} value={restrictions.filter_violence === true} onValueChange={(v) => updateRestriction('filter_violence', v)} />
        <SettingsSwitchRow icon={IconFilter} title={t('parental.filterProfanity') || 'Filter profanity'} value={restrictions.filter_profanity === true} onValueChange={(v) => updateRestriction('filter_profanity', v)} />
        <SettingsSwitchRow icon={IconEye} title={t('parental.safeSearch') || 'Safe search'} value={restrictions.safe_search === true} onValueChange={(v) => updateRestriction('safe_search', v)} />
      </SettingsGroup>
    </View>
  );

  // ─── Tab Content Map ───

  const tabContent = {
    today: renderTodayTab,
    week: renderWeekTab,
    apps: renderAppsTab,
    contacts: renderContactsTab,
  };

  // ─── Header ───

  const HeaderTitle = () => (
    <View style={s.hTitle} accessibilityRole="header" accessibilityLabel={`${childName}, ${statusLine}`}>
      <View>
        <AvatarCircle email={childEmail} name={childName} size={32} />
        {isOnline && <View style={[s.hDot, { borderColor: g.pageBg }]} />}
      </View>
      <View style={{ flexShrink: 1, minWidth: 0, marginLeft: 10 }}>
        <Text style={[s.hName, { color: g.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{childName}</Text>
        <Text style={[s.hSub, { color: g.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{statusLine}</Text>
      </View>
    </View>
  );

  const onBack = () => {
    if (showRestrictions) { setShowRestrictions(false); return; }
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/parental'); } catch {}
  };

  // ─── Main Render ───

  const bottomPad = 32 + (USE_NATIVE_HEADER && Platform.OS === 'ios' ? 0 : insets.bottom);

  return (
    <View style={[s.container, { backgroundColor: g.pageBg }]}>
      {USE_NATIVE_HEADER ? (
        // As options do Stack.Screen se MESCLAM entre renders: headerLeft/headerTitle
        // são sempre passados explicitamente (undefined limpa) p/ não "vazar" entre
        // o monitor e a sub-tela de restrições.
        <Stack.Screen options={{
          ...nativeHeaderOptions({
            colors,
            isDark,
            title: showRestrictions ? t('parentalMon.restrictionsTitle') : childName,
            headerTitleAlign: 'left',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: g.pageBg },
            contentStyle: { backgroundColor: g.pageBg },
          }),
          headerTitle: showRestrictions ? undefined : () => <HeaderTitle />,
          headerLeft: showRestrictions ? () => <HeaderBackButton onPress={() => setShowRestrictions(false)} color={g.text} /> : undefined,
          headerBackVisible: !showRestrictions,
        }} />
      ) : (
        <View style={[s.webHeader, { paddingTop: insets.top, backgroundColor: g.pageBg }]}>
          <Pressable onPress={onBack} style={s.webBack} accessibilityRole="button" accessibilityLabel={t('parentalDash.back')} hitSlop={8}>
            <IconArrowLeft size={24} color={g.text} />
          </Pressable>
          {showRestrictions
            ? <Text style={[s.hName, { color: g.text, fontSize: 17, flex: 1 }]} numberOfLines={1} accessibilityRole="header">{t('parentalMon.restrictionsTitle')}</Text>
            : <View style={{ flex: 1, minWidth: 0 }}><HeaderTitle /></View>}
        </View>
      )}

      {loading ? (
        <TabSkeleton dark={isDark} />
      ) : showRestrictions ? (
        <ScrollView
          contentContainerStyle={[s.content, { paddingBottom: bottomPad }]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          {renderRestrictions()}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: bottomPad }}
          stickyHeaderIndices={[1]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={refresh}
        >
          <View style={[s.content, { paddingBottom: 0 }]}>{renderSummary()}</View>
          <View style={[s.segWrap, { backgroundColor: g.pageBg }]}>
            <SegmentedControl options={tabs} value={tab} onChange={setTab} testID="monitor-tabs" />
          </View>
          <Animated.View style={[s.content, { paddingTop: 14, opacity: slideAnim }]}>
            {tabContent[tab]()}
          </Animated.View>
        </ScrollView>
      )}

      <ActionSheet
        visible={moreOpen}
        title={childName}
        subtitle={childEmail}
        items={[
          { key: 'restrictions', Icon: IconSliders, label: t('parentalMon.moreRestrictions') },
          { key: 'refresh', Icon: IconRefresh, label: t('parentalMon.moreRefresh') },
        ]}
        onSelect={onMoreSelect}
        onClose={() => setMoreOpen(false)}
        cancelLabel={t('parentalDash.cancel')}
      />
    </View>
  );
}

// [WAVE 63 #fam-crash] ErrorBoundary wrap — reached via /family → "Encontrar
// família" tile too, so a crash here surfaces as "Família crash" to user.
export default function ParentalMonitorScreen() {
  return <ErrorBoundary><ParentalMonitorScreenInner /></ErrorBoundary>;
}

// ─── Activity icon resolver (monocromático; vermelho só p/ chamada perdida) ───
function activityIconFor(type, t) {
  switch (type) {
    case 'message_sent':
    case 'chat_message':
      return { Icon: IconMessageSquare, label: t('parentalMon.evMessage') };
    case 'message_received':
      return { Icon: IconMessageSquare, label: t('parentalMon.evReceived') };
    case 'call_outgoing': return { Icon: IconPhone, label: t('parentalMon.evCall') };
    case 'call_incoming': return { Icon: IconPhone, label: t('parentalMon.evCallIn') };
    case 'call_missed':   return { Icon: IconPhoneOff, label: t('parentalMon.evCallMissed'), danger: true };
    case 'status_post':   return { Icon: IconImage, label: t('parentalMon.evStatus') };
    case 'video_played':
    case 'reel_view':     return { Icon: IconVideo, label: t('parentalMon.evReels') };
    case 'feed_post':     return { Icon: IconHeart, label: t('parentalMon.evFeed') };
    case 'app_open':      return { Icon: IconZap, label: t('parentalMon.evAppOpen') };
    case 'bedtime':       return { Icon: IconMoon, label: t('parentalMon.evOther') };
    default:              return { Icon: IconClock, label: t('parentalMon.evOther') };
  }
}

// ─── Styles ───

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, width: '100%', maxWidth: 720, alignSelf: 'center' },

  // Header (título nativo customizado + header web)
  hTitle: { flexDirection: 'row', alignItems: 'center', maxWidth: 280 },
  hDot: { position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6, backgroundColor: '#22c55e', borderWidth: 2 },
  hName: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  hSub: { fontSize: 12, marginTop: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, gap: 4 },
  webBack: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },

  // Summary card
  card: { borderRadius: 12, overflow: 'hidden' },
  sumTop: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingTop: 14, gap: 12 },
  caption: { fontSize: 13, fontWeight: '500' },
  sumValueRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2, columnGap: 8 },
  sumValue: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  sumOf: { fontSize: 15, fontWeight: '500' },
  bonusBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 32, borderRadius: 16, marginTop: 2, ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  bonusText: { fontSize: 13, fontWeight: '600' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', marginHorizontal: 16, marginTop: 12 },
  trackFill: { height: '100%', borderRadius: 3 },
  sumFoot: { fontSize: 13, paddingHorizontal: 16, marginTop: 8, marginBottom: 14 },
  hair: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  lockRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },

  actRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 6 },
  segWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, width: '100%', maxWidth: 720, alignSelf: 'center' },

  // Rows
  groupHeader: { fontSize: 13, fontWeight: '500', letterSpacing: 0.2, paddingHorizontal: 16, marginBottom: 7 },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, minHeight: 52 },
  mutedIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, letterSpacing: -0.2 },
  rowSub: { fontSize: 13, lineHeight: 17, marginTop: 2 },
  rowValue: { fontSize: 13, marginLeft: 10, fontVariant: ['tabular-nums'] },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  tagText: { fontSize: 11, fontWeight: '600' },
  inlineBtn: { minWidth: 92, minHeight: 32, paddingHorizontal: 14, borderRadius: 16, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  inlineBtnText: { fontSize: 13, fontWeight: '600' },

  // Week chart
  barChart: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 150, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12 },
  barCol: { alignItems: 'center', flex: 1, justifyContent: 'flex-end' },
  bar: { width: 22, minHeight: 4, borderRadius: 5 },
  barLabel: { fontSize: 11, marginTop: 6 },

  // Active hours
  hoursGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hourChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, alignItems: 'center', minWidth: 64 },
  hourText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hourPct: { fontSize: 11, marginTop: 1 },

  // Restrições
  saveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingBottom: 12 },
  inputLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  timeInput: { textAlign: 'center', fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  addBtn: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  removeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
});
