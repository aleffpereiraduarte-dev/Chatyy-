import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Platform, ScrollView, TextInput, Switch, Alert, Animated, AppState, RefreshControl } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconMessageSquare, IconPhone, IconPhoneOff, IconAlertCircle, IconChevronRight, IconShield, IconEye, IconLock, IconClock, IconBarChart, IconX, IconPlus, IconUser, IconMail, IconTrash, IconAlertTriangle, IconFilter, IconSmartphone, IconCheck, IconSparkles, IconHeart, IconImage, IconVideo, IconZap } from '../components/Icons';
import EmptyStateCard from '../components/EmptyStateCard';
import AvatarCircle from '../components/AvatarCircle';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import useIsMounted from '../hooks/useIsMounted';

const ACCENT = '#7C3AED';
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
const fmtDateTime = (d) => { const x = safeDate(d); return x ? x.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
const fmtTime = (d) => { const x = safeDate(d); return x ? x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const minsAgo = (d) => {
  const x = safeDate(d);
  if (!x) return null;
  const diff = Math.floor((Date.now() - x.getTime()) / 60000);
  return diff < 0 ? 0 : diff;
};
const fmtRelative = (d) => {
  const m = minsAgo(d);
  if (m === null) return '';
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d`;
};

// Skeleton block — minimal shimmer used while a tab loads.
function Skel({ w = '100%', h = 14, mt = 0, br = 8, dark }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 700, useNativeDriver: false }),
      ])
    ).start();
  }, [anim]);
  const bg = anim.interpolate({ inputRange: [0, 1], outputRange: [dark ? '#1e293b' : '#e5e7eb', dark ? '#334155' : '#f3f4f6'] });
  return <Animated.View style={{ width: w, height: h, marginTop: mt, borderRadius: br, backgroundColor: bg }} />;
}

function TabSkeleton({ dark }) {
  return (
    <View style={{ padding: 18, gap: 14 }}>
      <Skel dark={dark} h={88} br={20} />
      <Skel dark={dark} h={160} br={20} mt={10} />
      <Skel dark={dark} h={20} w="40%" mt={14} />
      <Skel dark={dark} h={64} br={16} mt={4} />
      <Skel dark={dark} h={64} br={16} mt={6} />
    </View>
  );
}

// Risk indicators for Contacts tab.
const isUnknownContact = (c) => !c?.name || /^\+?\d{6,}$/.test(String(c?.name || ''));
const isNewThisWeek = (c) => {
  const x = safeDate(c?.first_seen || c?.created_at);
  return x ? (Date.now() - x.getTime()) < 7 * 24 * 3600 * 1000 : false;
};

export default function ParentalMonitorScreen() {
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

  const slideAnim = useRef(new Animated.Value(0)).current;
  const livePulse = useRef(new Animated.Value(0)).current;

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
      if (r?.success) setRestrictions(r.data?.restrictions || {});
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

  // Live status pulse animation.
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, [livePulse]);

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

  // ─── Tab Config (4 monitor tabs) ───

  const tabs = [
    { key: 'today',    label: 'Hoje',     icon: IconClock },
    { key: 'week',     label: 'Semana',   icon: IconBarChart },
    { key: 'apps',     label: 'Apps',     icon: IconSmartphone },
    { key: 'contacts', label: 'Contatos', icon: IconUser, badge: monitorContacts.filter(c => c.approval_status === 'pending').length },
  ];

  // ─── Derived (Today) ───

  const todayMinutes = todayData?.today_minutes ?? screenTime?.today_minutes ?? 0;
  const dailyLimit = restrictions.daily_limit_minutes || 0;
  const todayProgress = dailyLimit > 0 ? Math.min(todayMinutes / Math.max(dailyLimit, 1), 1) : (todayMinutes > 0 ? 0.5 : 0);
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

  // Activity timeline grouped by hour.
  const groupedActivity = useMemo(() => {
    const events = (activity && activity.length)
      ? activity
      : []; // fallback synth from chats[] last_message
    if (!events.length && chats?.length) {
      // Build a minimal pseudo-timeline from last messages — keeps the tab
      // useful even before the activity endpoint ships.
      const now = Date.now();
      chats.slice(0, 8).forEach((c, i) => {
        if (c?.last_message_at || c?.last_message) {
          events.push({
            id: 'chat_' + (c.id || i),
            type: 'chat_message',
            label: c.last_message || (c.name || 'mensagem'),
            target: c.name || c.email,
            created_at: c.last_message_at || new Date(now - i * 600000).toISOString(),
          });
        }
      });
    }
    const buckets = {};
    events.forEach(ev => {
      const d = safeDate(ev.created_at || ev.ts);
      if (!d) return;
      const hk = d.getHours();
      const key = String(hk).padStart(2, '0') + ':00';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(ev);
    });
    return Object.entries(buckets)
      .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0]))
      .map(([hour, items]) => ({ hour, items: items.sort((a, b) => new Date(b.created_at || b.ts) - new Date(a.created_at || a.ts)) }));
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
      { key: 'chat',   label: 'Chat',     value: f.chat ?? f.messages ?? screenTime?.today_minutes ?? 0, color: '#7C3AED', Icon: IconMessageSquare },
      { key: 'status', label: 'Status',   value: f.status ?? 0,    color: '#22c55e', Icon: IconImage },
      { key: 'reels',  label: 'Reels',    value: f.reels ?? 0,     color: '#ec4899', Icon: IconVideo },
      { key: 'feed',   label: 'Feed',     value: f.feed ?? 0,      color: '#f59e0b', Icon: IconHeart },
      { key: 'calls',  label: 'Chamadas', value: f.calls ?? calls.length, color: '#3b82f6', Icon: IconPhone },
    ];
  }, [todayData, weekData, screenTime, calls]);
  const appsMax = Math.max(...appsBreakdown.map(a => Number(a.value) || 0), 1);

  // ─── Render: AI Cards ───
  const renderAICard = (card) => {
    const tone = card.risk === 'high' ? '#ef4444' : card.risk === 'warning' ? '#f59e0b' : card.risk === 'medium' ? '#f59e0b' : '#A78BFA';
    return (
      <TouchableOpacity
        key={card.id}
        style={[s.aiCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: tone + '55' }]}
        activeOpacity={0.85}
        onPress={() => setTab('today')}
        accessibilityLabel={`AI insight: ${card.title}`}
        accessibilityRole="button"
      >
        <View style={[s.aiCardIcon, { backgroundColor: tone + '20' }]}>
          <IconSparkles size={16} color={tone} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.aiCardTitle, { color: colors.text }]} numberOfLines={3}>{card.title}</Text>
          {!!card.flags?.length && (
            <Text style={[s.aiCardSub, { color: colors.textSecondary }]} numberOfLines={1}>{card.flags.slice(0, 3).join(' · ')}</Text>
          )}
        </View>
        <IconChevronRight size={16} color={colors.textSecondary} />
      </TouchableOpacity>
    );
  };

  // ─── Render: Today Tab ───

  const renderTodayTab = () => {
    const ringColor = todayProgress > 0.8 ? '#ef4444' : todayProgress > 0.5 ? '#f59e0b' : ACCENT;
    const ringSize = 160;
    const strokeWidth = 12;
    const radius = (ringSize - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference * (1 - todayProgress);
    const hours = Math.floor(todayMinutes / 60);
    const mins = todayMinutes % 60;
    const pulseOpacity = livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

    return (
      <ScrollView
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
      >
        {/* Live status pill */}
        <View style={[s.livePill, { backgroundColor: isOnline ? '#22c55e15' : (isDark ? '#1e293b' : '#f1f5f9'), borderColor: isOnline ? '#22c55e55' : (isDark ? '#334155' : '#e2e8f0') }]}>
          {isOnline ? (
            <Animated.View style={[s.liveDot, { backgroundColor: '#22c55e', opacity: pulseOpacity }]} />
          ) : (
            <View style={[s.liveDot, { backgroundColor: colors.textSecondary }]} />
          )}
          <Text style={[s.livePillText, { color: isOnline ? '#16a34a' : colors.textSecondary }]} numberOfLines={1}>
            {isOnline
              ? `Online agora — usando ${currentApp}`
              : (lastSeenMins !== null ? `Offline há ${fmtRelative(lastSeenAt)}` : 'Offline')}
          </Text>
        </View>

        {/* AI insight cards */}
        {aiCards.length > 0 && (
          <View style={{ gap: 10, marginTop: 14 }}>
            <Text style={[s.sectionLabel, { color: colors.textSecondary, marginBottom: 0 }]}>{t('parental.aiSummary').toUpperCase()}</Text>
            {aiCards.map(renderAICard)}
          </View>
        )}

        {/* Donut chart for today screen time */}
        <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 18 }]}>{t('parental.todayUsage')?.toUpperCase() || 'HOJE'}</Text>
        <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', alignItems: 'center', paddingVertical: 28 }]} accessibilityLabel={`Tempo de tela: ${hours}h${mins}min de ${dailyLimit} minutos`}>
          <View style={{ width: ringSize, height: ringSize, justifyContent: 'center', alignItems: 'center' }}>
            <Svg width={ringSize} height={ringSize} style={{ position: 'absolute' }}>
              <SvgCircle cx={ringSize/2} cy={ringSize/2} r={radius} stroke={isDark ? '#0f172a' : '#f1f5f9'} strokeWidth={strokeWidth} fill="none" />
              <SvgCircle cx={ringSize/2} cy={ringSize/2} r={radius} stroke={ringColor} strokeWidth={strokeWidth} fill="none"
                strokeDasharray={`${circumference}`} strokeDashoffset={strokeDashoffset}
                strokeLinecap="round" rotation="-90" origin={`${ringSize/2}, ${ringSize/2}`} />
            </Svg>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 36, fontWeight: '800', color: colors.text }}>{hours > 0 ? `${hours}h${mins > 0 ? mins : ''}` : `${mins}`}</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: -2 }}>{hours > 0 ? '' : t('parental.minutesToday')}</Text>
            </View>
          </View>
          {dailyLimit > 0 && (
            <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 13 }}>
              {t('parental.dailyLimit')}: {dailyLimit >= 60 ? `${Math.floor(dailyLimit/60)}h${dailyLimit%60 > 0 ? dailyLimit%60 + 'min' : ''}` : `${dailyLimit} min`}
            </Text>
          )}
          {todayProgress > 0.8 && dailyLimit > 0 && (
            <View style={{ backgroundColor: '#ef444420', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
              {todayMinutes >= dailyLimit
                ? <><IconAlertCircle size={16} color="#ef4444" /><Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>{t('parental.limitReached') || 'Limite atingido'}</Text></>
                : <><IconAlertTriangle size={16} color="#f59e0b" /><Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>{t('parental.almostLimit') || 'Quase no limite'}</Text></>
              }
            </View>
          )}
        </View>

        {/* Top 3 contacts today */}
        {todayTopContacts.length > 0 && (
          <>
            <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.mostContacted').toUpperCase()}</Text>
            <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
              {todayTopContacts.map((c, idx) => (
                <View key={c.email || idx} style={[s.contactRow, idx < todayTopContacts.length - 1 && { borderBottomWidth: 1, borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
                  <AvatarCircle name={c.name || c.email} email={c.email} size={36} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[s.contactName, { color: colors.text }]}>{c.name || c.email}</Text>
                    <Text style={[s.contactMeta, { color: colors.textSecondary }]}>{c.message_count || c.count || 0} msgs</Text>
                  </View>
                  <IconChevronRight size={16} color={colors.textSecondary} />
                </View>
              ))}
            </View>
          </>
        )}

        {/* Activity timeline grouped by hour */}
        <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>LINHA DO TEMPO</Text>
        {groupedActivity.length === 0 ? (
          <EmptyStateCard Icon={IconClock} title="Sem atividade hoje" tone="neutral" />
        ) : (
          <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
            {groupedActivity.map(({ hour, items }, gi) => (
              <View key={hour} style={[s.timelineGroup, gi > 0 && { borderTopWidth: 1, borderTopColor: isDark ? '#334155' : '#f1f5f9' }]}>
                <Text style={[s.timelineHour, { color: colors.textSecondary }]}>{hour}</Text>
                <View style={{ flex: 1 }}>
                  {items.map((ev, i) => {
                    const cfg = activityIconFor(ev.type);
                    return (
                      <View key={ev.id || i} style={s.timelineItem} accessibilityLabel={`${cfg.label}: ${ev.label || ev.target || ''} às ${fmtTime(ev.created_at || ev.ts)}`}>
                        <View style={[s.timelineDot, { backgroundColor: cfg.color + '22' }]}>
                          <cfg.Icon size={12} color={cfg.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.timelineText, { color: colors.text }]} numberOfLines={2}>
                            <Text style={{ fontWeight: '700' }}>{cfg.label}</Text>
                            {ev.target ? <Text style={{ color: colors.textSecondary }}> · {ev.target}</Text> : null}
                          </Text>
                          {!!ev.label && ev.label !== ev.target && (
                            <Text style={[s.timelineSub, { color: colors.textSecondary }]} numberOfLines={2}>{ev.label}</Text>
                          )}
                        </View>
                        <Text style={[s.timelineTime, { color: colors.textSecondary }]}>{fmtTime(ev.created_at || ev.ts)}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    );
  };

  // ─── Render: Week Tab ───

  const renderWeekTab = () => {
    const dayLabels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    const days7 = weekDays.length === 7 ? weekDays : (() => {
      // Pad to 7 — current weekday last.
      const seq = Array.from({ length: 7 }).map((_, i) => ({ day: i, minutes: 0, messages: 0, calls: 0 }));
      weekDays.forEach(d => { const i = typeof d.day === 'number' ? d.day : 0; seq[i] = { ...seq[i], ...d }; });
      return seq;
    })();
    const maxBar = Math.max(...days7.map(d => d.minutes || 0), 1);
    const totalMessages = days7.reduce((s, d) => s + (d.messages || 0), 0);
    const totalCalls = days7.reduce((s, d) => s + (d.calls || 0), 0);

    return (
      <ScrollView
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
      >
        {/* Week summary header */}
        <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <Text style={{ fontSize: 30, fontWeight: '800', color: colors.text }}>
              {Math.floor(weekTotalMinutes / 60)}h{weekTotalMinutes % 60 > 0 ? (weekTotalMinutes % 60) : ''}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>esta semana</Text>
            {weekTrend !== null && (
              <View style={[s.trendChip, { backgroundColor: weekTrend > 0 ? '#ef444420' : '#22c55e20' }]} accessibilityLabel={`Tendência ${weekTrend > 0 ? 'subindo' : 'caindo'} ${Math.abs(weekTrend)}%`}>
                <Text style={{ color: weekTrend > 0 ? '#ef4444' : '#16a34a', fontSize: 12, fontWeight: '700' }}>
                  {weekTrend > 0 ? '↑' : '↓'} {Math.abs(weekTrend)}%
                </Text>
              </View>
            )}
          </View>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
            {totalMessages} mensagens · {totalCalls} chamadas
          </Text>
        </View>

        {/* 7-day bar chart */}
        <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.weeklyUsage').toUpperCase()}</Text>
        <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
          <View style={s.barChartContainer}>
            {days7.map((item, idx) => {
              const barHeight = Math.max((item.minutes / maxBar) * 130, 4);
              const isToday = idx === new Date().getDay();
              return (
                <View key={idx} style={s.barCol} accessibilityLabel={`${dayLabels[idx]}: ${item.minutes} minutos`}>
                  <Text style={[s.barValue, { color: colors.textSecondary }]}>{item.minutes > 0 ? item.minutes : ''}</Text>
                  <View style={[s.bar, { height: barHeight, backgroundColor: isToday ? ACCENT : (isDark ? '#475569' : '#cbd5e1'), borderRadius: 6 }]} />
                  <Text style={[s.barLabel, { color: isToday ? ACCENT : colors.textSecondary, fontWeight: isToday ? '700' : '500' }]}>{dayLabels[idx]}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Daily breakdown */}
        <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>POR DIA</Text>
        <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
          {days7.map((d, idx) => (
            <View key={idx} style={[s.contactRow, idx < days7.length - 1 && { borderBottomWidth: 1, borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
              <View style={[s.cardIcon, { backgroundColor: ACCENT + '15', width: 36, height: 36, borderRadius: 12 }]}>
                <Text style={{ color: ACCENT, fontWeight: '800', fontSize: 12 }}>{dayLabels[idx]}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[s.contactName, { color: colors.text }]}>
                  {d.minutes > 0 ? `${Math.floor(d.minutes / 60) > 0 ? Math.floor(d.minutes / 60) + 'h' : ''}${d.minutes % 60 ? (d.minutes % 60) + 'min' : (d.minutes < 60 ? d.minutes + 'min' : '')}` : '—'}
                </Text>
                <Text style={[s.contactMeta, { color: colors.textSecondary }]}>{d.messages || 0} msgs · {d.calls || 0} chamadas</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>
    );
  };

  // ─── Render: Apps Tab ───

  const renderAppsTab = () => {
    return (
      <ScrollView
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
      >
        <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>USO POR ÁREA</Text>
        <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
          {appsBreakdown.map((a, i) => {
            const pct = (Number(a.value) || 0) / appsMax;
            return (
              <View key={a.key} style={[s.appRow, i > 0 && { marginTop: 14 }]} accessibilityLabel={`${a.label}: ${a.value}`}>
                <View style={[s.appIcon, { backgroundColor: a.color + '18' }]}>
                  <a.Icon size={18} color={a.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={[s.appLabel, { color: colors.text }]}>{a.label}</Text>
                    <Text style={[s.appValue, { color: colors.textSecondary }]}>{a.value}</Text>
                  </View>
                  <View style={[s.appBarBg, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}>
                    <View style={[s.appBarFill, { width: `${Math.max(pct * 100, 4)}%`, backgroundColor: a.color }]} />
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* Active hours strip from backend */}
        {(todayData?.active_hours || screenTime?.active_hours || []).length > 0 && (
          <>
            <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.mostActive').toUpperCase()}</Text>
            <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
              <View style={s.hoursGrid}>
                {(todayData?.active_hours || screenTime?.active_hours || []).slice(0, 6).map((h, i) => (
                  <View key={i} style={[s.hourChip, { backgroundColor: ACCENT + (Math.round((h.percentage || 0.5) * 40 + 10).toString(16)) }]}>
                    <Text style={[s.hourText, { color: colors.text }]}>{String(h.hour).padStart(2, '0')}:00</Text>
                    <Text style={[s.hourPct, { color: colors.textSecondary }]}>{Math.round((h.percentage || 0) * 100)}%</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    );
  };

  // ─── Render: Contacts Tab ───

  const renderContactItem = ({ item }) => {
    const newThisWeek = isNewThisWeek(item);
    const unknown = isUnknownContact(item);
    const ageUnknown = item.age_known === false;
    const status = item.approval_status; // 'approved' | 'pending' | 'blocked'
    const busy = contactBusy[item.email];
    return (
      <TouchableOpacity
        style={[s.contactCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}
        onPress={() => router.push(`/parental-child-chat?child_email=${encodeURIComponent(childEmail)}&conversation_id=${encodeURIComponent(item.conversation_id || '')}&chat_name=${encodeURIComponent(item.name || item.email || '')}`)}
        activeOpacity={0.85}
        accessibilityLabel={`Contato ${item.name || item.email}, ${item.message_count || 0} mensagens. Toque para revisar.`}
        accessibilityRole="button"
      >
        <AvatarCircle name={item.name || item.email} email={item.email} size={44} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={[s.cardTitle, { color: colors.text, fontSize: 15 }]} numberOfLines={1}>{item.name || item.email || t('parental.unknown')}</Text>
            {status === 'blocked' && <View style={[s.riskTag, { backgroundColor: '#ef444420' }]}><Text style={[s.riskTagText, { color: '#ef4444' }]}>Bloqueado</Text></View>}
            {status === 'approved' && <View style={[s.riskTag, { backgroundColor: '#22c55e20' }]}><Text style={[s.riskTagText, { color: '#16a34a' }]}>Aprovado</Text></View>}
          </View>
          <Text style={[s.cardSub, { color: colors.textSecondary, fontSize: 12 }]} numberOfLines={1}>
            {item.message_count || 0} msgs · {item.last_interaction_at ? fmtRelative(item.last_interaction_at) : '—'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {newThisWeek && <View style={[s.riskTag, { backgroundColor: '#f59e0b20' }]}><Text style={[s.riskTagText, { color: '#d97706' }]}>Novo esta semana</Text></View>}
            {unknown && <View style={[s.riskTag, { backgroundColor: '#ef444415' }]}><Text style={[s.riskTagText, { color: '#ef4444' }]}>Desconhecido</Text></View>}
            {ageUnknown && <View style={[s.riskTag, { backgroundColor: '#A78BFA20' }]}><Text style={[s.riskTagText, { color: '#A78BFA' }]}>Idade ?</Text></View>}
          </View>
          {/* Approve / Block inline actions */}
          {status !== 'approved' && status !== 'blocked' && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); handleApproveContact(item.email); }}
                disabled={!!busy}
                style={[s.inlineBtn, { backgroundColor: '#22c55e' }]}
                accessibilityLabel={`Aprovar contato ${item.name || item.email}`}
                accessibilityRole="button"
              >
                {busy === 'approving' ? <ActivityIndicator size="small" color="#fff" /> : <><IconCheck size={14} color="#fff" /><Text style={s.inlineBtnText}>Aprovar</Text></>}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); handleBlockContact(item.email); }}
                disabled={!!busy}
                style={[s.inlineBtn, { backgroundColor: '#ef4444' }]}
                accessibilityLabel={`Bloquear contato ${item.name || item.email}`}
                accessibilityRole="button"
              >
                {busy === 'blocking' ? <ActivityIndicator size="small" color="#fff" /> : <><IconX size={14} color="#fff" /><Text style={s.inlineBtnText}>Bloquear</Text></>}
              </TouchableOpacity>
            </View>
          )}
        </View>
        <IconChevronRight size={16} color={colors.textSecondary} />
      </TouchableOpacity>
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

    return (
      <FlatList
        data={data}
        keyExtractor={(item, i) => String(item.email || item.conversation_id || i)}
        renderItem={renderContactItem}
        contentContainerStyle={s.listContent}
        ListHeaderComponent={
          <View style={{ marginBottom: 6 }}>
            <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>INTERAÇÕES</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, paddingHorizontal: 4, marginBottom: 8 }}>
              Toque em um contato para revisar a conversa.
            </Text>
          </View>
        }
        ListEmptyComponent={<EmptyStateCard Icon={IconUser} title="Sem contatos ainda" tone="neutral" />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
      />
    );
  };

  // ─── Render: Restrictions sheet (kept for parent admin) ───

  const timeLimitIndex = TIME_LIMITS.findIndex(tl => tl.value === (restrictions.daily_limit_minutes || 0));
  const currentLimitIdx = timeLimitIndex >= 0 ? timeLimitIndex : TIME_LIMITS.length - 1;

  const renderRestrictionsSheet = () => (
    <ScrollView contentContainerStyle={s.listContent} showsVerticalScrollIndicator={false}>
      {(saving || savedMsg) && (
        <View style={[s.saveIndicator, { backgroundColor: saving ? '#f59e0b20' : '#22c55e20' }]}>
          {saving ? <ActivityIndicator size="small" color="#f59e0b" /> : null}
          <Text style={{ color: saving ? '#f59e0b' : '#22c55e', fontWeight: '600', fontSize: 13 }}>
            {saving ? t('parental.saving') : savedMsg}
          </Text>
        </View>
      )}

      <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('parental.restrictions').toUpperCase()}</Text>
      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <SettingRow icon={<IconMail size={18} color="#A78BFA" />} label={t('parental.canSendEmail')} colors={colors}
          right={<Switch value={restrictions.can_send_email !== false} onValueChange={(v) => updateRestriction('can_send_email', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.can_send_email !== false ? ACCENT : '#f4f3f4'} />} />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow icon={<IconTrash size={18} color="#ef4444" />} label={t('parental.canDeleteMessages')} colors={colors}
          right={<Switch value={restrictions.can_delete_messages !== false} onValueChange={(v) => updateRestriction('can_delete_messages', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.can_delete_messages !== false ? ACCENT : '#f4f3f4'} />} />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow icon={<IconLock size={18} color="#f59e0b" />} label={t('parental.canChangePassword')} colors={colors}
          right={<Switch value={restrictions.can_change_password !== false} onValueChange={(v) => updateRestriction('can_change_password', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.can_change_password !== false ? ACCENT : '#f4f3f4'} />} />
      </View>

      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.dailyLimit').toUpperCase()}</Text>
      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        <View style={s.timeLimitRow}>
          {TIME_LIMITS.map((tl, idx) => {
            const isActive = idx === currentLimitIdx;
            const label = tl.value === 0 ? t('parental.unlimited') : tl.label;
            return (
              <TouchableOpacity key={idx}
                style={[s.timeLimitChip, { backgroundColor: isActive ? ACCENT : (isDark ? '#0f172a' : '#f1f5f9'), borderColor: isActive ? ACCENT : (isDark ? '#475569' : '#e2e8f0') }]}
                onPress={() => updateRestriction('daily_limit_minutes', tl.value)}
                accessibilityLabel={`Limite diário ${label}${isActive ? ' selecionado' : ''}`}
                accessibilityRole="button"
              >
                <Text style={[s.timeLimitText, { color: isActive ? '#fff' : colors.text }]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.bedtime').toUpperCase()}</Text>
      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.bedtimeLabel, { color: colors.textSecondary }]}>{t('parental.bedtimeStart')}</Text>
            <TextInput style={[s.bedtimeInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
              value={restrictions.bedtime_start || '22:00'}
              onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_start: v }))}
              onBlur={() => updateRestriction('bedtime_start', restrictions.bedtime_start || '22:00')}
              placeholder="22:00" placeholderTextColor={colors.textSecondary} keyboardType="numbers-and-punctuation" maxLength={5}
              accessibilityLabel={t('parental.bedtimeStart')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.bedtimeLabel, { color: colors.textSecondary }]}>{t('parental.bedtimeEnd')}</Text>
            <TextInput style={[s.bedtimeInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
              value={restrictions.bedtime_end || '07:00'}
              onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_end: v }))}
              onBlur={() => updateRestriction('bedtime_end', restrictions.bedtime_end || '07:00')}
              placeholder="07:00" placeholderTextColor={colors.textSecondary} keyboardType="numbers-and-punctuation" maxLength={5}
              accessibilityLabel={t('parental.bedtimeEnd')}
            />
          </View>
        </View>
      </View>

      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.whitelist').toUpperCase()}</Text>
      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        <View style={s.addContactRow}>
          <TextInput style={[s.addContactInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
            value={newContact} onChangeText={setNewContact} placeholder={t('parental.contactEmail')} placeholderTextColor={colors.textSecondary}
            keyboardType="email-address" autoCapitalize="none" onSubmitEditing={handleAddContact}
            accessibilityLabel={t('parental.contactEmail')}
          />
          <TouchableOpacity style={[s.addContactBtn, { backgroundColor: ACCENT }]} onPress={handleAddContact} accessibilityLabel={t('parental.addContact')} accessibilityRole="button">
            <IconPlus size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        {whitelist.length === 0 ? (
          <Text style={[s.emptyInline, { color: colors.textSecondary }]}>{t('parental.noContacts')}</Text>
        ) : (
          whitelist.map((contact, idx) => (
            <View key={contact.email || idx} style={[s.whitelistItem, idx < whitelist.length - 1 && { borderBottomWidth: 1, borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
              <View style={[s.whitelistAvatar, { backgroundColor: ACCENT + '15' }]}>
                <IconUser size={16} color={ACCENT} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.whitelistName, { color: colors.text }]}>{contact.name || contact.email}</Text>
                {contact.name && <Text style={[s.whitelistEmail, { color: colors.textSecondary }]}>{contact.email}</Text>}
              </View>
              <TouchableOpacity onPress={() => handleRemoveContact(contact.email)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel={`${t('parental.removeContact')} ${contact.email}`} accessibilityRole="button">
                <IconX size={16} color="#ef4444" />
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.contentFilters') || 'CONTENT FILTERS'}</Text>
      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <SettingRow icon={<IconShield size={18} color="#ef4444" />} label={t('parental.filterAdult') || 'Block adult content'} colors={colors}
          right={<Switch value={restrictions.filter_adult !== false} onValueChange={(v) => updateRestriction('filter_adult', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.filter_adult !== false ? ACCENT : '#f4f3f4'} />} />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow icon={<IconAlertTriangle size={18} color="#f59e0b" />} label={t('parental.filterViolence') || 'Block violence'} colors={colors}
          right={<Switch value={restrictions.filter_violence === true} onValueChange={(v) => updateRestriction('filter_violence', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.filter_violence === true ? ACCENT : '#f4f3f4'} />} />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow icon={<IconFilter size={18} color="#8b5cf6" />} label={t('parental.filterProfanity') || 'Filter profanity'} colors={colors}
          right={<Switch value={restrictions.filter_profanity === true} onValueChange={(v) => updateRestriction('filter_profanity', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.filter_profanity === true ? ACCENT : '#f4f3f4'} />} />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow icon={<IconEye size={18} color="#A78BFA" />} label={t('parental.safeSearch') || 'Safe search'} colors={colors}
          right={<Switch value={restrictions.safe_search === true} onValueChange={(v) => updateRestriction('safe_search', v)} trackColor={{ false: '#767577', true: ACCENT + '60' }} thumbColor={restrictions.safe_search === true ? ACCENT : '#f4f3f4'} />} />
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // ─── Tab Content Map ───

  const tabContent = {
    today: renderTodayTab,
    week: renderWeekTab,
    apps: renderAppsTab,
    contacts: renderContactsTab,
  };

  // ─── Main Render ───

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Modern gradient header */}
      <View style={[s.header,
        Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #059669 0%, #10b981 50%, #34d399 100%)' }
          : { backgroundColor: ACCENT }
      ]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Voltar" accessibilityRole="button">
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: '#fff' }]} numberOfLines={1}>{childName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconEye size={13} color="rgba(255,255,255,0.8)" />
            <Text style={[s.headerSub, { color: 'rgba(255,255,255,0.8)' }]}>Modo monitoramento</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={() => setShowRestrictions(v => !v)}
          style={s.headerSettingsBtn}
          accessibilityLabel="Restrições e configurações"
          accessibilityRole="button"
        >
          <IconShield size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* 4-tab segmented control */}
      <View style={[s.tabsBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {tabs.map(t2 => (
          <TouchableOpacity
            key={t2.key}
            style={[s.tab, tab === t2.key && { borderBottomColor: ACCENT }]}
            onPress={() => setTab(t2.key)}
            accessibilityLabel={`Aba ${t2.label}${tab === t2.key ? ' selecionada' : ''}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t2.key }}
          >
            <t2.icon size={15} color={tab === t2.key ? ACCENT : colors.textSecondary} />
            <Text style={[s.tabText, { color: tab === t2.key ? ACCENT : colors.textSecondary }]}>{t2.label}</Text>
            {t2.badge > 0 && <View style={s.tabBadge}><Text style={s.tabBadgeText}>{t2.badge}</Text></View>}
          </TouchableOpacity>
        ))}
      </View>

      {/* SOS Emergency Button */}
      {!loading && !showRestrictions && (
        <View style={[s.sosContainer, { backgroundColor: isDark ? '#1e293b' : '#fff', borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
          <TouchableOpacity
            style={s.sosButton}
            onPress={async () => {
              if (sosLoading) return;
              setSosLoading(true);
              try {
                const r = await api.parentalGetLocation(childEmail);
                if (!mounted.current) return;
                const lat = Number(r?.data?.latitude);
                const lng = Number(r?.data?.longitude);
                const hasCoords = r?.success && r?.data && Number.isFinite(lat) && Number.isFinite(lng);
                if (hasCoords) {
                  const ts = r.data.updated_at ? fmtTime(r.data.updated_at) : '--';
                  Alert.alert(
                    t('parental.childLocation') || 'Child Location',
                    `${lat.toFixed(5)}, ${lng.toFixed(5)}\n${t('parental.lastUpdated') || 'Updated'}: ${ts}`,
                    [{ text: 'OK' }]
                  );
                } else {
                  Alert.alert(
                    t('parental.locationUnavailable') || 'Localização indisponível',
                    t('parental.locationUnavailableDesc') || 'Não foi possível obter a localização. O dispositivo pode estar offline ou a permissão de localização desligada.'
                  );
                }
              } catch {
                if (mounted.current) Alert.alert(t('parental.error') || 'Error', t('parental.connectionError') || 'Connection error');
              } finally { if (mounted.current) setSosLoading(false); }
            }}
            activeOpacity={0.7}
            accessibilityLabel="SOS - Localizar criança"
            accessibilityRole="button"
          >
            {sosLoading ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <IconAlertCircle size={18} color="#fff" />
                <Text style={s.sosButtonText}>{t('parental.findChild') || 'Find Child'}</Text>
              </>
            )}
          </TouchableOpacity>

          {todayMinutes !== undefined && todayMinutes !== null && (
            <View style={s.quickTimeBar}>
              <IconClock size={14} color={colors.textSecondary} />
              <View style={[s.quickTimeBg, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}>
                <View style={[s.quickTimeFill, {
                  width: `${Math.min((todayMinutes / Math.max(restrictions.daily_limit_minutes || 180, 1)) * 100, 100)}%`,
                  backgroundColor: (todayMinutes / Math.max(restrictions.daily_limit_minutes || 180, 1)) > 0.8 ? '#ef4444' : ACCENT,
                }]} />
              </View>
              <Text style={[s.quickTimeText, { color: colors.textSecondary }]}>{todayMinutes}m</Text>
            </View>
          )}
        </View>
      )}

      {/* Content */}
      {loading ? (
        <TabSkeleton dark={isDark} />
      ) : showRestrictions ? (
        <Animated.View style={{ flex: 1, opacity: slideAnim }}>
          {renderRestrictionsSheet()}
        </Animated.View>
      ) : (
        <Animated.View style={{ flex: 1, opacity: slideAnim }}>
          {tabContent[tab]()}
        </Animated.View>
      )}
    </View>
  );
}

// ─── Activity icon resolver ───
function activityIconFor(type) {
  switch (type) {
    case 'message_sent':
    case 'message_received':
    case 'chat_message':
      return { Icon: IconMessageSquare, color: '#7C3AED', label: type === 'message_received' ? 'Recebeu mensagem' : 'Mensagem' };
    case 'call_outgoing': return { Icon: IconPhone, color: '#22c55e', label: 'Ligação' };
    case 'call_incoming': return { Icon: IconPhone, color: '#3b82f6', label: 'Chamada recebida' };
    case 'call_missed':   return { Icon: IconPhoneOff, color: '#ef4444', label: 'Chamada perdida' };
    case 'status_post':   return { Icon: IconImage, color: '#22c55e', label: 'Publicou status' };
    case 'video_played':
    case 'reel_view':     return { Icon: IconVideo, color: '#ec4899', label: 'Reels' };
    case 'feed_post':     return { Icon: IconHeart, color: '#f59e0b', label: 'Postou no feed' };
    case 'app_open':      return { Icon: IconZap, color: '#A78BFA', label: 'Abriu o app' };
    default:              return { Icon: IconClock, color: '#94a3b8', label: 'Atividade' };
  }
}

// ─── Shared Components ───

function SettingRow({ icon, label, right, colors }) {
  return (
    <View style={s.settingRow} accessibilityLabel={label} accessibilityRole="switch">
      <View style={s.settingLeft}>
        {icon}
        <Text style={[s.settingLabel, { color: colors.text }]}>{label}</Text>
      </View>
      {right}
    </View>
  );
}

// ─── Styles ───

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: Platform.OS === 'ios' ? 56 : 20, paddingBottom: 16, gap: 14 },
  backBtn: { padding: 6, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerSettingsBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '800' },
  headerSub: { fontSize: 13, fontWeight: '500' },

  // Tabs (now segmented, full-width row)
  tabsBar: { flexDirection: 'row', borderBottomWidth: 1, paddingHorizontal: 4 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 8, gap: 5, borderBottomWidth: 2.5, borderBottomColor: 'transparent', minHeight: 48 },
  tabText: { fontSize: 12, fontWeight: '600' },
  tabBadge: { backgroundColor: '#ef4444', minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  tabBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Cards (shared)
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, borderWidth: 1, marginBottom: 12, gap: 14 },
  cardIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardSub: { fontSize: 14, marginTop: 3 },
  cardMeta: { fontSize: 12 },
  cardMetaSm: { fontSize: 11, marginTop: 2 },
  listContent: { padding: 18, paddingBottom: 30 },

  // Live status pill
  livePill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, gap: 8, maxWidth: '100%' },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  livePillText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },

  // AI cards
  aiCard: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, borderWidth: 1, gap: 12 },
  aiCardIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  aiCardTitle: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  aiCardSub: { fontSize: 12, marginTop: 3 },

  // Trend chip
  trendChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },

  // Pills
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  pillText: { fontSize: 11, fontWeight: '600' },

  // Risk tag
  riskTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  riskTagText: { fontSize: 10, fontWeight: '700' },

  // Unread dot
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#A78BFA' },

  // Settings group
  sectionLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8, marginBottom: 10, paddingHorizontal: 4 },
  settingsGroup: { borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 16, minHeight: 56 },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  settingLabel: { fontSize: 16, fontWeight: '600' },
  divider: { height: 1, marginHorizontal: 16 },

  // Time limit chips
  timeLimitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  timeLimitChip: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 16, borderWidth: 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  timeLimitText: { fontSize: 15, fontWeight: '700' },

  // Bedtime
  bedtimeLabel: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  bedtimeInput: { height: 54, borderRadius: 16, paddingHorizontal: 18, fontSize: 20, fontWeight: '800', textAlign: 'center', borderWidth: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bedtimeHint: { fontSize: 13, marginTop: 14, textAlign: 'center' },

  // Whitelist
  addContactRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  addContactInput: { flex: 1, height: 44, borderRadius: 12, paddingHorizontal: 14, fontSize: 14, borderWidth: 1 },
  addContactBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  whitelistItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  whitelistAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  whitelistName: { fontSize: 14, fontWeight: '600' },
  whitelistEmail: { fontSize: 12, marginTop: 1 },
  emptyInline: { fontSize: 13, textAlign: 'center', paddingVertical: 16 },

  // Screen time
  screenTimeCard: { borderRadius: 20, borderWidth: 1, padding: 18 },

  // Bar chart
  barChartContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 180, paddingTop: 10 },
  barCol: { alignItems: 'center', flex: 1, justifyContent: 'flex-end', gap: 5 },
  bar: { width: 28, minHeight: 4 },
  barValue: { fontSize: 11, fontWeight: '700' },
  barLabel: { fontSize: 12, marginTop: 5 },

  // Active hours
  hoursGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hourChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  hourText: { fontSize: 14, fontWeight: '700' },
  hourPct: { fontSize: 11, marginTop: 1 },

  // Apps tab
  appRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  appIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  appLabel: { fontSize: 14, fontWeight: '700' },
  appValue: { fontSize: 13, fontWeight: '600' },
  appBarBg: { height: 8, borderRadius: 4, marginTop: 6, overflow: 'hidden' },
  appBarFill: { height: 8, borderRadius: 4 },

  // Contacts list
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingVertical: 12 },
  contactAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  contactName: { fontSize: 14, fontWeight: '600' },
  contactMeta: { fontSize: 12, marginTop: 1 },
  contactCard: { flexDirection: 'row', alignItems: 'flex-start', padding: 14, borderRadius: 18, borderWidth: 1, marginBottom: 10 },
  inlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, minHeight: 32, justifyContent: 'center' },
  inlineBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  // Timeline
  timelineGroup: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  timelineHour: { width: 48, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  timelineItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  timelineDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  timelineText: { fontSize: 13, lineHeight: 17 },
  timelineSub: { fontSize: 12, marginTop: 1 },
  timelineTime: { fontSize: 11, marginLeft: 8, marginTop: 2 },

  // Save indicator
  saveIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, borderRadius: 10, marginBottom: 12 },

  // Loading / Empty
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 12 },
  emptyText: { textAlign: 'center', fontSize: 14, color: '#94a3b8' },

  // SOS button
  sosContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 10, gap: 12, borderBottomWidth: 1 },
  sosButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#ef4444', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, minHeight: 40, minWidth: 120 },
  sosButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  quickTimeBar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  quickTimeBg: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  quickTimeFill: { height: 8, borderRadius: 4 },
  quickTimeText: { fontSize: 12, fontWeight: '700', minWidth: 30, textAlign: 'right' },
});
