import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ScrollView, Switch, Platform, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconMail, IconCalendar, IconCheckCircle } from './Icons';
import * as api from '../services/api';

export default function VacationResponder({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const successTimerRef = useRef(null);

  useEffect(() => {
    if (visible) {
      loadSettings();
    }
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, [visible]);

  const loadSettings = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.apiCall('vacation_get');
      if (r.success && r.data) {
        setEnabled(!!r.data.enabled);
        setSubject(r.data.subject || '');
        setBody(r.data.body || '');
        setStartDate(r.data.start_date || '');
        setEndDate(r.data.end_date || '');
      }
    } catch {
      setError(t('vacation.loadError'));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const r = await api.apiCall('vacation_set', {
        enabled,
        subject,
        body,
        start_date: startDate,
        end_date: endDate,
      }, 'POST');
      if (r.success) {
        setSuccess(t('vacation.saved'));
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setSuccess(''), 3000);
      } else {
        setError(r.message || t('vacation.saveError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setError('');
    setSuccess('');
    onClose();
  };

  const renderDateInput = (value, onChange, placeholder) => {
    if (Platform.OS === 'web') {
      return (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%', padding: 10, fontSize: 14,
            borderRadius: 8, border: `1px solid ${colors.border}`,
            backgroundColor: colors.surfaceVariant, color: colors.text,
            boxSizing: 'border-box',
          }}
        />
      );
    }
    return (
      <TextInput
        style={[s.input, { backgroundColor: colors.surfaceVariant, borderColor: colors.border, color: colors.text }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder + ' (AAAA-MM-DD)'}
        placeholderTextColor={colors.textTertiary}
      />
    );
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <TouchableOpacity style={s.overlay} onPress={handleClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconMail size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>{t('vacation.title')}</Text>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={s.loadingContainer}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <ScrollView style={s.scrollBody} contentContainerStyle={s.bodyContent}>
              {error ? (
                <View style={[s.errorBox, { backgroundColor: colors.errorBg }]}>
                  <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                </View>
              ) : null}

              {success ? (
                <View style={[s.successBox, { backgroundColor: colors.successBg }]}>
                  <IconCheckCircle size={16} color={colors.success} style={{ marginRight: 6 }} />
                  <Text style={[s.successText, { color: colors.success }]}>{success}</Text>
                </View>
              ) : null}

              {/* Enable toggle */}
              <View style={[s.toggleRow, { borderBottomColor: colors.borderLight }]}>
                <View style={s.toggleInfo}>
                  <Text style={[s.toggleLabel, { color: colors.text }]}>{t('vacation.title')}</Text>
                  <Text style={[s.toggleDesc, { color: colors.textTertiary }]}>
                    {enabled ? t('vacation.activeDesc') : t('vacation.inactiveDesc')}
                  </Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={setEnabled}
                  trackColor={{ false: colors.border, true: colors.primaryLight }}
                  thumbColor={enabled ? colors.primary : colors.textTertiary}
                />
              </View>

              {/* Subject */}
              <View style={s.field}>
                <Text style={[s.label, { color: colors.textSecondary }]}>{t('compose.subject')}</Text>
                <TextInput
                  style={[s.input, { backgroundColor: colors.surfaceVariant, borderColor: colors.border, color: colors.text }]}
                  value={subject}
                  onChangeText={setSubject}
                  placeholder={t('vacation.subjectPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                />
              </View>

              {/* Body */}
              <View style={s.field}>
                <Text style={[s.label, { color: colors.textSecondary }]}>{t('vacation.message')}</Text>
                <TextInput
                  style={[s.textArea, { backgroundColor: colors.surfaceVariant, borderColor: colors.border, color: colors.text }]}
                  value={body}
                  onChangeText={setBody}
                  placeholder={t('vacation.bodyPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                />
              </View>

              {/* Date range */}
              <View style={s.dateRow}>
                <View style={s.dateField}>
                  <Text style={[s.label, { color: colors.textSecondary }]}>
                    <IconCalendar size={14} color={colors.textSecondary} /> {t('vacation.startDate')}
                  </Text>
                  {renderDateInput(startDate, setStartDate, t('vacation.startDate'))}
                </View>
                <View style={s.dateField}>
                  <Text style={[s.label, { color: colors.textSecondary }]}>
                    <IconCalendar size={14} color={colors.textSecondary} /> {t('vacation.endDate')}
                  </Text>
                  {renderDateInput(endDate, setEndDate, t('vacation.endDate'))}
                </View>
              </View>

              {/* Save */}
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: colors.primary }]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={s.saveBtnText}>{t('settings.save')}</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 480, maxHeight: '85%' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  loadingContainer: { padding: Spacing.xxxl, alignItems: 'center' },
  scrollBody: { flex: 1 },
  bodyContent: { padding: Spacing.xl, paddingBottom: Spacing.xxxl },
  // Toggle
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.lg, marginBottom: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleInfo: { flex: 1, marginRight: Spacing.lg },
  toggleLabel: { fontSize: FontSize.lg, fontWeight: '600' },
  toggleDesc: { fontSize: FontSize.sm, marginTop: 2 },
  // Fields
  field: { marginBottom: Spacing.lg },
  label: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    fontSize: FontSize.base, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg,
  },
  textArea: {
    fontSize: FontSize.base, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg,
    minHeight: 120,
  },
  // Dates
  dateRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  dateField: { flex: 1 },
  // Save
  saveBtn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, paddingVertical: 14,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  // Error / Success
  errorBox: {
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, marginBottom: Spacing.lg,
  },
  errorText: { fontSize: FontSize.sm, fontWeight: '500' },
  successBox: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, marginBottom: Spacing.lg,
  },
  successText: { fontSize: FontSize.sm, fontWeight: '500' },
});
