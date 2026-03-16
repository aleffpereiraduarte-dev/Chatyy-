import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, TextInput, Modal, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import {
  IconCalendar, IconClock, IconArrowLeft, IconCheck, IconX,
  IconEdit, IconTrash, IconMapPin, IconRepeat, IconUsers,
} from '../components/Icons';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeRange(startStr, endStr, allDay, allDayLabel) {
  if (allDay) return allDayLabel || 'All day';
  const startD = new Date(startStr);
  const endD = new Date(endStr);
  const sameDay = startD.toDateString() === endD.toDateString();
  if (sameDay) {
    return `${formatTime(startStr)} - ${formatTime(endStr)}`;
  }
  return `${formatDate(startStr)} ${formatTime(startStr)} - ${formatDate(endStr)} ${formatTime(endStr)}`;
}

function RsvpStatusBadge({ status, colors }) {
  const { t } = useLanguage();
  const map = {
    accepted: { bg: colors.success + '20', color: colors.success, label: t('eventDetail.rsvpAccepted') },
    declined: { bg: colors.error + '20', color: colors.error, label: t('eventDetail.rsvpDeclined') },
    tentative: { bg: colors.warning + '20', color: colors.warning, label: t('eventDetail.rsvpTentative') },
    'needs-action': { bg: colors.textTertiary + '20', color: colors.textTertiary, label: t('eventDetail.rsvpPending') },
    pending: { bg: colors.textTertiary + '20', color: colors.textTertiary, label: t('eventDetail.rsvpPending') },
  };
  const cfg = map[status] || map['needs-action'];
  return (
    <View style={[styles.rsvpBadge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.rsvpBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ============================================================
// Edit Event Modal
// ============================================================
function EditEventModal({ visible, onClose, event, onSave, colors }) {
  const { t } = useLanguage();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && event) {
      setTitle(event.title || '');
      setDescription(event.description || '');
      setLocation(event.location || '');
    }
  }, [visible, event]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ title, description, location });
      onClose();
    } catch {
      Alert.alert(t('common.error'), t('eventDetail.editError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
        <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={onClose} style={styles.modalHeaderBtn}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{t('eventDetail.editEvent')}</Text>
            <TouchableOpacity onPress={handleSave} style={styles.modalHeaderBtn} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <IconCheck size={22} color={colors.primary} />
              )}
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('eventDetail.titleField')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              value={title}
              onChangeText={setTitle}
              placeholder={t('eventDetail.titlePlaceholder')}
              placeholderTextColor={colors.textTertiary}
            />
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('eventDetail.descriptionField')}</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              value={description}
              onChangeText={setDescription}
              placeholder={t('eventDetail.descriptionPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={4}
            />
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('eventDetail.locationField')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              value={location}
              onChangeText={setLocation}
              placeholder={t('eventDetail.locationPlaceholder')}
              placeholderTextColor={colors.textTertiary}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================
// Error Boundary
// ============================================================
class EventDetailErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Event Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// Main Screen
// ============================================================
export default function EventDetailScreenWrapper() {
  return (
    <EventDetailErrorBoundary>
      <EventDetailScreenInner />
    </EventDetailErrorBoundary>
  );
}

function EventDetailScreenInner() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const eventId = params.id;

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(false);

  const loadEvent = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const r = await api.calEvent(eventId);
      if (r.success) {
        setEvent(r.data?.event || null);
      } else {
        Alert.alert(t('common.error'), r.message || t('eventDetail.loadError'));
      }
    } catch {
      Alert.alert(t('common.error'), t('eventDetail.loadError'));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    loadEvent();
  }, [loadEvent]);

  const handleRsvp = async (status) => {
    setRsvpLoading(true);
    try {
      const r = await api.calRsvp(eventId, status);
      if (r.success) {
        loadEvent();
      } else {
        Alert.alert(t('common.error'), r.message || t('eventDetail.rsvpError'));
      }
    } catch {
      Alert.alert(t('common.error'), t('eventDetail.networkError'));
    } finally {
      setRsvpLoading(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      t('eventDetail.deleteEvent'),
      t('eventDetail.deleteConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('eventDetail.deleteButton'), style: 'destructive',
          onPress: async () => {
            try {
              const r = await api.calDeleteEvent(eventId);
              if (r.success) {
                router.back();
              } else {
                Alert.alert(t('common.error'), r.message || t('eventDetail.deleteError'));
              }
            } catch {
              Alert.alert(t('common.error'), t('eventDetail.networkError'));
            }
          },
        },
      ]
    );
  };

  const handleUpdateEvent = async (data) => {
    const r = await api.calUpdateEvent(eventId, data);
    if (r.success) {
      loadEvent();
    } else {
      throw new Error(r.message || 'Update failed');
    }
  };

  const handleExport = async () => {
    try {
      const r = await api.apiCall('cal_export_ics', { event_id: eventId });
      if (r.success && r.data?.ics) {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          const blob = new Blob([r.data.ics], { type: 'text/calendar' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = r.data.filename || 'event.ics';
          a.click();
          URL.revokeObjectURL(url);
        } else {
          Alert.alert(t('eventDetail.exportLabel'), t('eventDetail.exportWebOnly'));
        }
      }
    } catch {
      Alert.alert(t('common.error'), t('eventDetail.exportError'));
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('eventDetail.title')}</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  if (!event) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('eventDetail.title')}</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.emptyWrap}>
          <IconCalendar size={48} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('eventDetail.notFound')}</Text>
        </View>
      </View>
    );
  }

  const userEmail = (user?.email || '').toLowerCase();
  const isCreator = (event.created_by || event.creator_email || '').toLowerCase() === userEmail
    || (event.owner_email || '').toLowerCase() === userEmail;
  const isAttendee = (event.attendees || []).some(a => (a.email || '').toLowerCase() === userEmail);
  const eventColor = event.color || event.calendar_color || colors.primary;
  const myRsvp = (event.attendees || []).find(a => (a.email || '').toLowerCase() === userEmail);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('eventDetail.title')}</Text>
        <View style={styles.headerRight}>
          {isCreator && (
            <>
              <TouchableOpacity onPress={() => setShowEdit(true)} style={styles.headerBtn}>
                <IconEdit size={20} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleDelete} style={styles.headerBtn}>
                <IconTrash size={20} color={colors.error} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.xl }}>
        {/* Color bar */}
        <View style={[styles.colorBar, { backgroundColor: eventColor }]} />

        {/* Title */}
        <View style={styles.section}>
          <Text style={[styles.eventTitle, { color: colors.text }]}>{event.title || t('eventDetail.untitled')}</Text>
          {event.status === 'cancelled' && (
            <View style={[styles.statusBadge, { backgroundColor: colors.error + '20' }]}>
              <Text style={[styles.statusBadgeText, { color: colors.error }]}>{t('eventDetail.cancelled')}</Text>
            </View>
          )}
        </View>

        {/* Date & Time */}
        <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
          <View style={[styles.infoIcon, { backgroundColor: eventColor + '18' }]}>
            <IconClock size={18} color={eventColor} />
          </View>
          <View style={styles.infoContent}>
            <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{t('eventDetail.dateTime')}</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(event.start_at)}
            </Text>
            <Text style={[styles.infoValueSub, { color: colors.textSecondary }]}>
              {formatTimeRange(event.start_at, event.end_at, event.all_day, t('eventDetail.allDay'))}
            </Text>
          </View>
        </View>

        {/* Location */}
        {!!event.location && (
          <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
            <View style={[styles.infoIcon, { backgroundColor: eventColor + '18' }]}>
              <IconMapPin size={18} color={eventColor} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{t('eventDetail.location')}</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>{event.location}</Text>
            </View>
          </View>
        )}

        {/* Calendar */}
        {!!event.calendar_name && (
          <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
            <View style={[styles.infoIcon, { backgroundColor: eventColor + '18' }]}>
              <IconCalendar size={18} color={eventColor} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{t('eventDetail.calendar')}</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>{event.calendar_name}</Text>
            </View>
          </View>
        )}

        {/* Recurrence */}
        {!!event.recurrence_rule && (
          <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
            <View style={[styles.infoIcon, { backgroundColor: eventColor + '18' }]}>
              <IconRepeat size={18} color={eventColor} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{t('eventDetail.recurrence')}</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>{event.recurrence_rule}</Text>
            </View>
          </View>
        )}

        {/* Description */}
        {!!event.description && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('eventDetail.description')}</Text>
            <Text style={[styles.descriptionText, { color: colors.textSecondary }]}>{event.description}</Text>
          </View>
        )}

        {/* Creator */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('eventDetail.organizer')}</Text>
          <View style={styles.attendeeRow}>
            <View style={[styles.attendeeAvatar, { backgroundColor: eventColor }]}>
              <Text style={styles.attendeeAvatarText}>
                {(event.creator_name || event.created_by || event.creator_email || '?')[0].toUpperCase()}
              </Text>
            </View>
            <View style={styles.attendeeInfo}>
              <Text style={[styles.attendeeName, { color: colors.text }]}>
                {event.creator_name || event.created_by || event.creator_email}
              </Text>
              <Text style={[styles.attendeeEmail, { color: colors.textSecondary }]}>
                {event.created_by || event.creator_email}
              </Text>
            </View>
          </View>
        </View>

        {/* Attendees */}
        {event.attendees && event.attendees.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <IconUsers size={16} color={colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: colors.text, marginLeft: 6 }]}>
                {t('eventDetail.participantsCount', { count: event.attendees.length })}
              </Text>
            </View>
            {event.attendees.map((att, idx) => (
              <View key={idx} style={[styles.attendeeRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.attendeeAvatar, { backgroundColor: colors.primary }]}>
                  <Text style={styles.attendeeAvatarText}>
                    {(att.display_name || att.email || '?')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={styles.attendeeInfo}>
                  <Text style={[styles.attendeeName, { color: colors.text }]}>
                    {att.display_name || att.email}
                  </Text>
                  <Text style={[styles.attendeeEmail, { color: colors.textSecondary }]}>
                    {att.email}
                  </Text>
                </View>
                <RsvpStatusBadge status={att.rsvp || att.status} colors={colors} />
              </View>
            ))}
          </View>
        )}

        {/* RSVP Buttons — for attendees */}
        {isAttendee && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('eventDetail.yourResponse')}</Text>
            {myRsvp && (
              <View style={{ marginBottom: Spacing.sm }}>
                <RsvpStatusBadge status={myRsvp.rsvp || myRsvp.status} colors={colors} />
              </View>
            )}
            <View style={styles.rsvpButtonRow}>
              <TouchableOpacity
                style={[styles.rsvpButton, { backgroundColor: colors.success + '18', borderColor: colors.success }]}
                onPress={() => handleRsvp('accepted')}
                disabled={rsvpLoading}
              >
                <IconCheck size={16} color={colors.success} />
                <Text style={[styles.rsvpButtonText, { color: colors.success }]}>{t('eventDetail.accept')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rsvpButton, { backgroundColor: colors.warning + '18', borderColor: colors.warning }]}
                onPress={() => handleRsvp('tentative')}
                disabled={rsvpLoading}
              >
                <Text style={[styles.rsvpButtonText, { color: colors.warning }]}>{t('eventDetail.maybe')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rsvpButton, { backgroundColor: colors.error + '18', borderColor: colors.error }]}
                onPress={() => handleRsvp('declined')}
                disabled={rsvpLoading}
              >
                <IconX size={16} color={colors.error} />
                <Text style={[styles.rsvpButtonText, { color: colors.error }]}>{t('eventDetail.decline')}</Text>
              </TouchableOpacity>
            </View>
            {rsvpLoading && <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: Spacing.sm }} />}
          </View>
        )}

        {/* Export button */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.exportBtn, { borderColor: colors.border }]}
            onPress={handleExport}
          >
            <IconCalendar size={16} color={colors.primary} />
            <Text style={[styles.exportBtnText, { color: colors.primary }]}>{t('eventDetail.exportIcs')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Edit Modal */}
      <EditEventModal
        visible={showEdit}
        onClose={() => setShowEdit(false)}
        event={event}
        onSave={handleUpdateEvent}
        colors={colors}
      />
    </View>
  );
}

// ============================================================
// Styles
// ============================================================
const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.md },
  emptyText: { fontSize: FontSize.lg, fontWeight: '500' },

  body: { flex: 1 },

  colorBar: { height: 4, width: '100%' },

  section: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', marginBottom: Spacing.xs },

  eventTitle: { fontSize: FontSize.xl + 2, fontWeight: '700', marginBottom: Spacing.xs },
  statusBadge: {
    alignSelf: 'flex-start', paddingHorizontal: Spacing.sm, paddingVertical: 3,
    borderRadius: BorderRadius.full || 99,
  },
  statusBadgeText: { fontSize: FontSize.sm, fontWeight: '600' },

  infoRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md,
  },
  infoContent: { flex: 1 },
  infoLabel: { fontSize: FontSize.xs, fontWeight: '600', textTransform: 'uppercase', marginBottom: 2 },
  infoValue: { fontSize: FontSize.md, fontWeight: '500' },
  infoValueSub: { fontSize: FontSize.sm, marginTop: 2 },

  descriptionText: { fontSize: FontSize.md, lineHeight: 22 },

  // Attendee
  attendeeRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.xs,
  },
  attendeeAvatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.sm,
  },
  attendeeAvatarText: { color: '#fff', fontWeight: '600', fontSize: FontSize.md },
  attendeeInfo: { flex: 1 },
  attendeeName: { fontSize: FontSize.md, fontWeight: '500' },
  attendeeEmail: { fontSize: FontSize.sm },

  // RSVP
  rsvpBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full || 99,
  },
  rsvpBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  rsvpButtonRow: {
    flexDirection: 'row', gap: Spacing.sm,
  },
  rsvpButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1,
  },
  rsvpButtonText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Export
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1,
  },
  exportBtnText: { fontSize: FontSize.md, fontWeight: '600' },

  // Modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalContent: {
    borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    maxHeight: '80%', ...Shadow.lg,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalHeaderBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  modalBody: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },

  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.xs, marginTop: Spacing.xs },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs + 2,
    fontSize: FontSize.md, marginBottom: Spacing.sm,
  },
  inputMultiline: { minHeight: 80, textAlignVertical: 'top' },
});
