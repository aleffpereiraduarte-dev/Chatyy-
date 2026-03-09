import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput,
  ActivityIndicator, RefreshControl, Alert, Modal, ScrollView,
  Switch, Platform, Linking, KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  IconCalendar, IconPlus, IconClock, IconArrowLeft, IconArrowRight,
  IconCheck, IconX, IconEdit, IconTrash, IconMapPin, IconRepeat,
  IconChevronLeft, IconChevronRight, IconUsers, IconSearch, IconSparkles,
  IconUpload, IconDownload, IconSmartphone, IconRefresh,
} from '../components/Icons';

// Try to import expo-calendar (native only)
let ExpoCalendar = null;
try { ExpoCalendar = require('expo-calendar'); } catch {}

// Month/Day names are now provided via t() in components
// These are kept as fallbacks for non-i18n contexts (ICS export filenames)
const MONTH_NAMES_FALLBACK = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const PRESET_COLORS = ['#4285F4', '#EA4335', '#34A853', '#FBBC05', '#8E24AA', '#F4511E', '#0097A7', '#616161'];

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year, month) {
  return new Date(year, month, 1).getDay();
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeRange(startStr, endStr, allDay, t) {
  if (allDay) return t ? t('calendar.allDay') : 'All day';
  return `${formatTime(startStr)} - ${formatTime(endStr)}`;
}

function formatDateForAPI(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00`;
}

function formatDateTimeForAPI(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:00`;
}

function generateICS(event) {
  const start = (event.start_at || event.start || '').replace(/[-:]/g, '').replace(/\.\d+/, '').replace('T', 'T');
  const end = (event.end_at || event.end || '').replace(/[-:]/g, '').replace(/\.\d+/, '').replace('T', 'T');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OneMundo Mail//Calendar//EN',
    'BEGIN:VEVENT',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${(event.title || '').replace(/[,;\\]/g, ' ')}`,
    event.location ? `LOCATION:${event.location.replace(/[,;\\]/g, ' ')}` : '',
    event.description ? `DESCRIPTION:${event.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, ' ')}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return lines;
}

async function downloadICS(event, t) {
  const ics = generateICS(event);
  if (Platform.OS === 'web') {
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(event.title || 'event').replace(/\s+/g, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    try {
      const fileName = `${(event.title || 'event').replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
      const filePath = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(filePath, ics, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics' });
      } else {
        Alert.alert(t ? t('common.error') : 'Error', t ? t('calendar.sharingUnavailable') : 'Sharing not available on this device');
      }
    } catch {
      Alert.alert(t ? t('common.error') : 'Error', t ? t('calendar.exportEventFailed') : 'Failed to export event');
    }
  }
}

// ============================================================
// ICS Parser — parse .ics file content into event objects
// ============================================================
function parseICSDate(val) {
  if (!val) return null;
  // Handle formats: 20260305T090000, 20260305T090000Z, 20260305
  const clean = val.replace(/[^0-9T]/g, '');
  if (clean.length >= 8) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    if (clean.length >= 15) {
      const h = clean.substring(9, 11);
      const min = clean.substring(11, 13);
      return `${y}-${m}-${d}T${h}:${min}:00`;
    }
    return `${y}-${m}-${d}T00:00:00`;
  }
  return null;
}

function unfoldICS(text) {
  // ICS spec: lines folded by CRLF + whitespace are continuation lines
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseICSEvents(icsContent) {
  const unfolded = unfoldICS(icsContent);
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let currentEvent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (trimmed === 'END:VEVENT' && currentEvent) {
      // Only add if it has at minimum a start date
      if (currentEvent.start_at) {
        events.push({
          title: currentEvent.title || 'Imported Event',
          description: (currentEvent.description || '').replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\'),
          location: (currentEvent.location || '').replace(/\\,/g, ',').replace(/\\\\/g, '\\'),
          start_at: currentEvent.start_at,
          end_at: currentEvent.end_at || currentEvent.start_at,
          all_day: currentEvent.all_day || false,
          color: '#0097A7', // imported events color
          recurrence_rule: currentEvent.rrule || '',
        });
      }
      currentEvent = null;
    } else if (currentEvent) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.substring(0, colonIdx);
      const value = trimmed.substring(colonIdx + 1);
      const baseProp = key.split(';')[0].toUpperCase();
      const params = key.toUpperCase();

      switch (baseProp) {
        case 'SUMMARY':
          currentEvent.title = value.replace(/\\,/g, ',').replace(/\\\\/g, '\\');
          break;
        case 'DESCRIPTION':
          currentEvent.description = value;
          break;
        case 'LOCATION':
          currentEvent.location = value;
          break;
        case 'DTSTART':
          currentEvent.start_at = parseICSDate(value);
          if (params.includes('VALUE=DATE') && !params.includes('VALUE=DATE-TIME')) {
            currentEvent.all_day = true;
          }
          break;
        case 'DTEND':
          currentEvent.end_at = parseICSDate(value);
          break;
        case 'RRULE':
          currentEvent.rrule = value;
          break;
      }
    }
  }
  return events;
}

// ============================================================
// Calendar Grid Component
// ============================================================
function CalendarGrid({ year, month, selectedDate, events, colors, onSelectDate, onPrevMonth, onNextMonth, t }) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const today = new Date();

  // Previous month days to show
  const prevMonthDays = getDaysInMonth(year, month - 1);
  const rows = [];
  let dayCounter = 1;
  let nextDayCounter = 1;

  // Build 6 rows max
  for (let row = 0; row < 6; row++) {
    const cells = [];
    for (let col = 0; col < 7; col++) {
      const idx = row * 7 + col;
      if (idx < firstDay) {
        // Previous month
        const day = prevMonthDays - firstDay + idx + 1;
        cells.push({ day, type: 'prev', date: new Date(year, month - 1, day) });
      } else if (dayCounter <= daysInMonth) {
        const date = new Date(year, month, dayCounter);
        cells.push({ day: dayCounter, type: 'current', date });
        dayCounter++;
      } else {
        cells.push({ day: nextDayCounter, type: 'next', date: new Date(year, month + 1, nextDayCounter) });
        nextDayCounter++;
      }
    }
    rows.push(cells);
    if (dayCounter > daysInMonth && row >= 4) break;
  }

  // Build a map of dates with events
  const eventDots = useMemo(() => {
    const map = {};
    (events || []).forEach(evt => {
      const d = new Date(evt.start_at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[key]) map[key] = [];
      if (map[key].length < 3) {
        map[key].push(evt.color || evt.calendar_color || colors.primary);
      }
    });
    return map;
  }, [events, colors.primary]);

  return (
    <View style={styles.calendarGrid}>
      {/* Month header */}
      <View style={styles.monthHeader}>
        <TouchableOpacity onPress={onPrevMonth} style={styles.monthArrow}>
          <IconChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.monthTitle, { color: colors.text }]}>
          {t('calendar.months')[month]} {year}
        </Text>
        <TouchableOpacity onPress={onNextMonth} style={styles.monthArrow}>
          <IconChevronRight size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Day headers */}
      <View style={styles.dayHeaders}>
        {t('calendar.dayNames').map(d => (
          <View key={d} style={styles.dayHeaderCell}>
            <Text style={[styles.dayHeaderText, { color: colors.textTertiary }]}>{d}</Text>
          </View>
        ))}
      </View>

      {/* Calendar rows */}
      {rows.map((row, ri) => (
        <View key={ri} style={styles.calendarRow}>
          {row.map((cell, ci) => {
            const isToday = cell.type === 'current' && isSameDay(cell.date, today);
            const isSelected = selectedDate && isSameDay(cell.date, selectedDate);
            const isOtherMonth = cell.type !== 'current';
            const dateKey = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
            const dots = eventDots[dateKey] || [];

            return (
              <TouchableOpacity
                key={ci}
                style={[
                  styles.calendarCell,
                  isSelected && { backgroundColor: colors.primary + '18' },
                ]}
                onPress={() => onSelectDate(cell.date)}
                activeOpacity={0.7}
              >
                <View style={[
                  styles.dayCellInner,
                  isToday && { backgroundColor: colors.primary },
                ]}>
                  <Text style={[
                    styles.dayCellText,
                    { color: isToday ? '#fff' : isOtherMonth ? colors.textTertiary : colors.text },
                    isSelected && !isToday && { color: colors.primary, fontWeight: '700' },
                  ]}>
                    {cell.day}
                  </Text>
                </View>
                {dots.length > 0 && (
                  <View style={styles.dotRow}>
                    {dots.map((dotColor, di) => (
                      <View key={di} style={[styles.eventDot, { backgroundColor: dotColor }]} />
                    ))}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ============================================================
// Event Card
// ============================================================
function EventCard({ event, colors, onPress, t }) {
  const borderColor = event.color || event.calendar_color || colors.primary;
  return (
    <TouchableOpacity
      style={[styles.eventCard, { backgroundColor: colors.surface, borderColor: colors.border, borderLeftColor: borderColor, borderLeftWidth: 4 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.eventCardBody}>
        <Text style={[styles.eventTitle, { color: colors.text }]} numberOfLines={1}>
          {event.title || (t ? t('calendar.untitledEvent') : 'Untitled event')}
        </Text>
        <View style={styles.eventMeta}>
          <IconClock size={13} color={colors.textSecondary} />
          <Text style={[styles.eventMetaText, { color: colors.textSecondary }]}>
            {formatTimeRange(event.start_at, event.end_at, event.all_day, t)}
          </Text>
        </View>
        {!!event.location && (
          <View style={styles.eventMeta}>
            <IconMapPin size={13} color={colors.textSecondary} />
            <Text style={[styles.eventMetaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {event.location}
            </Text>
          </View>
        )}
        {!!event.recurrence_rule && (
          <View style={styles.eventMeta}>
            <IconRepeat size={13} color={colors.textSecondary} />
            <Text style={[styles.eventMetaText, { color: colors.textSecondary }]}>{t ? t('calendar.recurring') : 'Recurring'}</Text>
          </View>
        )}
      </View>
      {!!event.calendar_name && (
        <View style={[styles.calBadge, { backgroundColor: (event.calendar_color || colors.primary) + '18' }]}>
          <Text style={[styles.calBadgeText, { color: event.calendar_color || colors.primary }]} numberOfLines={1}>
            {event.calendar_name}
          </Text>
        </View>
      )}
      <TouchableOpacity onPress={() => downloadICS(event, t)} style={styles.exportBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <IconCalendar size={16} color={colors.textTertiary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ============================================================
// Add Event Modal
// ============================================================
function AddEventModal({ visible, onClose, onSave, colors, calendars, selectedDate, t }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('10:00');
  const [selectedColor, setSelectedColor] = useState('#4285F4');
  const [calendarId, setCalendarId] = useState(0);
  const [attendeesText, setAttendeesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [recurrence, setRecurrence] = useState('');

  useEffect(() => {
    if (visible && selectedDate) {
      const y = selectedDate.getFullYear();
      const m = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const d = String(selectedDate.getDate()).padStart(2, '0');
      const ds = `${y}-${m}-${d}`;
      setStartDate(ds);
      setEndDate(ds);
    }
    if (visible) {
      setTitle('');
      setDescription('');
      setLocation('');
      setAllDay(false);
      setStartTime('09:00');
      setEndTime('10:00');
      setSelectedColor('#4285F4');
      setCalendarId(calendars?.[0]?.id || 0);
      setAttendeesText('');
      setSaving(false);
      setRecurrence('');
    }
  }, [visible, selectedDate, calendars]);

  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert(t('common.error'), t('calendar.errorTitle'));
      return;
    }
    if (!startDate || !endDate) {
      Alert.alert(t('common.error'), t('calendar.errorDates'));
      return;
    }
    setSaving(true);
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
        calendar_id: calendarId,
        attendees,
        recurrence_rule: recurrence,
      });
      onClose();
    } catch {
      Alert.alert(t('common.error'), t('calendar.createEventFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
        <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={onClose} style={styles.modalHeaderBtn}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{t('calendar.newEvent')}</Text>
            <TouchableOpacity onPress={handleSave} style={styles.modalHeaderBtn} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <IconCheck size={22} color={colors.primary} />
              )}
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            {/* Title */}
            <TextInput
              style={[styles.input, styles.inputLarge, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder={t('calendar.eventTitlePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={title}
              onChangeText={setTitle}
              autoFocus
            />

            {/* All Day Toggle */}
            <View style={[styles.switchRow, { borderColor: colors.border }]}>
              <Text style={[styles.switchLabel, { color: colors.text }]}>{t('calendar.allDay')}</Text>
              <Switch
                value={allDay}
                onValueChange={setAllDay}
                trackColor={{ true: colors.primary, false: colors.border }}
                thumbColor="#fff"
              />
            </View>

            {/* Start Date/Time */}
            <View style={styles.dateTimeRow}>
              <View style={styles.dateTimeCol}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.startDate')}</Text>
                <TextInput
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder={t('calendar.dateFormat')}
                  placeholderTextColor={colors.textTertiary}
                  value={startDate}
                  onChangeText={setStartDate}
                />
              </View>
              {!allDay && (
                <View style={styles.dateTimeCol}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.startTime')}</Text>
                  <TextInput
                    style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                    placeholder={t('calendar.timeFormat')}
                    placeholderTextColor={colors.textTertiary}
                    value={startTime}
                    onChangeText={setStartTime}
                  />
                </View>
              )}
            </View>

            {/* End Date/Time */}
            <View style={styles.dateTimeRow}>
              <View style={styles.dateTimeCol}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.endDate')}</Text>
                <TextInput
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder={t('calendar.dateFormat')}
                  placeholderTextColor={colors.textTertiary}
                  value={endDate}
                  onChangeText={setEndDate}
                />
              </View>
              {!allDay && (
                <View style={styles.dateTimeCol}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.endTime')}</Text>
                  <TextInput
                    style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                    placeholder={t('calendar.timeFormat')}
                    placeholderTextColor={colors.textTertiary}
                    value={endTime}
                    onChangeText={setEndTime}
                  />
                </View>
              )}
            </View>

            {/* Description */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.description')}</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder={t('calendar.addDescription')}
              placeholderTextColor={colors.textTertiary}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={3}
            />

            {/* Location */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.location')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder={t('calendar.addLocation')}
              placeholderTextColor={colors.textTertiary}
              value={location}
              onChangeText={setLocation}
            />

            {/* Recurrence */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.repeat')}</Text>
            <View style={styles.recurrenceRow}>
              {[
                { label: t('calendar.recurrenceNone'), value: '' },
                { label: t('calendar.recurrenceDaily'), value: 'FREQ=DAILY' },
                { label: t('calendar.recurrenceWeekly'), value: 'FREQ=WEEKLY' },
                { label: t('calendar.recurrenceMonthly'), value: 'FREQ=MONTHLY' },
              ].map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[
                    styles.recurrenceChip,
                    { borderColor: colors.border, backgroundColor: recurrence === opt.value ? colors.primary : colors.surface },
                  ]}
                  onPress={() => setRecurrence(opt.value)}
                >
                  <Text style={[styles.recurrenceChipText, { color: recurrence === opt.value ? '#fff' : colors.text }]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Color picker */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.color')}</Text>
            <View style={styles.colorRow}>
              {PRESET_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  style={[styles.colorCircle, { backgroundColor: c, borderColor: selectedColor === c ? colors.text : 'transparent' }]}
                  onPress={() => setSelectedColor(c)}
                >
                  {selectedColor === c && <IconCheck size={14} color="#fff" />}
                </TouchableOpacity>
              ))}
            </View>

            {/* Calendar selector */}
            {calendars && calendars.length > 1 && (
              <>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.calendarLabel')}</Text>
                <View style={styles.calSelectorRow}>
                  {calendars.map(cal => (
                    <TouchableOpacity
                      key={cal.id}
                      style={[
                        styles.calSelectorChip,
                        { borderColor: calendarId === cal.id ? cal.color : colors.border,
                          backgroundColor: calendarId === cal.id ? cal.color + '18' : colors.surface },
                      ]}
                      onPress={() => setCalendarId(cal.id)}
                    >
                      <View style={[styles.calDotSmall, { backgroundColor: cal.color }]} />
                      <Text style={[styles.calSelectorText, { color: calendarId === cal.id ? cal.color : colors.text }]} numberOfLines={1}>
                        {cal.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            {/* Attendees */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.attendeesLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholder={t('calendar.attendeesPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={attendeesText}
              onChangeText={setAttendeesText}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </ScrollView>
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================
// Error Boundary
// ============================================================
class CalendarErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Calendar Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// Main Calendar Screen
// ============================================================
export default function CalendarScreenWrapper() {
  return (
    <CalendarErrorBoundary>
      <CalendarScreenInner />
    </CalendarErrorBoundary>
  );
}

function CalendarScreenInner() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState(today);
  const [events, setEvents] = useState([]);
  const [calendars, setCalendars] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [aiReminders, setAiReminders] = useState([]);
  const [loadingReminders, setLoadingReminders] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { total, success, failed }
  const [syncingDevice, setSyncingDevice] = useState(false);
  const [deviceCalPermission, setDeviceCalPermission] = useState(null);

  // Load calendars on mount
  useEffect(() => {
    loadCalendars();
  }, []);

  // Load events when month changes
  useEffect(() => {
    loadEvents(true);
  }, [currentYear, currentMonth]);

  const loadCalendars = async () => {
    try {
      const r = await api.calCalendars();
      if (r.success) {
        setCalendars(r.data?.calendars || []);
      }
    } catch {}
  };

  const loadEvents = useCallback(async (showLoader) => {
    if (showLoader) setLoading(true);
    try {
      // Load a wider range: previous month through next month
      const start = new Date(currentYear, currentMonth - 1, 1);
      const end = new Date(currentYear, currentMonth + 2, 0);
      const r = await api.calEvents(formatDateForAPI(start), formatDateForAPI(end));
      if (r.success) {
        setEvents(r.data?.events || []);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentYear, currentMonth]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadEvents(false);
    loadCalendars();
  }, [loadEvents]);

  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(y => y - 1);
    } else {
      setCurrentMonth(m => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(y => y + 1);
    } else {
      setCurrentMonth(m => m + 1);
    }
  };

  const handleToday = () => {
    const t = new Date();
    setCurrentYear(t.getFullYear());
    setCurrentMonth(t.getMonth());
    setSelectedDate(t);
  };

  const handleSelectDate = (date) => {
    setSelectedDate(date);
    // If date is in a different month, navigate to it
    if (date.getMonth() !== currentMonth || date.getFullYear() !== currentYear) {
      setCurrentMonth(date.getMonth());
      setCurrentYear(date.getFullYear());
    }
  };

  const handleCreateEvent = async (data) => {
    const r = await api.calCreateEvent(data);
    if (r.success) {
      loadEvents(false);
      loadCalendars();
    } else {
      throw new Error(r.message || t('calendar.createEventFailed'));
    }
  };

  const handleEventPress = (event) => {
    router.push(`/event-detail?id=${event.id}`);
  };

  // Import .ics file from device
  const handleImportICS = async () => {
    try {
      setImporting(true);
      setImportResult(null);
      let icsContent = '';

      if (Platform.OS === 'web') {
        // Web: use file input
        icsContent = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.ics,.ical,.ifb,text/calendar';
          input.onchange = (e) => {
            const file = e.target.files?.[0];
            if (!file) { reject(new Error('No file selected')); return; }
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
          };
          input.oncancel = () => reject(new Error('cancelled'));
          input.click();
        });
      } else {
        // Mobile: use document picker + FileSystem
        const result = await DocumentPicker.getDocumentAsync({
          type: ['text/calendar', 'application/ics', '*/*'],
          copyToCacheDirectory: true,
        });
        if (result.canceled || !result.assets?.[0]) {
          setImporting(false);
          return;
        }
        const asset = result.assets[0];
        try {
          icsContent = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
        } catch {
          // Fallback to fetch if FileSystem fails
          const response = await fetch(asset.uri);
          icsContent = await response.text();
        }
      }

      if (!icsContent || !icsContent.includes('VCALENDAR')) {
        Alert.alert(t('calendar.invalidFile'), t('calendar.invalidFileDesc'));
        setImporting(false);
        return;
      }

      const parsedEvents = parseICSEvents(icsContent);
      if (parsedEvents.length === 0) {
        Alert.alert(t('calendar.noEvents'), t('calendar.noEventsInFile'));
        setImporting(false);
        return;
      }

      // Confirm import
      Alert.alert(
        t('calendar.importCalendar'),
        t('calendar.importConfirm', { count: parsedEvents.length }),
        [
          { text: t('common.cancel'), style: 'cancel', onPress: () => setImporting(false) },
          {
            text: t('calendar.importAll'),
            onPress: async () => {
              let success = 0;
              let failed = 0;
              for (const evt of parsedEvents) {
                try {
                  const r = await api.calCreateEvent({
                    title: evt.title,
                    description: evt.description,
                    location: evt.location,
                    start_at: evt.start_at,
                    end_at: evt.end_at,
                    all_day: evt.all_day,
                    color: evt.color,
                    recurrence_rule: evt.recurrence_rule,
                    calendar_id: calendars?.[0]?.id || 0,
                  });
                  if (r.success) success++;
                  else failed++;
                } catch {
                  failed++;
                }
              }
              setImportResult({ total: parsedEvents.length, success, failed });
              setImporting(false);
              loadEvents(false);
              // Auto-clear result after 5s
              setTimeout(() => setImportResult(null), 5000);
            },
          },
        ]
      );
    } catch (err) {
      if (err?.message === 'cancelled') {
        setImporting(false);
        return;
      }
      Alert.alert(t('common.error'), t('calendar.importFailed'));
      setImporting(false);
    }
  };

  // Export all visible month events as .ics
  const handleExportMonth = async () => {
    if (events.length === 0) {
      Alert.alert(t('calendar.noEvents'), t('calendar.noEventsToExport'));
      return;
    }
    const icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OneMundo Mail//Calendar//EN',
      'CALSCALE:GREGORIAN',
    ];
    events.forEach(evt => {
      const start = (evt.start_at || '').replace(/[-:]/g, '').replace(/\.\d+/, '');
      const end = (evt.end_at || '').replace(/[-:]/g, '').replace(/\.\d+/, '');
      icsLines.push('BEGIN:VEVENT');
      icsLines.push(`DTSTART:${start}`);
      icsLines.push(`DTEND:${end}`);
      icsLines.push(`SUMMARY:${(evt.title || '').replace(/[,;\\]/g, ' ')}`);
      if (evt.location) icsLines.push(`LOCATION:${evt.location.replace(/[,;\\]/g, ' ')}`);
      if (evt.description) icsLines.push(`DESCRIPTION:${evt.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, ' ')}`);
      if (evt.recurrence_rule) icsLines.push(`RRULE:${evt.recurrence_rule}`);
      icsLines.push('END:VEVENT');
    });
    icsLines.push('END:VCALENDAR');
    const icsStr = icsLines.join('\r\n');

    if (Platform.OS === 'web') {
      const blob = new Blob([icsStr], { type: 'text/calendar' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `calendar_${MONTH_NAMES_FALLBACK[currentMonth]}_${currentYear}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      try {
        const fileName = `calendar_${MONTH_NAMES_FALLBACK[currentMonth]}_${currentYear}.ics`;
        const filePath = `${FileSystem.cacheDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(filePath, icsStr, { encoding: FileSystem.EncodingType.UTF8 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(filePath, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics' });
        }
      } catch {
        Alert.alert(t('common.error'), t('calendar.exportFailed'));
      }
    }
  };

  const handleSubscribeCalendar = () => {
    const token = api.getAuthToken();
    if (!token) {
      Alert.alert(t('common.error'), t('calendar.subscribeError'));
      return;
    }
    const icsUrl = api.calExportICSUrl(token);
    Alert.alert(
      t('calendar.subscribe'),
      t('calendar.subscribeInstructions', { url: icsUrl }),
      [
        { text: t('calendar.copyUrl'), onPress: () => {
          if (Platform.OS === 'web' && navigator?.clipboard) {
            navigator.clipboard.writeText(icsUrl);
            Alert.alert(t('calendar.urlCopied'));
          }
        }},
        { text: t('common.cancel'), style: 'cancel' },
      ]
    );
  };

  const generateSmartReminders = async () => {
    setLoadingReminders(true);
    try {
      const { aiAssist } = await import('../services/api');
      const upcomingEvents = events.filter(e => new Date(e.start_at) >= new Date()).slice(0, 20);
      const eventSummaries = upcomingEvents.map(e => ({
        title: e.title,
        start: e.start_at,
        end: e.end_at,
        location: e.location,
      }));
      const r = await aiAssist('smart_compose', {
        partial_text: `Analyze these calendar events and create 3-5 smart, helpful reminders in ${t('calendar.aiPromptLanguage')}. For each reminder suggest: preparation needed, travel time if location exists, items to bring, etc. Events: ${JSON.stringify(eventSummaries)}`,
        context: 'Calendar reminders assistant',
        tone: 'friendly',
      });
      if (r.success && r.data?.result) {
        const lines = r.data.result.split('\n').filter(l => l.trim());
        setAiReminders(lines);
      }
    } catch {} finally {
      setLoadingReminders(false);
    }
  };

  // Sync with device calendar (iPhone/Android)
  const handleSyncDeviceCalendar = async () => {
    if (!ExpoCalendar || Platform.OS === 'web') {
      Alert.alert(t('calendar.sync'), t('calendar.syncWebOnly'));
      return;
    }
    setSyncingDevice(true);
    try {
      const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
      setDeviceCalPermission(status);
      if (status !== 'granted') {
        Alert.alert(t('calendar.permissionRequired'), t('calendar.permissionDesc'));
        setSyncingDevice(false);
        return;
      }

      const deviceCalendars = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      if (!deviceCalendars || deviceCalendars.length === 0) {
        Alert.alert(t('calendar.noCalendars'), t('calendar.noCalendarsDesc'));
        setSyncingDevice(false);
        return;
      }

      const startDate = new Date(currentYear, currentMonth - 1, 1);
      const endDate = new Date(currentYear, currentMonth + 2, 0);
      const calendarIds = deviceCalendars.map(c => c.id);
      const deviceEvents = await ExpoCalendar.getEventsAsync(calendarIds, startDate, endDate);

      // Auto-sync: import new events without asking
      const existingKeys = new Set(events.map(e => `${(e.title || '').toLowerCase()}|${(e.start_at || '').substring(0, 16)}`));
      const newEvents = (deviceEvents || []).filter(de => {
        const key = `${(de.title || '').toLowerCase()}|${new Date(de.startDate).toISOString().substring(0, 16)}`;
        return !existingKeys.has(key);
      });

      if (newEvents.length === 0) {
        Alert.alert(t('calendar.synced'), t('calendar.allEventsSynced', { count: (deviceEvents || []).length }));
        setSyncingDevice(false);
        return;
      }

      // Auto-import without confirmation dialog
      let success = 0;
      let failed = 0;
      for (const de of newEvents) {
        try {
          const startAt = formatDateTimeForAPI(new Date(de.startDate));
          const endAt = formatDateTimeForAPI(new Date(de.endDate));
          const r = await api.calCreateEvent({
            title: de.title || t('calendar.untitledEvent'),
            description: de.notes || '',
            location: de.location || '',
            start_at: startAt,
            end_at: endAt,
            all_day: de.allDay || false,
            color: '#0097A7',
            calendar_id: calendars?.[0]?.id || 0,
          });
          if (r.success) success++;
          else failed++;
        } catch { failed++; }
      }
      setImportResult({ total: newEvents.length, success, failed });
      setSyncingDevice(false);
      loadEvents(false);
      setTimeout(() => setImportResult(null), 5000);
    } catch (err) {
      Alert.alert(t('common.error'), t('calendar.syncFailed'));
      setSyncingDevice(false);
    }
  };

  // Push our events TO device calendar
  const handlePushToDevice = async () => {
    if (!ExpoCalendar || Platform.OS === 'web') {
      Alert.alert(t('calendar.sync'), t('calendar.syncNativeOnly'));
      return;
    }
    setSyncingDevice(true);
    try {
      const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('calendar.permissionRequired'), t('calendar.permissionSettingsDesc'));
        setSyncingDevice(false);
        return;
      }

      // Find or create OneMundo calendar on device
      const deviceCalendars = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      let targetCalId = null;
      const existing = deviceCalendars.find(c => c.title === 'OneMundo Mail');
      if (existing) {
        targetCalId = existing.id;
      } else {
        // Create calendar - need a default source
        let defaultSource;
        if (Platform.OS === 'ios') {
          defaultSource = deviceCalendars.find(c => c.source?.name === 'iCloud')?.source
            || deviceCalendars.find(c => c.source?.type === 'caldav')?.source
            || deviceCalendars.find(c => c.allowsModifications)?.source
            || deviceCalendars[0]?.source;
        } else {
          defaultSource = { isLocalAccount: true, name: 'OneMundo Mail', type: 'LOCAL' };
        }
        if (defaultSource) {
          try {
            targetCalId = await ExpoCalendar.createCalendarAsync({
              title: 'OneMundo Mail',
              color: '#2563eb',
              entityType: ExpoCalendar.EntityTypes.EVENT,
              source: defaultSource,
              name: 'OneMundo Mail',
              ownerAccount: 'personal',
              accessLevel: ExpoCalendar.CalendarAccessLevel?.OWNER || 'owner',
            });
          } catch {
            // If create fails, use first writable calendar
            const writable = deviceCalendars.find(c => c.allowsModifications);
            if (writable) targetCalId = writable.id;
          }
        }
      }

      if (!targetCalId) {
        Alert.alert(t('common.error'), t('calendar.noCalendarOnDevice'));
        setSyncingDevice(false);
        return;
      }

      // Get existing events on device in this calendar
      const startDate = new Date(currentYear, currentMonth - 1, 1);
      const endDate = new Date(currentYear, currentMonth + 2, 0);
      const deviceEvents = await ExpoCalendar.getEventsAsync([targetCalId], startDate, endDate);
      const deviceKeys = new Set(deviceEvents.map(de => `${(de.title || '').toLowerCase()}|${new Date(de.startDate).toISOString().substring(0, 16)}`));

      const toExport = events.filter(e => {
        const key = `${(e.title || '').toLowerCase()}|${(e.start_at || '').substring(0, 16)}`;
        return !deviceKeys.has(key);
      });

      if (toExport.length === 0) {
        Alert.alert(t('calendar.synced'), t('calendar.allEventsOnDevice'));
        setSyncingDevice(false);
        return;
      }

      let success = 0;
      for (const evt of toExport) {
        try {
          await ExpoCalendar.createEventAsync(targetCalId, {
            title: evt.title || t('calendar.untitledEvent'),
            startDate: new Date(evt.start_at),
            endDate: new Date(evt.end_at),
            location: evt.location || '',
            notes: evt.description || '',
            allDay: evt.all_day || false,
          });
          success++;
        } catch {}
      }

      Alert.alert(t('calendar.done'), t('calendar.eventsAddedToDevice', { count: success }));
    } catch {
      Alert.alert(t('common.error'), t('calendar.exportToDeviceFailed'));
    } finally {
      setSyncingDevice(false);
    }
  };

  // Filter events for selected day
  const dayEvents = useMemo(() => {
    if (!selectedDate) return [];
    return events.filter(evt => {
      const evtStart = new Date(evt.start_at);
      const evtEnd = new Date(evt.end_at);
      const dayStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
      const dayEnd = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 23, 59, 59);
      return evtStart <= dayEnd && evtEnd >= dayStart;
    }).sort((a, b) => {
      if (a.all_day && !b.all_day) return -1;
      if (!a.all_day && b.all_day) return 1;
      return new Date(a.start_at) - new Date(b.start_at);
    });
  }, [events, selectedDate]);

  const selectedDateStr = selectedDate
    ? selectedDate.toLocaleDateString(t('_locale') || 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : '';

  const renderEventItem = ({ item }) => (
    <EventCard event={item} colors={colors} onPress={() => handleEventPress(item)} t={t} />
  );

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <IconCalendar size={48} color={colors.textTertiary} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('calendar.noEvents')}</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          {t('calendar.noEventsForDay')}
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
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('calendar.title')}</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={handleToday} style={[styles.todayBtn, { borderColor: colors.border }]}>
            <Text style={[styles.todayBtnText, { color: colors.primary }]}>{t('calendar.today')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowAddModal(true)} style={styles.headerBtn}>
            <IconPlus size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={dayEvents}
        keyExtractor={(item, index) => `${item.id}-${index}`}
        renderItem={renderEventItem}
        ListHeaderComponent={
          <>
            {/* Import result banner */}
            {importResult && (
              <View style={[styles.importBanner, {
                backgroundColor: importResult.failed === 0 ? '#dcfce7' : '#fef3c7',
                borderColor: importResult.failed === 0 ? '#86efac' : '#fcd34d',
              }]}>
                <IconCheck size={16} color={importResult.failed === 0 ? '#16a34a' : '#d97706'} />
                <Text style={[styles.importBannerText, { color: importResult.failed === 0 ? '#16a34a' : '#92400e' }]}>
                  {t('calendar.importedCount', { success: importResult.success, total: importResult.total })}{importResult.failed > 0 ? ` (${importResult.failed} ${t('calendar.failed')})` : ''}
                </Text>
                <TouchableOpacity onPress={() => setImportResult(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <IconX size={14} color={importResult.failed === 0 ? '#16a34a' : '#92400e'} />
                </TouchableOpacity>
              </View>
            )}

            {/* Calendar Grid */}
            <CalendarGrid
              year={currentYear}
              month={currentMonth}
              selectedDate={selectedDate}
              events={events}
              colors={colors}
              onSelectDate={handleSelectDate}
              onPrevMonth={handlePrevMonth}
              onNextMonth={handleNextMonth}
              t={t}
            />

            {/* Sync / Import / Export bar */}
            <View style={[styles.syncBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {Platform.OS !== 'web' && ExpoCalendar && (
                <>
                  <TouchableOpacity
                    onPress={handleSyncDeviceCalendar}
                    disabled={syncingDevice}
                    style={[styles.syncBarBtn, { backgroundColor: colors.primary + '10', borderColor: colors.primary + '30' }]}
                  >
                    {syncingDevice ? <ActivityIndicator size="small" color={colors.primary} /> : <IconSmartphone size={15} color={colors.primary} />}
                    <Text style={[styles.syncBarBtnText, { color: colors.primary }]}>
                      {t('calendar.syncToApp', { device: Platform.OS === 'ios' ? 'iPhone' : 'Android' })}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handlePushToDevice}
                    disabled={syncingDevice}
                    style={[styles.syncBarBtn, { backgroundColor: colors.primary + '10', borderColor: colors.primary + '30' }]}
                  >
                    {syncingDevice ? <ActivityIndicator size="small" color={colors.primary} /> : <IconRefresh size={15} color={colors.primary} />}
                    <Text style={[styles.syncBarBtnText, { color: colors.primary }]}>
                      {t('calendar.syncToDevice', { device: Platform.OS === 'ios' ? 'iPhone' : 'Android' })}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                onPress={handleImportICS}
                disabled={importing}
                style={[styles.syncBarBtn, { borderColor: colors.border }]}
              >
                {importing ? <ActivityIndicator size="small" color={colors.primary} /> : <IconUpload size={15} color={colors.primary} />}
                <Text style={[styles.syncBarBtnText, { color: colors.primary }]}>{t('calendar.importIcs')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleExportMonth}
                style={[styles.syncBarBtn, { borderColor: colors.border }]}
              >
                <IconDownload size={15} color={colors.textSecondary} />
                <Text style={[styles.syncBarBtnText, { color: colors.textSecondary }]}>{t('calendar.export')}</Text>
              </TouchableOpacity>
              {Platform.OS === 'web' && (
                <TouchableOpacity
                  onPress={handleSubscribeCalendar}
                  style={[styles.syncBarBtn, { borderColor: colors.border }]}
                >
                  <IconSmartphone size={15} color={colors.primary} />
                  <Text style={[styles.syncBarBtnText, { color: colors.primary }]}>{t('calendar.subscribe')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={generateSmartReminders}
                disabled={loadingReminders}
                style={[styles.syncBarBtn, { borderColor: colors.border }]}
              >
                {loadingReminders ? <ActivityIndicator size="small" color={colors.primary} /> : <IconSparkles size={15} color={colors.primary} />}
                <Text style={[styles.syncBarBtnText, { color: colors.primary }]}>AI</Text>
              </TouchableOpacity>
            </View>

            {aiReminders.length > 0 && (
              <View style={[styles.remindersCard, { backgroundColor: colors.primaryLight + '30', borderColor: colors.primaryLight }]}>
                <View style={styles.remindersHeader}>
                  <IconSparkles size={14} color={colors.primary} />
                  <Text style={[styles.remindersTitle, { color: colors.primary }]}>{t('calendar.smartReminders')}</Text>
                  <TouchableOpacity onPress={() => setAiReminders([])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <IconX size={14} color={colors.textTertiary} />
                  </TouchableOpacity>
                </View>
                {aiReminders.map((reminder, i) => (
                  <Text key={i} style={[styles.reminderText, { color: colors.text }]}>{reminder}</Text>
                ))}
              </View>
            )}

            {/* Selected day header */}
            <View style={[styles.dayHeader, { borderTopColor: colors.border }]}>
              <Text style={[styles.dayHeaderTitle, { color: colors.text }]}>
                {selectedDateStr}
              </Text>
              <Text style={[styles.dayEventCount, { color: colors.textSecondary }]}>
                {t('calendar.eventCount', { count: dayEvents.length })}
              </Text>
            </View>

            {loading && !refreshing && (
              <View style={styles.loaderWrap}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            )}
          </>
        }
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={[styles.list, dayEvents.length === 0 && styles.listEmpty]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      />

      {/* Add Event Modal */}
      <AddEventModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSave={handleCreateEvent}
        colors={colors}
        calendars={calendars}
        selectedDate={selectedDate}
        t={t}
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
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  todayBtn: {
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  todayBtnText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Calendar Grid
  calendarGrid: { paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm },
  monthHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm, marginBottom: Spacing.sm,
  },
  monthArrow: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  dayHeaders: { flexDirection: 'row' },
  dayHeaderCell: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  dayHeaderText: { fontSize: FontSize.xs, fontWeight: '600', textTransform: 'uppercase' },
  calendarRow: { flexDirection: 'row' },
  calendarCell: {
    flex: 1, alignItems: 'center', paddingVertical: 4, minHeight: 44,
    borderRadius: BorderRadius.sm,
  },
  dayCellInner: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  dayCellText: { fontSize: FontSize.sm, fontWeight: '500' },
  dotRow: { flexDirection: 'row', gap: 2, marginTop: 1 },
  eventDot: { width: 5, height: 5, borderRadius: 2.5 },

  // Day header
  dayHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: 1, marginTop: Spacing.xs,
  },
  dayHeaderTitle: { fontSize: FontSize.md, fontWeight: '600' },
  dayEventCount: { fontSize: FontSize.sm },

  // Event Card
  eventCard: {
    borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.xs,
    marginHorizontal: Spacing.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    ...Shadow.sm,
  },
  eventCardBody: { flex: 1, gap: 4 },
  eventTitle: { fontSize: FontSize.md, fontWeight: '600' },
  eventMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  eventMetaText: { fontSize: FontSize.sm },
  calBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full || 99,
    marginLeft: Spacing.sm,
  },
  calBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Empty
  emptyContainer: {
    alignItems: 'center', paddingVertical: Spacing.xxl, paddingHorizontal: Spacing.xl,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },

  // List
  list: { paddingBottom: Spacing.xl },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { paddingVertical: Spacing.md, alignItems: 'center' },

  // Modal
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    maxHeight: '92%', minHeight: '60%',
    ...Shadow.lg,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalHeaderBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  modalBody: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },

  // Form
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs + 2,
    fontSize: FontSize.md, marginBottom: Spacing.sm,
  },
  inputLarge: { fontSize: FontSize.lg, fontWeight: '600', paddingVertical: Spacing.sm },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  fieldLabel: {
    fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.xs, marginTop: Spacing.xs,
  },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.sm, marginBottom: Spacing.xs,
  },
  switchLabel: { fontSize: FontSize.md, fontWeight: '500' },
  dateTimeRow: { flexDirection: 'row', gap: Spacing.sm },
  dateTimeCol: { flex: 1 },

  // Color picker
  colorRow: {
    flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md, flexWrap: 'wrap',
  },
  colorCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2.5,
  },

  // Calendar selector
  calSelectorRow: {
    flexDirection: 'row', gap: Spacing.xs, flexWrap: 'wrap', marginBottom: Spacing.sm,
  },
  calSelectorChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  calDotSmall: { width: 8, height: 8, borderRadius: 4 },
  calSelectorText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Recurrence
  recurrenceRow: {
    flexDirection: 'row', gap: Spacing.xs, flexWrap: 'wrap', marginBottom: Spacing.sm,
  },
  recurrenceChip: {
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  recurrenceChipText: { fontSize: FontSize.sm, fontWeight: '500' },

  // AI Reminders
  remindersCard: { marginHorizontal: Spacing.lg, marginVertical: Spacing.sm, borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.md },
  remindersHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  remindersTitle: { flex: 1, fontSize: FontSize.sm, fontWeight: '700' },
  reminderText: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: 4, paddingLeft: 4 },
  exportBtn: { padding: 6 },

  // Sync bar
  syncBar: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    marginTop: Spacing.xs,
  },
  syncBarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 5,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  syncBarBtnText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Import banner
  importBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  importBannerText: { flex: 1, fontSize: FontSize.sm, fontWeight: '600' },
});
