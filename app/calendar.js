import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl, Alert, Modal, ScrollView,
  Switch, Platform, Linking, KeyboardAvoidingView, Animated, PanResponder, Easing,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { CalendarSkeleton } from '../components/SkeletonLoader';
import * as DocumentPicker from 'expo-document-picker';
let FileSystem = null;
try { FileSystem = require('expo-file-system'); } catch (e) {}
import * as Sharing from 'expo-sharing';
import {
  IconCalendar, IconPlus, IconClock, IconArrowLeft, IconArrowRight,
  IconCheck, IconX, IconEdit, IconTrash, IconMapPin, IconRepeat,
  IconChevronLeft, IconChevronRight, IconUsers, IconSearch, IconSparkles,
  IconUpload, IconDownload, IconSmartphone, IconRefresh, IconBell, IconVideo,
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

const REMINDER_OPTIONS = [
  { value: 'none', mins: 0 },
  { value: '5min', mins: 5 },
  { value: '15min', mins: 15 },
  { value: '30min', mins: 30 },
  { value: '1hour', mins: 60 },
  { value: '1day', mins: 1440 },
];

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

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
  if (isNaN(d.getTime())) return "";
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
    'PRODID:-//Chatyy//Calendar//EN',
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
    if (!FileSystem) {
      safeAlert(t ? t('common.error') : 'Error', 'File system not available');
      return;
    }
    try {
      const fileName = `${(event.title || 'event').replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
      const filePath = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(filePath, ics, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics' });
      } else {
        safeAlert(t ? t('common.error') : 'Error', t ? t('calendar.sharingUnavailable') : 'Sharing not available on this device');
      }
    } catch {
      safeAlert(t ? t('common.error') : 'Error', t ? t('calendar.exportEventFailed') : 'Failed to export event');
    }
  }
}

// ============================================================
// ICS Parser — parse .ics file content into event objects
// ============================================================
function parseICSDate(val) {
  if (!val) return null;
  // Handle formats: 20260305T090000, 20260305T090000Z, 20260305.
  // CRITICAL: preserve the trailing 'Z'. The previous version stripped it
  // (`replace(/[^0-9T]/g, '')`) so a UTC timestamp was silently parsed as
  // local — reminders fired at the wrong wall clock for any non-UTC user.
  const isUtc = /Z\s*$/.test(val);
  const clean = val.replace(/[^0-9T]/g, '');
  if (clean.length >= 8) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    if (clean.length >= 15) {
      const h = clean.substring(9, 11);
      const min = clean.substring(11, 13);
      if (isUtc) {
        // Convert the UTC wall time to a local ISO string so the rest
        // of the codebase keeps the same "no offset suffix" convention.
        const dt = new Date(Date.UTC(+y, +m - 1, +d, +h, +min, 0));
        const pad = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
      }
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
function CalendarGrid({ year, month, selectedDate, events, colors, onSelectDate, onPrevMonth, onNextMonth, onQuickAdd, t }) {
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

  // Build a map of dates with events (include title previews, up to 2)
  const eventsByDate = useMemo(() => {
    const map = {};
    (events || []).forEach(evt => {
      const d = new Date(evt.start_at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[key]) map[key] = [];
      map[key].push(evt);
    });
    return map;
  }, [events]);

  // Count events in this month
  const monthEventCount = useMemo(() => {
    return (events || []).filter(evt => {
      const d = new Date(evt.start_at);
      return d.getFullYear() === year && d.getMonth() === month;
    }).length;
  }, [events, year, month]);

  return (
    <View style={styles.calendarGrid}>
      {/* Month header */}
      <View style={styles.monthHeader}>
        <TouchableOpacity onPress={onPrevMonth} style={styles.monthArrow}>
          <IconChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={[styles.monthTitle, { color: colors.text }]}>
            {(Array.isArray(t('calendar.months')) ? t('calendar.months') : [])[month] || ''} {year}
          </Text>
          {monthEventCount > 0 && (
            <Text style={[styles.monthEventCount, { color: colors.textSecondary }]}>
              {t('calendar.eventCount', { count: monthEventCount })}
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={onNextMonth} style={styles.monthArrow}>
          <IconChevronRight size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Day headers */}
      <View style={styles.dayHeaders}>
        {(Array.isArray(t('calendar.dayNames')) ? t('calendar.dayNames') : []).map(d => (
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
            const cellEvents = eventsByDate[dateKey] || [];

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
                <View style={styles.cellTopRow}>
                  <View style={[
                    styles.dayCellInner,
                    isToday && { backgroundColor: colors.primary,
                      ...(Platform.OS === 'web' ? { background: `linear-gradient(135deg, ${colors.primary}, #8b5cf6)`, boxShadow: `0 2px 8px ${colors.primary}40` } : {}),
                    },
                    isSelected && !isToday && { borderWidth: 2, borderColor: colors.primary },
                  ]}>
                    <Text style={[
                      styles.dayCellText,
                      { color: isToday ? '#fff' : isOtherMonth ? colors.textTertiary : colors.text },
                      isSelected && !isToday && { color: colors.primary, fontWeight: '800' },
                      isToday && { fontWeight: '700' },
                    ]}>
                      {cell.day}
                    </Text>
                  </View>
                  {!isOtherMonth && onQuickAdd && (
                    <TouchableOpacity
                      onPress={(e) => { e.stopPropagation && e.stopPropagation(); onQuickAdd(cell.date); }}
                      style={styles.cellAddBtn}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <IconPlus size={10} color={colors.textTertiary} />
                    </TouchableOpacity>
                  )}
                </View>
                {/* Mini event previews */}
                {cellEvents.length > 0 && (
                  <View style={styles.cellEventPreviews}>
                    {cellEvents.slice(0, 2).map((evt, ei) => (
                      <View key={ei} style={[styles.cellEventPreview, { backgroundColor: (evt.color || evt.calendar_color || colors.primary) + '22' }]}>
                        <View style={[styles.cellEventDot, { backgroundColor: evt.color || evt.calendar_color || colors.primary }]} />
                        <Text style={[styles.cellEventText, { color: isOtherMonth ? colors.textTertiary : colors.text }]} numberOfLines={1}>
                          {evt.title || ''}
                        </Text>
                      </View>
                    ))}
                    {cellEvents.length > 2 && (
                      <Text style={[styles.cellEventMore, { color: colors.textTertiary }]}>+{cellEvents.length - 2}</Text>
                    )}
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
// Week View Component
// ============================================================
const HOUR_HEIGHT = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function WeekView({ weekStart, events, colors, onEventPress, onPrevWeek, onNextWeek, t }) {
  const scrollRef = React.useRef(null);
  const today = new Date();
  const dayNames = Array.isArray(t('calendar.dayNames')) ? t('calendar.dayNames') : [];

  // Build 7 days from weekStart
  const days = useMemo(() => {
    const arr = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [weekStart]);

  // Map events to day columns
  const dayEvents = useMemo(() => {
    const map = {}; // dayIdx -> [event]
    for (let i = 0; i < 7; i++) {
      map[i] = [];
    }
    (events || []).forEach(evt => {
      const evtStart = new Date(evt.start_at);
      const evtEnd = new Date(evt.end_at);
      for (let i = 0; i < 7; i++) {
        const dayStart = new Date(days[i]);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(days[i]);
        dayEnd.setHours(23, 59, 59, 999);
        if (evtStart <= dayEnd && evtEnd >= dayStart) {
          map[i].push(evt);
        }
      }
    });
    return map;
  }, [events, days]);

  // Current time indicator position
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowTop = (nowMinutes / 60) * HOUR_HEIGHT;
  const todayIdx = days.findIndex(d => isSameDay(d, today));

  // Scroll to ~8am on mount. Cleanup the timer on unmount/week-change
  // so a stale callback can't fire scrollTo on a torn-down WeekView.
  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: 8 * HOUR_HEIGHT - 20, animated: false });
    }, 100);
    return () => clearTimeout(id);
  }, [weekStart]);

  // Week header label
  const weekLabel = useMemo(() => {
    const months = Array.isArray(t('calendar.months')) ? t('calendar.months') : [];
    const first = days[0];
    const last = days[6];
    if (first.getMonth() === last.getMonth()) {
      return `${first.getDate()} - ${last.getDate()} ${months[first.getMonth()] || ''} ${first.getFullYear()}`;
    }
    return `${first.getDate()} ${months[first.getMonth()] || ''} - ${last.getDate()} ${months[last.getMonth()] || ''} ${last.getFullYear()}`;
  }, [days, t]);

  return (
    <View style={weekStyles.container}>
      {/* Week navigation header */}
      <View style={weekStyles.navRow}>
        <TouchableOpacity onPress={onPrevWeek} style={weekStyles.navArrow}>
          <IconChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[weekStyles.navTitle, { color: colors.text }]}>{weekLabel}</Text>
        <TouchableOpacity onPress={onNextWeek} style={weekStyles.navArrow}>
          <IconChevronRight size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Day name headers */}
      <View style={weekStyles.dayHeaderRow}>
        <View style={weekStyles.timeGutter} />
        {days.map((d, i) => {
          const isToday = isSameDay(d, today);
          return (
            <View key={i} style={[weekStyles.dayCol, isToday && { backgroundColor: colors.primary + '08' }]}>
              <Text style={[weekStyles.dayName, { color: isToday ? colors.primary : colors.textTertiary }]}>
                {dayNames[i] || ''}
              </Text>
              <View style={[weekStyles.dayNum, isToday && { backgroundColor: colors.primary }]}>
                <Text style={[weekStyles.dayNumText, { color: isToday ? '#fff' : colors.text }]}>
                  {d.getDate()}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* Scrollable time grid */}
      <ScrollView ref={scrollRef} style={weekStyles.scrollArea} showsVerticalScrollIndicator={false}>
        <View style={[weekStyles.gridBody, { height: 24 * HOUR_HEIGHT }]}>
          {/* Hour lines */}
          {HOURS.map(h => (
            <View key={h} style={[weekStyles.hourRow, { top: h * HOUR_HEIGHT, borderBottomColor: colors.border }]}>
              <View style={weekStyles.timeGutter}>
                <Text style={[weekStyles.hourLabel, { color: colors.textTertiary }]}>
                  {String(h).padStart(2, '0')}:00
                </Text>
              </View>
            </View>
          ))}

          {/* Day columns with events */}
          <View style={weekStyles.columnsOverlay}>
            <View style={weekStyles.timeGutter} />
            {days.map((d, i) => {
              const isToday = isSameDay(d, today);
              return (
                <View key={i} style={[weekStyles.dayColBody, { borderLeftColor: colors.border }, isToday && { backgroundColor: colors.primary + '05' }]}>
                  {(dayEvents[i] || []).map(evt => {
                    const evtStart = new Date(evt.start_at);
                    const evtEnd = new Date(evt.end_at);
                    const startMin = evtStart.getHours() * 60 + evtStart.getMinutes();
                    const endMin = evtEnd.getHours() * 60 + evtEnd.getMinutes();
                    const topPx = (startMin / 60) * HOUR_HEIGHT;
                    const duration = Math.max(endMin - startMin, 30); // min 30min block
                    const heightPx = (duration / 60) * HOUR_HEIGHT;
                    const bgColor = evt.color || evt.calendar_color || colors.primary;

                    return (
                      <TouchableOpacity
                        key={evt.id}
                        style={[weekStyles.eventBlock, {
                          top: topPx,
                          height: heightPx,
                          backgroundColor: bgColor + '22',
                          borderLeftColor: bgColor,
                        }]}
                        onPress={() => onEventPress(evt)}
                        activeOpacity={0.7}
                      >
                        {/* Drag handle visual (top) */}
                        <View style={weekStyles.dragHandle}>
                          <View style={[weekStyles.dragHandleDot, { backgroundColor: bgColor + '55' }]} />
                          <View style={[weekStyles.dragHandleDot, { backgroundColor: bgColor + '55' }]} />
                          <View style={[weekStyles.dragHandleDot, { backgroundColor: bgColor + '55' }]} />
                        </View>
                        <Text style={[weekStyles.eventBlockTitle, { color: bgColor }]} numberOfLines={1}>
                          {evt.title || ''}
                        </Text>
                        {heightPx > 30 && (
                          <Text style={[weekStyles.eventBlockTime, { color: bgColor }]} numberOfLines={1}>
                            {formatTime(evt.start_at)}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
          </View>

          {/* Current time indicator */}
          {todayIdx >= 0 && (
            <View style={[weekStyles.nowLine, { top: nowTop }]} pointerEvents="none">
              <View style={weekStyles.timeGutter} />
              {days.map((_, i) => (
                <View key={i} style={weekStyles.dayColBody}>
                  {i === todayIdx && (
                    <View style={weekStyles.nowLineInner}>
                      <View style={weekStyles.nowDot} />
                      <View style={weekStyles.nowBar} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const weekStyles = StyleSheet.create({
  container: { flex: 1 },
  navRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
  },
  navArrow: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: FontSize.md, fontWeight: '600' },
  dayHeaderRow: {
    flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0', paddingBottom: 6,
  },
  timeGutter: { width: 48 },
  dayCol: { flex: 1, alignItems: 'center', paddingVertical: 2 },
  dayName: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', marginBottom: 2 },
  dayNum: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dayNumText: { fontSize: FontSize.sm, fontWeight: '600' },
  scrollArea: { flex: 1 },
  gridBody: { position: 'relative' },
  hourRow: {
    position: 'absolute', left: 0, right: 0, height: HOUR_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row',
  },
  hourLabel: { fontSize: 10, fontWeight: '500', textAlign: 'right', paddingRight: 6, paddingTop: 2 },
  columnsOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    flexDirection: 'row',
  },
  dayColBody: { flex: 1, position: 'relative', borderLeftWidth: StyleSheet.hairlineWidth },
  eventBlock: {
    position: 'absolute', left: 1, right: 1,
    borderLeftWidth: 3, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2,
    overflow: 'hidden',
  },
  dragHandle: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 2, paddingVertical: 1, marginBottom: 0,
  },
  dragHandleDot: { width: 3, height: 3, borderRadius: 1.5 },
  eventBlockTitle: { fontSize: 11, fontWeight: '600' },
  eventBlockTime: { fontSize: 10 },
  nowLine: {
    position: 'absolute', left: 0, right: 0, flexDirection: 'row',
    height: 2, zIndex: 10,
  },
  nowLineInner: { position: 'absolute', left: -4, right: 0, flexDirection: 'row', alignItems: 'center' },
  nowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EA4335' },
  nowBar: { flex: 1, height: 2, backgroundColor: '#EA4335' },
});

// Helper: relative time for upcoming events
function getRelativeTime(startAt, t) {
  if (!startAt || !t) return '';
  const now = new Date();
  const start = new Date(startAt);
  const diffMs = start - now;
  if (diffMs < 0) return ''; // past
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('calendar.now');
  if (diffMin < 60) return t('calendar.inMinutes', { count: diffMin });
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t('calendar.inHours', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return t('calendar.tomorrow');
  if (diffDays <= 7) return t('calendar.inDays', { count: diffDays });
  return '';
}

// ============================================================
// Swipeable Event Card
// ============================================================
function SwipeableEventCard({ event, colors, onPress, onEdit, onDelete, onJoinMeeting, t }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 15 && Math.abs(gs.dx) > Math.abs(gs.dy) * 2,
      onMoveShouldSetPanResponderCapture: (_, gs) => Math.abs(gs.dx) > 25 && Math.abs(gs.dx) > Math.abs(gs.dy) * 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, gs) => {
        // Clamp swipe: right for edit (max 80), left for delete (max -80)
        const clamped = Math.max(-80, Math.min(80, gs.dx));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx > 50 && onEdit) {
          // Swipe right -> edit
          Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
          onEdit(event);
        } else if (gs.dx < -50 && onDelete) {
          // Swipe left -> delete
          Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
          onDelete(event);
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  const borderColor = event.color || event.calendar_color || colors.primary;
  const relTime = getRelativeTime(event.start_at, t);
  const isSynced = event.calendar_name || event.source === 'device';
  const hasReminder = event.reminder && event.reminder !== 'none';

  // Detect meeting events by location or description containing a meet URL
  const meetUrlPattern = /\/meet\/([a-zA-Z0-9_-]+)/;
  const meetMatch = (event.location && meetUrlPattern.exec(event.location)) ||
    (event.meeting_room_id ? { 1: event.meeting_room_id } : null) ||
    (event.description && meetUrlPattern.exec(event.description));
  const isMeetingEvent = !!meetMatch;
  const meetingRoomId = meetMatch ? (meetMatch[1] || meetMatch['1']) : null;

  return (
    <View style={styles.swipeContainer}>
      {/* Background actions revealed by swipe */}
      <View style={styles.swipeActions}>
        <View style={[styles.swipeActionLeft, { backgroundColor: colors.primary }]}>
          <IconEdit size={20} color="#fff" />
          <Text style={styles.swipeActionText}>{t('calendar.edit')}</Text>
        </View>
        <View style={[styles.swipeActionRight, { backgroundColor: colors.error || '#EA4335' }]}>
          <IconTrash size={20} color="#fff" />
          <Text style={styles.swipeActionText}>{t('calendar.delete')}</Text>
        </View>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TouchableOpacity
          style={[styles.eventCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={onPress}
          activeOpacity={0.7}
        >
          {/* Colored left border accent */}
          <View style={[styles.eventCardAccent, { backgroundColor: borderColor }]} />
          <View style={styles.eventCardBody}>
            <View style={styles.eventTitleRow}>
              <Text style={[styles.eventTitle, { color: colors.text }]} numberOfLines={1}>
                {event.title || (t ? t('calendar.untitledEvent') : 'Untitled event')}
              </Text>
              {!!relTime && (
                <View style={[styles.relTimeBadge, { backgroundColor: borderColor + '18' }]}>
                  <Text style={[styles.relTimeText, { color: borderColor }]}>{relTime}</Text>
                </View>
              )}
            </View>
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
            {isMeetingEvent && (
              <View style={styles.eventMeta}>
                <IconVideo size={13} color="#7C3AED" />
                <Text style={[styles.eventMetaText, { color: '#7C3AED', fontWeight: '600' }]}>{t ? t('calendar.meetingEvent') : 'Video Meeting'}</Text>
              </View>
            )}
          </View>
          <View style={styles.eventCardRight}>
            {/* Badges row */}
            <View style={styles.eventBadgesCol}>
              {isSynced && (
                <View style={[styles.syncBadgeSmall, { backgroundColor: '#0097A7' + '22' }]}>
                  <IconSmartphone size={10} color="#0097A7" />
                </View>
              )}
              {hasReminder && (
                <View style={[styles.reminderBadgeSmall, { backgroundColor: borderColor + '18' }]}>
                  <IconBell size={10} color={borderColor} />
                </View>
              )}
              {!!event.calendar_name && (
                <View style={[styles.calBadge, { backgroundColor: (event.calendar_color || colors.primary) + '18' }]}>
                  <Text style={[styles.calBadgeText, { color: event.calendar_color || colors.primary }]} numberOfLines={1}>
                    {event.calendar_name}
                  </Text>
                </View>
              )}
            </View>
            {isMeetingEvent && meetingRoomId && (
              <TouchableOpacity
                style={styles.joinMeetingBtn}
                onPress={(e) => { e.stopPropagation(); onJoinMeeting?.(meetingRoomId); }}
                activeOpacity={0.7}
              >
                <IconVideo size={14} color="#fff" />
                <Text style={styles.joinMeetingBtnText}>{t ? t('calendar.joinMeeting') : 'Join'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
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

  // Auto-format time with colon (e.g., "14" -> "14:", "1430" -> "14:30")
  const formatTimeInput = (text, setter) => {
    let clean = text.replace(/[^0-9]/g, '');
    if (clean.length >= 3) clean = clean.slice(0, 2) + ':' + clean.slice(2, 4);
    else if (clean.length === 2 && text.length > (setter === setStartTime ? startTime : endTime).length) clean = clean + ':';
    if (clean.length > 5) clean = clean.slice(0, 5);
    setter(clean);
  };

  // Auto-format date (e.g., "2026" -> "2026-", "202603" -> "2026-03-")
  const formatDateInput = (text, setter) => {
    let clean = text.replace(/[^0-9]/g, '');
    if (clean.length >= 5) clean = clean.slice(0, 4) + '-' + clean.slice(4);
    if (clean.length >= 8) clean = clean.slice(0, 7) + '-' + clean.slice(7, 9);
    if (clean.length > 10) clean = clean.slice(0, 10);
    setter(clean);
  };
  const [selectedColor, setSelectedColor] = useState('#4285F4');
  const [calendarId, setCalendarId] = useState(0);
  const [attendeesText, setAttendeesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [recurrence, setRecurrence] = useState('');
  const [reminder, setReminder] = useState('none');

  useEffect(() => {
    if (visible) {
      const dateObj = selectedDate || new Date();
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      const ds = `${y}-${m}-${d}`;
      setStartDate(ds);
      setEndDate(ds);
    }
    if (visible) {
      // Pre-fill with current time rounded to next 30min
      const now = new Date();
      const mins = now.getMinutes();
      const roundedMins = mins < 30 ? 30 : 0;
      const roundedHour = mins < 30 ? now.getHours() : now.getHours() + 1;
      const startH = String(roundedHour % 24).padStart(2, '0');
      const startM = String(roundedMins).padStart(2, '0');
      const endH = String((roundedHour + 1) % 24).padStart(2, '0');

      setTitle('');
      setDescription('');
      setLocation('');
      setAllDay(false);
      setStartTime(`${startH}:${startM}`);
      setEndTime(`${endH}:${startM}`);
      setSelectedColor('#4285F4');
      setCalendarId(calendars?.[0]?.id || 0);
      setAttendeesText('');
      setSaving(false);
      setRecurrence('');
      setReminder('none');
    }
  }, [visible, selectedDate, calendars]);

  const handleSave = async () => {
    if (!title.trim()) {
      safeAlert(t('common.error'), t('calendar.errorTitle'));
      return;
    }
    if (!startDate || !endDate) {
      safeAlert(t('common.error'), t('calendar.errorDates'));
      return;
    }

    // Validate date/time components
    const validateDateTime = (dateStr, timeStr) => {
      const parts = dateStr.split('-');
      if (parts.length !== 3) return false;
      const [y, m, d] = parts.map(Number);
      if (!y || m < 1 || m > 12) return false;
      const maxDay = new Date(y, m, 0).getDate(); // last day of month
      if (d < 1 || d > maxDay) return false;
      if (!allDay && timeStr) {
        const timeParts = timeStr.split(':');
        if (timeParts.length < 2) return false;
        const [h, min] = timeParts.map(Number);
        if (h < 0 || h > 23 || min < 0 || min > 59) return false;
      }
      return true;
    };

    if (!validateDateTime(startDate, startTime)) {
      safeAlert(t('common.error'), t('calendar.errorInvalidDate') || 'Data ou hora de início inválida. Verifique mês (1-12), dia, hora (0-23) e minuto (0-59).');
      return;
    }
    if (!validateDateTime(endDate, endTime)) {
      safeAlert(t('common.error'), t('calendar.errorInvalidEndDate') || 'Data ou hora de término inválida. Verifique mês (1-12), dia, hora (0-23) e minuto (0-59).');
      return;
    }

    // Validate date is not in the past
    const startAt = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
    const startDateObj = new Date(startAt);
    const now = new Date();
    if (!allDay && startDateObj < now) {
      safeAlert(t('common.error'), t('calendar.errorPastDate') || 'A data/hora de início não pode ser no passado');
      return;
    }
    setSaving(true);
    try {
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
        reminder,
      });
      onClose();
    } catch {
      safeAlert(t('common.error'), t('calendar.createEventFailed'));
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

            {/* Quick Duration Buttons */}
            {!allDay && (
              <>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: Spacing.xs }]}>{t('calendar.quickDuration')}</Text>
                <View style={styles.durationRow}>
                  {[
                    { label: '30min', mins: 30 },
                    { label: '1h', mins: 60 },
                    { label: '2h', mins: 120 },
                  ].map(dur => {
                    // Check if this duration is currently active
                    const [sh, sm] = startTime.split(':').map(Number);
                    const [eh, em] = endTime.split(':').map(Number);
                    const diffMins = ((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440;
                    const isActive = diffMins === dur.mins;
                    return (
                      <TouchableOpacity
                        key={dur.label}
                        style={[
                          styles.durationChip,
                          { borderColor: colors.border, backgroundColor: isActive ? colors.primary : colors.surface },
                        ]}
                        onPress={() => {
                          const [h, m] = startTime.split(':').map(Number);
                          const totalMin = h * 60 + m + dur.mins;
                          const newH = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
                          const newM = String(totalMin % 60).padStart(2, '0');
                          setEndTime(`${newH}:${newM}`);
                          setEndDate(startDate);
                        }}
                      >
                        <Text style={[styles.durationChipText, { color: isActive ? '#fff' : colors.text }]}>{dur.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                  <TouchableOpacity
                    style={[
                      styles.durationChip,
                      { borderColor: colors.border, backgroundColor: allDay ? colors.primary : colors.surface },
                    ]}
                    onPress={() => setAllDay(true)}
                  >
                    <Text style={[styles.durationChipText, { color: allDay ? '#fff' : colors.text }]}>{t('calendar.allDay')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

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
                  style={[styles.input, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder={t('calendar.dateFormat')}
                  placeholderTextColor={colors.textTertiary}
                  value={startDate}
                  onChangeText={(t) => formatDateInput(t, setStartDate)}
                  keyboardType="numeric"
                  maxLength={10}
                />
              </View>
              {!allDay && (
                <View style={styles.dateTimeCol}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.startTime')}</Text>
                  <TextInput
                    style={[styles.input, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                    placeholder="HH:MM"
                    placeholderTextColor={colors.textTertiary}
                    value={startTime}
                    onChangeText={(t) => formatTimeInput(t, setStartTime)}
                    keyboardType="numeric"
                    maxLength={5}
                  />
                </View>
              )}
            </View>

            {/* End Date/Time */}
            <View style={styles.dateTimeRow}>
              <View style={styles.dateTimeCol}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.endDate')}</Text>
                <TextInput
                  style={[styles.input, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder={t('calendar.dateFormat')}
                  placeholderTextColor={colors.textTertiary}
                  value={endDate}
                  onChangeText={(t) => formatDateInput(t, setEndDate)}
                  keyboardType="numeric"
                  maxLength={10}
                />
              </View>
              {!allDay && (
                <View style={styles.dateTimeCol}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.endTime')}</Text>
                  <TextInput
                    style={[styles.input, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                    placeholder="HH:MM"
                    placeholderTextColor={colors.textTertiary}
                    value={endTime}
                    onChangeText={(t) => formatTimeInput(t, setEndTime)}
                    keyboardType="numeric"
                    maxLength={5}
                  />
                </View>
              )}
            </View>

            {/* Description */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.description')}</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface, minHeight: 88 }]}
              placeholder={t('calendar.addDescription')}
              placeholderTextColor={colors.textTertiary}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
            />

            {/* Location */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('calendar.location')}</Text>
            <TextInput
              style={[styles.input, styles.inputImproved, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
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

            {/* Reminder */}
            <View style={styles.reminderLabelRow}>
              <IconBell size={15} color={colors.textSecondary} />
              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginBottom: 0, marginLeft: 6 }]}>{t('calendar.reminder')}</Text>
            </View>
            <View style={styles.recurrenceRow}>
              {REMINDER_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[
                    styles.recurrenceChip,
                    { borderColor: colors.border, backgroundColor: reminder === opt.value ? colors.primary : colors.surface },
                  ]}
                  onPress={() => setReminder(opt.value)}
                >
                  <Text style={[styles.recurrenceChipText, { color: reminder === opt.value ? '#fff' : colors.text }]}>
                    {t(`calendar.reminder_${opt.value}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

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

// ---- Polished Empty State for Calendar ----
function CalendarEmptyState({ colors, isDark, t, onAdd }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 12, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start();
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <Animated.View style={[styles.emptyContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <View style={styles.emptyIconOuter}>
        <Animated.View style={[styles.emptyOuterRing, {
          borderColor: colors.primary + '10',
          transform: [{ scale: pulseAnim }],
        }]} />
        <Animated.View style={[styles.emptyMiddleRing, {
          borderColor: colors.primary + '18',
          transform: [{ scale: pulseAnim }],
        }]} />
        <Animated.View style={[styles.emptyIconWrap, {
          backgroundColor: colors.primary + '10',
          transform: [{ scale: scaleAnim }],
        }]}>
          <IconCalendar size={44} color={colors.primary} />
        </Animated.View>
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('calendar.noEventsThisDay')}</Text>
      <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
        {t('calendar.emptyDesc')}
      </Text>
      <TouchableOpacity
        onPress={onAdd}
        style={[styles.emptyAddBtn, { backgroundColor: colors.primary }]}
        activeOpacity={0.7}
      >
        <IconPlus size={18} color="#fff" />
        <Text style={styles.emptyAddBtnText}>{t('calendar.newEvent')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function CalendarScreenInner() {
  const { colors, isDark } = useTheme();
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
  const [calendarView, setCalendarView] = useState('month');
  const [weekStartDate, setWeekStartDate] = useState(() => getWeekStart(new Date()));

  // Load calendars on mount
  useEffect(() => {
    loadCalendars();
  }, []);

  // Load events when month changes
  useEffect(() => {
    loadEvents(true);
  }, [currentYear, currentMonth]);

  const loadCalendars = async () => {
    const cached = await getCached('calendars');
    if (cached?.data?.calendars) setCalendars(cached.data.calendars);
    try {
      const r = await api.calCalendars();
      if (r.success) {
        setCalendars(r.data?.calendars || []);
        setCache('calendars', r, 7776000000).catch(() => {});
      }
    } catch {}
  };

  const isMountedRef = useRef(true);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);
  const eventsRequestIdRef = useRef(0); // Race condition guard for month changes
  const loadEvents = useCallback(async (showLoader) => {
    const cacheKey = `calendar_events_${currentYear}_${currentMonth}`;
    const requestId = ++eventsRequestIdRef.current;
    // ALWAYS show cached data instantly (cache-first pattern)
    try {
      const cached = await getCached('calendar_events') || await getCached(cacheKey);
      if (cached?.data?.events) {
        if (requestId !== eventsRequestIdRef.current) return;
        setEvents(cached.data.events);
        setLoading(false);
        showLoader = false;
      } else if (showLoader) {
        setLoading(true);
      }
    } catch {
      if (showLoader) setLoading(true);
    }
    try {
      // Load a wider range: previous month through next month
      const start = new Date(currentYear, currentMonth - 1, 1);
      const end = new Date(currentYear, currentMonth + 2, 0);
      const r = await api.calEvents(formatDateForAPI(start), formatDateForAPI(end));
      if (requestId !== eventsRequestIdRef.current) return; // Stale request
      if (r.success) {
        setEvents(r.data?.events || []);
        setCache(cacheKey, r, 7776000000).catch(() => {});
        setCache('calendar_events', r, 7776000000).catch(() => {});
      }
    } catch {} finally {
      if (requestId === eventsRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
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
    const today = new Date();
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
    setSelectedDate(today);
    setWeekStartDate(getWeekStart(today));
  };

  const handlePrevWeek = () => {
    setWeekStartDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() - 7);
      return d;
    });
  };

  const handleNextWeek = () => {
    setWeekStartDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() + 7);
      return d;
    });
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

  // Quick-add: open add modal pre-filled with the tapped date
  const handleQuickAdd = (date) => {
    setSelectedDate(date);
    setShowAddModal(true);
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
        if (!FileSystem) {
          safeAlert(t('common.error'), 'File system not available');
          setImporting(false);
          return;
        }
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
        safeAlert(t('calendar.invalidFile'), t('calendar.invalidFileDesc'));
        setImporting(false);
        return;
      }

      const parsedEvents = parseICSEvents(icsContent);
      if (parsedEvents.length === 0) {
        safeAlert(t('calendar.noEvents'), t('calendar.noEventsInFile'));
        setImporting(false);
        return;
      }

      // Confirm import
      safeAlert(
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
              if (!isMountedRef.current) return;
              setImportResult({ total: parsedEvents.length, success, failed });
              setImporting(false);
              loadEvents(false);
              // Auto-clear result after 5s
              setTimeout(() => { if (isMountedRef.current) setImportResult(null); }, 5000);
            },
          },
        ]
      );
    } catch (err) {
      if (err?.message === 'cancelled') {
        setImporting(false);
        return;
      }
      safeAlert(t('common.error'), t('calendar.importFailed'));
      setImporting(false);
    }
  };

  // Export all visible month events as .ics
  const handleExportMonth = async () => {
    if (events.length === 0) {
      safeAlert(t('calendar.noEvents'), t('calendar.noEventsToExport'));
      return;
    }
    const icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Chatyy//Calendar//EN',
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
      if (!FileSystem) {
        safeAlert(t('common.error'), 'File system not available');
        return;
      }
      try {
        const fileName = `calendar_${MONTH_NAMES_FALLBACK[currentMonth]}_${currentYear}.ics`;
        const filePath = `${FileSystem.cacheDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(filePath, icsStr, { encoding: FileSystem.EncodingType.UTF8 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(filePath, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics' });
        }
      } catch {
        safeAlert(t('common.error'), t('calendar.exportFailed'));
      }
    }
  };

  const handleSubscribeCalendar = () => {
    const token = api.getAuthToken();
    if (!token) {
      safeAlert(t('common.error'), t('calendar.subscribeError'));
      return;
    }
    const icsUrl = api.calExportICSUrl(token);
    safeAlert(
      t('calendar.subscribe'),
      t('calendar.subscribeInstructions', { url: icsUrl }),
      [
        { text: t('calendar.copyUrl'), onPress: async () => {
          // Without await + catch, a permissions / insecure-context
          // failure was silently swallowed and the user got a "copied"
          // toast even though nothing landed on the clipboard.
          if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(icsUrl);
              safeAlert(t('calendar.urlCopied'));
            } catch {
              safeAlert(t('common.error') || 'Erro', icsUrl);
            }
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
      safeAlert(t('calendar.sync'), t('calendar.syncWebOnly'));
      return;
    }
    setSyncingDevice(true);
    try {
      const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
      setDeviceCalPermission(status);
      if (status !== 'granted') {
        safeAlert(t('calendar.permissionRequired'), t('calendar.permissionDesc'));
        setSyncingDevice(false);
        return;
      }

      const deviceCalendars = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      if (!deviceCalendars || deviceCalendars.length === 0) {
        safeAlert(t('calendar.noCalendars'), t('calendar.noCalendarsDesc'));
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
        safeAlert(t('calendar.synced'), t('calendar.allEventsSynced', { count: (deviceEvents || []).length }));
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
      if (!isMountedRef.current) return;
      setImportResult({ total: newEvents.length, success, failed });
      setSyncingDevice(false);
      loadEvents(false);
      setTimeout(() => { if (isMountedRef.current) setImportResult(null); }, 5000);
    } catch (err) {
      if (!isMountedRef.current) return;
      safeAlert(t('common.error'), t('calendar.syncFailed'));
      setSyncingDevice(false);
    }
  };

  // Push our events TO device calendar
  const handlePushToDevice = async () => {
    if (!ExpoCalendar || Platform.OS === 'web') {
      safeAlert(t('calendar.sync'), t('calendar.syncNativeOnly'));
      return;
    }
    setSyncingDevice(true);
    try {
      const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        safeAlert(t('calendar.permissionRequired'), t('calendar.permissionSettingsDesc'));
        setSyncingDevice(false);
        return;
      }

      // Find or create OneMundo calendar on device
      const deviceCalendars = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      let targetCalId = null;
      const existing = deviceCalendars.find(c => c.title === 'Chatyy');
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
          defaultSource = { isLocalAccount: true, name: 'Chatyy', type: 'LOCAL' };
        }
        if (defaultSource) {
          try {
            targetCalId = await ExpoCalendar.createCalendarAsync({
              title: 'Chatyy',
              color: '#2563eb',
              entityType: ExpoCalendar.EntityTypes.EVENT,
              source: defaultSource,
              name: 'Chatyy',
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
        safeAlert(t('common.error'), t('calendar.noCalendarOnDevice'));
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
        safeAlert(t('calendar.synced'), t('calendar.allEventsOnDevice'));
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

      if (isMountedRef.current) safeAlert(t('calendar.done'), t('calendar.eventsAddedToDevice', { count: success }));
    } catch {
      if (isMountedRef.current) safeAlert(t('common.error'), t('calendar.exportToDeviceFailed'));
    } finally {
      if (isMountedRef.current) setSyncingDevice(false);
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

  const handleSwipeEdit = (event) => {
    router.push(`/event-detail?id=${event.id}`);
    // Will open in edit mode via a small delay
  };

  const handleSwipeDelete = (event) => {
    safeAlert(
      t('eventDetail.deleteEvent'),
      t('eventDetail.deleteConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('eventDetail.deleteButton'),
          style: 'destructive',
          onPress: async () => {
            try {
              const r = await api.calDeleteEvent(event.id);
              if (r.success) {
                loadEvents(false);
              }
            } catch {}
          },
        },
      ]
    );
  };

  const handleJoinMeeting = useCallback((roomId) => {
    router.push('/meet/' + roomId);
  }, [router]);

  const renderEventItem = ({ item }) => (
    <SwipeableEventCard
      event={item}
      colors={colors}
      onPress={() => handleEventPress(item)}
      onEdit={handleSwipeEdit}
      onDelete={handleSwipeDelete}
      onJoinMeeting={handleJoinMeeting}
      t={t}
    />
  );

  const renderEmpty = () => {
    if (loading) return null;
    return <CalendarEmptyState colors={colors} isDark={isDark} t={t} onAdd={() => setShowAddModal(true)} />;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/calendar" }, "*"); } catch {} } else { router.back(); } }} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('calendar.title')}</Text>
        <View style={styles.headerRight}>
          {/* View Toggle */}
          <View style={[styles.viewToggle, { borderColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => setCalendarView('month')}
              style={[styles.viewToggleBtn, calendarView === 'month' && { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.viewToggleBtnText, { color: calendarView === 'month' ? '#fff' : colors.textSecondary }]}>
                {t('calendar.monthView')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setCalendarView('week')}
              style={[styles.viewToggleBtn, calendarView === 'week' && { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.viewToggleBtnText, { color: calendarView === 'week' ? '#fff' : colors.textSecondary }]}>
                {t('calendar.weekView')}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={handleToday} style={[styles.todayBtn, { borderColor: colors.border }]}>
            <Text style={[styles.todayBtnText, { color: colors.primary }]}>{t('calendar.today')}</Text>
          </TouchableOpacity>
          {Platform.OS !== 'web' && ExpoCalendar && (
            <TouchableOpacity
              onPress={handleSyncDeviceCalendar}
              disabled={syncingDevice}
              style={styles.headerBtn}
              accessibilityLabel={t('calendar.syncNow')}
            >
              {syncingDevice ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <IconRefresh size={20} color={colors.primary} />
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setShowAddModal(true)} style={styles.headerBtn}>
            <IconPlus size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {calendarView === 'week' ? (
        <WeekView
          weekStart={weekStartDate}
          events={events}
          colors={colors}
          onEventPress={handleEventPress}
          onPrevWeek={handlePrevWeek}
          onNextWeek={handleNextWeek}
          t={t}
        />
      ) : (
        <FlatList
          data={dayEvents}
          keyExtractor={(item) => String(item.id)}
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
                onQuickAdd={handleQuickAdd}
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
                <CalendarSkeleton />
              )}
            </>
          }
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[styles.list, dayEvents.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

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
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderBottomWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 16px rgba(0,0,0,0.05)', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' },
    }),
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '800', letterSpacing: -0.3 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  todayBtn: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: 12, borderWidth: 1.5,
  },
  todayBtnText: { fontSize: FontSize.sm, fontWeight: '700' },
  viewToggle: {
    flexDirection: 'row', borderWidth: 1.5, borderRadius: 12, overflow: 'hidden',
  },
  viewToggleBtn: {
    paddingHorizontal: Spacing.sm + 2, paddingVertical: Spacing.xs + 1,
  },
  viewToggleBtnText: { fontSize: FontSize.xs, fontWeight: '700' },

  // Calendar Grid
  calendarGrid: { paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm },
  monthHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm, marginBottom: Spacing.sm,
  },
  monthArrow: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  monthTitle: { fontSize: FontSize.lg + 2, fontWeight: '800', letterSpacing: -0.3 },
  dayHeaders: { flexDirection: 'row' },
  dayHeaderCell: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  dayHeaderText: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.5 },
  calendarRow: { flexDirection: 'row' },
  calendarCell: {
    flex: 1, alignItems: 'stretch', paddingVertical: 3, paddingHorizontal: 2, minHeight: 72,
    borderRadius: 10,
    ...Platform.select({
      web: { transition: 'background-color 0.2s ease, transform 0.15s ease' },
      default: {},
    }),
  },
  cellTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  cellAddBtn: {
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center', opacity: 0.4,
  },
  dayCellInner: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  dayCellText: { fontSize: FontSize.xs + 1, fontWeight: '500' },
  // Mini event previews in cells — colored pills
  cellEventPreviews: { marginTop: 2, gap: 2, paddingHorizontal: 1 },
  cellEventPreview: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderRadius: 4, paddingHorizontal: 3, paddingVertical: 1.5,
  },
  cellEventDot: { width: 5, height: 5, borderRadius: 2.5, flexShrink: 0 },
  cellEventText: { fontSize: 9, fontWeight: '600', flex: 1 },
  cellEventMore: { fontSize: 9, fontWeight: '700', paddingLeft: 2 },
  dotRow: { flexDirection: 'row', gap: 2, marginTop: 2 },
  eventDot: { width: 6, height: 6, borderRadius: 3 },

  // Day header
  dayHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: 1, marginTop: Spacing.xs,
  },
  dayHeaderTitle: { fontSize: FontSize.md, fontWeight: '600' },
  dayEventCount: { fontSize: FontSize.sm },

  // Swipe container
  swipeContainer: { position: 'relative', marginHorizontal: Spacing.md, marginBottom: Spacing.sm },
  swipeActions: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'stretch',
    borderRadius: BorderRadius.lg, overflow: 'hidden',
  },
  swipeActionLeft: {
    width: 80, alignItems: 'center', justifyContent: 'center', gap: 4,
    borderTopLeftRadius: BorderRadius.lg, borderBottomLeftRadius: BorderRadius.lg,
  },
  swipeActionRight: {
    width: 80, alignItems: 'center', justifyContent: 'center', gap: 4,
    borderTopRightRadius: BorderRadius.lg, borderBottomRightRadius: BorderRadius.lg,
  },
  swipeActionText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Event Card — frosted glass with colored left border
  eventCard: {
    borderRadius: 16,
    borderWidth: 0,
    flexDirection: 'row', alignItems: 'stretch',
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 16 },
      android: { elevation: 4 },
      web: {
        boxShadow: '0 4px 20px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04)',
        backdropFilter: 'blur(16px) saturate(120%)',
        WebkitBackdropFilter: 'blur(16px) saturate(120%)',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      },
    }),
  },
  eventCardAccent: {
    width: 5, borderTopLeftRadius: 16, borderBottomLeftRadius: 16,
  },
  eventCardBody: { flex: 1, gap: 7, paddingVertical: Spacing.md + 5, paddingHorizontal: Spacing.md + 6 },
  eventCardRight: { alignItems: 'flex-end', justifyContent: 'center', paddingVertical: Spacing.sm, paddingRight: Spacing.md },
  eventBadgesCol: { alignItems: 'flex-end', gap: 5 },
  eventTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  eventTitle: { fontSize: 16, fontWeight: '800', flexShrink: 1, letterSpacing: -0.3 },
  relTimeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  relTimeText: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.2 },
  eventMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  eventMetaText: { fontSize: FontSize.sm, letterSpacing: 0.1 },
  calBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full || 99,
  },
  calBadgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  joinMeetingBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#7C3AED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    marginTop: 6,
  },
  joinMeetingBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  syncBadgeSmall: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  reminderBadgeSmall: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },

  // Empty
  emptyContainer: {
    alignItems: 'center', paddingVertical: Spacing.xxl + 20, paddingHorizontal: Spacing.xl,
  },
  emptyIconOuter: {
    width: 160, height: 160,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  emptyOuterRing: {
    position: 'absolute', width: 160, height: 160, borderRadius: 80,
    borderWidth: 1.5,
  },
  emptyMiddleRing: {
    position: 'absolute', width: 130, height: 130, borderRadius: 65,
    borderWidth: 1.5,
  },
  emptyIconWrap: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 20px rgba(0,0,0,0.06)' },
    }),
  },
  emptyTitle: { fontSize: FontSize.lg + 2, fontWeight: '700', marginTop: Spacing.sm, letterSpacing: -0.2 },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs, opacity: 0.6, lineHeight: 20 },
  emptyAddBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    borderRadius: 16, marginTop: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: '#4F46E5', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 16px rgba(79,70,229,0.25)', transition: 'transform 0.15s ease' },
    }),
  },
  emptyAddBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },

  // List
  list: { paddingBottom: Spacing.xl },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { paddingVertical: Spacing.md, alignItems: 'center' },

  // Modal — frosted glass backdrop
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '92%', minHeight: '60%',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -8 }, shadowOpacity: 0.15, shadowRadius: 24 },
      android: { elevation: 16 },
      web: { boxShadow: '0 -8px 40px rgba(0,0,0,0.12)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
    }),
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalHeaderBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.2 },
  modalBody: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },

  // Form — rounded inputs
  input: {
    borderWidth: 1.5, borderRadius: 14,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 4,
    fontSize: FontSize.md, marginBottom: Spacing.sm,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease' } : {}),
  },
  inputLarge: { fontSize: FontSize.lg, fontWeight: '700', paddingVertical: Spacing.sm },
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

  // Reminder label
  reminderLabelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs, marginTop: Spacing.sm },

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

  // Month event count
  monthEventCount: { fontSize: FontSize.xs, fontWeight: '600', marginTop: 3, letterSpacing: 0.3, opacity: 0.7 },

  // Duration quick-select
  durationRow: {
    flexDirection: 'row', gap: Spacing.xs, flexWrap: 'wrap', marginBottom: Spacing.sm,
  },
  durationChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.xxl || 99, borderWidth: 1,
  },
  durationChipText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Improved inputs (bigger, clearer)
  inputImproved: {
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
    borderRadius: BorderRadius.lg || 12,
  },
});
