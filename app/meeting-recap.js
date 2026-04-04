import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, ActivityIndicator, Share,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow, Colors } from '../constants/theme';
import { IconArrowLeft, IconUsers, IconClock, IconCheck, IconVideo, IconDownload, IconMessageCircle } from '../components/Icons';
import * as api from '../services/api';

const ACCENT = '#25D366';

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

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDurationMinutes(minutes) {
  if (!minutes || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.join(',')).join('\n');
  if (Platform.OS === 'web') {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } else {
    Share.share({ message: csv, title: filename });
  }
}

function renderSummaryText(text, colors) {
  if (!text) return null;
  return text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <View key={i} style={{ height: Spacing.sm }} />;
    const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('• ');
    const content = isBullet ? trimmed.slice(2) : trimmed;
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((part, j) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <Text key={j} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
      }
      return <Text key={j}>{part}</Text>;
    });
    return (
      <Text key={i} style={[styles.summaryLine, { color: colors.text }]}>
        {isBullet ? '  \u2022  ' : ''}{parts}
      </Text>
    );
  });
}

export default function MeetingRecapScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();

  const [loading, setLoading] = useState(true);
  const [meeting, setMeeting] = useState(null);
  const [attendance, setAttendance] = useState([]);
  const [chat, setChat] = useState([]);
  const [recording, setRecording] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const r = await api.meetRecap(id);
        if (r.success && r.data) {
          setMeeting(r.data.meeting);
          setAttendance(r.data.attendance || []);
          setChat(r.data.chat_messages || []);
          setRecording(r.data.recordings?.[0] || null);
          setAiSummary(r.data.ai_summary || r.data.meeting?.ai_summary || null);
        } else {
          setError(t('meetingRecap.loadError'));
        }
      } catch {
        setError(t('meetingRecap.loadErrorGeneric'));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleGenerateSummary = async () => {
    setGeneratingSummary(true);
    try {
      const r = await api.meetAiSummary(id);
      if (r.success && r.data) {
        setAiSummary(typeof r.data === 'string' ? r.data : r.data.summary || r.data.ai_summary || '');
      }
    } catch {} finally {
      setGeneratingSummary(false);
    }
  };

  const handleDownloadCSV = () => {
    const header = [t('meetingRecap.csvName'), t('meetingRecap.csvEmail'), t('meetingRecap.csvRole'), t('meetingRecap.csvJoined'), t('meetingRecap.csvLeft'), t('meetingRecap.csvDuration')];
    const rows = [header, ...attendance.map(a => [
      `"${a.display_name || ''}"`, a.email || '', a.role || 'participant',
      formatTime(a.joined_at, t('_locale')), formatTime(a.left_at, t('_locale')),
      // BUG FIX: backend sends duration_minutes now (was duration_seconds before fix).
      // Support both for backwards compatibility.
      a.duration_seconds ? formatDuration(a.duration_seconds) : formatDurationMinutes(a.duration_minutes),
    ])];
    downloadCSV(rows, `meeting-${id}-attendance.csv`);
  };

  const handleSendEmail = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(t('meetingRecap.comingSoon'));
    } else {
      const { Alert } = require('react-native');
      Alert.alert(t('meetingRecap.comingSoon'), t('meetingRecap.comingSoonDesc'));
    }
  };

  const statusBadge = (status) => {
    const map = {
      active: { bg: ACCENT + '20', color: ACCENT, label: t('meetingRecap.statusActive') },
      scheduled: { bg: colors.primary + '20', color: colors.primary, label: t('meetingRecap.statusScheduled') },
      ended: { bg: colors.textTertiary + '20', color: colors.textSecondary, label: t('meetingRecap.statusEnded') },
      cancelled: { bg: colors.error + '20', color: colors.error, label: t('meetingRecap.statusCancelled') },
    };
    const s = map[status] || map.ended;
    return (
      <View style={[styles.badge, { backgroundColor: s.bg }]}>
        <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
      </View>
    );
  };

  const getDuration = () => {
    if (meeting.duration_minutes) return formatDurationMinutes(meeting.duration_minutes);
    if (meeting.ended_at && meeting.created_at) {
      const diff = Math.round((new Date(meeting.ended_at) - new Date(meeting.created_at)) / 60000);
      return formatDurationMinutes(diff);
    }
    return null;
  };

  if (loading && !meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]} />
    );
  }

  if (error || !meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingRecap.title')}</Text>
        </View>
        <View style={styles.center}>
          <IconVideo size={48} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{error || t('meetingRecap.notFound')}</Text>
        </View>
      </View>
    );
  }

  const duration = getDuration();

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: isDark ? colors.surface : '#fff', borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingRecap.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Meeting Info Card */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.meetingTitle, { color: colors.text }]}>{meeting.title || t('meetingRecap.untitled')}</Text>
            {statusBadge(meeting.status)}
          </View>
          <View style={[styles.infoRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border + '40' }]}>
            <View style={[styles.infoIconWrap, { backgroundColor: colors.primary + '15' }]}>
              <IconUsers size={15} color={colors.primary} />
            </View>
            <Text style={[styles.infoText, { color: colors.text }]}>{meeting.host_name || t('meetingRecap.unknown')}</Text>
          </View>
          <View style={[styles.infoRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border + '40' }]}>
            <View style={[styles.infoIconWrap, { backgroundColor: ACCENT + '15' }]}>
              <IconClock size={15} color={ACCENT} />
            </View>
            <Text style={[styles.infoText, { color: colors.text }]}>
              {formatDate(meeting.scheduled_at || meeting.created_at, t('_locale'))} {t('meetingRecap.at')} {formatTime(meeting.scheduled_at || meeting.created_at, t('_locale'))}
            </Text>
          </View>
          {duration && (
            <View style={styles.infoRow}>
              <View style={[styles.infoIconWrap, { backgroundColor: colors.warning + '15' }]}>
                <IconVideo size={15} color={colors.warning} />
              </View>
              <Text style={[styles.infoText, { color: colors.text }]}>{duration}</Text>
            </View>
          )}
        </View>

        {/* AI Summary Card */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8', borderLeftWidth: 4, borderLeftColor: ACCENT }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('meetingRecap.aiSummary')}</Text>
          {aiSummary ? (
            <View>{renderSummaryText(aiSummary, colors)}</View>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: Spacing.lg }}>
              {generatingSummary ? (
                <>
                  <ActivityIndicator size="small" color={ACCENT} />
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: Spacing.sm }}>{t('meetingRecap.generatingSummary')}</Text>
                </>
              ) : (
                <>
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, marginBottom: Spacing.md, textAlign: 'center' }}>{t('meetingRecap.noSummary')}</Text>
                  <TouchableOpacity style={[styles.actionBtn, { backgroundColor: ACCENT }]} onPress={handleGenerateSummary} activeOpacity={0.8}>
                    <Text style={styles.actionBtnText}>{t('meetingRecap.generateSummary')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
        </View>

        {/* Attendance Section */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
          <View style={styles.sectionTitleRow}>
            <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>
              {t('meetingRecap.attendanceTitle', { count: attendance.length, s: attendance.length !== 1 ? 's' : '' })}
            </Text>
            <View style={[styles.countBadge, { backgroundColor: ACCENT + '20' }]}>
              <Text style={[styles.countBadgeText, { color: ACCENT }]}>{attendance.length}</Text>
            </View>
          </View>
          {attendance.map((a, i) => (
            <View key={a.email || i} style={[styles.attendeeRow, i < attendance.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border + '30' }]}>
              <View style={[styles.avatar, { backgroundColor: getAvatarColor(a.display_name || a.email) }]}>
                <Text style={styles.avatarText}>{(a.display_name || a.email || '?')[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.attendeeName, { color: colors.text }]}>{a.display_name || a.email}</Text>
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                  {formatTime(a.joined_at, t('_locale'))} – {formatTime(a.left_at, t('_locale'))} · {
                    // BUG FIX: support both duration_seconds and duration_minutes
                    a.duration_seconds ? formatDuration(a.duration_seconds) : formatDurationMinutes(a.duration_minutes)
                  }
                </Text>
              </View>
              <View style={[styles.roleBadge, { backgroundColor: a.role === 'host' ? ACCENT + '18' : colors.textTertiary + '15' }]}>
                <Text style={[styles.roleBadgeText, { color: a.role === 'host' ? ACCENT : colors.textSecondary }]}>
                  {a.role === 'host' ? t('meetingRecap.host') : t('meetingRecap.participant')}
                </Text>
              </View>
            </View>
          ))}
          {attendance.length === 0 && (
            <View style={styles.emptySection}>
              <IconUsers size={36} color={colors.textTertiary} />
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', marginTop: Spacing.sm }}>
                {t('meetingRecap.noAttendance')}
              </Text>
            </View>
          )}
          {attendance.length > 0 && (
            <TouchableOpacity style={[styles.outlineBtn, { borderColor: ACCENT + '40', marginTop: Spacing.lg }]} onPress={handleDownloadCSV} activeOpacity={0.7}>
              <IconDownload size={16} color={ACCENT} />
              <Text style={[styles.outlineBtnText, { color: ACCENT }]}>{t('meetingRecap.downloadCSV')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Chat Transcript Section */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
          <View style={styles.sectionTitleRow}>
            <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>
              {t('meetingRecap.chatTitle', { count: chat.length, s: chat.length !== 1 ? 's' : '' })}
            </Text>
            <View style={[styles.countBadge, { backgroundColor: colors.primary + '20' }]}>
              <Text style={[styles.countBadgeText, { color: colors.primary }]}>{chat.length}</Text>
            </View>
          </View>
          {chat.length === 0 ? (
            <View style={styles.emptySection}>
              <IconMessageCircle size={36} color={colors.textTertiary} />
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', marginTop: Spacing.sm }}>
                {t('meetingRecap.noMessages')}
              </Text>
            </View>
          ) : (
            chat.map((msg, i) => (
              <View key={i} style={[styles.chatMsg, i < chat.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border + '20' }]}>
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginBottom: 2 }}>{formatTime(msg.created_at, t('_locale'))}</Text>
                <Text style={{ color: colors.text, fontSize: FontSize.base, lineHeight: 20 }}>
                  <Text style={{ fontWeight: '700', color: getAvatarColor(msg.sender_name) }}>{msg.sender_name}: </Text>
                  {msg.message}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Recording Section */}
        {recording && (
          <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: isDark ? '#000' : '#94a3b8' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md }}>
              <View style={[styles.infoIconWrap, { backgroundColor: colors.error + '15', marginRight: Spacing.sm }]}>
                <IconVideo size={16} color={colors.error} />
              </View>
              <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('meetingRecap.recording')}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
              <View style={[styles.badge, { backgroundColor: recording.status === 'completed' ? ACCENT + '20' : colors.warning + '20' }]}>
                <Text style={[styles.badgeText, { color: recording.status === 'completed' ? ACCENT : colors.warning }]}>
                  {recording.status === 'completed' ? t('meetingRecap.recordingReady') : t('meetingRecap.recordingProcessing')}
                </Text>
              </View>
              {recording.duration_seconds > 0 && (
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{formatDuration(recording.duration_seconds)}</Text>
              )}
            </View>
            {recording.status === 'completed' && recording.file_path && (
              <TouchableOpacity style={[styles.outlineBtn, { borderColor: ACCENT + '40', marginTop: Spacing.lg }]} onPress={() => {
                if (Platform.OS === 'web') window.open(recording.file_path, '_blank');
                else router.push(recording.file_path);
              }} activeOpacity={0.7}>
                <IconDownload size={16} color={ACCENT} />
                <Text style={[styles.outlineBtnText, { color: ACCENT }]}>{t('meetingRecap.downloadRecording')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Bottom Actions */}
        <View style={{ gap: Spacing.sm, marginTop: Spacing.md, marginBottom: Spacing.xxl || 48 }}>
{/* Send recap by email button hidden until feature is implemented */}
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: ACCENT }]}
            onPress={() => router.push('/meetings')}
            activeOpacity={0.8}
          >
            <Text style={styles.actionBtnText}>{t('meetingRecap.backToMeetings')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
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
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md, textAlign: 'center' },
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
  infoIconWrap: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: { fontSize: FontSize.base, fontWeight: '500' },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  sectionTitleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  countBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  countBadgeText: { fontSize: FontSize.sm, fontWeight: '700' },
  summaryLine: { fontSize: FontSize.base, lineHeight: 24, marginBottom: Spacing.xs },
  attendeeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  attendeeName: { fontSize: FontSize.base, fontWeight: '600' },
  roleBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginLeft: Spacing.sm,
  },
  roleBadgeText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'capitalize' },
  chatMsg: { paddingVertical: 10 },
  emptySection: {
    alignItems: 'center', paddingVertical: Spacing.xl,
  },
  actionBtn: {
    borderRadius: 14, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  outlineBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderRadius: 12,
    paddingVertical: 12, gap: Spacing.sm,
  },
  outlineBtnText: { fontSize: FontSize.sm, fontWeight: '700' },
});
