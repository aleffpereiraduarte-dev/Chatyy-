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
  const { colors } = useTheme();
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
          setChat(r.data.chat || []);
          setRecording(r.data.recording || null);
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
      formatTime(a.joined_at, t('_locale')), formatTime(a.left_at, t('_locale')), formatDuration(a.duration_seconds),
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
      active: { bg: colors.success + '20', color: colors.success, label: t('meetingRecap.statusActive') },
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
    if (meeting.duration_minutes) return `${meeting.duration_minutes} min`;
    if (meeting.ended_at && meeting.created_at) {
      const diff = Math.round((new Date(meeting.ended_at) - new Date(meeting.created_at)) / 60000);
      return `${diff} min`;
    }
    return null;
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      </View>
    );
  }

  if (error || !meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={24} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingRecap.title')}</Text>
        </View>
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary, fontSize: FontSize.lg }}>{error || t('meetingRecap.notFound')}</Text>
        </View>
      </View>
    );
  }

  const duration = getDuration();

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingRecap.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Meeting Info Card */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.meetingTitle, { color: colors.text }]}>{meeting.title || t('meetingRecap.untitled')}</Text>
            {statusBadge(meeting.status)}
          </View>
          <View style={styles.infoRow}>
            <IconUsers size={16} color={colors.textSecondary} />
            <Text style={[styles.infoText, { color: colors.textSecondary }]}>{meeting.host_name || t('meetingRecap.unknown')}</Text>
          </View>
          <View style={styles.infoRow}>
            <IconClock size={16} color={colors.textSecondary} />
            <Text style={[styles.infoText, { color: colors.textSecondary }]}>
              {formatDate(meeting.scheduled_at || meeting.created_at, t('_locale'))} {t('meetingRecap.at')} {formatTime(meeting.scheduled_at || meeting.created_at, t('_locale'))}
            </Text>
          </View>
          {duration && (
            <View style={styles.infoRow}>
              <IconVideo size={16} color={colors.textSecondary} />
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>{duration}</Text>
            </View>
          )}
        </View>

        {/* AI Summary Card */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface, borderLeftWidth: 4, borderLeftColor: colors.primary }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('meetingRecap.aiSummary')}</Text>
          {aiSummary ? (
            <View>{renderSummaryText(aiSummary, colors)}</View>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: Spacing.md }}>
              {generatingSummary ? (
                <>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: Spacing.sm }}>{t('meetingRecap.generatingSummary')}</Text>
                </>
              ) : (
                <>
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, marginBottom: Spacing.md }}>{t('meetingRecap.noSummary')}</Text>
                  <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.primary }]} onPress={handleGenerateSummary}>
                    <Text style={styles.actionBtnText}>{t('meetingRecap.generateSummary')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
        </View>

        {/* Attendance Section */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('meetingRecap.attendanceTitle', { count: attendance.length, s: attendance.length !== 1 ? 's' : '' })}
          </Text>
          {attendance.map((a, i) => (
            <View key={a.email || i} style={[styles.attendeeRow, i < attendance.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }]}>
              <View style={[styles.avatar, { backgroundColor: getAvatarColor(a.display_name || a.email) }]}>
                <Text style={styles.avatarText}>{(a.display_name || a.email || '?')[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.attendeeName, { color: colors.text }]}>{a.display_name || a.email}</Text>
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                  {formatTime(a.joined_at, t('_locale'))} – {formatTime(a.left_at, t('_locale'))} · {formatDuration(a.duration_seconds)}
                </Text>
              </View>
              <View style={[styles.roleBadge, { backgroundColor: a.role === 'host' ? colors.primary + '20' : colors.textTertiary + '15' }]}>
                <Text style={[styles.roleBadgeText, { color: a.role === 'host' ? colors.primary : colors.textSecondary }]}>
                  {a.role === 'host' ? t('meetingRecap.host') : t('meetingRecap.participant')}
                </Text>
              </View>
            </View>
          ))}
          {attendance.length === 0 && (
            <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', paddingVertical: Spacing.lg }}>
              {t('meetingRecap.noAttendance')}
            </Text>
          )}
          {attendance.length > 0 && (
            <TouchableOpacity style={[styles.outlineBtn, { borderColor: colors.border, marginTop: Spacing.lg }]} onPress={handleDownloadCSV}>
              <IconDownload size={16} color={colors.primary} />
              <Text style={[styles.outlineBtnText, { color: colors.primary }]}>{t('meetingRecap.downloadCSV')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Chat Transcript Section */}
        <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('meetingRecap.chatTitle', { count: chat.length, s: chat.length !== 1 ? 's' : '' })}
          </Text>
          {chat.length === 0 ? (
            <Text style={{ color: colors.textTertiary, fontSize: FontSize.base, textAlign: 'center', paddingVertical: Spacing.lg }}>
              {t('meetingRecap.noMessages')}
            </Text>
          ) : (
            chat.map((msg, i) => (
              <View key={i} style={[styles.chatMsg, i < chat.length - 1 && { marginBottom: Spacing.sm }]}>
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>{formatTime(msg.created_at, t('_locale'))}</Text>
                <Text style={{ color: colors.text, fontSize: FontSize.base }}>
                  <Text style={{ fontWeight: '600', color: getAvatarColor(msg.sender_name) }}>{msg.sender_name}: </Text>
                  {msg.message}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Recording Section */}
        {recording && (
          <View style={[styles.card, Shadow.md, { backgroundColor: colors.surface }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md }}>
              <IconVideo size={20} color={colors.text} style={{ marginRight: Spacing.sm }} />
              <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('meetingRecap.recording')}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
              <View style={[styles.badge, { backgroundColor: recording.status === 'completed' ? colors.success + '20' : colors.warning + '20' }]}>
                <Text style={[styles.badgeText, { color: recording.status === 'completed' ? colors.success : colors.warning }]}>
                  {recording.status === 'completed' ? t('meetingRecap.recordingReady') : t('meetingRecap.recordingProcessing')}
                </Text>
              </View>
              {recording.duration_seconds > 0 && (
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{formatDuration(recording.duration_seconds)}</Text>
              )}
            </View>
            {recording.status === 'completed' && recording.file_path && (
              <TouchableOpacity style={[styles.outlineBtn, { borderColor: colors.primary, marginTop: Spacing.lg }]} onPress={() => {
                if (Platform.OS === 'web') window.open(recording.file_path, '_blank');
                else router.push(recording.file_path);
              }}>
                <IconDownload size={16} color={colors.primary} />
                <Text style={[styles.outlineBtnText, { color: colors.primary }]}>{t('meetingRecap.downloadRecording')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Bottom Actions */}
        <View style={{ gap: Spacing.md, marginTop: Spacing.md, marginBottom: Spacing.xxl }}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.textTertiary + '30' }]} onPress={handleSendEmail}>
            <Text style={[styles.actionBtnText, { color: colors.text }]}>{t('meetingRecap.sendByEmail')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.primary }]} onPress={() => router.push('/meetings')}>
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
  sectionTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.lg },
  summaryLine: { fontSize: FontSize.base, lineHeight: 22, marginBottom: Spacing.xs },
  attendeeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  attendeeName: { fontSize: FontSize.base, fontWeight: '500' },
  roleBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.sm, marginLeft: Spacing.sm,
  },
  roleBadgeText: { fontSize: FontSize.xs, fontWeight: '600', textTransform: 'capitalize' },
  chatMsg: { paddingVertical: Spacing.xs },
  actionBtn: {
    borderRadius: BorderRadius.xxl, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  outlineBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: BorderRadius.xxl,
    paddingVertical: Spacing.md, gap: Spacing.sm,
  },
  outlineBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});
