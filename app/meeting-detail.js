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
import { useConfirm } from '../components/ConfirmModal';
import {
  IconArrowLeft, IconVideo, IconCopy, IconCheck, IconX,
  IconClock, IconEdit, IconTrash, IconUsers, IconCalendar, IconUser,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

const ACCENT = '#7C3AED';

function formatDate(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale || undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
}

function canJoin(meeting) {
  if (!meeting) return false;
  if (meeting.status === 'active') return true;
  if (meeting.status === 'scheduled' && meeting.scheduled_at) {
    // start é um number (ms epoch) — antes chamava .getTime() em number
    // e quebrava com TypeError na primeira reunião agendada.
    const start = new Date(meeting.scheduled_at).getTime();
    if (isNaN(start)) return false;
    return Date.now() >= start - 10 * 60 * 1000;
  }
  return false;
}

export default function MeetingDetailScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const confirm = useConfirm();
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
      // Usa room_id se existir, senão cai no id (legado) — antes só passava
      // room_id e meetings antigas com só `id` não carregavam.
      const r = await api.meetInfo(room_id || id);
      if (r.success && r.data) {
        const m = r.data.meeting || r.data;
        setMeeting(m);
        setParticipants(r.data.participants || []);
        setIsHost(!!r.data.is_host || !!m.is_host);
        const me = (r.data.participants || []).find(
          p => (p.email || '').toLowerCase() === (user?.email || '').toLowerCase()
        );
        if (me) setMyRsvp(me.rsvp_status || null);
      }
    } catch (e) {
      console.warn('[MeetingDetail] loadInfo error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [room_id, id, user]);

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
        Alert.alert(t('common.error') || 'Error', r.message || (t('meetingDetail.rsvpError') || 'Falha ao confirmar presença'));
      }
    } catch (e) {
      try { console.warn('[meetingDetail] rsvp error', e); } catch {}
      Alert.alert(t('common.error') || 'Error', t('meetingDetail.rsvpError') || 'Falha ao confirmar presença');
    } finally { setRsvpLoading(null); }
  };

  const handleCancel = async () => {
    const doCancel = async () => {
      try {
        const r = await api.meetCancel(meeting.room_id || id);
        if (r.success) router.back();
      } catch {}
    };
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(t('meetingDetail.cancelConfirm')))
      : await confirm({
          title: t('meetingDetail.cancelMeeting'),
          message: t('meetingDetail.cancelConfirm'),
          confirmLabel: t('meetingDetail.yesCancel'),
          cancelLabel: t('meetingDetail.no'),
          destructive: true,
        });
    if (ok) doCancel();
  };

  const handleDelete = async () => {
    const doDelete = async () => {
      try {
        const r = await api.meetDelete(meeting.room_id || room_id);
        if (r.success) router.back();
        else Alert.alert(t('common.error') || 'Error', r.message || 'Delete failed');
      } catch (e) {
        Alert.alert(t('common.error') || 'Error', e.message || 'Delete failed');
      }
    };
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(t('meetingDetail.deleteConfirm')))
      : await confirm({
          title: t('meetingDetail.deleteMeeting'),
          message: t('meetingDetail.deleteConfirm'),
          confirmLabel: t('meetingDetail.yesDelete'),
          cancelLabel: t('meetingDetail.no'),
          destructive: true,
        });
    if (ok) doDelete();
  };

  const handleCopyLink = async () => {
    // Match meetings.js MEET_BASE: web prefers current origin (handles dev +
    // chatyy.com.br + onemundo.com.br alike), native uses canonical prod host.
    const base = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.location?.origin) || 'https://chatyy.com.br'
      : 'https://chatyy.com.br';
    const link = `${base}/meet/${room_id}`;
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
      active: { bg: ACCENT + '20', color: ACCENT, label: t('meetingDetail.statusActive') },
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
    if (status === 'accepted') return <IconCheck size={14} color={ACCENT} />;
    if (status === 'declined') return <IconX size={14} color={colors.error} />;
    if (status === 'tentative') return <IconClock size={14} color={colors.warning} />;
    return <IconClock size={14} color={colors.textTertiary} />;
  };

  const rsvpLabel = (status) => {
    if (status === 'accepted') return t('meetings.rsvpAccepted');
    if (status === 'declined') return t('meetings.rsvpDeclined');
    if (status === 'tentative') return t('meetings.rsvpTentative');
    return t('meetingDetail.pending');
  };

  if (loading && !meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]} />
    );
  }

  if (!meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingDetail.title')}</Text>
        </View>
        <View style={styles.center}>
          <IconCalendar size={56} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('meetingDetail.notFound')}</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            {t('meetingDetail.notFoundDesc') || ''}
          </Text>
        </View>
      </View>
    );
  }

  const ended = meeting.status === 'ended';
  const joinable = canJoin(meeting);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: isDark ? colors.surface : '#fff', borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {meeting.title || t('meetingDetail.title')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadInfo(); }} colors={[ACCENT]} tintColor={ACCENT} />}
      >
        {/* Info Card */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.meetingTitle, { color: colors.text }]}>{meeting.title || t('meetingDetail.untitled')}</Text>
            {statusBadge(meeting.status)}
          </View>

          <View style={[styles.infoRow, styles.infoRowBorder, { borderBottomColor: colors.borderLight || colors.border + '40' }]}>
            <View style={[styles.infoIconWrap, { backgroundColor: colors.primary + '15' }]}>
              <IconUser size={15} color={colors.primary} />
            </View>
            <Text style={[styles.infoText, { color: colors.text }]}>
              {(() => {
                const hp = (participants || []).find(p => p.role === 'host');
                return meeting.host_name
                  || (hp && (hp.display_name || hp.email))
                  || meeting.host_email
                  || t('meetingDetail.unknown');
              })()} <Text style={[styles.roleLabel, { color: colors.textTertiary }]}>{t('meetingDetail.organizer')}</Text>
            </Text>
          </View>

          {meeting.scheduled_at && (
            <View style={[styles.infoRow, styles.infoRowBorder, { borderBottomColor: colors.borderLight || colors.border + '40' }]}>
              <View style={[styles.infoIconWrap, { backgroundColor: ACCENT + '15' }]}>
                <IconCalendar size={15} color={ACCENT} />
              </View>
              <Text style={[styles.infoText, { color: colors.text }]}>
                {formatDate(meeting.scheduled_at, t('_locale'))} {t('meetingDetail.at')} {formatTime(meeting.scheduled_at, t('_locale'))}
              </Text>
            </View>
          )}

          {meeting.duration_minutes > 0 && (
            <View style={[styles.infoRow, styles.infoRowBorder, { borderBottomColor: colors.borderLight || colors.border + '40' }]}>
              <View style={[styles.infoIconWrap, { backgroundColor: colors.warning + '15' }]}>
                <IconClock size={15} color={colors.warning} />
              </View>
              <Text style={[styles.infoText, { color: colors.text }]}>
                {meeting.duration_minutes} min
              </Text>
            </View>
          )}

          {!!meeting.description && (
            <Text style={[styles.description, { color: colors.text }]}>{meeting.description}</Text>
          )}

          {ended && meeting.ended_at && (
            <View style={[styles.endedBanner, { backgroundColor: isDark ? colors.error + '15' : '#fef2f2' }]}>
              <Text style={[styles.endedText, { color: colors.error }]}>
                {t('meetingDetail.meetingEndedAt', { date: formatDate(meeting.ended_at, t('_locale')), time: formatTime(meeting.ended_at, t('_locale')) })}
              </Text>
            </View>
          )}
        </View>

        {/* RSVP Section (non-host, non-ended) */}
        {!isHost && !ended && meeting.status !== 'cancelled' && (
          <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('meetingDetail.yourResponse')}</Text>
            <View style={styles.rsvpRow}>
              {['accepted', 'tentative', 'declined'].map((s) => {
                const active = myRsvp === s;
                const cfg = {
                  accepted: { bg: ACCENT, label: t('meetingDetail.accept') },
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
                    activeOpacity={0.7}
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
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
          <View style={styles.sectionTitleRow}>
            <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>
              {t('meetingDetail.participantsCount', { count: participants.length })}
            </Text>
            <View style={[styles.countBadge, { backgroundColor: ACCENT + '20' }]}>
              <Text style={[styles.countBadgeText, { color: ACCENT }]}>{participants.length}</Text>
            </View>
          </View>
          {participants.map((p, i) => (
            <View key={p.user_id || p.email || i} style={[styles.participantRow, i < participants.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border + '30' }]}>
              <AvatarCircle name={p.display_name || p.email} email={p.email} size={40} style={{ marginRight: Spacing.md }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.participantName, { color: colors.text }]}>
                  {p.display_name || p.email}
                </Text>
                {p.email && p.display_name && (
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.sm }}>{p.email}</Text>
                )}
              </View>
              {p.role === 'host' && (
                <View style={[styles.roleBadge, { backgroundColor: ACCENT + '18' }]}>
                  <Text style={[styles.roleBadgeText, { color: ACCENT }]}>{t('meetingDetail.organizer')}</Text>
                </View>
              )}
              {p.role === 'co-host' && (
                <View style={[styles.roleBadge, { backgroundColor: colors.warning + '20' }]}>
                  <Text style={[styles.roleBadgeText, { color: colors.warning }]}>{t('meetingDetail.coOrganizer')}</Text>
                </View>
              )}
              <View style={[styles.rsvpStatusWrap, { marginLeft: Spacing.sm }]}>
                {rsvpIcon(p.rsvp_status)}
                <Text style={[styles.rsvpStatusText, {
                  color: p.rsvp_status === 'accepted' ? ACCENT
                    : p.rsvp_status === 'declined' ? colors.error
                    : p.rsvp_status === 'tentative' ? colors.warning
                    : colors.textTertiary
                }]}>{rsvpLabel(p.rsvp_status)}</Text>
              </View>
            </View>
          ))}
          {participants.length === 0 && (
            <View style={styles.emptyParticipants}>
              <IconUsers size={40} color={colors.textTertiary} />
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', marginTop: Spacing.sm }}>
                {t('meetingDetail.noParticipants')}
              </Text>
            </View>
          )}
        </View>

        {/* Spacer for bottom buttons */}
        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomBar, { backgroundColor: colors.surface, borderTopColor: colors.border, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
        <View style={{ paddingBottom: Math.max(insets.bottom, Spacing.md) }}>
          {ended ? (
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: ACCENT }]}
              onPress={() => router.push('/meeting-recap?id=' + (meeting.room_id || id))}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnText}>{t('meetingDetail.viewRecap')}</Text>
            </TouchableOpacity>
          ) : (
            <>
              {joinable ? (
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: ACCENT }, joining && { opacity: 0.6 }]}
                  onPress={handleJoin}
                  disabled={joining}
                  activeOpacity={0.8}
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
              ) : meeting?.status === 'scheduled' && meeting?.scheduled_at ? (
                <View style={[styles.primaryBtn, { backgroundColor: isDark ? '#333' : '#e0e0e0' }]}>
                  <Text style={[styles.primaryBtnText, { color: isDark ? '#999' : '#666' }]}>
                    {(() => {
                      const start = new Date(meeting.scheduled_at).getTime();
                      const mins = Math.ceil((start - 10 * 60 * 1000 - Date.now()) / 60000);
                      return mins > 60
                        ? `${t('meetingDetail.availableIn') || 'Disponível em'} ${Math.ceil(mins / 60)}h`
                        : `${t('meetingDetail.availableIn') || 'Disponível em'} ${mins} min`;
                    })()}
                  </Text>
                </View>
              ) : null}
            </>
          )}

          <View style={styles.secondaryRow}>
            <TouchableOpacity style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: isDark ? colors.surfaceVariant : '#f8fafc' }]} onPress={handleCopyLink} activeOpacity={0.7}>
              {copied ? <IconCheck size={16} color={ACCENT} /> : <IconCopy size={16} color={colors.textSecondary} />}
              <Text style={[styles.secondaryBtnText, { color: copied ? ACCENT : colors.textSecondary }]}>
                {copied ? t('meetingDetail.copied') : t('meetingDetail.copyLink')}
              </Text>
            </TouchableOpacity>

            {isHost && !ended && (
              <>
                <TouchableOpacity
                  style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: isDark ? colors.surfaceVariant : '#f8fafc' }]}
                  onPress={() => router.push('/meeting-create?edit=' + (meeting.room_id || room_id))}
                  activeOpacity={0.7}
                >
                  <IconEdit size={16} color={colors.primary} />
                  <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>{t('meetingDetail.edit')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.secondaryBtn, { borderColor: colors.error + '30', backgroundColor: isDark ? colors.error + '10' : '#fef2f2' }]}
                  onPress={handleCancel}
                  activeOpacity={0.7}
                >
                  <IconX size={16} color={colors.error} />
                  <Text style={[styles.secondaryBtnText, { color: colors.error }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              </>
            )}

            {isHost && (
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: colors.error + '30', backgroundColor: isDark ? colors.error + '15' : '#fef2f2', marginTop: ended ? 0 : Spacing.xs }]}
                onPress={handleDelete}
                activeOpacity={0.7}
              >
                <IconTrash size={16} color={colors.error} />
                <Text style={[styles.secondaryBtnText, { color: colors.error }]}>{t('meetingDetail.deleteMeeting')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  headerTitle: { flex: 1, fontSize: FontSize.xl, fontWeight: '700' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
  content: { padding: Spacing.md },
  card: {
    borderRadius: 16, padding: Spacing.lg, marginBottom: Spacing.md,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  meetingTitle: { fontSize: FontSize.xxl || 22, fontWeight: '700', flex: 1, marginRight: Spacing.md },
  badge: {
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 20,
  },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: Spacing.sm },
  infoRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth },
  infoIconWrap: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: { fontSize: FontSize.base, fontWeight: '500' },
  roleLabel: { fontStyle: 'italic', fontSize: FontSize.sm, fontWeight: '400' },
  description: { fontSize: FontSize.base, lineHeight: 22, marginTop: Spacing.lg, opacity: 0.85 },
  endedBanner: {
    marginTop: Spacing.lg, padding: Spacing.md, borderRadius: 12, alignItems: 'center',
  },
  endedText: { fontSize: FontSize.sm, fontWeight: '500' },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  sectionTitleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  countBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  countBadgeText: { fontSize: FontSize.sm, fontWeight: '700' },
  rsvpRow: { flexDirection: 'row', gap: Spacing.sm },
  rsvpBtn: {
    flex: 1, borderWidth: 2, borderRadius: 14,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
    minHeight: 44,
  },
  rsvpBtnText: { fontWeight: '700', fontSize: FontSize.base },
  // Why: participant row felt cramped at 14px — bumped to 15 with web hover
  // so it reads as a tappable row not a static list. Name went 600→700 with
  // letter-spacing for the "person label" weight (matches contacts polish).
  // Role badge gets bigger radius + uppercase letter-spacing so it reads as
  // a real chip, not just colored text.
  participantRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 15,
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease', cursor: 'default' } : {}),
  },
  participantName: { fontSize: FontSize.base, fontWeight: '700', letterSpacing: -0.2 },
  roleBadge: {
    paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, marginLeft: Spacing.sm,
  },
  roleBadgeText: { fontSize: FontSize.xs, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  rsvpStatusWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: Spacing.xs,
  },
  rsvpStatusText: { fontSize: FontSize.xs, fontWeight: '600' },
  emptyParticipants: {
    alignItems: 'center', paddingVertical: Spacing.xl,
  },
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 8,
  },
  // Why: primary CTA radius 14→16, deeper purple shadow, web transition for
  // hover lift; secondary buttons get matching radius bump + transition.
  primaryBtn: {
    flexDirection: 'row', borderRadius: 16,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm,
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 5,
    ...(Platform.OS === 'web' ? { transition: 'transform 180ms ease, box-shadow 200ms ease', cursor: 'pointer', boxShadow: '0 5px 16px rgba(124,58,237,0.38)' } : {}),
  },
  primaryBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700', letterSpacing: -0.2 },
  secondaryRow: { flexDirection: 'row', gap: Spacing.sm },
  secondaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: 14,
    paddingVertical: 12, gap: Spacing.xs,
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease, transform 160ms ease', cursor: 'pointer' } : {}),
  },
  secondaryBtnText: { fontSize: FontSize.sm, fontWeight: '700', letterSpacing: -0.1 },
});
