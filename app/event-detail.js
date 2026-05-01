import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, TextInput, Modal, Platform,
  Animated, Switch, KeyboardAvoidingView, Linking,
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
  IconEdit, IconTrash, IconMapPin, IconRepeat, IconUsers, IconSmartphone,
  IconPlus, IconBell,
} from '../components/Icons';

const PRESET_COLORS = ['#4285F4', '#EA4335', '#34A853', '#FBBC05', '#8E24AA', '#F4511E', '#0097A7', '#616161'];

const REMINDER_OPTIONS = [
  { value: 'none', mins: 0 },
  { value: '5min', mins: 5 },
  { value: '15min', mins: 15 },
  { value: '30min', mins: 30 },
  { value: '1hour', mins: 60 },
  { value: '1day', mins: 1440 },
];

// Try to import expo-calendar (native only)
let ExpoCalendar = null;
try { ExpoCalendar = require('expo-calendar'); } catch {}

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

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

function padTwo(n) { return String(n).padStart(2, '0'); }

function dateToDateStr(d) {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

function dateToTimeStr(d) {
  return `${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`;
}

function RsvpStatusBadge({ status, colors, t }) {
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
// Edit Event Screen (inline, not modal)
// ============================================================
function EditEventView({ event, onSave, onCancel, colors, t }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('10:00');
  const [selectedColor, setSelectedColor] = useState('#4285F4');
  const [recurrence, setRecurrence] = useState('');
  const [attendeesText, setAttendeesText] = useState('');
  const [reminder, setReminder] = useState('none');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const isSynced = event?.calendar_name || event?.source === 'device';

  useEffect(() => {
    if (event) {
      setTitle(event.title || '');
      setDescription(event.description || '');
      setLocation(event.location || '');
      setAllDay(!!event.all_day);
      setSelectedColor(event.color || event.calendar_color || '#4285F4');
      setRecurrence(event.recurrence_rule || '');
      setReminder(event.reminder || 'none');
      if (event.start_at) {
        const s = new Date(event.start_at);
        setStartDate(dateToDateStr(s));
        setStartTime(dateToTimeStr(s));
      }
      if (event.end_at) {
        const e = new Date(event.end_at);
        setEndDate(dateToDateStr(e));
        setEndTime(dateToTimeStr(e));
      }
      if (event.attendees && event.attendees.length > 0) {
        setAttendeesText(event.attendees.map(a => a?.email).filter(Boolean).join(', '));
      } else {
        setAttendeesText('');
      }
    }
  }, [event]);

  const handleSave = async () => {
    if (!title.trim()) {
      safeAlert(t('common.error'), t('eventDetail.titleRequired'));
      return;
    }
    setSaving(true);
    setSaveSuccess(false);
    try {
      const startAt = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
      const endAt = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`;
      const attendees = attendeesText.split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e }));
      await onSave({
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        start_at: startAt,
        end_at: endAt,
        all_day: allDay,
        color: selectedColor,
        recurrence_rule: recurrence,
        reminder,
        attendees,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      safeAlert(t('common.error'), t('eventDetail.editError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
      {/* Synced event hint — edits will be pushed to the device calendar too */}
      {isSynced && (
        <View style={[styles.syncWarning, { backgroundColor: '#dbeafe', borderColor: '#93c5fd' }]}>
          <IconSmartphone size={16} color="#1e40af" />
          <Text style={[styles.syncWarningText, { color: '#1e40af' }]}>
            {t('eventDetail.syncedEditInfo') || 'Suas alterações serão sincronizadas com o calendário do celular.'}
          </Text>
        </View>
      )}

      {/* Title */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.titleField')}</Text>
        <TextInput
          style={[styles.editInput, styles.editInputLarge, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
          value={title}
          onChangeText={setTitle}
          placeholder={t('eventDetail.titlePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          autoFocus
        />
      </View>

      {/* All Day Toggle */}
      <View style={[styles.editSwitchRow, { borderColor: colors.border }]}>
        <Text style={[styles.editSwitchLabel, { color: colors.text }]}>{t('eventDetail.allDay')}</Text>
        <Switch
          value={allDay}
          onValueChange={setAllDay}
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor="#fff"
        />
      </View>

      {/* Start Date/Time */}
      <View style={styles.editSection}>
        <View style={styles.editDateTimeRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.startDate')}</Text>
            <TextInput
              style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textTertiary}
              value={startDate}
              onChangeText={setStartDate}
            />
          </View>
          {!allDay && (
            <View style={{ flex: 1 }}>
              <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.startTime')}</Text>
              <TextInput
                style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="HH:MM"
                placeholderTextColor={colors.textTertiary}
                value={startTime}
                onChangeText={setStartTime}
              />
            </View>
          )}
        </View>
      </View>

      {/* End Date/Time */}
      <View style={styles.editSection}>
        <View style={styles.editDateTimeRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.endDate')}</Text>
            <TextInput
              style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textTertiary}
              value={endDate}
              onChangeText={setEndDate}
            />
          </View>
          {!allDay && (
            <View style={{ flex: 1 }}>
              <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.endTime')}</Text>
              <TextInput
                style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="HH:MM"
                placeholderTextColor={colors.textTertiary}
                value={endTime}
                onChangeText={setEndTime}
              />
            </View>
          )}
        </View>
      </View>

      {/* Description */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.descriptionField')}</Text>
        <TextInput
          style={[styles.editInput, styles.editInputMultiline, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
          value={description}
          onChangeText={setDescription}
          placeholder={t('eventDetail.descriptionPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          multiline
          numberOfLines={4}
        />
      </View>

      {/* Location */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.locationField')}</Text>
        <TextInput
          style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
          value={location}
          onChangeText={setLocation}
          placeholder={t('eventDetail.locationPlaceholder')}
          placeholderTextColor={colors.textTertiary}
        />
      </View>

      {/* Reminder */}
      <View style={styles.editSection}>
        <View style={styles.editLabelRow}>
          <IconBell size={16} color={colors.textSecondary} />
          <Text style={[styles.editLabel, { color: colors.textSecondary, marginBottom: 0, marginLeft: 6 }]}>{t('eventDetail.reminderLabel')}</Text>
        </View>
        <View style={styles.editChipsRow}>
          {REMINDER_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.editChip, {
                borderColor: colors.border,
                backgroundColor: reminder === opt.value ? colors.primary : colors.surface,
              }]}
              onPress={() => setReminder(opt.value)}
            >
              <Text style={[styles.editChipText, { color: reminder === opt.value ? '#fff' : colors.text }]}>
                {t(`eventDetail.reminder_${opt.value}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Recurrence */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.recurrenceLabel')}</Text>
        <View style={styles.editChipsRow}>
          {[
            { label: t('eventDetail.recurrenceNone'), value: '' },
            { label: t('eventDetail.recurrenceDaily'), value: 'FREQ=DAILY' },
            { label: t('eventDetail.recurrenceWeekly'), value: 'FREQ=WEEKLY' },
            { label: t('eventDetail.recurrenceMonthly'), value: 'FREQ=MONTHLY' },
          ].map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.editChip, {
                borderColor: colors.border,
                backgroundColor: recurrence === opt.value ? colors.primary : colors.surface,
              }]}
              onPress={() => setRecurrence(opt.value)}
            >
              <Text style={[styles.editChipText, { color: recurrence === opt.value ? '#fff' : colors.text }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Color */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.colorLabel')}</Text>
        <View style={styles.editColorRow}>
          {PRESET_COLORS.map(c => (
            <TouchableOpacity
              key={c}
              style={[styles.editColorCircle, { backgroundColor: c, borderColor: selectedColor === c ? colors.text : 'transparent' }]}
              onPress={() => setSelectedColor(c)}
            >
              {selectedColor === c && <IconCheck size={14} color="#fff" />}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Attendees */}
      <View style={styles.editSection}>
        <Text style={[styles.editLabel, { color: colors.textSecondary }]}>{t('eventDetail.attendeesLabel')}</Text>
        <TextInput
          style={[styles.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
          value={attendeesText}
          onChangeText={setAttendeesText}
          placeholder={t('eventDetail.attendeesPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </View>

      {/* Save / Cancel buttons */}
      <View style={styles.editActions}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={saving}
          style={[styles.editSaveBtn, { backgroundColor: colors.primary }]}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : saveSuccess ? (
            <>
              <IconCheck size={18} color="#fff" />
              <Text style={styles.editSaveBtnText}>{t('eventDetail.saved')}</Text>
            </>
          ) : (
            <>
              <IconCheck size={18} color="#fff" />
              <Text style={styles.editSaveBtnText}>{t('eventDetail.saveChanges')}</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.editCancelBtn, { borderColor: colors.border }]}
        >
          <Text style={[styles.editCancelBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
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
  // expo-router pode retornar params como string[] em deep links com vários
  // valores — extrai sempre o primeiro pra evitar passar array pra API.
  const eventId = Array.isArray(params.id) ? params.id[0] : params.id;

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadEvent = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const r = await api.calEvent(eventId);
      if (r.success) {
        setEvent(r.data?.event || null);
      } else {
        safeAlert(t('common.error'), r.message || t('eventDetail.loadError'));
      }
    } catch {
      safeAlert(t('common.error'), t('eventDetail.loadError'));
    } finally {
      setLoading(false);
    }
  }, [eventId, t]);

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
        safeAlert(t('common.error'), r.message || t('eventDetail.rsvpError'));
      }
    } catch {
      safeAlert(t('common.error'), t('eventDetail.networkError'));
    } finally {
      setRsvpLoading(false);
    }
  };

  // Delete from Chatyy backend only
  const deleteFromChatyy = async () => {
    setDeleting(true);
    try {
      const r = await api.calDeleteEvent(eventId);
      if (r.success) {
        router.back();
      } else {
        safeAlert(t('common.error'), r.message || t('eventDetail.deleteError'));
      }
    } catch {
      safeAlert(t('common.error'), t('eventDetail.networkError'));
    } finally {
      setDeleting(false);
    }
  };

  // Delete from both Chatyy and device calendar
  const deleteFromBoth = async () => {
    setDeleting(true);
    try {
      if (ExpoCalendar && Platform.OS !== 'web' && event) {
        try {
          const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
          if (status === 'granted') {
            const deviceCalendars = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
            if (deviceCalendars.length > 0) {
              const calendarIds = deviceCalendars.map(c => c.id);
              const startDate = new Date(event.start_at);
              const endDate = new Date(event.end_at);
              const searchStart = new Date(startDate.getTime() - 60000);
              const searchEnd = new Date(endDate.getTime() + 60000);
              const deviceEvents = await ExpoCalendar.getEventsAsync(calendarIds, searchStart, searchEnd);
              const matching = deviceEvents.find(de => {
                const titleMatch = (de.title || '').toLowerCase() === (event.title || '').toLowerCase();
                const startMatch = Math.abs(new Date(de.startDate).getTime() - startDate.getTime()) < 120000;
                return titleMatch && startMatch;
              });
              if (matching) {
                await ExpoCalendar.deleteEventAsync(matching.id);
              }
            }
          }
        } catch (e) {
          console.warn('Failed to delete from device calendar:', e?.message);
        }
      }
      await deleteFromChatyy();
    } catch {
      safeAlert(t('common.error'), t('eventDetail.networkError'));
      setDeleting(false);
    }
  };

  const handleDelete = () => {
    const isSyncedEvent = event?.calendar_name || event?.source === 'device' || (event?.color === '#0097A7');
    const canDeleteFromDevice = ExpoCalendar && Platform.OS !== 'web';

    if (isSyncedEvent && canDeleteFromDevice) {
      safeAlert(
        t('eventDetail.deleteEvent'),
        t('eventDetail.deleteFromWhere'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('eventDetail.deleteChatyyOnly'),
            onPress: deleteFromChatyy,
          },
          {
            text: t('eventDetail.deleteBoth'),
            style: 'destructive',
            onPress: deleteFromBoth,
          },
        ]
      );
    } else {
      safeAlert(
        t('eventDetail.deleteEvent'),
        t('eventDetail.deleteConfirm'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('eventDetail.deleteButton'), style: 'destructive',
            onPress: deleteFromChatyy,
          },
        ]
      );
    }
  };

  const handleUpdateEvent = async (data) => {
    const r = await api.calUpdateEvent(eventId, data);
    if (r.success) {
      setEditMode(false);
      // If this is a synced device-calendar event, also push the changes back to the OS calendar
      const wasSynced = !!(event?.calendar_name || event?.source === 'device');
      const deviceEventId = event?.device_event_id || event?.external_id;
      if (wasSynced && deviceEventId && Platform.OS !== 'web') {
        try {
          const ExpoCal = require('expo-calendar');
          const perm = await ExpoCal.requestCalendarPermissionsAsync();
          if (perm.status === 'granted') {
            const updates = {};
            if (data.title != null) updates.title = data.title;
            if (data.location != null) updates.location = data.location;
            if (data.notes != null || data.description != null) updates.notes = data.notes ?? data.description;
            // Editor saves as start_at/end_at (singular) — the previous
            // version checked starts_at/ends_at which never matched, so
            // device-calendar reminders kept firing at the OLD time after
            // every edit. Accept both for forward compat.
            const _startSrc = data.start_at || data.starts_at;
            const _endSrc = data.end_at || data.ends_at;
            if (_startSrc) updates.startDate = new Date(_startSrc);
            if (_endSrc) updates.endDate = new Date(_endSrc);
            if (data.all_day != null) updates.allDay = !!data.all_day;
            await ExpoCal.updateEventAsync(String(deviceEventId), updates);
          }
        } catch (e) {
          console.warn('[event-detail] device calendar update failed:', e?.message);
          // Non-fatal — server already has the new state.
        }
      }
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
          safeAlert(t('eventDetail.exportLabel'), t('eventDetail.exportWebOnly'));
        }
      }
    } catch {
      safeAlert(t('common.error'), t('eventDetail.exportError'));
    }
  };

  if (loading && !event) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('eventDetail.title')}</Text>
          <View style={styles.headerBtn} />
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
  const isSyncedEvent = event?.calendar_name || event?.source === 'device';
  const hasReminder = event?.reminder && event.reminder !== 'none';

  // Get human-readable reminder label
  const reminderLabel = hasReminder ? t(`eventDetail.reminder_${event.reminder}`) : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => { if (editMode) setEditMode(false); else router.back(); }} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {editMode ? t('eventDetail.editEvent') : t('eventDetail.title')}
        </Text>
        <View style={styles.headerRight}>
          {!editMode && isCreator && (
            <TouchableOpacity onPress={() => setEditMode(true)} style={styles.headerBtn}>
              <IconEdit size={20} color={colors.primary} />
            </TouchableOpacity>
          )}
          {!editMode && !isCreator && isSyncedEvent && (
            <TouchableOpacity
              onPress={async () => {
                if (Platform.OS === 'web') {
                  safeAlert(
                    t('eventDetail.syncedEventTitle') || 'Evento sincronizado',
                    'Este evento veio do calendário do seu celular. Edite no app Calendário do iPhone/Android.'
                  );
                  return;
                }
                // Native: open the device's native event editor via expo-calendar
                try {
                  const ExpoCal = require('expo-calendar');
                  const perm = await ExpoCal.requestCalendarPermissionsAsync();
                  if (perm.status !== 'granted') {
                    safeAlert(t('common.error') || 'Erro', 'Permita acesso ao Calendário em Ajustes do app');
                    return;
                  }
                  // Try to open the system event dialog with the existing event's ID
                  const deviceEventId = event.device_event_id || event.external_id || event.id;
                  if (typeof ExpoCal.editEventInCalendarAsync === 'function') {
                    await ExpoCal.editEventInCalendarAsync({ id: String(deviceEventId) });
                    loadEvent();
                    return;
                  }
                  if (typeof ExpoCal.openEventInCalendarAsync === 'function') {
                    await ExpoCal.openEventInCalendarAsync(String(deviceEventId));
                    return;
                  }
                  // Fallback: deep link to native calendar app
                  Linking.openURL(Platform.OS === 'ios' ? 'calshow:' : 'content://com.android.calendar/time/');
                } catch (e) {
                  console.warn('[event-detail] open native edit:', e?.message);
                  try {
                    Linking.openURL(Platform.OS === 'ios' ? 'calshow:' : 'content://com.android.calendar/time/');
                  } catch {}
                }
              }}
              style={styles.headerBtn}
            >
              <IconEdit size={20} color={colors.primary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {editMode ? (
        <EditEventView
          event={event}
          onSave={handleUpdateEvent}
          onCancel={() => setEditMode(false)}
          colors={colors}
          t={t}
        />
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.xl }}>
          {/* Color bar + Sync badge row */}
          <View style={[styles.colorBarRow, { backgroundColor: eventColor }]}>
            <View style={{ flex: 1 }} />
            {isSyncedEvent && (
              <View style={styles.syncBadge}>
                <IconSmartphone size={12} color="#fff" />
                <Text style={styles.syncBadgeText}>{t('eventDetail.synced')}</Text>
              </View>
            )}
          </View>

          {/* Title + Calendar name */}
          <View style={styles.section}>
            <Text style={[styles.eventTitle, { color: colors.text }]}>{event.title || t('eventDetail.untitled')}</Text>
            {!!event.calendar_name && (
              <View style={[styles.calNameBadge, { backgroundColor: (event.calendar_color || eventColor) + '18' }]}>
                <View style={[styles.calNameDot, { backgroundColor: event.calendar_color || eventColor }]} />
                <Text style={[styles.calNameText, { color: event.calendar_color || eventColor }]}>{event.calendar_name}</Text>
              </View>
            )}
            {event.status === 'cancelled' && (
              <View style={[styles.statusBadge, { backgroundColor: colors.error + '20' }]}>
                <Text style={[styles.statusBadgeText, { color: colors.error }]}>{t('eventDetail.cancelled')}</Text>
              </View>
            )}
          </View>

          {/* Prominent EDIT button for creator */}
          {isCreator && (
            <View style={styles.editBtnWrap}>
              <TouchableOpacity
                onPress={() => setEditMode(true)}
                style={[styles.prominentEditBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.7}
              >
                <IconEdit size={18} color="#fff" />
                <Text style={styles.prominentEditBtnText}>{t('eventDetail.editEvent')}</Text>
              </TouchableOpacity>
            </View>
          )}

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
              {/* Dual-zone display: when the event carries `display_timezones`
                  ({ tz: 'America/New_York', label: 'NY' }, ...) we render each
                  zone's local time on its own line. Used for international
                  meetings ("10:00 (Brasil) / 14:00 (UTC) / 09:00 (NY)"). */}
              {(() => {
                let zones = event.display_timezones;
                if (typeof zones === 'string') {
                  try { zones = JSON.parse(zones); } catch { zones = null; }
                }
                if (!Array.isArray(zones) || !zones.length || event.all_day) return null;
                return (
                  <View style={{ marginTop: 4 }}>
                    {zones.slice(0, 3).map((z, i) => {
                      try {
                        const tz = z.tz || z.timeZone;
                        if (!tz) return null;
                        const fmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
                        const start = fmt.format(new Date(event.start_at));
                        const label = z.label || tz.split('/').pop().replace('_', ' ');
                        return (
                          <Text key={'tz-' + i} style={[styles.infoValueSub, { color: colors.textSecondary, fontSize: 12 }]}>
                            {`${start} (${label})`}
                          </Text>
                        );
                      } catch { return null; }
                    })}
                  </View>
                );
              })()}
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

          {/* Reminder */}
          {hasReminder && (
            <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
              <View style={[styles.infoIcon, { backgroundColor: eventColor + '18' }]}>
                <IconBell size={18} color={eventColor} />
              </View>
              <View style={styles.infoContent}>
                <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{t('eventDetail.reminderLabel')}</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>{reminderLabel}</Text>
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
                  <RsvpStatusBadge status={att.rsvp || att.status} colors={colors} t={t} />
                </View>
              ))}
            </View>
          )}

          {/* RSVP Buttons -- for attendees */}
          {isAttendee && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('eventDetail.yourResponse')}</Text>
              {myRsvp && (
                <View style={{ marginBottom: Spacing.sm }}>
                  <RsvpStatusBadge status={myRsvp.rsvp || myRsvp.status} colors={colors} t={t} />
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

          {/* DELETE button -- prominent red, at bottom */}
          {isCreator && (
            <View style={[styles.section, { paddingTop: Spacing.md }]}>
              <TouchableOpacity
                onPress={handleDelete}
                disabled={deleting}
                style={[styles.deleteBtn, { backgroundColor: colors.error + '10', borderColor: colors.error }]}
                activeOpacity={0.7}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={colors.error} />
                ) : (
                  <>
                    <IconTrash size={18} color={colors.error} />
                    <Text style={[styles.deleteBtnText, { color: colors.error }]}>{t('eventDetail.deleteEvent')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
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

  // Color bar row with sync badge
  colorBarRow: {
    height: 6, width: '100%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
    paddingRight: Spacing.sm,
  },
  syncBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 10, position: 'absolute', right: Spacing.md, top: -14,
  },
  syncBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Calendar name badge
  calNameBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 12, marginTop: 6,
  },
  calNameDot: { width: 8, height: 8, borderRadius: 4 },
  calNameText: { fontSize: FontSize.sm, fontWeight: '600' },

  section: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', marginBottom: Spacing.xs },

  eventTitle: { fontSize: FontSize.xl + 4, fontWeight: '800', marginBottom: Spacing.xs, lineHeight: 30 },
  statusBadge: {
    alignSelf: 'flex-start', paddingHorizontal: Spacing.sm, paddingVertical: 3,
    borderRadius: BorderRadius.full || 99, marginTop: 6,
  },
  statusBadgeText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Prominent edit button
  editBtnWrap: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm },
  prominentEditBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: BorderRadius.lg,
    ...Shadow.sm,
  },
  prominentEditBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },

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

  // Delete button
  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: BorderRadius.lg, borderWidth: 1.5,
  },
  deleteBtnText: { fontSize: FontSize.md, fontWeight: '700' },

  // Sync warning
  syncWarning: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  syncWarningText: { flex: 1, fontSize: FontSize.sm, lineHeight: 18 },

  // Edit mode styles
  editSection: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  editLabel: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.xs, marginTop: Spacing.xs },
  editLabelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs, marginTop: Spacing.xs },
  editInput: {
    borderWidth: 1, borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
  },
  editInputLarge: { fontSize: FontSize.lg, fontWeight: '600', paddingVertical: Spacing.md },
  editInputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  editSwitchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginBottom: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editSwitchLabel: { fontSize: FontSize.md, fontWeight: '500' },
  editDateTimeRow: { flexDirection: 'row', gap: Spacing.sm },
  editChipsRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: Spacing.sm,
  },
  editChip: {
    paddingHorizontal: Spacing.sm, paddingVertical: 7,
    borderRadius: BorderRadius.full || 99, borderWidth: 1,
  },
  editChipText: { fontSize: FontSize.sm, fontWeight: '500' },
  editColorRow: {
    flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.sm, flexWrap: 'wrap',
  },
  editColorCircle: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 2.5, alignItems: 'center', justifyContent: 'center',
  },
  editActions: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.lg, gap: Spacing.sm,
  },
  editSaveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: BorderRadius.lg,
    ...Shadow.sm,
  },
  editSaveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  editCancelBtn: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: BorderRadius.lg, borderWidth: 1,
  },
  editCancelBtnText: { fontSize: FontSize.md, fontWeight: '600' },
});
