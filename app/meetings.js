import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, Platform, Animated, Easing,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { syncMeetingReminders } from '../services/meetingReminders';
import { ListSkeleton } from '../components/SkeletonLoader';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconVideo, IconPlus, IconCalendar, IconClock, IconUsers,
  IconArrowLeft, IconCheck, IconLink,
} from '../components/Icons';

const MEET_BASE = 'https://chatyy.com.br/meet/';
const ACCENT = '#7C3AED';
const ACCENT_DARK = '#6D28D9';
const AMBER = '#F59E0B';
const LIVE_RED = '#EF4444';

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// Relative time formatter — inline (no util dependency for portability).
// Returns labels like "Em 23 min", "Em 2h", "Amanhã 14:00", "Há 5 min".
function formatRelativeTime(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const diffMs = date - now;
  const diffMin = Math.round(diffMs / 60000);
  const diffHr = Math.round(diffMs / 3600000);
  const absDiffMin = Math.abs(diffMin);
  const absDiffHr = Math.abs(diffHr);
  const locale = t?.('_locale') || undefined;

  if (diffMs > 0) {
    if (diffMin < 60) return t('meetings.inMinutes', { n: diffMin });
    if (diffHr < 24) return t('meetings.inHours', { n: diffHr });
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (date.toDateString() === tomorrow.toDateString()) {
      return `${t('meetings.tomorrow')} ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  if (absDiffMin < 60) return t('meetings.agoMinutes', { n: absDiffMin });
  if (absDiffHr < 24) return t('meetings.agoHours', { n: absDiffHr });
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(meeting, t) {
  const start = meeting.scheduled_at || meeting.started_at || meeting.created_at;
  const end = meeting.ended_at || meeting.scheduled_end_at;
  if (!start || !end) return null;
  const ms = new Date(end) - new Date(start);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr}h ${rem}m` : `${hr}h`;
}

// Treat meetings that started >4h ago without an explicit ended_at as ended.
function isStale(meeting) {
  if (!meeting || meeting.status !== 'active') return false;
  const startMs = new Date(meeting.started_at || meeting.scheduled_at || meeting.created_at || 0).getTime();
  if (!Number.isFinite(startMs) || !startMs) return true;
  return (Date.now() - startMs) > 4 * 60 * 60 * 1000;
}
function isLive(meeting) {
  return meeting.status === 'active' && !isStale(meeting);
}
function canJoin(meeting) {
  if (isLive(meeting)) return true;
  if (meeting.status !== 'scheduled' || !meeting.scheduled_at) return false;
  const diff = new Date(meeting.scheduled_at) - new Date();
  return diff <= 15 * 60000 && diff >= -60 * 60000;
}
function isToday(meeting) {
  const d = new Date(meeting.scheduled_at || meeting.started_at || meeting.created_at);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.toDateString() === now.toDateString();
}
function isWithin1h(meeting) {
  if (meeting.status !== 'scheduled' || !meeting.scheduled_at) return false;
  const diff = new Date(meeting.scheduled_at) - new Date();
  return diff > 0 && diff <= 60 * 60000;
}
function isPast(meeting) {
  return meeting.status === 'ended' || meeting.status === 'cancelled' || isStale(meeting);
}

// Pulsing live dot
function LivePulseDot({ color = LIVE_RED, size = 8 }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.15] });
  const ringSize = size + 6;
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: ringSize, height: ringSize, borderRadius: ringSize / 2, backgroundColor: color, opacity, transform: [{ scale }] }} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

function RsvpBadge({ rsvp, colors, t }) {
  if (!rsvp || rsvp === 'pending') return null;
  const map = {
    accepted: { bg: ACCENT + '20', color: ACCENT, label: t('meetings.rsvpAccepted') },
    declined: { bg: colors.error + '20', color: colors.error, label: t('meetings.rsvpDeclined') },
    tentative: { bg: colors.warning + '20', color: colors.warning, label: t('meetings.rsvpTentative') },
  };
  const cfg = map[rsvp];
  if (!cfg) return null;
  return (
    <View style={[styles.rsvpBadge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.rsvpText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// Avatar stack — overlapping circles for host + first 2 participants, then "+N".
function AvatarStack({ meeting, colors }) {
  const list = [];
  if (meeting.host_email || meeting.host_name) {
    list.push({ email: meeting.host_email, name: meeting.host_name });
  }
  const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
  for (const p of participants) {
    if (list.length >= 3) break;
    if (p?.email && p.email === meeting.host_email) continue;
    list.push({ email: p.email, name: p.name || p.display_name });
  }
  const totalCount = (meeting.participant_count || participants.length || 0) + (meeting.host_email ? 0 : 0);
  const extra = Math.max(0, totalCount - list.length);

  if (list.length === 0 && extra === 0) return null;

  return (
    <View style={styles.avatarStack}>
      {list.map((p, idx) => (
        <View key={(p.email || p.name || idx) + ':' + idx} style={[styles.avatarStackItem, { marginLeft: idx === 0 ? 0 : -12, zIndex: 10 - idx, borderColor: colors.surface }]}>
          <AvatarCircle name={p.name || p.email} email={p.email} size={28} />
        </View>
      ))}
      {extra > 0 && (
        <View style={[styles.avatarStackItem, styles.avatarStackExtra, { marginLeft: list.length === 0 ? 0 : -12, backgroundColor: colors.surfaceVariant, borderColor: colors.surface }]}>
          <Text style={[styles.avatarStackExtraText, { color: colors.textSecondary }]} numberOfLines={1}>+{extra}</Text>
        </View>
      )}
    </View>
  );
}

function HeroLiveCard({ meeting, colors, isDark, onPress, onJoin, t }) {
  return (
    <TouchableOpacity
      activeOpacity={0.92}
      onPress={onPress}
      style={[styles.heroCard, { shadowColor: ACCENT }]}
    >
      <View style={[styles.heroBg, { backgroundColor: ACCENT }]} />
      <View style={styles.heroHighlight} pointerEvents="none" />
      <View style={[styles.heroOverlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.04)' }]} />
      <View style={styles.heroContent}>
        <View style={styles.heroTopRow}>
          <View style={styles.heroLiveBadge}>
            <LivePulseDot color="#fff" size={7} />
            <Text style={styles.heroLiveBadgeText}>{t('meetings.live').toUpperCase()}</Text>
          </View>
          <Text style={styles.heroParticipants} numberOfLines={1}>
            {meeting.participant_count > 0 ? `${meeting.participant_count} ${t('meetings.organizer').toLowerCase() === 'organizador' ? 'na sala' : 'in room'}` : ''}
          </Text>
        </View>
        <Text style={styles.heroTitle} numberOfLines={2}>
          {meeting.title || t('meetings.untitled')}
        </Text>
        {meeting.host_name ? (
          <Text style={styles.heroHost} numberOfLines={1}>{t('meetings.organizer')}: {meeting.host_name}</Text>
        ) : null}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onJoin}
          style={styles.heroJoinBtn}
        >
          <IconVideo size={18} color={ACCENT} />
          <Text style={styles.heroJoinText}>{t('meetings.join')}</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

function MeetingCard({ meeting, colors, isDark, onPress, onJoin, onCopy, t, highlightAmber }) {
  const live = isLive(meeting);
  const past = isPast(meeting);
  const joinable = canJoin(meeting);

  const timeLabel = past
    ? formatRelativeTime(meeting.ended_at || meeting.created_at, t)
    : meeting.scheduled_at
      ? formatRelativeTime(meeting.scheduled_at, t)
      : formatRelativeTime(meeting.created_at, t);

  const duration = formatDuration(meeting, t);

  const borderStyle = live
    ? { borderLeftWidth: 3, borderLeftColor: LIVE_RED }
    : highlightAmber
      ? { borderLeftWidth: 3, borderLeftColor: AMBER }
      : null;

  return (
    <TouchableOpacity
      style={[styles.card,
        { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' },
        borderStyle]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardTop}>
        <AvatarStack meeting={meeting} colors={colors} />
        <View style={styles.cardTopRight}>
          {live ? (
            <View style={[styles.liveBadge, { backgroundColor: LIVE_RED + '18' }]}>
              <LivePulseDot color={LIVE_RED} size={7} />
              <Text style={[styles.liveText, { color: LIVE_RED }]}>{t('meetings.live')}</Text>
            </View>
          ) : (
            <View style={[styles.timePill, { backgroundColor: (highlightAmber ? AMBER : ACCENT) + '14' }]}>
              <IconClock size={11} color={highlightAmber ? AMBER : ACCENT} />
              <Text style={[styles.timePillText, { color: highlightAmber ? AMBER : ACCENT }]} numberOfLines={1} ellipsizeMode="tail">{timeLabel}</Text>
            </View>
          )}
          <TouchableOpacity onPress={onCopy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[styles.copyBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
            <IconLink size={14} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
      </View>

      <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={2}>
        {meeting.title || t('meetings.untitled')}
      </Text>

      <View style={styles.cardMeta}>
        {duration && (
          <View style={[styles.durationPill, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
            <IconClock size={11} color={colors.textSecondary} />
            <Text style={[styles.durationPillText, { color: colors.textSecondary }]}>{duration}</Text>
          </View>
        )}
        {meeting.participant_count > 0 && (
          <View style={styles.metaItem}>
            <IconUsers size={13} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {meeting.participant_count}
            </Text>
          </View>
        )}
        <RsvpBadge rsvp={meeting.my_rsvp} colors={colors} t={t} />
      </View>

      <View style={styles.cardFooter}>
        {meeting.host_name ? (
          <Text style={[styles.hostText, { color: colors.textTertiary }]} numberOfLines={1}>
            {t('meetings.organizer')}: {meeting.host_name}
          </Text>
        ) : <View />}
        {live || joinable ? (
          <TouchableOpacity
            style={[styles.joinBtn, { backgroundColor: ACCENT }]}
            onPress={onJoin}
            activeOpacity={0.8}
          >
            <IconVideo size={15} color="#fff" />
            <Text style={styles.joinBtnText}>{t('meetings.join')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.recapBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}
            onPress={onPress}
            activeOpacity={0.7}
          >
            <Text style={[styles.recapBtnText, { color: colors.textSecondary }]}>
              {past ? t('meetings.recap') : (t('meetings.viewDetails') || (t?.('_locale')?.startsWith('pt') ? 'Ver detalhes' : 'View details'))}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

class MeetingsErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    try { console.warn('[MeetingsErrorBoundary]', error, info); } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>{this.props.errorLabel || 'Erro'}</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{this.props.errorBody || 'Algo deu errado'}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function MeetingsErrorBoundaryWithI18n({ children }) {
  const { t } = useLanguage();
  return (
    <MeetingsErrorBoundary
      errorLabel={t('common.error') || 'Erro'}
      errorBody={t('common.somethingWentWrong') || 'Algo deu errado'}
    >
      {children}
    </MeetingsErrorBoundary>
  );
}

export default function MeetingsScreenWrapper() {
  return (
    <MeetingsErrorBoundaryWithI18n>
      <MeetingsScreenInner />
    </MeetingsErrorBoundaryWithI18n>
  );
}

const TAB_KEYS = ['today', 'upcoming', 'past'];

function MeetingsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Default to "Hoje" (today)
  const [tab, setTab] = useState('today');
  // For "today" we use 'upcoming' from backend (and live), filtered locally.
  const apiTab = tab === 'past' ? 'past' : 'upcoming';
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const copiedTimerRef = useRef(null);
  const meetingsRequestIdRef = useRef(0);

  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);

  const loadMeetings = useCallback(async (showLoader) => {
    const cacheKey = `meetings_${apiTab}`;
    const requestId = ++meetingsRequestIdRef.current;
    try {
      const cached = await getCached(cacheKey);
      if (requestId !== meetingsRequestIdRef.current) return;
      if (cached) {
        setMeetings(cached);
        setLoading(false);
        showLoader = false;
      } else if (showLoader) {
        setLoading(true);
      }
    } catch {
      if (showLoader) setLoading(true);
    }
    try {
      const r = await api.meetList(apiTab, 50, 0);
      if (requestId !== meetingsRequestIdRef.current) return;
      if (r.success) {
        setMeetings(r.data?.meetings || []);
        setCache(cacheKey, r.data?.meetings || [], 7776000000).catch(() => {});
        if (apiTab === 'upcoming') syncMeetingReminders();
      }
    } catch {} finally {
      if (requestId === meetingsRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiTab]);

  useEffect(() => { loadMeetings(true); }, [loadMeetings]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadMeetings(false);
  }, [loadMeetings]);

  const handleInstantMeeting = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const r = await api.meetCreate(t('meetings.defaultTitle'), false);
      if (r.success && r.data?.room_id) {
        router.push('/meet/' + r.data.room_id);
      } else {
        safeAlert(t('common.error'), r?.message || t('meetings.createError'));
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = (meeting) => {
    if (meeting.room_id) router.push('/meet/' + meeting.room_id);
  };

  const handleCardPress = (meeting) => {
    router.push(`/meeting-detail?id=${meeting.id}&room_id=${meeting.room_id}`);
  };

  const handleCopyLink = async (meeting) => {
    const url = MEET_BASE + meeting.room_id;
    try {
      if (Clipboard?.setStringAsync) {
        await Clipboard.setStringAsync(url);
      } else if (Platform.OS === 'web' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      }
      setCopiedId(meeting.id);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  // Counts pulled from existing state. We have to compute against the live list:
  //  - "today" → not past and isToday
  //  - "upcoming" → not past and not today (future days)
  //  - "past" → past meetings (from past list when loaded; otherwise unknown)
  const { sortedMeetings, liveMeetings, soonMeetings, todayCount, upcomingCount, pastCount } = useMemo(() => {
    const stale = (m) => isStale(m);
    const filtered = meetings.filter(m => {
      const isS = stale(m);
      if (isS && apiTab === 'upcoming') return false;
      return true;
    });

    // Counts apply to the loaded list. "past" count is only known when we're on past tab.
    const today = [];
    const upcoming = [];
    const past = [];
    for (const m of filtered) {
      if (isPast(m)) past.push(m);
      else if (isToday(m)) today.push(m);
      else upcoming.push(m);
    }

    let list;
    if (tab === 'today') list = today;
    else if (tab === 'upcoming') list = upcoming;
    else list = past;

    const sorted = [...list].sort((a, b) => {
      const aLive = isLive(a);
      const bLive = isLive(b);
      if (aLive && !bLive) return -1;
      if (bLive && !aLive) return 1;
      const dateA = new Date(a.scheduled_at || a.created_at).getTime();
      const dateB = new Date(b.scheduled_at || b.created_at).getTime();
      return tab === 'past' ? dateB - dateA : dateA - dateB;
    });

    const live = sorted.filter(isLive);
    const soon = sorted.filter(m => !isLive(m) && isWithin1h(m));

    return {
      sortedMeetings: sorted,
      liveMeetings: live,
      soonMeetings: soon,
      todayCount: today.length,
      upcomingCount: upcoming.length,
      pastCount: past.length,
    };
  }, [meetings, tab, apiTab]);

  const renderItem = ({ item, _highlightAmber }) => (
    <MeetingCard
      meeting={item}
      colors={colors}
      isDark={isDark}
      t={t}
      highlightAmber={_highlightAmber}
      onPress={() => handleCardPress(item)}
      onJoin={() => handleJoin(item)}
      onCopy={() => handleCopyLink(item)}
    />
  );

  // Section header pill
  const SectionHeader = ({ label, color, count }) => (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionDot, { backgroundColor: color }]} />
      <Text style={[styles.sectionLabel, { color: colors.text }]}>{label}</Text>
      {typeof count === 'number' && count > 0 && (
        <Text style={[styles.sectionCount, { color: colors.textTertiary }]}>{count}</Text>
      )}
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;
    const emptyKey = tab === 'past' ? 'meetings.emptyPast' : 'meetings.emptyUpcoming';
    return (
      <View style={styles.emptyContainer}>
        <View style={[styles.emptyIconWrap, { backgroundColor: ACCENT + '15' }]}>
          <IconCalendar size={56} color={ACCENT} />
          <View style={[styles.emptyCheckBadge, { backgroundColor: ACCENT, borderColor: colors.background }]}>
            <IconCheck size={14} color="#fff" strokeWidth={3} />
          </View>
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {tab === 'past' ? t('meetings.empty') : (t?.('_locale')?.startsWith('pt') ? 'Nenhuma reunião' : t('meetings.empty'))}
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          {t(emptyKey)}
        </Text>
        {tab !== 'past' && (
          <TouchableOpacity
            style={[styles.emptyCta, { backgroundColor: ACCENT }]}
            onPress={() => router.push('/meeting-create')}
            activeOpacity={0.85}
            accessibilityLabel={t('meetings.scheduleCta')}
            accessibilityRole="button"
          >
            <IconCalendar size={16} color="#fff" />
            <Text style={styles.emptyCtaText}>{t('meetings.scheduleCta')}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const showHero = tab !== 'past' && liveMeetings.length > 0;
  const showSoon = tab !== 'past' && soonMeetings.length > 0;
  // Other meetings = sorted minus already-shown live + soon
  const otherMeetings = useMemo(() => {
    const usedIds = new Set();
    if (showHero) liveMeetings.forEach(m => usedIds.add(m.id));
    if (showSoon) soonMeetings.forEach(m => usedIds.add(m.id));
    return sortedMeetings.filter(m => !usedIds.has(m.id));
  }, [sortedMeetings, liveMeetings, soonMeetings, showHero, showSoon]);

  const ListHeader = (
    <View>
      {showHero && (
        <View>
          <SectionHeader
            label={t?.('_locale')?.startsWith('pt') ? 'Acontecendo agora' : 'Happening now'}
            color={LIVE_RED}
            count={liveMeetings.length}
          />
          {liveMeetings.map((m) => (
            <HeroLiveCard
              key={'hero-' + m.id}
              meeting={m}
              colors={colors}
              isDark={isDark}
              t={t}
              onPress={() => handleCardPress(m)}
              onJoin={() => handleJoin(m)}
            />
          ))}
        </View>
      )}
      {showSoon && (
        <View>
          <SectionHeader
            label={t?.('_locale')?.startsWith('pt') ? 'Em 1h' : 'In 1 hour'}
            color={AMBER}
            count={soonMeetings.length}
          />
          {soonMeetings.map((m) => (
            <MeetingCard
              key={'soon-' + m.id}
              meeting={m}
              colors={colors}
              isDark={isDark}
              t={t}
              highlightAmber
              onPress={() => handleCardPress(m)}
              onJoin={() => handleJoin(m)}
              onCopy={() => handleCopyLink(m)}
            />
          ))}
        </View>
      )}
      {otherMeetings.length > 0 && (showHero || showSoon) && (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 16, marginTop: 8 }}>
          <SectionHeader
            label={tab === 'past'
              ? (t?.('_locale')?.startsWith('pt') ? 'Anteriores' : 'Past')
              : (t?.('_locale')?.startsWith('pt') ? 'Mais reuniões' : 'More meetings')}
            color={ACCENT}
          />
        </View>
      )}
    </View>
  );

  const tabLabels = {
    today: t?.('_locale')?.startsWith('pt') ? 'Hoje' : (t?.('_locale')?.startsWith('es') ? 'Hoy' : 'Today'),
    upcoming: t('meetings.tab.upcoming'),
    past: t('meetings.tab.past'),
  };
  const tabCounts = {
    today: todayCount,
    upcoming: upcomingCount,
    past: tab === 'past' ? pastCount : null,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Gradient header */}
      <View style={[styles.header, { backgroundColor: ACCENT }]}>
        <View style={[styles.headerGradientOverlay, { backgroundColor: ACCENT_DARK }]} />
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => {
              if (Platform.OS === 'web' && window.parent !== window) {
                try { window.parent.postMessage({ type: 'close-side-panel', route: '/meetings' }, '*'); } catch {}
              } else { router.back(); }
            }}
            style={styles.headerBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{t('meetings.title')}</Text>
          <TouchableOpacity
            onPress={() => router.push('/meeting-create')}
            style={styles.headerCta}
            activeOpacity={0.85}
            accessibilityLabel={t('meetings.scheduleCta')}
            accessibilityRole="button"
          >
            <IconPlus size={14} color={ACCENT} />
            <Text style={styles.headerCtaText} numberOfLines={1}>
              {t?.('_locale')?.startsWith('pt') ? 'Criar' : (t?.('_locale')?.startsWith('es') ? 'Crear' : 'Create')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Segmented tabs */}
      <View style={[styles.tabBar, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
        {TAB_KEYS.map((key) => {
          const active = tab === key;
          const cnt = tabCounts[key];
          return (
            <TouchableOpacity
              key={key}
              style={[styles.tab,
                active && { backgroundColor: ACCENT, shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3 }]}
              onPress={() => setTab(key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, { color: active ? '#fff' : colors.textSecondary }]} numberOfLines={1}>
                {tabLabels[key]}
                {typeof cnt === 'number' && cnt > 0 ? (
                  <Text style={{ color: active ? 'rgba(255,255,255,0.85)' : colors.textTertiary, fontWeight: '600' }}>{`  ${cnt}`}</Text>
                ) : null}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Copied toast */}
      {copiedId && (
        <View style={[styles.toast, { backgroundColor: isDark ? colors.surface : colors.text }]}>
          <IconCheck size={14} color={isDark ? ACCENT : colors.background} />
          <Text style={[styles.toastText, { color: isDark ? colors.text : colors.background }]}>{t('meetings.linkCopied')}</Text>
        </View>
      )}

      {/* Body */}
      {loading && !refreshing && meetings.length === 0 ? (
        <ListSkeleton count={4} />
      ) : (
        <FlatList
          data={otherMeetings}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => renderItem({ item })}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={otherMeetings.length === 0 && !showHero && !showSoon ? renderEmpty : null}
          contentContainerStyle={[styles.list, (otherMeetings.length === 0 && !showHero && !showSoon) && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />
          }
        />
      )}

      {/* FAB row */}
      <View style={[styles.fabRow, { paddingBottom: insets.bottom + Spacing.md }]}>
        <TouchableOpacity
          style={[styles.fab, styles.fabSecondary, { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: isDark ? '#000' : '#94a3b8' }]}
          onPress={() => router.push('/meeting-create')}
          activeOpacity={0.7}
        >
          <IconCalendar size={20} color={ACCENT} />
          <Text style={[styles.fabText, { color: ACCENT }]}>{t('meetings.schedule')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, styles.fabPrimary, { backgroundColor: ACCENT }]}
          onPress={handleInstantMeeting}
          disabled={creating}
          activeOpacity={0.8}
        >
          {creating ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconPlus size={20} color="#fff" />
              <Text style={[styles.fabText, { color: '#fff' }]}>{t('meetings.newMeeting')}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    overflow: 'hidden',
  },
  headerGradientOverlay: {
    position: 'absolute', right: -40, top: -30, width: 220, height: 220, borderRadius: 110, opacity: 0.55,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)' },
  headerTitle: { flex: 1, fontSize: 22, fontWeight: '600', color: '#fff', textAlign: 'left', marginLeft: 4 },
  headerCta: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
  },
  headerCtaText: { color: ACCENT, fontSize: 13, fontWeight: '700' },

  tabBar: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderRadius: 14, padding: 4, gap: 4,
  },
  tab: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    alignItems: 'center',
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },

  list: { padding: Spacing.md, gap: Spacing.xs },
  listEmpty: { flexGrow: 1 },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: Spacing.md, marginBottom: Spacing.xs,
    paddingHorizontal: 4,
  },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.2, textTransform: 'uppercase' },
  sectionCount: { fontSize: 12, fontWeight: '600' },

  // Hero "happening now" card
  heroCard: {
    borderRadius: 18,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
    shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 6,
  },
  heroBg: { ...StyleSheet.absoluteFillObject },
  heroHighlight: {
    position: 'absolute', top: -40, right: -40, width: 200, height: 200, borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  heroOverlay: { ...StyleSheet.absoluteFillObject },
  heroContent: { padding: 16, gap: 8 },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLiveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.22)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
  },
  heroLiveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  heroParticipants: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '600', maxWidth: 140 },
  heroTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  heroHost: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '500' },
  heroJoinBtn: {
    marginTop: 6, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12,
  },
  heroJoinText: { color: ACCENT, fontSize: 15, fontWeight: '700' },

  // Card
  card: {
    borderRadius: 16, padding: Spacing.md,
    marginBottom: Spacing.sm,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8 },

  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  avatarStackItem: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 2, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarStackExtra: {
    paddingHorizontal: 4,
  },
  avatarStackExtraText: { fontSize: 11, fontWeight: '700' },

  liveBadge: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, gap: 5,
  },
  liveText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  timePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 14, maxWidth: 160,
  },
  timePillText: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: -0.1 },

  durationPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
  },
  durationPillText: { fontSize: 11, fontWeight: '600' },

  cardMeta: { flexDirection: 'row', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: FontSize.sm },

  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  hostText: { fontSize: FontSize.xs, flex: 1 },

  rsvpBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
  rsvpText: { fontSize: FontSize.xs, fontWeight: '700' },

  copyBtn: {
    width: 28, height: 28, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  joinBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 9,
    borderRadius: 12,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3, shadowRadius: 4, elevation: 3,
  },
  joinBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '700' },
  recapBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10,
  },
  recapBtnText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Empty state
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl },
  emptyIconWrap: {
    width: 112, height: 112, borderRadius: 56,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
    position: 'relative',
  },
  emptyCheckBadge: {
    position: 'absolute', right: 6, bottom: 6,
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', marginTop: Spacing.xs, textAlign: 'center' },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: Spacing.lg,
    paddingHorizontal: 18, paddingVertical: 11,
    borderRadius: 14,
    shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 4,
  },
  emptyCtaText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700', letterSpacing: -0.1 },

  // FAB
  fabRow: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },
  fab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 14,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  fabPrimary: {
    shadowColor: ACCENT,
    shadowOpacity: 0.3,
  },
  fabSecondary: { borderWidth: 1 },
  fabText: { fontSize: FontSize.md, fontWeight: '700' },

  toast: {
    position: 'absolute', top: 140, alignSelf: 'center', zIndex: 100,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  toastText: { fontSize: FontSize.sm, fontWeight: '600' },
});
