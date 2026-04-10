import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, Platform,
} from 'react-native';
// FlashList reverted to FlatList
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
import {
  IconVideo, IconPlus, IconCalendar, IconClock, IconUsers,
  IconArrowLeft, IconSearch, IconCheck, IconX, IconLink, IconCopy,
} from '../components/Icons';

const TABS = ['upcoming', 'past', 'active'];
const MEET_BASE = Platform.OS === 'web' ? 'https://chatyy.com.br/meet/' : 'https://mail.onemundo.com.br/meet/';
const ACCENT = '#7C3AED';

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

function relativeTime(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
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

function formatDateTime(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function canJoin(meeting) {
  if (meeting.status === 'active') return true;
  if (meeting.status !== 'scheduled' || !meeting.scheduled_at) return false;
  const diff = new Date(meeting.scheduled_at) - new Date();
  return diff <= 15 * 60000 && diff >= -60 * 60000;
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

function MeetingCard({ meeting, colors, isDark, onPress, onJoin, onCopy, t }) {
  const isActive = meeting.status === 'active';
  const isPast = meeting.status === 'ended' || meeting.status === 'cancelled';
  const joinable = canJoin(meeting);

  return (
    <TouchableOpacity
      style={[styles.card,
        { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' },
        isActive && { borderLeftWidth: 3, borderLeftColor: ACCENT }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          {isActive && (
            <View style={[styles.liveBadge, { backgroundColor: ACCENT + '18' }]}>
              <View style={[styles.liveDot, { backgroundColor: ACCENT }]} />
              <Text style={[styles.liveText, { color: ACCENT }]}>{t('meetings.live')}</Text>
            </View>
          )}
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {meeting.title || t('meetings.untitled')}
          </Text>
        </View>
        <TouchableOpacity onPress={onCopy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[styles.copyBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
          <IconLink size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>

      <View style={styles.cardMeta}>
        <View style={styles.metaItem}>
          <IconClock size={14} color={colors.textSecondary} />
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>
            {isPast
              ? `${t('meetings.ended')}: ${relativeTime(meeting.ended_at || meeting.created_at, t)}`
              : meeting.scheduled_at
                ? relativeTime(meeting.scheduled_at, t)
                : formatDateTime(meeting.created_at, t('_locale'))}
          </Text>
        </View>
        {/* BUG FIX: participant_count is now correctly sent by backend */}
        {meeting.participant_count > 0 && (
          <View style={styles.metaItem}>
            <IconUsers size={14} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {meeting.participant_count}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.footerLeft}>
          {/* BUG FIX: host_name is now correctly sent by backend */}
          {meeting.host_name ? (
            <Text style={[styles.hostText, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('meetings.organizer')}: {meeting.host_name}
            </Text>
          ) : null}
          {/* BUG FIX: my_rsvp is the correct field name (was my_rsvp_status, now fixed) */}
          <RsvpBadge rsvp={meeting.my_rsvp} colors={colors} t={t} />
        </View>
        {isActive || joinable ? (
          <TouchableOpacity
            style={[styles.joinBtn, { backgroundColor: ACCENT }]}
            onPress={onJoin}
            activeOpacity={0.8}
          >
            <IconVideo size={16} color="#fff" />
            <Text style={styles.joinBtnText}>{t('meetings.join')}</Text>
          </TouchableOpacity>
        ) : isPast ? (
          <TouchableOpacity
            style={[styles.recapBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}
            onPress={onPress}
            activeOpacity={0.7}
          >
            <Text style={[styles.recapBtnText, { color: colors.textSecondary }]}>{t('meetings.recap')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

class MeetingsErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>{this.props.errorLabel || 'Erro'}</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function MeetingsScreenWrapper() {
  return (
    <MeetingsErrorBoundary errorLabel="Erro">
      <MeetingsScreenInner />
    </MeetingsErrorBoundary>
  );
}

function MeetingsScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState('upcoming');
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
    const cacheKey = `meetings_${tab}`;
    const requestId = ++meetingsRequestIdRef.current;
    // ALWAYS show cached data instantly (cache-first pattern)
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
      const r = await api.meetList(tab, 50, 0);
      if (requestId !== meetingsRequestIdRef.current) return;
      if (r.success) {
        setMeetings(r.data?.meetings || []);
        setCache(cacheKey, r.data?.meetings || [], 7776000000).catch(() => {});
        // Re-sync meeting reminders when upcoming list refreshes
        if (tab === 'upcoming') syncMeetingReminders();
      }
    } catch {} finally {
      if (requestId === meetingsRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [tab]);

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

  const sortedMeetings = [...meetings].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    const dateA = new Date(a.scheduled_at || a.created_at).getTime();
    const dateB = new Date(b.scheduled_at || b.created_at).getTime();
    return tab === 'upcoming' ? dateA - dateB : dateB - dateA;
  });

  const renderItem = ({ item }) => (
    <MeetingCard
      meeting={item}
      colors={colors}
      isDark={isDark}
      t={t}
      onPress={() => handleCardPress(item)}
      onJoin={() => handleJoin(item)}
      onCopy={() => handleCopyLink(item)}
    />
  );

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <View style={[styles.emptyIconWrap, { backgroundColor: ACCENT + '15' }]}>
          <IconCalendar size={48} color={ACCENT} />
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('meetings.empty')}</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          {tab === 'upcoming'
            ? t('meetings.emptyUpcoming')
            : tab === 'active'
              ? t('meetings.emptyActive')
              : t('meetings.emptyPast')}
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: isDark ? colors.surface : '#fff' }]}>
        <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/meetings" }, "*"); } catch {} } else { router.back(); } }} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetings.title')}</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Tab Bar */}
      <View style={[styles.tabBar, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
        {TABS.map((key) => (
          <TouchableOpacity
            key={key}
            style={[styles.tab,
              tab === key && { backgroundColor: ACCENT, shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3 }]}
            onPress={() => setTab(key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, { color: tab === key ? '#fff' : colors.textSecondary }]}>
              {t(`meetings.tab.${key}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Copied toast */}
      {copiedId && (
        <View style={[styles.toast, { backgroundColor: isDark ? colors.surface : colors.text }]}>
          <IconCheck size={14} color={isDark ? ACCENT : colors.background} />
          <Text style={[styles.toastText, { color: isDark ? colors.text : colors.background }]}>{t('meetings.linkCopied')}</Text>
        </View>
      )}

      {/* Meeting List */}
      {loading && !refreshing && meetings.length === 0 ? (
        <ListSkeleton count={4} />
      ) : (
        <FlatList
          data={sortedMeetings}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[styles.list, sortedMeetings.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />
          }
        />
      )}

      {/* FAB buttons */}
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
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
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
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    borderRadius: 16, padding: Spacing.md,
    marginBottom: Spacing.sm,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', flexShrink: 1 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, gap: 5,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardMeta: { flexDirection: 'row', gap: Spacing.md, marginBottom: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: FontSize.sm },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  hostText: { fontSize: FontSize.xs },
  rsvpBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  rsvpText: { fontSize: FontSize.xs, fontWeight: '700' },
  copyBtn: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  joinBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 9,
    borderRadius: 12,
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  joinBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '700' },
  recapBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10,
  },
  recapBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyIconWrap: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', marginTop: Spacing.xs },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20 },
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
    shadowColor: '#7C3AED',
    shadowOpacity: 0.3,
  },
  fabSecondary: { borderWidth: 1 },
  fabText: { fontSize: FontSize.md, fontWeight: '700' },
  toast: {
    position: 'absolute', top: 120, alignSelf: 'center', zIndex: 100,
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
