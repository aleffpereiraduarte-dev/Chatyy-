import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, RefreshControl, Alert, Platform,
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
import { syncMeetingReminders } from '../services/meetingReminders';
import {
  IconVideo, IconPlus, IconCalendar, IconClock, IconUsers,
  IconArrowLeft, IconSearch, IconCheck, IconX, IconLink, IconCopy,
} from '../components/Icons';

const TABS = ['upcoming', 'past', 'active'];
const MEET_BASE = 'https://mail.onemundo.com.br/meet/';

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
    accepted: { bg: colors.success + '20', color: colors.success, label: t('meetings.rsvpAccepted') },
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

function MeetingCard({ meeting, colors, onPress, onJoin, onCopy, t }) {
  const isActive = meeting.status === 'active';
  const isPast = meeting.status === 'ended' || meeting.status === 'cancelled';
  const joinable = canJoin(meeting);

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border },
        isActive && { borderColor: colors.success, borderWidth: 1.5 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          {isActive && (
            <View style={[styles.liveBadge, { backgroundColor: colors.success + '20' }]}>
              <View style={[styles.liveDot, { backgroundColor: colors.success }]} />
              <Text style={[styles.liveText, { color: colors.success }]}>{t('meetings.live')}</Text>
            </View>
          )}
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {meeting.title || t('meetings.untitled')}
          </Text>
        </View>
        <TouchableOpacity onPress={onCopy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <IconLink size={18} color={colors.textTertiary} />
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
          {meeting.host_name ? (
            <Text style={[styles.hostText, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('meetings.organizer')}: {meeting.host_name}
            </Text>
          ) : null}
          <RsvpBadge rsvp={meeting.my_rsvp} colors={colors} t={t} />
        </View>
        {isActive || joinable ? (
          <TouchableOpacity
            style={[styles.joinBtn, { backgroundColor: colors.primary }]}
            onPress={onJoin}
          >
            <IconVideo size={16} color="#fff" />
            <Text style={styles.joinBtnText}>{t('meetings.join')}</Text>
          </TouchableOpacity>
        ) : isPast ? (
          <TouchableOpacity
            style={[styles.recapBtn, { backgroundColor: colors.surfaceVariant || colors.border + '40' }]}
            onPress={onPress}
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
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Meeting Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function MeetingsScreenWrapper() {
  return (
    <MeetingsErrorBoundary>
      <MeetingsScreenInner />
    </MeetingsErrorBoundary>
  );
}

function MeetingsScreenInner() {
  const { colors } = useTheme();
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

  const loadMeetings = useCallback(async (showLoader) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.meetList(tab, 50, 0);
      if (r.success) {
        setMeetings(r.data?.meetings || []);
        // Re-sync meeting reminders when upcoming list refreshes
        if (tab === 'upcoming') syncMeetingReminders();
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
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
        Alert.alert(t('common.error'), r?.message || t('meetings.createError'));
      }
    } catch {
      Alert.alert(t('common.error'), t('common.networkError'));
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
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  const sortedMeetings = [...meetings].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    const dateA = new Date(a.scheduled_at || a.created_at).getTime();
    const dateB = new Date(b.scheduled_at || b.created_at).getTime();
    return dateB - dateA;
  });

  const renderItem = ({ item }) => (
    <MeetingCard
      meeting={item}
      colors={colors}
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
        <IconCalendar size={64} color={colors.textTertiary} />
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
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetings.title')}</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Tab Bar */}
      <View style={[styles.tabBar, { backgroundColor: colors.surfaceVariant || colors.background }]}>
        {TABS.map((key) => (
          <TouchableOpacity
            key={key}
            style={[styles.tab, tab === key && { backgroundColor: colors.primary }]}
            onPress={() => setTab(key)}
          >
            <Text style={[styles.tabText, { color: tab === key ? '#fff' : colors.textSecondary }]}>
              {t(`meetings.tab.${key}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Copied toast */}
      {copiedId && (
        <View style={[styles.toast, { backgroundColor: colors.text }]}>
          <IconCheck size={14} color={colors.background} />
          <Text style={[styles.toastText, { color: colors.background }]}>{t('meetings.linkCopied')}</Text>
        </View>
      )}

      {/* Meeting List */}
      {loading && !refreshing ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={sortedMeetings}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[styles.list, sortedMeetings.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      {/* FAB buttons */}
      <View style={[styles.fabRow, { paddingBottom: insets.bottom + Spacing.md }]}>
        <TouchableOpacity
          style={[styles.fab, styles.fabSecondary, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push('/meeting-create')}
        >
          <IconCalendar size={20} color={colors.primary} />
          <Text style={[styles.fabText, { color: colors.primary }]}>{t('meetings.schedule')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, styles.fabPrimary, { backgroundColor: colors.primary }]}
          onPress={handleInstantMeeting}
          disabled={creating}
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
    borderRadius: BorderRadius.lg, padding: 3, gap: 4,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },
  list: { padding: Spacing.md, gap: Spacing.sm },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.xs,
    ...Shadow.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '600', flexShrink: 1 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: BorderRadius.full || 99, gap: 4,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase' },
  cardMeta: { flexDirection: 'row', gap: Spacing.md, marginBottom: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: FontSize.sm },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  hostText: { fontSize: FontSize.xs },
  rsvpBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: BorderRadius.full || 99 },
  rsvpText: { fontSize: FontSize.xs, fontWeight: '600' },
  joinBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
  },
  joinBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  recapBtn: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
  },
  recapBtnText: { fontSize: FontSize.sm, fontWeight: '500' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
  fabRow: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },
  fab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: Spacing.sm + 2, borderRadius: BorderRadius.lg,
    ...Shadow.md,
  },
  fabPrimary: {},
  fabSecondary: { borderWidth: 1 },
  fabText: { fontSize: FontSize.md, fontWeight: '600' },
  toast: {
    position: 'absolute', top: 120, alignSelf: 'center', zIndex: 100,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full || 99,
  },
  toastText: { fontSize: FontSize.sm, fontWeight: '500' },
});
