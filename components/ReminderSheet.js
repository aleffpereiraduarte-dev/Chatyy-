// ============================================================
// ReminderSheet — confirmation sheet for the chat "Criar lembrete" smart
// action. Shows the parsed date ("amanhã às 08:00"), quick-adjust chips, a
// full date/time wheel picker, and surfaces EVERY error inline (permission
// denied → "Abrir ajustes"). WhatsApp/Google-Messages feel: one tap to
// confirm when the parse was right, one more to adjust when it wasn't.
// ============================================================
import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, ActivityIndicator, Linking, Platform, StyleSheet } from 'react-native';
import { Shadow } from '../constants/theme';
import { IconClock, IconX } from './Icons';
import { DateTimePickerModal } from './ScheduleModals';
import { formatReminderWhen, reminderErrorKey, REMINDER_DEFAULTS as _RD } from '../services/reminders';
// [2026-10-06 HOTFIX P0] fallback defensivo: nunca deixar um import quebrado
// derrubar a tela da conversa (o sheet é montado sempre, mesmo fechado).
const REMINDER_DEFAULTS = _RD || { morning: 8, lunch: 12, afternoon: 14, evening: 20, endOfDay: 18, none: 9 };

function at(base, hour, minute = 0) { const d = new Date(base); d.setHours(hour, minute, 0, 0); return d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/**
 * props: visible, onClose, text, initialWhen (Date), colors, t,
 *        onConfirm(date) → Promise (throws ReminderError on failure)
 */
export default function ReminderSheet({ visible, onClose, text, initialWhen, colors, t, onConfirm }) {
  // Inner is remounted on every open so its state (when/error/busy) is fresh.
  return visible ? <ReminderSheetInner onClose={onClose} text={text} initialWhen={initialWhen} colors={colors} t={t} onConfirm={onConfirm} /> : null;
}

function ReminderSheetInner({ onClose, text, initialWhen, colors, t, onConfirm }) {
  const now = useMemo(() => new Date(), []);
  const safeInitial = initialWhen instanceof Date && !isNaN(initialWhen) && initialWhen.getTime() > now.getTime() + 60000
    ? initialWhen
    : at(addDays(now, 1), REMINDER_DEFAULTS.none);
  const [when, setWhen] = useState(safeInitial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { key, code }
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => { setError(null); }, [when]);

  const tt = (k, p, fb) => { const v = t ? t(k, p) : null; return v && v !== k ? v : fb; };

  const chips = useMemo(() => {
    const list = [
      { key: 'in1h', label: tt('reminder.chipIn1h', null, 'Em 1 hora'), date: new Date(now.getTime() + 3600000) },
      { key: 'in3h', label: tt('reminder.chipIn3h', null, 'Em 3 horas'), date: new Date(now.getTime() + 3 * 3600000) },
      { key: 'tonight', label: tt('reminder.chipTonight', null, 'Hoje à noite'), date: at(now, REMINDER_DEFAULTS.evening) },
      { key: 'tmrwMorning', label: tt('reminder.chipTomorrowMorning', null, 'Amanhã de manhã'), date: at(addDays(now, 1), REMINDER_DEFAULTS.morning) },
      { key: 'tmrwAfternoon', label: tt('reminder.chipTomorrowAfternoon', null, 'Amanhã à tarde'), date: at(addDays(now, 1), REMINDER_DEFAULTS.afternoon) },
    ];
    for (const c of list) { c.date.setSeconds(0, 0); }
    return list.filter(c => c.date.getTime() > now.getTime() + 60000);
  }, [now]);

  const isPast = when.getTime() <= Date.now() + 5000;
  const whenLabel = formatReminderWhen(when, t, now);
  const selectedChip = chips.find(c => Math.abs(c.date.getTime() - when.getTime()) < 60000)?.key || null;

  const confirm = async () => {
    if (busy) return;
    if (isPast) { setError({ key: 'reminder.errPast', code: 'past' }); return; }
    setBusy(true); setError(null);
    try {
      await onConfirm(when);
    } catch (e) {
      setError({ key: reminderErrorKey(e), code: e?.code || 'generic', detail: e?.code ? null : (e?.message || '') });
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => { try { Linking.openSettings(); } catch {} };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={st.overlay} onPress={busy ? undefined : onClose}>
        <Pressable style={[st.sheet, { backgroundColor: colors.surface }, Shadow.lg]} onPress={() => {}}>
          <View style={st.headerRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconClock size={18} color={colors.primary} />
              <Text style={[st.title, { color: colors.text }]}>{tt('reminder.title', null, 'Criar lembrete')}</Text>
            </View>
            <TouchableOpacity onPress={onClose} disabled={busy} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.close', null, 'Fechar')}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {!!text && (
            <View style={[st.quote, { borderLeftColor: colors.primary, backgroundColor: colors.primary + '12' }]}>
              <Text numberOfLines={3} style={{ fontSize: 13.5, color: colors.text, lineHeight: 19 }}>{text}</Text>
            </View>
          )}

          <Text style={[st.label, { color: colors.textSecondary }]}>{tt('reminder.whenLabel', null, 'Quando')}</Text>
          <TouchableOpacity onPress={() => setShowPicker(true)} disabled={busy} activeOpacity={0.75}
            accessibilityRole="button"
            style={[st.whenBox, { borderColor: isPast ? '#ef4444' : colors.border, backgroundColor: colors.background }]}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, textTransform: 'capitalize' }}>{whenLabel}</Text>
            <Text style={{ fontSize: 12.5, color: colors.primary, fontWeight: '600' }}>{tt('reminder.adjust', null, 'Ajustar')}</Text>
          </TouchableOpacity>

          <View style={st.chips}>
            {chips.map(c => {
              const on = selectedChip === c.key;
              return (
                <TouchableOpacity key={c.key} onPress={() => setWhen(c.date)} disabled={busy} activeOpacity={0.7}
                  style={[st.chip, { backgroundColor: on ? colors.primary : colors.primary + '14', borderColor: on ? colors.primary : colors.primary + '40' }]}>
                  <Text style={{ fontSize: 12.5, fontWeight: '600', color: on ? '#fff' : colors.primary }}>{c.label}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={() => setShowPicker(true)} disabled={busy} activeOpacity={0.7}
              style={[st.chip, { backgroundColor: 'transparent', borderColor: colors.border }]}>
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: colors.text }}>{tt('reminder.chipCustom', null, 'Escolher data e hora')}</Text>
            </TouchableOpacity>
          </View>

          {!!error && (
            <View style={[st.errorBox, { backgroundColor: '#ef44441a', borderColor: '#ef444455' }]}>
              <Text style={{ color: '#b91c1c', fontSize: 13, lineHeight: 18 }}>
                {tt(error.key, null, 'Não foi possível criar o lembrete.')}{error.detail ? `\n${error.detail}` : ''}
              </Text>
              {error.code === 'permission' && Platform.OS !== 'web' && (
                <TouchableOpacity onPress={openSettings} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                  <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>{tt('reminder.openSettings', null, 'Abrir ajustes')}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <View style={st.actions}>
            <TouchableOpacity onPress={onClose} disabled={busy} style={st.btnGhost}>
              <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>{tt('common.cancel', null, 'Cancelar')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={confirm} disabled={busy || isPast} activeOpacity={0.8}
              accessibilityRole="button"
              style={[st.btnPrimary, { backgroundColor: colors.primary, opacity: (busy || isPast) ? 0.6 : 1 }]}>
              {busy ? <ActivityIndicator color="#fff" size="small" /> : (
                <Text style={{ color: '#fff', fontWeight: '700' }}>{tt('reminder.create', null, 'Criar lembrete')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>

      <DateTimePickerModal
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        initial={when}
        minDate={new Date(Date.now() + 60000)}
        onConfirm={(d) => { if (d instanceof Date && !isNaN(d)) setWhen(d); }}
        colors={colors}
        t={t}
        title={tt('reminder.pickTitle', null, 'Data e hora do lembrete')}
      />
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 16, paddingBottom: Platform.OS === 'ios' ? 34 : androidBottomInset(20), maxWidth: 560, width: '100%', alignSelf: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '700' },
  quote: { borderLeftWidth: 3, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  whenBox: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1 },
  errorBox: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  btnGhost: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 10 },
  btnPrimary: { paddingVertical: 11, paddingHorizontal: 18, borderRadius: 10, minWidth: 140, alignItems: 'center', justifyContent: 'center' },
});
