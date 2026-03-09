import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Platform, RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import {
  IconArrowLeft, IconVideo, IconCopy, IconCheck, IconX,
  IconClock, IconEdit, IconTrash, IconUsers, IconCalendar, IconUser,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
}

function formatDate(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale || undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr, locale) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
}

function canJoin(meeting) {
  if (!meeting) return false;
  if (meeting.status === 'active') return true;
  if (meeting.status === 'scheduled' && meeting.scheduled_at) {
    const start = new Date(meeting.scheduled_at).getTime();
    return Date.now() >= start - 30 * 60 * 1000;
  }
  return false;
}

export default function MeetingDetailScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, room_id } = useLocalSearchParams();

  const [meeting, setMeeting] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(null);
  const [copied, setCopied] = useState(false);
  const [myRsvp, setMyRsvp] = useState(null);

  const loadInfo = useCallback(async () => {
    try {
      const r = await api.meetInfo(room_id);
      if (r.success && r.data) {
        setMeeting(r.data.meeting);
        setParticipants(r.data.participants || []);
        setIsHost(!!r.data.is_host);
        const me = (r.data.participants || []).find(
          p => p.user_id === user?.id || p.email === user?.email
        );
        if (me) setMyRsvp(me.rsvp_status || null);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [room_id, user]);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const handleJoin = async () => {
    setJoining(true);
    try {
      const r = await api.meetJoin(room_id);
      if (r.success) {
        router.push('/meet/' + room_id);
      }
    } catch {} finally { setJoining(false); }
  };

  const handleRsvp = async (status) => {
    setRsvpLoading(status);
    try {
      const r = await api.meetRsvp(meeting?.room_id || room_id, status);
      if (r.success) {
        setMyRsvp(status);
        loadInfo();
      } else {
        Alert.alert(t('common.error') || 'Error', r.message || 'RSVP failed');
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Error', e.message || 'RSVP failed');
    } finally { setRsvpLoading(null); }
  };

  const handleCancel = () => {
    const doCancel = async () => {
      try {
        const r = await api.meetCancel(meeting.room_id || id);
        if (r.success) router.back();
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(t('meetingDetail.cancelConfirm'))) doCancel();
    } else {
      Alert.alert(t('meetingDetail.cancelMeeting'), t('meetingDetail.cancelConfirm'), [
        { text: t('meetingDetail.no'), style: 'cancel' },
        { text: t('meetingDetail.yesCancel'), style: 'destructive', onPress: doCancel },
      ]);
    }
  };

  const handleCopyLink = async () => {
    const link = `${Platform.OS === 'web' ? window.location.origin : 'https://mail.onemundo.com.br'}/meet/${room_id}`;
    try {
      if (Clipboard?.setStringAsync) {
        await Clipboard.setStringAsync(link);
      } else if (Platform.OS === 'web' && navigator.clipboard) {
        await navigator.clipboard.writeText(link);
      }
    } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusBadge = (status) => {
    const map = {
      active: { bg: colors.success + '20', color: colors.success, label: t('meetingDetail.statusActive') },
      scheduled: { bg: colors.primary + '20', color: colors.primary, label: t('meetingDetail.statusScheduled') },
      ended: { bg: colors.textTertiary + '20', color: colors.textSecondary, label: t('meetingDetail.statusEnded') },
      cancelled: { bg: colors.error + '20', color: colors.error, label: t('meetingDetail.statusCancelled') },
    };
    const s = map[status] || map.scheduled;
    return (
      <View style={[styles.badge, { backgroundColor: s.bg }]}>
        <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
      </View>
    );
  };

  const rsvpIcon = (status) => {
    if (status === 'accepted') return <IconCheck size={14} color={colors.success} />;
    if (status === 'declined') return <IconX size={14} color={colors.error} />;
    return <IconClock size={14} color={colors.textTertiary} />;
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      </View>
    );
  }

  if (!meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={24} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingDetail.title')}</Text>
        </View>
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary, fontSize: FontSize.lg }}>{t('meetingDetail.notFound')}</Text>
        </View>
      </View>
    );
  }

  const ended = meeting.status === 'ended';
  const joinable = canJoin(meeting);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {meeting.title || t('meetingDetail.title')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadInfo(); }} colors={[colors.primary]} />}
      >
        {/* Info Card */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.meetingTitle, { color: colors.text }]}>{meeting.title || t('meetingDetail.untitled')}</Text>
            {statusBadge(meeting.status)}
          </View>

          <View style={styles.infoRow}>
            <IconUser size={16} color={colors.textSecondary} />
            <Text style={[styles.infoText, { color: colors.textSecondary }]}>
              {meeting.host_name || t('meetingDetail.unknown')} <Text style={styles.roleLabel}>{t('meetingDetail.organizer')}</Text>
            </Text>
          </View>

          {meeting.scheduled_at && (
            <View style={styles.infoRow}>
              <IconCalendar size={16} color={colors.textSecondary} />
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                {formatDate(meeting.scheduled_at, t('_locale'))} {t('meetingDetail.at')} {formatTime(meeting.scheduled_at, t('_locale'))}
              </Text>
            </View>
          )}

          {meeting.duration_minutes > 0 && (
            <View style={styles.infoRow}>
              <IconClock size={16} color={colors.textSecondary} />
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                {meeting.duration_minutes} min
              </Text>
            </View>
          )}

          {!!meeting.description && (
            <Text style={[styles.description, { color: colors.text }]}>{meeting.description}</Text>
          )}

          {ended && meeting.ended_at && (
            <View style={[styles.endedBanner, { backgroundColor: colors.textTertiary + '15' }]}>
              <Text style={[styles.endedText, { color: colors.textSecondary }]}>
                {t('meetingDetail.meetingEndedAt', { date: formatDate(meeting.ended_at, t('_locale')), time: formatTime(meeting.ended_at, t('_locale')) })}
              </Text>
            </View>
          )}
        </View>

        {/* RSVP Section (non-host, non-ended) */}
        {!isHost && !ended && meeting.status !== 'cancelled' && (
          <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('meetingDetail.yourResponse')}</Text>
            <View style={styles.rsvpRow}>
              {['accepted', 'tentative', 'declined'].map((s) => {
                const active = myRsvp === s;
                const cfg = {
                  accepted: { bg: colors.success, label: t('meetingDetail.accept') },
                  tentative: { bg: colors.warning, label: t('meetingDetail.maybe') },
                  declined: { bg: colors.error, label: t('meetingDetail.decline') },
                };
                const c = cfg[s];
                return (
                  <TouchableOpacity
                    key={s}
                    style={[
                      styles.rsvpBtn,
                      { borderColor: c.bg },
                      active && { backgroundColor: c.bg },
                    ]}
                    onPress={() => handleRsvp(s)}
                    disabled={rsvpLoading !== null}
                  >
                    {rsvpLoading === s ? (
                      <ActivityIndicator size="small" color={active ? '#fff' : c.bg} />
                    ) : (
                      <Text style={[styles.rsvpBtnText, { color: active ? '#fff' : c.bg }]}>{c.label}</Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Participants */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('meetingDetail.participantsCount', { count: participants.length })}
          </Text>
          {participants.map((p, i) => (
            <View key={p.user_id || p.email || i} style={[styles.participantRow, i < participants.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }]}>
              <AvatarCircle name={p.display_name || p.email} email={p.email} size={36} style={{ marginRight: Spacing.md }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.participantName, { color: colors.text }]}>
                  {p.display_name || p.email}
                </Text>
                {p.email && p.display_name && (
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.sm }}>{p.email}</Text>
                )}
              </View>
              {p.role === 'host' && (
                <View style={[styles.roleBadge, { backgroundColor: colors.primary + '20' }]}>
                  <Text style={[styles.roleBadgeText, { color: colors.primary }]}>{t('meetingDetail.organizer')}</Text>
                </View>
              )}
              {p.role === 'co-host' && (
                <View style={[styles.roleBadge, { backgroundColor: colors.warning + '20' }]}>
                  <Text style={[styles.roleBadgeText, { color: colors.warning }]}>{t('meetingDetail.coOrganizer')}</Text>
                </View>
              )}
              <View style={{ marginLeft: Spacing.sm }}>{rsvpIcon(p.rsvp_status)}</View>
            </View>
          ))}
          {participants.length === 0 && (
            <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', paddingVertical: Spacing.lg }}>
              {t('meetingDetail.noParticipants')}
            </Text>
          )}
        </View>

        {/* Spacer for bottom buttons */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomBar, Shadow.lg, { backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
        {ended ? (
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/meeting-recap?id=' + (meeting.room_id || id))}
          >
            <Text style={styles.primaryBtnText}>{t('meetingDetail.viewRecap')}</Text>
          </TouchableOpacity>
        ) : (
          <>
            {joinable && (
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: colors.primary }, joining && { opacity: 0.6 }]}
                onPress={handleJoin}
                disabled={joining}
              >
                {joining ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <IconVideo size={18} color="#fff" style={{ marginRight: Spacing.sm }} />
                    <Text style={styles.primaryBtnText}>{t('meetingDetail.joinMeeting')}</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </>
        )}

        <View style={styles.secondaryRow}>
          <TouchableOpacity style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={handleCopyLink}>
            {copied ? <IconCheck size={16} color={colors.success} /> : <IconCopy size={16} color={colors.textSecondary} />}
            <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>
              {copied ? t('meetingDetail.copied') : t('meetingDetail.copyLink')}
            </Text>
          </TouchableOpacity>

          {isHost && !ended && (
            <>
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: colors.border }]}
                onPress={() => router.push('/meeting-create?edit=' + (meeting.id || id))}
              >
                <IconEdit size={16} color={colors.textSecondary} />
                <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>{t('meetingDetail.edit')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: colors.error + '40' }]}
                onPress={handleCancel}
              >
                <IconTrash size={16} color={colors.error} />
                <Text style={[styles.secondaryBtnText, { color: colors.error }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm },
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: Spacing.lg },
  card: {
    borderRadius: BorderRadius.xl, padding: Spacing.xl, marginBottom: Spacing.lg,
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  meetingTitle: { fontSize: FontSize.title, fontWeight: '700', flex: 1, marginRight: Spacing.md },
  badge: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.xxl,
  },
  badgeText: { fontSize: FontSize.sm, fontWeight: '600' },
  infoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md, gap: Spacing.sm },
  infoText: { fontSize: FontSize.base },
  roleLabel: { fontStyle: 'italic', fontSize: FontSize.sm },
  description: { fontSize: FontSize.base, lineHeight: 20, marginTop: Spacing.md },
  endedBanner: {
    marginTop: Spacing.lg, padding: Spacing.md, borderRadius: BorderRadius.md, alignItems: 'center',
  },
  endedText: { fontSize: FontSize.sm },
  sectionTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.lg },
  rsvpRow: { flexDirection: 'row', gap: Spacing.md },
  rsvpBtn: {
    flex: 1, borderWidth: 1.5, borderRadius: BorderRadius.xxl,
    paddingVertical: Spacing.md, alignItems: 'center', justifyContent: 'center',
    minHeight: 42,
  },
  rsvpBtnText: { fontWeight: '600', fontSize: FontSize.base },
  participantRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md,
  },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  participantName: { fontSize: FontSize.base, fontWeight: '500' },
  roleBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.sm, marginLeft: Spacing.sm,
  },
  roleBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg,
    borderTopWidth: 1, borderTopColor: 'transparent',
  },
  primaryBtn: {
    flexDirection: 'row', borderRadius: BorderRadius.xxl,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md,
  },
  primaryBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', gap: Spacing.md },
  secondaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: BorderRadius.xxl,
    paddingVertical: Spacing.md, gap: Spacing.xs,
  },
  secondaryBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});
