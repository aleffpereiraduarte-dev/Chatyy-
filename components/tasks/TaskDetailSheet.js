// [2026-10-13 tarefas] Detalhe/edição da tarefa (folha estilo Lembretes, P&B):
// título, notas, prazo (atalhos + linguagem natural "sexta 15h"), lembrete,
// prioridade, sinalizada, lista, subtarefas, abrir e-mail de origem, apagar.
// Recursos que dependem do servidor v2 (lembrete/prioridade/lista/subtarefas/
// sinalizada) só aparecem quando `v2`.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, Pressable, ScrollView, StyleSheet,
  Platform, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconTrash, IconMail, IconBell, IconCalendar, IconFlag, IconPlus } from '../Icons';
import NativeSwitch from '../NativeSwitch';
import TaskCheck from './TaskCheck';
import { parseCalDate, startOfDay, addDays, hhmm } from '../../utils/calDate';
import { parseTaskInput, dueLabel, toIso, dueToServer, dueDate } from '../../utils/taskUtils';
import { haptic } from '../../constants/theme';

function Chip({ label, active, onPress, g, icon }) {
  return (
    <TouchableOpacity
      onPress={() => { haptic.select(); onPress(); }}
      style={[s.chip, { backgroundColor: active ? g.ink : g.fill }]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      {icon}
      <Text style={[s.chipText, { color: active ? g.onInk : g.text }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function Section({ title, g, children, right }) {
  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
        <Text style={[s.sectionTitle, { color: g.header }]}>{title}</Text>
        {right}
      </View>
      <View style={[s.card, { backgroundColor: g.cardBg }]}>{children}</View>
    </View>
  );
}

export default function TaskDetailSheet({
  visible, task, subtasks = [], lists = [], v2, g, t, locale,
  onClose, onSave, onDelete, onToggleSub, onAddSub, onDeleteSub, onOpenEmail,
}) {
  const insets = useSafeAreaInsets();
  const tt = (k, fb) => (t && t(k)) || fb;
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [due, setDue] = useState(null); // Date | null
  const [allDay, setAllDay] = useState(true);
  const [remind, setRemind] = useState(null); // Date | null
  const [priority, setPriority] = useState(0);
  const [flagged, setFlagged] = useState(false);
  const [listId, setListId] = useState(null);
  const [nl, setNl] = useState('');
  const [subTitle, setSubTitle] = useState('');
  const seededFor = useRef(null);

  useEffect(() => {
    if (!visible) { seededFor.current = null; return; }
    if (!task || seededFor.current === task.id) return;
    seededFor.current = task.id;
    setTitle(task.title || '');
    setNotes(task.notes || '');
    setDue(dueDate(task));
    setAllDay(!!task.due_all_day || !task.due_at);
    const r = task.remind_at ? parseCalDate(task.remind_at) : null;
    setRemind(r && Number.isFinite(r.getTime()) ? r : null);
    setPriority(task.priority || 0);
    setFlagged(!!task.flagged);
    setListId(task.list_id || null);
    setNl('');
    setSubTitle('');
  }, [visible, task]);

  const now = new Date();
  const setDueDay = (day) => {
    if (!day) { setDue(null); setAllDay(true); setRemind(null); return; }
    const d = new Date(day);
    if (allDay || !due) d.setHours(12, 0, 0, 0);
    else d.setHours(due.getHours(), due.getMinutes(), 0, 0);
    setDue(d);
  };
  const setDueTime = (h, m) => {
    const d = new Date(due || startOfDay(now));
    if (h == null) { d.setHours(12, 0, 0, 0); setAllDay(true); }
    else { d.setHours(h, m || 0, 0, 0); setAllDay(false); }
    setDue(d);
  };
  const applyNl = () => {
    const r = parseTaskInput(nl, new Date());
    if (r?.due) { setDue(r.due); setAllDay(!r.hasTime); haptic.success(); }
    if (r?.priority) setPriority(r.priority);
    setNl('');
  };

  const remindOptions = useMemo(() => {
    if (due && !allDay) {
      return [
        { key: 'at', label: tt('tasks.remindAtTime', 'Na hora'), date: new Date(due) },
        { key: '15', label: tt('tasks.remind15', '15 min antes'), date: new Date(due.getTime() - 15 * 60000) },
        { key: '60', label: tt('tasks.remind60', '1 h antes'), date: new Date(due.getTime() - 60 * 60000) },
        { key: '1d', label: tt('tasks.remind1d', '1 dia antes'), date: new Date(due.getTime() - 86400000) },
      ];
    }
    const base = due ? new Date(due) : new Date(now);
    const morning = new Date(base); morning.setHours(9, 0, 0, 0);
    const opts = [];
    if (!due) opts.push({ key: '1h', label: tt('tasks.remindIn1h', 'Em 1 hora'), date: new Date(now.getTime() + 3600000) });
    if (morning > now) opts.push({ key: 'm', label: (due ? dueLabel({ due_at: dueToServer(morning, true), due_all_day: true }, t, locale) : tt('tasks.today', 'Hoje')) + ' 09:00', date: morning });
    const evening = new Date(base); evening.setHours(18, 0, 0, 0);
    if (evening > now) opts.push({ key: 'e', label: (due ? dueLabel({ due_at: dueToServer(evening, true), due_all_day: true }, t, locale) : tt('tasks.today', 'Hoje')) + ' 18:00', date: evening });
    const tm = addDays(startOfDay(now), 1); tm.setHours(9, 0, 0, 0);
    if (!due) opts.push({ key: 'tm', label: tt('tasks.tomorrow', 'Amanhã') + ' 09:00', date: tm });
    return opts;
  }, [due, allDay]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = () => {
    const fields = {};
    const tr = title.trim();
    if (tr && tr !== task.title) fields.title = tr;
    if (notes !== (task.notes || '')) fields.notes = notes;
    const dueIso = due ? dueToServer(due, allDay) : null;
    const oldDue = dueDate(task)?.getTime() ?? null;
    if ((due ? due.getTime() : null) !== oldDue || (!!allDay && !!due) !== !!task.due_all_day) {
      fields.due_at = dueIso;
      fields.due_all_day = !!due && allDay;
    }
    if (v2) {
      const oldRem = task.remind_at ? parseCalDate(task.remind_at).getTime() : null;
      if ((remind ? remind.getTime() : null) !== oldRem) fields.remind_at = remind ? toIso(remind) : null;
      if (priority !== (task.priority || 0)) fields.priority = priority;
      if (flagged !== !!task.flagged) fields.flagged = flagged;
      if ((listId || null) !== (task.list_id || null)) fields.list_id = listId || null;
    }
    onSave(fields);
  };

  if (!task) return null;
  const PRI = [
    { v: 0, l: tt('tasks.priority.none', 'Nenhuma') },
    { v: 1, l: tt('tasks.priority.low', 'Baixa') },
    { v: 2, l: tt('tasks.priority.medium', 'Média') },
    { v: 3, l: tt('tasks.priority.high', 'Alta') },
  ];
  const remindLabel = remind
    ? dueLabel({ due_at: remind.toISOString(), due_all_day: false }, t, locale)
    : tt('tasks.noReminder', 'Sem lembrete');

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={tt('common.close', 'Fechar')} />
          <View style={[s.sheet, { backgroundColor: g.pageBg, paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={s.grabber}><View style={[s.grabberBar, { backgroundColor: g.tertiary }]} /></View>
            <View style={s.header}>
              <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.cancel', 'Cancelar')}>
                <Text style={[s.headerBtn, { color: g.secondary }]}>{tt('common.cancel', 'Cancelar')}</Text>
              </TouchableOpacity>
              <Text style={[s.headerTitle, { color: g.text }]}>{tt('tasks.details', 'Detalhes')}</Text>
              <TouchableOpacity onPress={handleSave} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.done', 'OK')}>
                <Text style={[s.headerBtn, { color: g.ink, fontWeight: '700' }]}>{tt('common.done', 'OK')}</Text>
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
              <View style={[s.card, { backgroundColor: g.cardBg, marginHorizontal: 16 }]}>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  style={[s.titleInput, { color: g.text }]}
                  placeholder={tt('tasks.titlePlaceholder', 'Título')}
                  placeholderTextColor={g.secondary}
                  multiline
                />
                <View style={[s.sep, { backgroundColor: g.separator }]} />
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  style={[s.notesInput, { color: g.text }]}
                  placeholder={tt('tasks.notesPlaceholder', 'Notas')}
                  placeholderTextColor={g.secondary}
                  multiline
                />
              </View>

              <Section g={g} title={tt('tasks.due', 'Prazo')} right={due ? <Text style={[s.sectionValue, { color: g.text }]}>{dueLabel({ due_at: dueToServer(due, allDay), due_all_day: allDay }, t, locale)}</Text> : null}>
                <View style={s.chipsWrap}>
                  <Chip g={g} label={tt('tasks.noDate', 'Sem data')} active={!due} onPress={() => setDueDay(null)} />
                  <Chip g={g} label={tt('tasks.today', 'Hoje')} active={!!due && startOfDay(due).getTime() === startOfDay(now).getTime()} onPress={() => setDueDay(startOfDay(now))} />
                  <Chip g={g} label={tt('tasks.tomorrow', 'Amanhã')} active={!!due && startOfDay(due).getTime() === addDays(startOfDay(now), 1).getTime()} onPress={() => setDueDay(addDays(startOfDay(now), 1))} />
                  <Chip g={g} label={tt('tasks.nextWeek', 'Próx. semana')} active={false} onPress={() => setDueDay(addDays(startOfDay(now), ((8 - now.getDay()) % 7) || 7))} />
                </View>
                {!!due && (
                  <View style={[s.chipsWrap, { paddingTop: 0 }]}>
                    <Chip g={g} label={tt('tasks.allDay', 'Dia todo')} active={allDay} onPress={() => setDueTime(null)} />
                    {[[9, 0], [13, 0], [18, 0]].map(([h, m]) => (
                      <Chip key={h} g={g} label={`${String(h).padStart(2, '0')}:00`} active={!allDay && due.getHours() === h && due.getMinutes() === m} onPress={() => setDueTime(h, m)} />
                    ))}
                    {!allDay && ![9, 13, 18].includes(due.getHours()) && <Chip g={g} label={hhmm(due)} active onPress={() => {}} />}
                  </View>
                )}
                <View style={[s.sep, { backgroundColor: g.separator, marginLeft: 14 }]} />
                <View style={s.nlRow}>
                  <IconCalendar size={16} color={g.secondary} />
                  <TextInput
                    value={nl}
                    onChangeText={setNl}
                    onSubmitEditing={applyNl}
                    returnKeyType="done"
                    style={[s.nlInput, { color: g.text }]}
                    placeholder={tt('tasks.nlDuePlaceholder', 'Ou escreva: "sexta 15h", "dia 20 às 9"')}
                    placeholderTextColor={g.secondary}
                  />
                  {!!nl.trim() && (
                    <TouchableOpacity onPress={applyNl} hitSlop={8} accessibilityRole="button">
                      <Text style={[s.apply, { color: g.ink }]}>{tt('tasks.apply', 'Aplicar')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </Section>

              {v2 && (
                <Section g={g} title={tt('tasks.reminder', 'Lembrete')} right={<Text style={[s.sectionValue, { color: remind ? g.text : g.secondary }]}>{remindLabel}</Text>}>
                  <View style={s.chipsWrap}>
                    <Chip g={g} label={tt('tasks.noReminderShort', 'Nenhum')} active={!remind} onPress={() => setRemind(null)} />
                    {remindOptions.map((o) => (
                      <Chip
                        key={o.key}
                        g={g}
                        icon={<View style={{ marginRight: 5 }}><IconBell size={12} color={remind && Math.abs(remind - o.date) < 60000 ? g.onInk : g.secondary} /></View>}
                        label={o.label}
                        active={!!remind && Math.abs(remind - o.date) < 60000}
                        onPress={() => setRemind(o.date)}
                      />
                    ))}
                  </View>
                </Section>
              )}

              {v2 && (
                <Section g={g} title={tt('tasks.priority', 'Prioridade')}>
                  <View style={[s.seg, { backgroundColor: g.fill }]}>
                    {PRI.map((p) => (
                      <TouchableOpacity
                        key={p.v}
                        onPress={() => { haptic.select(); setPriority(p.v); }}
                        style={[s.segBtn, priority === p.v && { backgroundColor: g.cardBg }]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: priority === p.v }}
                      >
                        <Text style={[s.segText, { color: g.text, fontWeight: priority === p.v ? '700' : '500' }]}>{p.l}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={[s.sep, { backgroundColor: g.separator, marginLeft: 14 }]} />
                  <View style={s.switchRow}>
                    <IconFlag size={17} color={g.text} />
                    <Text style={[s.switchLabel, { color: g.text }]}>{tt('tasks.flagged', 'Sinalizada')}</Text>
                    <NativeSwitch value={flagged} onValueChange={setFlagged} />
                  </View>
                </Section>
              )}

              {v2 && lists.length > 0 && (
                <Section g={g} title={tt('tasks.list', 'Lista')}>
                  <View style={s.chipsWrap}>
                    <Chip g={g} label={tt('tasks.defaultList', 'Tarefas')} active={!listId} onPress={() => setListId(null)} />
                    {lists.map((l) => (
                      <Chip key={l.id} g={g} label={l.name} active={listId === l.id} onPress={() => setListId(l.id)} />
                    ))}
                  </View>
                </Section>
              )}

              {v2 && (
                <Section g={g} title={tt('tasks.subtasks', 'Subtarefas')} right={subtasks.length ? <Text style={[s.sectionValue, { color: g.secondary }]}>{subtasks.filter((x) => x.done).length}/{subtasks.length}</Text> : null}>
                  {subtasks.map((st, i) => (
                    <View key={st.id}>
                      {i > 0 && <View style={[s.sep, { backgroundColor: g.separator, marginLeft: 48 }]} />}
                      <View style={s.subRow}>
                        <Pressable onPress={() => onToggleSub(st)} hitSlop={10} style={s.subCheck} accessibilityRole="checkbox" accessibilityState={{ checked: !!st.done }}>
                          <TaskCheck done={!!st.done} g={g} size={20} />
                        </Pressable>
                        <Text style={[s.subTitle, { color: st.done ? g.secondary : g.text, textDecorationLine: st.done ? 'line-through' : 'none' }]} numberOfLines={2}>{st.title}</Text>
                        <TouchableOpacity onPress={() => onDeleteSub(st)} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.delete', 'Apagar')}>
                          <IconX size={16} color={g.tertiary} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                  {subtasks.length > 0 && <View style={[s.sep, { backgroundColor: g.separator, marginLeft: 48 }]} />}
                  <View style={s.subRow}>
                    <View style={s.subCheck}><IconPlus size={18} color={g.secondary} /></View>
                    <TextInput
                      value={subTitle}
                      onChangeText={setSubTitle}
                      onSubmitEditing={() => { const v = subTitle.trim(); if (v) { onAddSub(v); setSubTitle(''); } }}
                      returnKeyType="done"
                      blurOnSubmit={false}
                      style={[s.subInput, { color: g.text }]}
                      placeholder={tt('tasks.addSubtask', 'Adicionar subtarefa')}
                      placeholderTextColor={g.secondary}
                    />
                  </View>
                </Section>
              )}

              {!!task.email_uid && (
                <TouchableOpacity onPress={() => onOpenEmail(task)} style={[s.action, { backgroundColor: g.cardBg }]} accessibilityRole="button">
                  <IconMail size={17} color={g.text} />
                  <Text style={[s.actionText, { color: g.text }]} numberOfLines={1}>
                    {tt('tasks.openEmail', 'Abrir e-mail')}{task.email_from ? ` · ${task.email_from}` : ''}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => onDelete(task)} style={[s.action, { backgroundColor: g.cardBg }]} accessibilityRole="button">
                <IconTrash size={17} color={g.destructive} />
                <Text style={[s.actionText, { color: g.destructive }]}>{tt('tasks.delete', 'Apagar tarefa')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 14, borderTopRightRadius: 14, width: '100%', maxWidth: 640, alignSelf: 'center' },
  grabber: { alignItems: 'center', paddingTop: 8 },
  grabberBar: { width: 36, height: 5, borderRadius: 3 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerBtn: { fontSize: 16 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  card: { borderRadius: 12, overflow: 'hidden' },
  titleInput: { fontSize: 17, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 12, minHeight: 48, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  notesInput: { fontSize: 15, paddingHorizontal: 14, paddingVertical: 12, minHeight: 64, textAlignVertical: 'top', ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  sep: { height: StyleSheet.hairlineWidth },
  section: { marginTop: 18, marginHorizontal: 16 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.2 },
  sectionValue: { fontSize: 13, fontWeight: '600' },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 32, borderRadius: 16 },
  chipText: { fontSize: 14, fontWeight: '600' },
  nlRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 46, gap: 10 },
  nlInput: { flex: 1, fontSize: 15, paddingVertical: 10, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  apply: { fontSize: 15, fontWeight: '700' },
  seg: { flexDirection: 'row', margin: 12, borderRadius: 9, padding: 2 },
  segBtn: { flex: 1, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 50, gap: 12 },
  switchLabel: { flex: 1, fontSize: 16 },
  subRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14, minHeight: 46 },
  subCheck: { width: 48, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  subTitle: { flex: 1, fontSize: 15 },
  subInput: { flex: 1, fontSize: 15, paddingVertical: 10, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 18, borderRadius: 12, paddingHorizontal: 14, minHeight: 50 },
  actionText: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
});
