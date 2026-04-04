import { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, Switch, Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import {
  IconArrowLeft, IconX, IconPlus, IconClock, IconCalendar,
  IconVideo, IconCopy, IconCheck, IconChevronDown, IconChevronUp,
} from '../components/Icons';

let DateTimePicker = null;
if (Platform.OS !== 'web') {
  try { DateTimePicker = require('@react-native-community/datetimepicker').default; } catch {}
}

const DURATION_VALUES = [
  { label: '15min', value: 15 },
  { label: '30min', value: 30 },
  { label: '1h', value: 60 },
  { label: '1.5h', value: 90 },
  { label: '2h', value: 120 },
  { label: null, value: 0 },
];

const FREQUENCIES = ['none', 'daily', 'weekly', 'monthly'];

function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toISOLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function MeetingCreateScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const editMeetingId = params.edit || null;
  const [isEditMode, setIsEditMode] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  });
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [customDuration, setCustomDuration] = useState('');
  const [showCustomDuration, setShowCustomDuration] = useState(false);
  const [lobbyEnabled, setLobbyEnabled] = useState(true);
  const [recordMeeting, setRecordMeeting] = useState(false);
  const [meetingPassword, setMeetingPassword] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitees, setInvitees] = useState([]);
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const [frequency, setFrequency] = useState('none');
  const [untilDate, setUntilDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [successModal, setSuccessModal] = useState(null);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState({});

  // Load meeting data when in edit mode
  useEffect(() => {
    if (!editMeetingId) return;
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const res = await api.meetInfo(editMeetingId);
        if (!alive) return;
        const m = res?.data || res;
        if (m) {
          setIsEditMode(true);
          if (m.title) setTitle(m.title);
          if (m.description) setDescription(m.description);
          if (m.scheduled_at) setScheduledDate(new Date(m.scheduled_at));
          if (m.duration_minutes) setDurationMinutes(m.duration_minutes);
          if (m.lobby_enabled !== undefined) setLobbyEnabled(!!m.lobby_enabled);
          if (m.password) setMeetingPassword(m.password);
          if (m.invitees && Array.isArray(m.invitees)) setInvitees(m.invitees);
          if (m.recurrence?.frequency && m.recurrence.frequency !== 'none') {
            setFrequency(m.recurrence.frequency);
            if (m.recurrence.until_date) setUntilDate(m.recurrence.until_date);
          }
        }
      } catch (e) {
        console.warn('Failed to load meeting for edit:', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [editMeetingId]);

  const handleDurationSelect = useCallback((val) => {
    if (val === 0) {
      setShowCustomDuration(true);
      setDurationMinutes(0);
    } else {
      setShowCustomDuration(false);
      setCustomDuration('');
      setDurationMinutes(val);
    }
  }, []);

  const addInvitee = useCallback(() => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (invitees.some((i) => i.email === email)) return;
    setInvitees((prev) => [...prev, { email, name: '' }]);
    setInviteEmail('');
  }, [inviteEmail, invitees]);

  const removeInvitee = useCallback((email) => {
    setInvitees((prev) => prev.filter((i) => i.email !== email));
  }, []);

  const validate = useCallback(() => {
    const errs = {};
    if (!title.trim()) errs.title = t('meetingCreate.titleRequired');
    if (scheduledDate <= new Date()) errs.date = t('meetingCreate.dateMustBeFuture');
    const dur = showCustomDuration ? parseInt(customDuration, 10) : durationMinutes;
    if (!dur || dur < 5) errs.duration = t('meetingCreate.durationMinMinutes');
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [title, scheduledDate, durationMinutes, showCustomDuration, customDuration, t]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const dur = showCustomDuration ? parseInt(customDuration, 10) : durationMinutes;
      const payload = {
        title: title.trim(),
        description: description.trim() || undefined,
        scheduled_at: scheduledDate.toISOString(),
        duration_minutes: dur,
        lobby_enabled: lobbyEnabled,
        password: meetingPassword.trim() || undefined,
        invitees: invitees.length > 0 ? invitees : undefined,
        recurrence: frequency !== 'none' ? {
          frequency,
          interval_value: 1,
          until_date: untilDate || undefined,
        } : undefined,
      };
      let res;
      if (isEditMode && editMeetingId) {
        res = await api.meetUpdate(editMeetingId, payload);
      } else {
        res = await api.meetSchedule(payload);
      }
      if (res.success) {
        if (isEditMode) {
          router.back();
        } else {
          const d = res.data || res;
          setSuccessModal({
            link: d.join_url || d.meeting_link || `${BASE_URL}/meet/${d.room_id}`,
            roomId: d.room_id,
          });
        }
      } else {
        Alert.alert(t('common.error'), res.message || t('meetingCreate.scheduleFailed'));
      }
    } catch (e) {
      Alert.alert(t('common.error'), e.message || t('meetingCreate.connectionError'));
    } finally {
      setLoading(false);
    }
  }, [title, description, scheduledDate, durationMinutes, showCustomDuration, customDuration, lobbyEnabled, meetingPassword, invitees, frequency, untilDate, validate, isEditMode, editMeetingId, router]);

  const handleCopy = useCallback(async () => {
    if (!successModal?.link) return;
    try {
      if (Platform.OS === 'web' && navigator.clipboard) {
        await navigator.clipboard.writeText(successModal.link);
      } else {
        try {
          const Clipboard = require('expo-clipboard');
          await Clipboard.setStringAsync(successModal.link);
        } catch {}
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [successModal]);

  const handleDateChange = useCallback((event, selected) => {
    if (Platform.OS !== 'web') setShowDatePicker(false);
    if (selected) setScheduledDate(selected);
  }, []);

  const s = styles(colors);

  return (
    <KeyboardAvoidingView style={[s.container, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{isEditMode ? (t('meetingCreate.editTitle') || t('meetingCreate.title')) : t('meetingCreate.title')}</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Title */}
        <Text style={s.label}>{t('meetingCreate.titleLabel')}</Text>
        <TextInput
          style={[s.input, errors.title && s.inputError]}
          value={title}
          onChangeText={setTitle}
          placeholder={t('meetingCreate.titlePlaceholder')}
          placeholderTextColor={colors.textSecondary}
        />
        {errors.title && <Text style={s.errorText}>{errors.title}</Text>}

        {/* Description */}
        <Text style={s.label}>{t('meetingCreate.descriptionLabel')}</Text>
        <TextInput
          style={[s.input, s.inputMultiline]}
          value={description}
          onChangeText={setDescription}
          placeholder={t('meetingCreate.descriptionPlaceholder')}
          placeholderTextColor={colors.textSecondary}
          multiline
          numberOfLines={3}
        />

        {/* Date & Time */}
        <Text style={s.label}>{t('meetingCreate.dateTimeLabel')}</Text>
        {Platform.OS === 'web' ? (
          <View style={s.webDateWrap}>
            <input
              type="datetime-local"
              value={toISOLocal(scheduledDate)}
              onChange={(e) => { const d = new Date(e.target.value); if (!isNaN(d)) setScheduledDate(d); }}
              style={{ fontSize: 15, padding: 10, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.surface, color: colors.text, width: '100%', outline: 'none' }}
            />
          </View>
        ) : DateTimePicker ? (
          <>
            <TouchableOpacity style={s.dateBtn} onPress={() => setShowDatePicker(true)}>
              <IconCalendar size={18} color={colors.textSecondary} />
              <Text style={s.dateBtnText}>{formatDateTime(scheduledDate)}</Text>
            </TouchableOpacity>
            {showDatePicker && (
              <DateTimePicker value={scheduledDate} mode="datetime" display="default" onChange={handleDateChange} minimumDate={new Date()} />
            )}
          </>
        ) : (
          <TextInput
            style={[s.input, errors.date && s.inputError]}
            value={formatDateTime(scheduledDate)}
            onChangeText={(txt) => { const d = new Date(txt.replace(' ', 'T')); if (!isNaN(d)) setScheduledDate(d); }}
            placeholder="YYYY-MM-DD HH:MM"
            placeholderTextColor={colors.textSecondary}
          />
        )}
        {errors.date && <Text style={s.errorText}>{errors.date}</Text>}

        {/* Duration */}
        <Text style={s.label}>{t('meetingCreate.durationLabel')}</Text>
        <View style={s.pillRow}>
          {DURATION_VALUES.map((d) => {
            const active = d.value === 0 ? showCustomDuration : (!showCustomDuration && durationMinutes === d.value);
            const displayLabel = d.label || t('meetingCreate.durationCustom');
            return (
              <TouchableOpacity key={d.value} style={[s.pill, active && s.pillActive]} onPress={() => handleDurationSelect(d.value)}>
                <Text style={[s.pillText, active && s.pillTextActive]}>{displayLabel}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {showCustomDuration && (
          <TextInput
            style={[s.input, { marginTop: Spacing.sm }, errors.duration && s.inputError]}
            value={customDuration}
            onChangeText={setCustomDuration}
            placeholder={t('meetingCreate.customMinutesPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            keyboardType="numeric"
          />
        )}
        {errors.duration && <Text style={s.errorText}>{errors.duration}</Text>}

        {/* Toggles */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>{t('meetingCreate.lobbyLabel')}</Text>
              <Text style={s.toggleDesc}>{t('meetingCreate.lobbyDesc')}</Text>
            </View>
            <Switch value={lobbyEnabled} onValueChange={setLobbyEnabled} trackColor={{ true: colors.primary, false: colors.border }} thumbColor="#fff" />
          </View>
{/* Recording toggle hidden until feature is implemented */}
        </View>

        {/* Meeting Password */}
        <Text style={s.label}>{t('meetingCreate.passwordLabel')}</Text>
        <TextInput
          style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
          value={meetingPassword}
          onChangeText={setMeetingPassword}
          placeholder={t('meetingCreate.passwordPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={false}
          autoCapitalize="none"
        />

        {/* Invite Participants */}
        <Text style={s.label}>{t('meetingCreate.inviteLabel')}</Text>
        <View style={s.inviteRow}>
          <TextInput
            style={[s.input, { flex: 1, marginBottom: 0 }]}
            value={inviteEmail}
            onChangeText={setInviteEmail}
            placeholder="participante@email.com"
            placeholderTextColor={colors.textSecondary}
            keyboardType="email-address"
            autoCapitalize="none"
            onSubmitEditing={addInvitee}
          />
          <TouchableOpacity style={s.addBtn} onPress={addInvitee}>
            <IconPlus size={18} color="#fff" />
            <Text style={s.addBtnText}>{t('meetingCreate.addButton')}</Text>
          </TouchableOpacity>
        </View>
        {invitees.map((inv) => (
          <View key={inv.email} style={s.inviteeChip}>
            <Text style={s.inviteeEmail} numberOfLines={1}>{inv.email}</Text>
            <TouchableOpacity onPress={() => removeInvitee(inv.email)} hitSlop={8}>
              <IconX size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Recurrence */}
        <TouchableOpacity style={s.collapseHeader} onPress={() => setRecurrenceOpen((v) => !v)}>
          <Text style={s.label}>{t('meetingCreate.recurrenceLabel')}</Text>
          {recurrenceOpen ? <IconChevronUp size={18} color={colors.textSecondary} /> : <IconChevronDown size={18} color={colors.textSecondary} />}
        </TouchableOpacity>
        {recurrenceOpen && (
          <View style={s.recurrenceBody}>
            <View style={s.pillRow}>
              {FREQUENCIES.map((f) => {
                const freqLabelMap = { none: t('meetingCreate.freqNone'), daily: t('meetingCreate.freqDaily'), weekly: t('meetingCreate.freqWeekly'), monthly: t('meetingCreate.freqMonthly') };
                return (
                <TouchableOpacity key={f} style={[s.pill, frequency === f && s.pillActive]} onPress={() => setFrequency(f)}>
                  <Text style={[s.pillText, frequency === f && s.pillTextActive]}>
                    {freqLabelMap[f] || f}
                  </Text>
                </TouchableOpacity>
              );
              })}
            </View>
            {frequency !== 'none' && (
              <>
                <Text style={[s.label, { marginTop: Spacing.md }]}>{t('meetingCreate.endDateLabel')}</Text>
                <TextInput
                  style={s.input}
                  value={untilDate}
                  onChangeText={setUntilDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textSecondary}
                />
              </>
            )}
          </View>
        )}

        {/* Submit */}
        <TouchableOpacity style={[s.submitBtn, loading && { opacity: 0.6 }]} onPress={handleSubmit} disabled={loading} activeOpacity={0.8}>
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <IconVideo size={20} color="#fff" />
              <Text style={s.submitText}>{isEditMode ? (t('meetingCreate.updateButton') || t('meetingCreate.scheduleButton')) : t('meetingCreate.scheduleButton')}</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: Spacing.xxxl }} />
      </ScrollView>

      {/* Success Modal */}
      <Modal visible={!!successModal} transparent animationType="fade" onRequestClose={() => { setSuccessModal(null); router.back(); }}>
        <View style={s.modalOverlay}>
          <View style={[s.modalCard, { backgroundColor: colors.surface }]}>
            <View style={s.modalIconWrap}>
              <IconCheck size={32} color={colors.primary} />
            </View>
            <Text style={s.modalTitle}>{t('meetingCreate.successTitle')}</Text>
            <Text style={s.modalSubtitle}>{t('meetingCreate.successSubtitle')}</Text>
            <View style={s.linkBox}>
              <Text style={s.linkText} numberOfLines={2} selectable>{successModal?.link}</Text>
              <TouchableOpacity onPress={handleCopy} style={s.copyBtn}>
                {copied ? <IconCheck size={18} color={colors.primary} /> : <IconCopy size={18} color={colors.textSecondary} />}
              </TouchableOpacity>
            </View>
            {copied && <Text style={s.copiedText}>{t('meetingCreate.copied')}</Text>}
            <TouchableOpacity
              style={s.modalDoneBtn}
              onPress={() => { setSuccessModal(null); router.back(); }}
            >
              <Text style={s.modalDoneBtnText}>{t('meetingCreate.doneButton')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: FontSize.xxl, fontWeight: '600', color: colors.text },
  scroll: { flex: 1 },
  scrollContent: { padding: Spacing.lg },
  label: { fontSize: FontSize.base, fontWeight: '600', color: colors.text, marginBottom: Spacing.xs, marginTop: Spacing.lg },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    fontSize: FontSize.base, color: colors.text, ...Shadow.sm,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  inputError: { borderColor: colors.error },
  errorText: { color: colors.error, fontSize: FontSize.sm, marginTop: Spacing.xs },
  webDateWrap: { marginBottom: Spacing.xs },
  dateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    ...Shadow.sm,
  },
  dateBtnText: { fontSize: FontSize.base, color: colors.text },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  pill: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: FontSize.sm, color: colors.textSecondary, fontWeight: '500' },
  pillTextActive: { color: '#fff' },
  section: {
    marginTop: Spacing.xl, backgroundColor: colors.surface,
    borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: colors.border,
    ...Shadow.sm,
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  toggleLabel: { fontSize: FontSize.base, fontWeight: '500', color: colors.text },
  toggleDesc: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 2 },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    backgroundColor: colors.primary, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
  },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
  inviteeChip: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceVariant, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginTop: Spacing.sm,
  },
  inviteeEmail: { fontSize: FontSize.sm, color: colors.text, flex: 1, marginRight: Spacing.sm },
  collapseHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 0,
  },
  recurrenceBody: { marginTop: Spacing.sm },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: colors.primary, borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg, marginTop: Spacing.xxxl, ...Shadow.md,
  },
  submitText: { color: '#fff', fontSize: FontSize.xl, fontWeight: '700' },
  modalOverlay: {
    flex: 1, backgroundColor: colors.overlay,
    alignItems: 'center', justifyContent: 'center', padding: Spacing.xl,
  },
  modalCard: {
    width: '100%', maxWidth: 400, borderRadius: BorderRadius.xl,
    padding: Spacing.xxl, alignItems: 'center', ...Shadow.xl,
  },
  modalIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primaryLight || colors.surfaceVariant,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg,
  },
  modalTitle: { fontSize: FontSize.title, fontWeight: '700', color: colors.text, marginBottom: Spacing.sm },
  modalSubtitle: { fontSize: FontSize.base, color: colors.textSecondary, textAlign: 'center', marginBottom: Spacing.lg },
  linkBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceVariant,
    borderRadius: BorderRadius.md, padding: Spacing.md, width: '100%',
  },
  linkText: { flex: 1, fontSize: FontSize.sm, color: colors.text },
  copyBtn: { padding: Spacing.sm, marginLeft: Spacing.sm },
  copiedText: { color: colors.primary, fontSize: FontSize.sm, marginTop: Spacing.xs },
  modalDoneBtn: {
    marginTop: Spacing.xl, backgroundColor: colors.primary, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.xxxl, paddingVertical: Spacing.md,
  },
  modalDoneBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '600' },
});
