// NoteReminderSheet — "Lembrar-me" de uma nota (nível Apple Notes / Google Keep).
// [notas-lembrete 2026-10-14]
//
//   <NoteReminderSheet visible note={{id,title,content}} reminder={rem}
//      ensureNote={async () => ({id,title,content})} onClose={…} />
//
// Atalhos Hoje / Amanhã / Próxima semana + Personalizado (seletor NATIVO no
// iOS/Android, datetime-local no web) + repetição (não repete / diária /
// semanal / mensal). Quem dispara é o SERVIDOR (push em todos os aparelhos);
// services/noteReminders.js cuida do fallback local offline.
//
// NoteReminderChip — sino + horário p/ cartão da lista e cabeçalho do editor.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Sheet, ListRow, SegmentedControl, Button, useSurface, Type, Space, Radius } from '../ui';
import { IconBell, IconSun, IconMoon, IconCalendar, IconClock, IconRepeat } from '../Icons';
import {
  reminderPresets, setNoteReminder, clearNoteReminder, ensureNoteReminderPermission,
  formatNoteReminderShort, repeatLabel, reminderDisplayDate, reminderIsOverdue,
  NOTE_REMINDER_REPEATS,
} from '../../services/noteReminders';

let DateTimePicker = null;
if (Platform.OS !== 'web') {
  try { DateTimePicker = require('@react-native-community/datetimepicker').default; } catch {}
}

const tx = (t, k, p, fb) => { try { const v = t ? t(k, p) : null; return v && v !== k ? v : fb; } catch { return fb; } };

function errorText(t, code) {
  switch (code) {
    case 'past': return tx(t, 'noteReminder.errPast', null, 'Escolha um horário no futuro.');
    case 'note_required': return tx(t, 'noteReminder.errEmpty', null, 'Escreva algo na nota antes de adicionar um lembrete.');
    case 'not_found': return tx(t, 'noteReminder.errNotFound', null, 'Esta nota não existe mais.');
    case 'too_many': return tx(t, 'noteReminder.errTooMany', null, 'Você atingiu o limite de lembretes ativos.');
    default: return tx(t, 'noteReminder.errGeneric', null, 'Não foi possível salvar o lembrete. Tente de novo.');
  }
}

/** Chip compacto: sino + "Amanhã, 09:00" (+ ícone de repetição). */
export function NoteReminderChip({ reminder, t, color, style, compact = false }) {
  const s = useSurface();
  if (!reminder) return null;
  const d = reminderDisplayDate(reminder);
  if (!d) return null;
  const overdue = reminderIsOverdue(reminder);
  const fg = color || s.textSecondary;
  const label = formatNoteReminderShort(d, t);
  return (
    <View
      style={[st.chip, { borderColor: overdue ? s.separator : fg + '55' }, style]}
      accessibilityLabel={tx(t, 'noteReminder.chipA11y', { when: label }, `Lembrete: ${label}`)}
    >
      <IconBell size={compact ? 11 : 12} color={fg} />
      <Text numberOfLines={1} style={[st.chipText, { color: fg, textDecorationLine: overdue ? 'line-through' : 'none' }]}>
        {label}
      </Text>
      {reminder.repeat && reminder.repeat !== 'none' ? <IconRepeat size={compact ? 10 : 11} color={fg} /> : null}
    </View>
  );
}

export default function NoteReminderSheet({ visible, onClose, note, reminder, ensureNote, t, onSaved }) {
  const s = useSurface();
  const [repeat, setRepeat] = useState(reminder?.repeat || 'none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [permDenied, setPermDenied] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customDate, setCustomDate] = useState(null);
  const [androidMode, setAndroidMode] = useState(null); // 'date' | 'time' | null
  const [webValue, setWebValue] = useState('');

  useEffect(() => {
    if (!visible) return;
    setRepeat(reminder?.repeat || 'none');
    setError(null); setPermDenied(false); setBusy(false);
    setCustom(false); setAndroidMode(null);
    const base = reminderDisplayDate(reminder);
    const init = base && base.getTime() > Date.now() ? base : new Date(Date.now() + 60 * 60 * 1000);
    init.setSeconds(0, 0);
    setCustomDate(init);
    const p = (n) => String(n).padStart(2, '0');
    setWebValue(`${init.getFullYear()}-${p(init.getMonth() + 1)}-${p(init.getDate())}T${p(init.getHours())}:${p(init.getMinutes())}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const presets = useMemo(() => (visible ? reminderPresets(new Date()) : []), [visible]);
  const presetMeta = {
    today: { icon: IconSun, title: tx(t, 'noteReminder.presetToday', null, 'Hoje') },
    tomorrow: { icon: IconClock, title: tx(t, 'noteReminder.presetTomorrow', null, 'Amanhã') },
    nextWeek: { icon: IconCalendar, title: tx(t, 'noteReminder.presetNextWeek', null, 'Próxima semana') },
  };
  const repeatOptions = useMemo(() => NOTE_REMINDER_REPEATS.map((r) => ({
    value: r,
    label: r === 'none' ? tx(t, 'noteReminder.repeatNoneShort', null, 'Não repete')
      : r === 'daily' ? tx(t, 'noteReminder.repeatDailyShort', null, 'Diária')
        : r === 'weekly' ? tx(t, 'noteReminder.repeatWeeklyShort', null, 'Semanal')
          : tx(t, 'noteReminder.repeatMonthlyShort', null, 'Mensal'),
  })), [t]);

  const save = useCallback(async (date) => {
    if (busy) return;
    setError(null); setPermDenied(false);
    if (!(date instanceof Date) || isNaN(date.getTime())) { setError(errorText(t, 'invalid_time')); return; }
    if (repeat === 'none' && date.getTime() < Date.now() + 30 * 1000) { setError(errorText(t, 'past')); return; }
    setBusy(true);
    try {
      let target = note && note.id != null && !String(note.id).startsWith('local_') ? note : null;
      if (!target && ensureNote) target = await ensureNote();
      if (!target || target.id == null) { setError(errorText(t, 'note_required')); return; }
      const perm = await ensureNoteReminderPermission();
      const rem = await setNoteReminder(target, date, repeat);
      try { onSaved && onSaved(rem); } catch {}
      if (perm === 'denied') { setPermDenied(true); return; } // salvo (chega nos outros aparelhos); avisa aqui
      onClose && onClose();
    } catch (e) {
      setError(errorText(t, e?.code));
    } finally {
      setBusy(false);
    }
  }, [busy, note, ensureNote, repeat, t, onClose, onSaved]);

  const remove = useCallback(async () => {
    if (!note?.id) { onClose && onClose(); return; }
    setBusy(true);
    try { await clearNoteReminder(note.id); } catch {}
    setBusy(false);
    try { onSaved && onSaved(null); } catch {}
    onClose && onClose();
  }, [note, onClose, onSaved]);

  const openCustom = useCallback(() => {
    setError(null);
    if (Platform.OS === 'android') { setAndroidMode('date'); return; }
    setCustom(true);
  }, []);

  const onAndroidChange = useCallback((event, picked) => {
    const mode = androidMode;
    setAndroidMode(null);
    if (event?.type === 'dismissed' || !picked) return;
    const base = new Date(customDate || Date.now());
    if (mode === 'date') {
      base.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
      setCustomDate(base);
      setTimeout(() => setAndroidMode('time'), 50);
    } else {
      base.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
      setCustomDate(base);
      save(base);
    }
  }, [androidMode, customDate, save]);

  const current = reminderDisplayDate(reminder);
  const subtitle = reminder && current
    ? [formatNoteReminderShort(current, t), repeatLabel(reminder.repeat, t)].filter(Boolean).join(' · ')
    : tx(t, 'noteReminder.subtitle', null, 'Você recebe uma notificação em todos os seus aparelhos.');

  return (
    <Sheet
      visible={!!visible}
      onClose={busy ? undefined : onClose}
      title={tx(t, 'noteReminder.title', null, 'Lembrar-me')}
      subtitle={subtitle}
      scroll
      testID="note-reminder-sheet"
    >
      <View style={{ paddingHorizontal: Space.lg, paddingTop: Space.xs, paddingBottom: Space.sm }}>
        <View style={st.repeatHead}>
          <IconRepeat size={14} color={s.textSecondary} />
          <Text style={[Type.footnote, { color: s.textSecondary, marginLeft: 6 }]}>
            {tx(t, 'noteReminder.repeat', null, 'Repetir')}
          </Text>
        </View>
        <SegmentedControl options={repeatOptions} value={repeat} onChange={setRepeat} size="sm" />
      </View>

      {!custom && presets.map((p) => {
        const m = presetMeta[p.id];
        const Icon = p.id === 'today' && p.date.getHours() >= 20 ? IconMoon : m.icon;
        let time = '';
        try { time = p.id === 'nextWeek' ? formatNoteReminderShort(p.date, t) : p.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch {}
        return (
          <ListRow
            key={p.id}
            icon={Icon}
            title={m.title}
            value={time}
            disabled={busy}
            onPress={() => save(p.date)}
            testID={`note-reminder-${p.id}`}
          />
        );
      })}
      {!custom && (
        <ListRow
          icon={IconCalendar}
          title={tx(t, 'noteReminder.presetCustom', null, 'Escolher data e hora')}
          chevron
          disabled={busy}
          onPress={openCustom}
          testID="note-reminder-custom"
        />
      )}

      {custom && Platform.OS === 'ios' && DateTimePicker && customDate ? (
        <View style={{ paddingHorizontal: Space.lg, alignItems: 'center' }}>
          <DateTimePicker
            value={customDate}
            mode="datetime"
            display="inline"
            minimumDate={new Date()}
            themeVariant={s.isDark ? 'dark' : 'light'}
            accentColor={s.text}
            onChange={(_, v) => { if (v) setCustomDate(v); }}
          />
        </View>
      ) : null}
      {custom && Platform.OS === 'web' ? (
        <View style={{ paddingHorizontal: Space.lg, paddingVertical: Space.sm }}>
          {React.createElement('input', {
            type: 'datetime-local',
            value: webValue,
            min: (() => { const n = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`; })(),
            onChange: (e) => setWebValue(e.target.value),
            'aria-label': tx(t, 'noteReminder.presetCustom', null, 'Escolher data e hora'),
            style: {
              width: '100%', boxSizing: 'border-box', padding: 12, fontSize: 16, borderRadius: Radius.control,
              border: `1px solid ${s.separator}`, background: s.surfaceMuted || 'transparent', color: s.text,
              colorScheme: s.isDark ? 'dark' : 'light',
            },
          })}
        </View>
      ) : null}
      {custom ? (
        <View style={st.actions}>
          <Button variant="secondary" title={tx(t, 'common.back', null, 'Voltar')} onPress={() => setCustom(false)} disabled={busy} style={{ flex: 1 }} />
          <Button
            title={tx(t, 'noteReminder.save', null, 'Salvar lembrete')}
            loading={busy}
            style={{ flex: 1 }}
            onPress={() => {
              if (Platform.OS === 'web') { const d = new Date(webValue); save(d); } else save(customDate);
            }}
          />
        </View>
      ) : null}

      {Platform.OS === 'android' && androidMode && DateTimePicker && customDate ? (
        <DateTimePicker
          value={customDate}
          mode={androidMode}
          display="default"
          is24Hour
          minimumDate={androidMode === 'date' ? new Date() : undefined}
          onChange={onAndroidChange}
        />
      ) : null}

      {error ? (
        <Text style={[Type.footnote, st.msg, { color: s.danger }]} accessibilityLiveRegion="polite">{error}</Text>
      ) : null}
      {permDenied ? (
        <View style={[st.permBox, { backgroundColor: s.fill }]}>
          <Text style={[Type.footnote, { color: s.text, flex: 1 }]}>
            {tx(t, 'noteReminder.permDenied', null, 'Lembrete salvo, mas as notificações estão desativadas neste aparelho.')}
          </Text>
          <Pressable onPress={() => { try { Linking.openSettings(); } catch {} }} hitSlop={8} accessibilityRole="button">
            <Text style={[Type.footnote, { color: s.text, fontWeight: '600' }]}>{tx(t, 'noteReminder.openSettings', null, 'Abrir ajustes')}</Text>
          </Pressable>
        </View>
      ) : null}

      {reminder && !custom ? (
        <View style={{ paddingHorizontal: Space.lg, paddingTop: Space.sm }}>
          <Button variant="destructiveGhost" title={tx(t, 'noteReminder.remove', null, 'Remover lembrete')} onPress={remove} disabled={busy} fullWidth />
        </View>
      ) : null}
    </Sheet>
  );
}

const st = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 220,
  },
  chipText: { fontSize: 12, fontWeight: '500', letterSpacing: -0.1 },
  repeatHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  msg: { paddingHorizontal: 16, paddingTop: 8 },
  permBox: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12 },
});
