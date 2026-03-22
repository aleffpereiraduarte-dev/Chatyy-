import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconClock, IconCalendar } from './Icons';

function getSnoozeOptions(t) {
  const now = new Date();

  const inOneHour = new Date(now.getTime() + 3600000);

  const laterToday = new Date();
  laterToday.setHours(18, 0, 0, 0);
  if (laterToday <= now) laterToday.setDate(laterToday.getDate() + 1);

  const tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);

  const nextWeek = new Date();
  const daysUntilMon = (8 - nextWeek.getDay()) % 7 || 7;
  nextWeek.setDate(nextWeek.getDate() + daysUntilMon);
  nextWeek.setHours(9, 0, 0, 0);

  return [
    { label: t('snooze.inOneHour'), sub: formatTime(inOneHour), date: inOneHour, Icon: IconClock },
    { label: t('snooze.laterToday'), sub: formatTime(laterToday), date: laterToday, Icon: IconClock },
    { label: t('snooze.tomorrow9'), sub: formatDate(tomorrow9) + ' 09:00', date: tomorrow9, Icon: IconClock },
    { label: t('snooze.nextWeek'), sub: formatDate(nextWeek) + ' 09:00', date: nextWeek, Icon: IconCalendar },
  ];
}

function formatTime(d) { return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'); }
function formatDate(d) {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
  return days[d.getDay()] + ', ' + d.getDate() + '/' + (d.getMonth() + 1);
}

export default function SnoozePickerModal({ visible, onClose, onSnooze }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const options = getSnoozeOptions(t);

  const handleCustom = () => {
    if (customDate) {
      onSnooze(new Date(customDate).toISOString());
      setCustomDate('');
      setShowCustom(false);
    }
  };

  const handleClose = () => {
    setShowCustom(false);
    setCustomDate('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={handleClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconClock size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>{t('snooze.title')}</Text>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={s.body}>
            {options.map((opt, i) => (
              <TouchableOpacity
                key={i}
                style={[s.option, { borderBottomColor: colors.borderLight }]}
                onPress={() => { onSnooze(opt.date.toISOString()); handleClose(); }}
              >
                <opt.Icon size={20} color={colors.textSecondary} />
                <View style={s.optText}>
                  <Text style={[s.optLabel, { color: colors.text }]}>{opt.label}</Text>
                  <Text style={[s.optSub, { color: colors.textTertiary }]}>{opt.sub}</Text>
                </View>
              </TouchableOpacity>
            ))}

            {!showCustom ? (
              <TouchableOpacity
                style={[s.option, { borderBottomWidth: 0 }]}
                onPress={() => setShowCustom(true)}
              >
                <IconCalendar size={20} color={colors.primary} />
                <Text style={[s.optLabel, { color: colors.primary, marginLeft: Spacing.md }]}>{t('snooze.pickDateTime')}</Text>
              </TouchableOpacity>
            ) : (
              <View style={s.customSection}>
                {Platform.OS === 'web' ? (
                  <input
                    type="datetime-local"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                    style={{
                      width: '100%', padding: 10, fontSize: 16,
                      borderRadius: 8, border: `1px solid ${colors.border}`,
                      backgroundColor: colors.surfaceVariant, color: colors.text,
                      marginBottom: 12,
                    }}
                  />
                ) : (
                  <Text style={{ color: colors.textTertiary, marginBottom: 12 }}>Disponivel apenas na web</Text>
                )}
                <TouchableOpacity
                  style={[s.applyBtn, { backgroundColor: colors.primary }, !customDate && { opacity: 0.5 }]}
                  onPress={handleCustom}
                  disabled={!customDate}
                >
                  <Text style={s.applyBtnText}>{t('snooze.apply')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 400 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { paddingVertical: Spacing.sm },
  option: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optText: { marginLeft: Spacing.md, flex: 1 },
  optLabel: { fontSize: FontSize.lg },
  optSub: { fontSize: FontSize.sm, marginTop: 2 },
  customSection: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
  applyBtn: { borderRadius: BorderRadius.md, paddingVertical: 12, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
});
