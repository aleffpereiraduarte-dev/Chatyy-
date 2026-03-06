import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconClock, IconCalendar, IconSend } from './Icons';

export default function ScheduleSendModal({ visible, onClose, onSchedule }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [customDate, setCustomDate] = useState('');

  const getOptions = () => {
    const now = new Date();
    const tomorrow8 = new Date(now);
    tomorrow8.setDate(tomorrow8.getDate() + 1);
    tomorrow8.setHours(8, 0, 0, 0);

    const monday8 = new Date(now);
    const d = (8 - monday8.getDay()) % 7 || 7;
    monday8.setDate(monday8.getDate() + d);
    monday8.setHours(8, 0, 0, 0);

    return [
      { label: t('schedule.tomorrowMorning'), sub: fmtFull(tomorrow8), date: tomorrow8 },
      { label: t('schedule.monday'), sub: fmtFull(monday8), date: monday8 },
    ];
  };

  const fmtFull = (d) => {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' ' +
      d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconClock size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>{t('schedule.title')}</Text>
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View style={s.body}>
            {getOptions().map((opt, i) => (
              <TouchableOpacity key={i} style={[s.option, { borderBottomColor: colors.borderLight }]}
                onPress={() => { onSchedule(opt.date.toISOString()); onClose(); }}>
                <IconSend size={18} color={colors.textSecondary} />
                <View style={s.optText}>
                  <Text style={[s.optLabel, { color: colors.text }]}>{opt.label}</Text>
                  <Text style={[s.optSub, { color: colors.textTertiary }]}>{opt.sub}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <View style={s.customSection}>
              <Text style={[s.customLabel, { color: colors.textSecondary }]}>{t('schedule.pickDateTime')}</Text>
              {Platform.OS === 'web' ? (
                <input type="datetime-local" value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  style={{ width: '100%', padding: 10, fontSize: 16, borderRadius: 8,
                    border: `1px solid ${colors.border}`, backgroundColor: colors.surfaceVariant,
                    color: colors.text, marginTop: 8, marginBottom: 12 }} />
              ) : (
                <Text style={{ color: colors.textTertiary, marginTop: 8 }}>{t('schedule.useWeb')}</Text>
              )}
              <TouchableOpacity
                style={[s.scheduleBtn, { backgroundColor: colors.primary }, !customDate && { opacity: 0.4 }]}
                onPress={() => { if (customDate) { onSchedule(new Date(customDate).toISOString()); onClose(); } }}
                disabled={!customDate}>
                <IconSend size={16} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.scheduleBtnText}>{t('schedule.schedule')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 400 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: 1 },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { paddingVertical: Spacing.sm },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  optText: { marginLeft: Spacing.md, flex: 1 },
  optLabel: { fontSize: FontSize.lg },
  optSub: { fontSize: FontSize.sm, marginTop: 2 },
  customSection: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
  customLabel: { fontSize: FontSize.base, fontWeight: '500' },
  scheduleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, paddingVertical: 12 },
  scheduleBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
});
