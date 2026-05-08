// Schedule a call — modal opened from the Calls tab. Picks date+time,
// title, participants (free-form email tokens), and duration. Auto-DMs
// each participant a system message via the backend.
import { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView, StyleSheet,
  Platform, Alert, ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { IconX, IconCalendar, IconClock, IconUserPlus } from './Icons';
import AvatarCircle from './AvatarCircle';

let DateTimePicker = null;
if (Platform.OS !== 'web') {
  try { DateTimePicker = require('@react-native-community/datetimepicker').default; } catch {}
}

const DURATIONS = [15, 30, 60, 90, 120];

function pad(n) { return String(n).padStart(2, '0'); }
function toLocalDateTimeInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleCallModal({ visible, onClose, onScheduled }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(30);
  // default 30 min from now to avoid past-time validation roundtrip
  const initialDate = (() => {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    d.setSeconds(0, 0);
    return d;
  })();
  const [scheduledDate, setScheduledDate] = useState(initialDate);
  const [showAndroidPicker, setShowAndroidPicker] = useState(false);
  const [androidPickerMode, setAndroidPickerMode] = useState('date');

  const [participantInput, setParticipantInput] = useState('');
  const [participants, setParticipants] = useState([]);
  // Suggestion list — basic chat_check_chatyy lookup by email/handle prefix.
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);
  // Recurrence stub — backend doesn't yet wire repeating jobs, but UI
  // captures intent and tags it onto the title so we can light it up
  // server-side later without a frontend deploy.
  const [recurrence, setRecurrence] = useState('none'); // 'none' | 'daily' | 'weekly'
  // Existing scheduled calls — loaded once when the modal opens so we can
  // warn if the picked time collides with another booking ±30min.
  const [otherCalls, setOtherCalls] = useState([]);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) {
      setTitle('');
      setDuration(30);
      const d = new Date(Date.now() + 30 * 60 * 1000);
      d.setSeconds(0, 0);
      setScheduledDate(d);
      setParticipantInput('');
      setParticipants([]);
      setSuggestions([]);
      setRecurrence('none');
      setOtherCalls([]);
    } else {
      // Best-effort prefetch of the user's already-scheduled calls so the
      // conflict check below has data. If the API errors out we silently
      // proceed without conflict warnings.
      if (api.callScheduleList) {
        api.callScheduleList().then(r => {
          if (r?.success) {
            const arr = r.data?.calls || r.data?.scheduled || r.data || [];
            setOtherCalls(Array.isArray(arr) ? arr : []);
          }
        }).catch(() => {});
      }
    }
  }, [visible]);

  // Local timezone label — surfaced under the date picker so the user
  // doesn't pick "10:00" thinking it's UTC. Falls back to the offset
  // when Intl isn't available (older RN runtimes).
  const tzLabel = (() => {
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        const opts = Intl.DateTimeFormat().resolvedOptions();
        if (opts?.timeZone) return opts.timeZone;
      }
    } catch {}
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const h = Math.floor(Math.abs(off) / 60);
    const m = Math.abs(off) % 60;
    return `UTC${sign}${pad(h)}:${pad(m)}`;
  })();

  // Conflict detection — flag if any existing call sits within 30 minutes
  // of the chosen slot. Uses the call's scheduled_at field; ignores its
  // duration on purpose to keep the check simple and predictable.
  const conflictCall = (() => {
    if (!otherCalls.length) return null;
    const target = scheduledDate.getTime();
    const WINDOW = 30 * 60 * 1000;
    for (const c of otherCalls) {
      const at = Date.parse(c?.scheduled_at || c?.scheduledAt || '');
      if (!at || isNaN(at)) continue;
      if (Math.abs(at - target) <= WINDOW) return c;
    }
    return null;
  })();

  // Suggestion lookup — debounced. Reuses chatCheckChatyy if available so
  // we hit the same discovery surface as /chat-new instead of inventing
  // a new endpoint.
  useEffect(() => {
    const q = participantInput.trim();
    if (!q || q.length < 2) { setSuggestions([]); return; }
    let cancelled = false;
    setSuggesting(true);
    const tm = setTimeout(async () => {
      try {
        // No dedicated suggestion endpoint — fall back to a simple check
        // call so the user gets validation hints without a 2nd round trip.
        // chatCheckChatyy expects a destructured object; route by '@'
        // presence so phone-style input still gets resolved.
        if (api.chatCheckChatyy) {
          const isEmail = q.includes('@');
          const res = await api.chatCheckChatyy(isEmail ? { email: q } : { phone: q });
          if (!cancelled && res?.success && res.data?.users) {
            setSuggestions(res.data.users.slice(0, 5));
          }
        }
      } catch {}
      if (!cancelled) setSuggesting(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(tm); };
  }, [participantInput]);

  const addParticipant = useCallback((rawEmail) => {
    const em = String(rawEmail || '').toLowerCase().trim();
    if (!em) return;
    if (!em.includes('@')) return;
    setParticipants(prev => prev.includes(em) ? prev : [...prev, em]);
    setParticipantInput('');
    setSuggestions([]);
  }, []);

  const removeParticipant = useCallback((em) => {
    setParticipants(prev => prev.filter(e => e !== em));
  }, []);

  const handleParticipantSubmit = useCallback(() => {
    const v = participantInput.trim();
    if (v) addParticipant(v);
  }, [participantInput, addParticipant]);

  const handleSubmit = useCallback(async () => {
    if (participants.length === 0) {
      const msg = t('calls.needParticipants') || 'Adicione ao menos um participante';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('', msg);
      return;
    }
    if (scheduledDate.getTime() < Date.now() - 30000) {
      const msg = t('calls.timeFuture') || 'Hora deve estar no futuro';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('', msg);
      return;
    }
    // If there's a nearby call, ask the user to confirm before booking
    // a colliding slot. They can still proceed; we just want a beat of
    // friction so accidental double-bookings don't slip through.
    if (conflictCall) {
      const ok = await new Promise(resolve => {
        const msg = (t('calls.conflictWarning') || 'Você já tem outra chamada perto desse horário. Continuar mesmo assim?');
        if (Platform.OS === 'web') {
          try { resolve(typeof window !== 'undefined' && window.confirm ? window.confirm(msg) : true); }
          catch { resolve(true); }
          return;
        }
        Alert.alert(
          t('calls.scheduleNew') || 'Agendar',
          msg,
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
            { text: t('common.continue') || 'Continuar', onPress: () => resolve(true) },
          ],
        );
      });
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      // Encode recurrence in the title as `[repeat:weekly]` so the
      // backend can pick it up later without breaking today's plain-title
      // codepath. None = stripped from the payload.
      const baseTitle = title.trim() || (t('calls.scheduled') || 'Chamada agendada');
      const finalTitle = recurrence !== 'none' ? `${baseTitle} [repeat:${recurrence}]` : baseTitle;
      const r = await api.callSchedule({
        participants,
        title: finalTitle,
        scheduledAt: scheduledDate.toISOString(),
        durationMin: duration,
      });
      if (r?.success) {
        onScheduled?.(r.data);
        onClose?.();
      } else {
        const msg = r?.message || 'Erro';
        if (Platform.OS === 'web') window.alert(msg);
        else Alert.alert('', msg);
      }
    } catch (e) {
      const msg = e?.message || 'Erro';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('', msg);
    } finally {
      setSubmitting(false);
    }
  }, [participants, scheduledDate, duration, title, t, onScheduled, onClose]);

  const handleAndroidDateChange = useCallback((event, value) => {
    setShowAndroidPicker(false);
    if (event?.type === 'dismissed' || !value) return;
    if (androidPickerMode === 'date') {
      const next = new Date(scheduledDate);
      next.setFullYear(value.getFullYear(), value.getMonth(), value.getDate());
      setScheduledDate(next);
      // Chain into time picker
      setAndroidPickerMode('time');
      setTimeout(() => setShowAndroidPicker(true), 100);
    } else {
      const next = new Date(scheduledDate);
      next.setHours(value.getHours(), value.getMinutes(), 0, 0);
      setScheduledDate(next);
    }
  }, [scheduledDate, androidPickerMode]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <View style={[styles.handle, { backgroundColor: colors.borderLight }]} />
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('calls.scheduleNew') || 'Agendar chamada'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <IconX size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
            {/* Title */}
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {t('calls.callTitle') || 'Título'}
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('calls.titlePlaceholder') || 'Reunião semanal'}
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
            />

            {/* Date+Time */}
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {t('calls.when') || 'Quando'}
            </Text>
            {Platform.OS === 'web' ? (
              <input
                type="datetime-local"
                value={toLocalDateTimeInput(scheduledDate)}
                min={toLocalDateTimeInput(new Date())}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  setScheduledDate(new Date(v));
                }}
                style={{
                  padding: 12, fontSize: 15, borderRadius: 8,
                  border: `1px solid ${colors.border}`, backgroundColor: colors.surface,
                  color: colors.text,
                }}
              />
            ) : Platform.OS === 'ios' && DateTimePicker ? (
              <View style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, padding: 0 }]}>
                <DateTimePicker
                  value={scheduledDate}
                  mode="datetime"
                  display="default"
                  minimumDate={new Date()}
                  onChange={(_, v) => v && setScheduledDate(v)}
                  themeVariant={isDark ? 'dark' : 'light'}
                />
              </View>
            ) : DateTimePicker ? (
              <>
                <TouchableOpacity
                  style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: 'row', alignItems: 'center' }]}
                  onPress={() => { setAndroidPickerMode('date'); setShowAndroidPicker(true); }}
                >
                  <IconCalendar size={16} color={colors.textSecondary} />
                  <Text style={{ color: colors.text, marginLeft: 8 }}>
                    {scheduledDate.toLocaleString()}
                  </Text>
                </TouchableOpacity>
                {showAndroidPicker && (
                  <DateTimePicker
                    value={scheduledDate}
                    mode={androidPickerMode}
                    display="default"
                    minimumDate={new Date()}
                    onChange={handleAndroidDateChange}
                  />
                )}
              </>
            ) : (
              <Text style={{ color: colors.text }}>{scheduledDate.toLocaleString()}</Text>
            )}

            {/* Timezone + conflict warning — surfaces under the picker so
                the user knows what zone they just picked in (no more "I
                meant 10am my time but it saved as UTC" support tickets). */}
            <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
              {(t('calls.timezone') || 'Fuso: {tz}').replace('{tz}', tzLabel)}
            </Text>
            {conflictCall && (
              <View style={{
                marginTop: 6, padding: 8, borderRadius: 8,
                backgroundColor: '#f59e0b22', borderLeftWidth: 3, borderLeftColor: '#f59e0b',
              }}>
                <Text style={{ fontSize: 12, color: '#b45309', fontWeight: '600' }}>
                  {(t('calls.conflictWarning') || '⚠ Você já tem outra chamada perto de {time}')
                    .replace('{time}', new Date(conflictCall.scheduled_at || conflictCall.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
                </Text>
              </View>
            )}

            {/* Recurrence — UI captures the intent and tags it onto the
                title so the backend can wire repeating jobs later without
                a frontend change. */}
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {t('calls.repeat') || 'Repetir'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { k: 'none',   label: t('calls.repeatNone')   || 'Não' },
                { k: 'daily',  label: t('calls.repeatDaily')  || 'Diário' },
                { k: 'weekly', label: t('calls.repeatWeekly') || 'Semanal' },
              ].map(opt => {
                const sel = recurrence === opt.k;
                return (
                  <TouchableOpacity
                    key={opt.k}
                    onPress={() => setRecurrence(opt.k)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: sel ? colors.primary : colors.surface,
                        borderColor: sel ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={{
                      color: sel ? '#fff' : colors.text,
                      fontSize: FontSize.sm, fontWeight: '600',
                    }}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Duration */}
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {t('calls.duration') || 'Duração'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {DURATIONS.map(d => {
                const sel = d === duration;
                return (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDuration(d)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: sel ? colors.primary : colors.surface,
                        borderColor: sel ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={{
                      color: sel ? '#fff' : colors.text,
                      fontSize: FontSize.sm, fontWeight: '600',
                    }}>
                      {d < 60 ? `${d}min` : `${Math.round(d/60)}h${d % 60 ? ` ${d % 60}m` : ''}`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Participants */}
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {t('calls.participants') || 'Participantes'}
            </Text>
            {participants.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {participants.map(em => (
                  <View key={em} style={[styles.peerChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <AvatarCircle email={em} size={20} />
                    <Text style={{ color: colors.text, fontSize: FontSize.sm, marginLeft: 6, marginRight: 4 }} numberOfLines={1}>
                      {em}
                    </Text>
                    <TouchableOpacity onPress={() => removeParticipant(em)} hitSlop={6}>
                      <IconX size={14} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TextInput
                value={participantInput}
                onChangeText={setParticipantInput}
                onSubmitEditing={handleParticipantSubmit}
                placeholder={t('calls.addEmail') || 'email@chatyy.com.br'}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                keyboardType="email-address"
                style={[styles.input, { flex: 1, color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, marginBottom: 0 }]}
              />
              <TouchableOpacity onPress={handleParticipantSubmit} style={[styles.addBtn, { backgroundColor: colors.primary }]}>
                <IconUserPlus size={16} color="#fff" />
              </TouchableOpacity>
            </View>
            {suggesting && (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 8 }} />
            )}
            {!!suggestions.length && (
              <View style={{ marginTop: 8, borderRadius: BorderRadius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
                {suggestions.map(s => {
                  const em = s?.email || '';
                  if (!em) return null;
                  return (
                    <TouchableOpacity
                      key={em}
                      onPress={() => addParticipant(em)}
                      style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8 }}
                    >
                      <AvatarCircle email={em} size={28} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: FontSize.sm }}>{s?.name || em}</Text>
                        <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs }}>{em}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* CTA */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              style={[styles.cta, { backgroundColor: submitting ? colors.surfaceVariant : colors.primary }]}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.ctaText}>{t('calls.schedule') || 'Agendar'}</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: Spacing.lg, paddingTop: 8, paddingBottom: 30,
    maxHeight: '92%',
    ...Shadow.lg,
  },
  handle: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 8,
  },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700' },
  label: { fontSize: FontSize.sm, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 15, marginBottom: 4,
  },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1,
  },
  peerChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1,
  },
  addBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  cta: {
    marginTop: 22, paddingVertical: 14, borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  ctaText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
});
