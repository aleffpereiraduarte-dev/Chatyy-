// [2026-10-13 calendario] Topo "inteligente" do Calendário (P&B):
//  • Resumo do dia: "Seu dia: 3 eventos, 2 tarefas" + próximo compromisso
//    ("Almoço às 13:00 · em 25 min") + até 3 janelas livres (toque = criar ali);
//  • "Criar com a Bia": linguagem natural → evento ("almoço com Ana sexta 13h
//    no Outback"), prévia com Adicionar / Editar;
//  • atalho "Sincronizar com o celular" (CalDAV) e "Tarefas".
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { IconSparkles, IconX, IconClock, IconMapPin, IconSmartphone, IconCheckCircle, IconChevronRight } from '../Icons';
import { parseCalDate, sameDay, hhmm, freeSlots, eventsOnDay } from '../../utils/calDate';
import { parseEventText } from '../../services/pim';
import { haptic } from '../../constants/theme';
import { dueDate } from '../../utils/taskUtils';

function relIn(ms, t) {
  const m = Math.round(ms / 60000);
  if (m < 1) return t('calendar.nowLabel') || 'agora';
  if (m < 60) return t('calendar.inMinutes', { count: m }) || `em ${m} min`;
  const h = Math.round(m / 60);
  return t('calendar.inHours', { count: h }) || `em ${h}h`;
}

export default function CalendarSmartBar({
  date, events, tasks = [], colors, isDark, t, locale,
  onCreate, onOpenEditor, onCreateAt, onOpenSync, onOpenTasks, compact,
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const ink = colors.text || '#111111';
  const sub = colors.textSecondary || '#667781';
  const card = isDark ? '#1C1C1E' : '#FFFFFF';
  const fill = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)';
  const border = colors.border || (isDark ? '#2C2C2E' : '#E5E5EA');
  const now = new Date();
  const isToday = sameDay(date, now);

  const dayEvts = useMemo(() => eventsOnDay(events, date), [events, date]);
  const dayTasks = useMemo(() => (tasks || []).filter((tk) => !tk.done && !tk.parent_id && tk.due_at && sameDay(dueDate(tk), date)), [tasks, date]);
  const next = useMemo(() => (isToday ? dayEvts.find((e) => !e.all_day && parseCalDate(e.end_at || e.start_at) > now) : null), [dayEvts, isToday]); // eslint-disable-line react-hooks/exhaustive-deps
  const slots = useMemo(() => freeSlots(events, date, { minMinutes: 45 }).slice(0, 3), [events, date]);

  const nE = dayEvts.length; const nT = dayTasks.length;
  const evLabel = nE === 1 ? (t('calendar.summaryEventOne') || '1 evento') : (t('calendar.summaryEvents') || '{n} eventos').replace('{n}', String(nE));
  const tkLabel = nT === 1 ? (t('calendar.summaryTaskOne') || '1 tarefa') : (t('calendar.summaryTasks') || '{n} tarefas').replace('{n}', String(nT));
  const head = isToday ? (t('calendar.yourDay') || 'Seu dia') : (() => { try { return date.toLocaleDateString(locale || undefined, { weekday: 'long', day: 'numeric', month: 'short' }); } catch { return ''; } })();

  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const r = await parseEventText(v);
      if (r && r.start) { setDraft(r); haptic.light(); }
      else if (r) { onOpenEditor({ title: r.title, location: r.location, start: null }); setText(''); }
    } catch {} finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await onCreate(draft);
      setDraft(null); setText('');
    } catch {} finally { setSaving(false); }
  };

  const draftWhen = draft?.start ? (() => {
    try {
      const d = draft.start.toLocaleDateString(locale || undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      return draft.allDay ? `${d} · ${t('calendar.allDay') || 'Dia todo'}` : `${d} · ${hhmm(draft.start)}–${hhmm(draft.end || new Date(draft.start.getTime() + 3600000))}`;
    } catch { return ''; }
  })() : '';

  return (
    <View style={[s.wrap, compact && { marginTop: 4 }]}>
      {!compact && (
        <View style={[s.card, { backgroundColor: card, borderColor: border }]}>
          <View style={s.rowBetween}>
            <Text style={[s.head, { color: ink }]} numberOfLines={1}>{head.charAt(0).toUpperCase() + head.slice(1)}</Text>
            <TouchableOpacity onPress={onOpenTasks} hitSlop={8} style={s.inline} accessibilityRole="button">
              <Text style={[s.counts, { color: sub }]}>{evLabel} · {tkLabel}</Text>
              <IconChevronRight size={14} color={sub} />
            </TouchableOpacity>
          </View>
          {!!next && (
            <View style={[s.inline, { marginTop: 8 }]}>
              <IconClock size={14} color={ink} />
              <Text style={[s.next, { color: ink }]} numberOfLines={1}>
                {parseCalDate(next.start_at) <= now
                  ? `${t('calendar.happeningNow') || 'Agora'}: ${next.title}`
                  : `${next.title} · ${hhmm(parseCalDate(next.start_at))} · ${relIn(parseCalDate(next.start_at) - now, t)}`}
              </Text>
            </View>
          )}
          {!!next?.location && (
            <View style={[s.inline, { marginTop: 4 }]}>
              <IconMapPin size={13} color={sub} />
              <Text style={[s.loc, { color: sub }]} numberOfLines={1}>{next.location}</Text>
            </View>
          )}
          {slots.length > 0 && (
            <View style={s.slots}>
              <Text style={[s.slotsLabel, { color: sub }]}>{t('calendar.freeLabel') || 'Livre'}</Text>
              {slots.map((sl) => (
                <TouchableOpacity
                  key={sl.start.getTime()}
                  onPress={() => { haptic.select(); onCreateAt(sl.start, new Date(Math.min(sl.end.getTime(), sl.start.getTime() + 3600000))); }}
                  style={[s.slot, { backgroundColor: fill }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('calendar.freeLabel') || 'Livre'} ${hhmm(sl.start)}–${hhmm(sl.end)}`}
                >
                  <Text style={[s.slotText, { color: ink }]}>{hhmm(sl.start)}–{hhmm(sl.end)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      <View style={[s.nl, { backgroundColor: card, borderColor: border }]}>
        <IconSparkles size={16} color={ink} />
        <TextInput
          value={text}
          onChangeText={(v) => { setText(v); if (draft) setDraft(null); }}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder={t('calendar.nlPlaceholder') || 'Criar com a Bia: "almoço com Ana sexta 13h"'}
          placeholderTextColor={sub}
          style={[s.nlInput, { color: ink }]}
          accessibilityLabel={t('calendar.nlLabel') || 'Criar evento escrevendo'}
        />
        {busy ? <ActivityIndicator size="small" color={ink} /> : !!text.trim() && (
          <TouchableOpacity onPress={submit} hitSlop={8} style={[s.go, { backgroundColor: ink }]} accessibilityRole="button" accessibilityLabel={t('calendar.nlCreate') || 'Criar'}>
            <IconChevronRight size={16} color={isDark ? '#000' : '#fff'} />
          </TouchableOpacity>
        )}
      </View>

      {!!draft && (
        <View style={[s.draft, { backgroundColor: card, borderColor: ink }]}>
          <View style={s.rowBetween}>
            <Text style={[s.draftTitle, { color: ink }]} numberOfLines={2}>{draft.title}</Text>
            <TouchableOpacity onPress={() => setDraft(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.cancel') || 'Cancelar'}>
              <IconX size={16} color={sub} />
            </TouchableOpacity>
          </View>
          <View style={[s.inline, { marginTop: 6 }]}>
            <IconClock size={13} color={sub} />
            <Text style={[s.draftMeta, { color: sub }]}>{draftWhen}</Text>
          </View>
          {!!draft.location && (
            <View style={[s.inline, { marginTop: 4 }]}>
              <IconMapPin size={13} color={sub} />
              <Text style={[s.draftMeta, { color: sub }]} numberOfLines={1}>{draft.location}</Text>
            </View>
          )}
          <View style={s.draftBtns}>
            <TouchableOpacity onPress={() => { onOpenEditor(draft); setDraft(null); setText(''); }} style={[s.btn, { borderColor: border }]} accessibilityRole="button">
              <Text style={[s.btnText, { color: ink }]}>{t('common.edit') || 'Editar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={confirm} disabled={saving} style={[s.btn, { backgroundColor: ink, borderColor: ink }]} accessibilityRole="button">
              {saving ? <ActivityIndicator size="small" color={isDark ? '#000' : '#fff'} /> : (
                <>
                  <IconCheckCircle size={15} color={isDark ? '#000' : '#fff'} />
                  <Text style={[s.btnText, { color: isDark ? '#000' : '#fff', marginLeft: 6 }]}>{t('calendar.addEvent') || 'Adicionar'}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          {draft.source === 'local' && <Text style={[s.hint, { color: sub }]}>{t('calendar.nlOffline') || 'Entendido sem a Bia (offline). Confira antes de salvar.'}</Text>}
        </View>
      )}

      {!compact && (
        <TouchableOpacity onPress={onOpenSync} style={[s.syncRow, { borderColor: border }]} accessibilityRole="button">
          <IconSmartphone size={15} color={ink} />
          <Text style={[s.syncText, { color: ink }]} numberOfLines={1}>{t('calSync.title') || 'Sincronizar com o celular'}</Text>
          <Text style={[s.syncSub, { color: sub }]} numberOfLines={1}>{Platform.OS === 'android' ? 'Android' : 'iPhone · Android'}</Text>
          <IconChevronRight size={14} color={sub} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 16, marginTop: 12, gap: 10 },
  card: { borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  head: { fontSize: 18, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  counts: { fontSize: 13, fontWeight: '600' },
  next: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  loc: { fontSize: 13, flexShrink: 1 },
  slots: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  slotsLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginRight: 2 },
  slot: { paddingHorizontal: 10, height: 28, borderRadius: 14, justifyContent: 'center' },
  slotText: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  nl: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, paddingHorizontal: 12, minHeight: 46, borderWidth: StyleSheet.hairlineWidth },
  nlInput: { flex: 1, fontSize: 15, paddingVertical: 10, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  go: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  draft: { borderRadius: 14, padding: 14, borderWidth: 1.2 },
  draftTitle: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  draftMeta: { fontSize: 13, flexShrink: 1 },
  draftBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1 },
  btnText: { fontSize: 14, fontWeight: '700' },
  hint: { fontSize: 12, marginTop: 8 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 42, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  syncText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  syncSub: { fontSize: 12, flex: 1, textAlign: 'right' },
});
