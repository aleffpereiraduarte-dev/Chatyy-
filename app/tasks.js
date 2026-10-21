/**
 * /tasks — Tarefas (chat_tasks).
 *
 * [2026-10-13 tarefas v2] Nível Lembretes/Things, P&B:
 *  • listas inteligentes (Hoje, Programadas, Sinalizadas, Todas, Concluídas) +
 *    listas do usuário; contadores;
 *  • entrada rápida em linguagem natural ("Pagar conta amanhã 10h !!" →
 *    prazo amanhã 10:00, prioridade média; "#lista");
 *  • prazo, lembrete (notificação LOCAL agendada, services/taskReminders),
 *    prioridade, sinalizada, subtarefas, notas, origem e-mail;
 *  • concluir com animação (anel → disco + pulso) e a linha sai com fade;
 *  • tempo real: frame WS `pim_changed` (web ↔ celular ↔ iPhone via CalDAV)
 *    + volta do background → recarrega e reagenda os lembretes;
 *  • cache local → abre instantâneo e funciona offline (leitura).
 * Servidor sem pim.php → cai nas actions legadas (só título/notas/prazo).
 * Antes: o filtro "Concluídas" não filtrava (o servidor ignorava `filter`).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, SectionList,
  Alert, Platform, Pressable, ScrollView, Animated, Easing,
} from 'react-native';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canNavigateNow } from '../services/navGuard';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPlus, IconTrash, IconMail, IconArrowLeft, IconBell, IconFlag, IconRepeat, IconCalendar } from '../components/Icons';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, IOS_NATIVE_INSET, HeaderIconButton } from '../components/nativeHeader';
import ScreenEmptyState from '../components/ScreenEmptyState';
import SwipeableRow from '../components/SwipeableRow';
import { useGroupedColors } from '../components/settings/SettingsKit';
import { confirmAsync } from '../utils/confirm';
import TaskCheck from '../components/tasks/TaskCheck';
import TaskDetailSheet from '../components/tasks/TaskDetailSheet';
import * as pim from '../services/pim';
import { syncTaskReminders, cancelTaskReminder } from '../services/taskReminders';
import { filterTasks, sortTasks, scheduledSections, dueLabel, isOverdue, parseTaskInput, toIso, dueToServer, PRIORITY_MARK } from '../utils/taskUtils';
import { haptic } from '../constants/theme';

const SMART = ['today', 'scheduled', 'flagged', 'all', 'done'];

function useTicker(ms = 60000) {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(i); }, [ms]);
}

// Linha com "concluir" animado: o check anima, e se o filtro atual esconde
// concluídas a linha esmaece e só então some (onCommit).
function TaskRow({ item, subs, g, t, locale, listName, onToggle, onOpen, onOpenEmail, onDelete, first, last, colors }) {
  const fade = useRef(new Animated.Value(1)).current;
  const [localDone, setLocalDone] = useState(!!item.done);
  useEffect(() => { setLocalDone(!!item.done); fade.setValue(1); }, [item.done, item.id, fade]);
  const toggle = () => {
    const next = !localDone;
    setLocalDone(next);
    if (next) haptic.success(); else haptic.light();
    if (next) {
      Animated.timing(fade, { toValue: 0.35, duration: 520, delay: 260, easing: Easing.out(Easing.quad), useNativeDriver: true })
        .start(() => onToggle(item, next));
    } else {
      onToggle(item, next);
    }
  };
  const overdue = isOverdue(item);
  const due = dueLabel(item, t, locale);
  const subDone = subs.filter((x) => x.done).length;
  const meta = [];
  if (due) meta.push({ k: 'due', node: <><IconCalendar size={12} color={overdue ? g.ink : g.secondary} /><Text style={[s.meta, { color: overdue ? g.ink : g.secondary, fontWeight: overdue ? '700' : '400' }]}>{overdue ? `${(t('tasks.overdue') || 'Atrasada')} · ${due}` : due}</Text></> });
  if (item.remind_at && !item.done) meta.push({ k: 'rem', node: <IconBell size={12} color={g.secondary} /> });
  if (subs.length) meta.push({ k: 'sub', node: <Text style={[s.meta, { color: g.secondary }]}>{subDone}/{subs.length}</Text> });
  if (listName) meta.push({ k: 'list', node: <Text style={[s.meta, { color: g.secondary }]} numberOfLines={1}>{listName}</Text> });
  if (item.email_uid) meta.push({ k: 'mail', node: <TouchableOpacity onPress={() => onOpenEmail(item)} hitSlop={6} style={s.metaInline}><IconMail size={12} color={g.secondary} />{!!item.email_from && <Text style={[s.meta, { color: g.secondary }]} numberOfLines={1}>{item.email_from}</Text>}</TouchableOpacity> });

  const row = (
    <Animated.View style={[s.row, { backgroundColor: g.cardBg, opacity: fade }]}>
      <Pressable
        onPress={toggle}
        hitSlop={12}
        style={s.checkHit}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: localDone }}
        accessibilityLabel={localDone ? (t('tasks.markUndone') || 'Marcar como pendente') : (t('tasks.markDone') || 'Marcar como concluída')}
      >
        <TaskCheck done={localDone} g={g} priority={item.priority} />
      </Pressable>
      <Pressable style={s.rowBody} onPress={() => onOpen(item)} onLongPress={() => onDelete(item)} delayLongPress={400} accessibilityRole="button">
        <Text style={[s.title, { color: localDone ? g.secondary : g.text, textDecorationLine: localDone ? 'line-through' : 'none' }]} numberOfLines={3}>
          {item.priority > 0 && <Text style={{ fontWeight: '800', color: localDone ? g.secondary : g.ink }}>{PRIORITY_MARK[item.priority]} </Text>}
          {item.title}
        </Text>
        {!!item.notes && !localDone && <Text style={[s.notes, { color: g.secondary }]} numberOfLines={1}>{item.notes}</Text>}
        {meta.length > 0 && (
          <View style={s.metaRow}>
            {meta.map((m, i) => (
              <View key={m.k} style={s.metaInline}>
                {i > 0 && <Text style={[s.meta, { color: g.tertiary, marginLeft: 0, marginRight: 6 }]}>·</Text>}
                {m.node}
              </View>
            ))}
          </View>
        )}
      </Pressable>
      {item.flagged && !localDone && <View style={s.flag}><IconFlag size={15} color={g.ink} /></View>}
      {Platform.OS === 'web' && (
        <TouchableOpacity onPress={() => onDelete(item)} style={s.delBtn} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.delete') || 'Excluir'}>
          <IconTrash size={16} color={g.tertiary} />
        </TouchableOpacity>
      )}
    </Animated.View>
  );
  return (
    <View style={[s.cellWrap, first && s.cellFirst, last && s.cellLast, { backgroundColor: g.cardBg }]}>
      {!first && <View style={[s.sep, { backgroundColor: g.separator }]} />}
      {Platform.OS === 'web' ? row : <SwipeableRow onDelete={() => onDelete(item, true)} colors={colors}>{row}</SwipeableRow>}
    </View>
  );
}

export default function TasksScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const locale = (t && t('_locale')) || undefined;
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const inputRef = useRef(null);
  useTicker(60000);

  const cached = useMemo(() => pim.getCachedTasks(), []);
  const [tasks, setTasks] = useState(cached?.tasks || []);
  const [lists, setLists] = useState(cached?.lists || []);
  const [v2, setV2] = useState(!!cached?.v2);
  const [loading, setLoading] = useState(!cached);
  const [filter, setFilter] = useState('today');
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState('');
  const filterChosenRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await pim.fetchTasks();
      setTasks(r.tasks); setLists(r.lists); setV2(!!r.v2); setError('');
      syncTaskReminders(r.tasks, { t }).catch(() => {});
      // 1ª carga: "Hoje" vazio mas há pendentes → abre em "Todas".
      if (!filterChosenRef.current) {
        filterChosenRef.current = true;
        if (!filterTasks(r.tasks, 'today').length && filterTasks(r.tasks, 'all').length) setFilter('all');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // Tempo real (web ↔ celular ↔ CalDAV): debounce p/ rajadas.
  useEffect(() => {
    let tm = null;
    const off = pim.onPimChanged((d) => {
      if (d?.kind && !['task', 'list', '*'].includes(d.kind)) return;
      clearTimeout(tm); tm = setTimeout(load, 350);
    });
    return () => { clearTimeout(tm); off(); };
  }, [load]);

  // Deep link do lembrete: /tasks?focus=<id>
  useEffect(() => {
    const f = params?.focus ? Number(params.focus) : null;
    if (f && tasks.some((x) => x.id === f)) setOpenId(f);
  }, [params?.focus, tasks]);

  const subsOf = useMemo(() => {
    const m = new Map();
    tasks.forEach((x) => { if (x.parent_id) { if (!m.has(x.parent_id)) m.set(x.parent_id, []); m.get(x.parent_id).push(x); } });
    return m;
  }, [tasks]);
  const listName = useCallback((id) => (id ? (lists.find((l) => l.id === id)?.name || '') : ''), [lists]);

  const counts = useMemo(() => {
    const c = {};
    SMART.forEach((k) => { if (k !== 'done') c[k] = filterTasks(tasks, k).length; });
    c['list:0'] = filterTasks(tasks, 'list:0').length;
    lists.forEach((l) => { c['list:' + l.id] = filterTasks(tasks, 'list:' + l.id).length; });
    return c;
  }, [tasks, lists]);

  const sections = useMemo(() => {
    if (filter === 'scheduled') return scheduledSections(filterTasks(tasks, 'scheduled'), t);
    const arr = filter === 'done' ? filterTasks(tasks, 'done') : sortTasks(filterTasks(tasks, filter));
    return arr.length ? [{ key: filter, title: '', data: arr }] : [];
  }, [tasks, filter, t]);
  const visibleCount = sections.reduce((n, sct) => n + sct.data.length, 0);

  const replaceTask = useCallback((tk) => {
    if (!tk) return;
    setTasks((prev) => prev.map((x) => (x.id === tk.id ? { ...x, ...tk } : x)));
  }, []);

  const preview = useMemo(() => parseTaskInput(newTitle), [newTitle]);

  const addTask = useCallback(async () => {
    const p = parseTaskInput(newTitle);
    if (!p || !p.title.trim()) return;
    setAdding(true);
    const fields = { title: p.title.trim() };
    if (p.due) { fields.due_at = dueToServer(p.due, !p.hasTime); fields.due_all_day = !p.hasTime; }
    if (v2) {
      if (p.priority) fields.priority = p.priority;
      if (p.listHint) {
        const hit = lists.find((l) => l.name.toLowerCase() === p.listHint.toLowerCase());
        if (hit) fields.list_id = hit.id;
      }
      if (!fields.list_id && filter.startsWith('list:') && filter !== 'list:0') fields.list_id = Number(filter.slice(5));
      if (filter === 'flagged') fields.flagged = true;
      if (p.due && p.hasTime) fields.remind_at = toIso(p.due); // prazo com hora = lembrete na hora (como Lembretes)
    }
    if (!p.due && filter === 'today') { fields.due_at = dueToServer(new Date(), true); fields.due_all_day = true; }
    try {
      const tk = await pim.createTask(fields);
      setNewTitle('');
      haptic.light();
      if (tk) setTasks((prev) => [tk, ...prev.filter((x) => x.id !== tk.id)]);
      if (fields.remind_at) syncTaskReminders([tk, ...tasks].filter(Boolean), { ask: true, t }).catch(() => {});
      load();
    } catch {
      haptic.error();
      Alert.alert(t('common.error') || 'Erro', t('tasks.saveFailed') || 'Não foi possível salvar. Tente de novo.');
    } finally { setAdding(false); }
  }, [newTitle, v2, lists, filter, tasks, load, t]);

  const toggleDone = useCallback(async (task, next) => {
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, done: next, completed_at: next ? new Date().toISOString() : null } : x)));
    if (next) cancelTaskReminder(task.id).catch(() => {});
    try {
      const tk = await pim.updateTask(task.id, { done: next });
      if (tk) replaceTask(tk);
    } catch {
      setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, done: !next } : x)));
    }
  }, [replaceTask]);

  const deleteNow = useCallback(async (task) => {
    setTasks((prev) => prev.filter((x) => x.id !== task.id && x.parent_id !== task.id));
    cancelTaskReminder(task.id).catch(() => {});
    try { await pim.deleteTask(task.id); } catch { load(); }
  }, [load]);

  const removeTask = useCallback((task, skipConfirm) => {
    if (skipConfirm) { deleteNow(task); return; }
    if (Platform.OS === 'web') {
      confirmAsync({ title: t('tasks.deleteConfirm') || 'Apagar tarefa?', message: task.title, destructive: true })
        .then((ok) => { if (ok) deleteNow(task); });
      return;
    }
    Alert.alert(t('tasks.deleteConfirm') || 'Apagar tarefa?', task.title, [
      { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
      { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: () => deleteNow(task) },
    ]);
  }, [t, deleteNow]);

  const openEmail = useCallback((task) => {
    if (task.email_uid && task.email_folder) {
      if (!canNavigateNow()) return;
      setOpenId(null);
      router.push({ pathname: '/read', params: { uid: String(task.email_uid), folder: task.email_folder } });
    }
  }, [router]);

  const openTask = openId ? tasks.find((x) => x.id === openId) : null;

  const saveDetail = useCallback(async (fields) => {
    const task = openTask;
    setOpenId(null);
    if (!task || !Object.keys(fields).length) return;
    replaceTask({ ...task, ...fields });
    try {
      const tk = await pim.updateTask(task.id, fields);
      if (tk) replaceTask(tk);
      if ('remind_at' in fields || 'due_at' in fields) {
        const merged = tasks.map((x) => (x.id === task.id ? { ...x, ...(tk || fields) } : x));
        syncTaskReminders(merged, { ask: !!fields.remind_at, t }).catch(() => {});
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('tasks.saveFailed') || 'Não foi possível salvar. Tente de novo.');
      load();
    }
  }, [openTask, replaceTask, tasks, load, t]);

  const addSub = useCallback(async (title) => {
    if (!openTask) return;
    try {
      const tk = await pim.createTask({ title, parent_id: openTask.id, list_id: openTask.list_id || null });
      if (tk) setTasks((prev) => [...prev, tk]);
    } catch {}
  }, [openTask]);

  const newList = useCallback(() => {
    const create = async (name) => {
      const n = String(name || '').trim();
      if (!n) return;
      try { const l = await pim.createList(n); await load(); if (l?.id) setFilter('list:' + l.id); } catch {}
    };
    if (Platform.OS === 'ios' && Alert.prompt) {
      Alert.prompt(t('tasks.newList') || 'Nova lista', '', (v) => create(v));
    } else if (Platform.OS === 'web' && typeof window !== 'undefined' && window.prompt) {
      create(window.prompt(t('tasks.newList') || 'Nova lista') || '');
    } else {
      setFilter('__newlist');
    }
  }, [t, load]);

  const deleteListAsk = useCallback((l) => {
    const go = async () => {
      try { await pim.deleteList(l.id); setFilter('all'); load(); }
      catch { try { Alert.alert(t('common.error', 'Erro'), t('tasks.deleteListFailed', 'Não foi possível apagar a lista. Tente de novo.')); } catch {} }
    };
    const msg = t('tasks.deleteListMsg') || 'As tarefas desta lista também serão apagadas.';
    if (Platform.OS === 'web') { confirmAsync({ title: (t('tasks.deleteList') || 'Apagar lista') + ` "${l.name}"?`, message: msg, destructive: true }).then((ok) => ok && go()); return; }
    Alert.alert((t('tasks.deleteList') || 'Apagar lista') + ` "${l.name}"?`, msg, [
      { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
      { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: go },
    ]);
  }, [t, load]);

  const [listDraft, setListDraft] = useState('');
  const smartLabel = (k) => ({
    today: t('tasks.smart.today') || 'Hoje',
    scheduled: t('tasks.smart.scheduled') || 'Programadas',
    flagged: t('tasks.smart.flagged') || 'Sinalizadas',
    all: t('tasks.smart.all') || 'Todas',
    done: t('tasks.smart.done') || 'Concluídas',
  }[k]);

  const chip = (key, label, count, onLong) => {
    const active = filter === key;
    return (
      <Pressable
        key={key}
        onPress={() => { haptic.select(); filterChosenRef.current = true; setFilter(key); }}
        onLongPress={onLong}
        style={[s.chip, { backgroundColor: active ? g.ink : g.cardBg }]}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
      >
        <Text style={[s.chipText, { color: active ? g.onInk : g.text }]} numberOfLines={1}>{label}</Text>
        {count > 0 && <Text style={[s.chipCount, { color: active ? g.onInk : g.secondary }]}>{count}</Text>}
      </Pressable>
    );
  };

  const todayCount = counts.today || 0;
  const overdueCount = useMemo(() => tasks.filter((x) => !x.parent_id && isOverdue(x)).length, [tasks]);

  const header = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow} keyboardShouldPersistTaps="handled">
        {SMART.map((k) => chip(k, smartLabel(k), counts[k]))}
        {v2 && (lists.length > 0) && chip('list:0', t('tasks.defaultList') || 'Tarefas', counts['list:0'])}
        {v2 && lists.map((l) => chip('list:' + l.id, l.name, counts['list:' + l.id], () => deleteListAsk(l)))}
        {v2 && (
          <Pressable onPress={newList} style={[s.chip, { backgroundColor: g.fill }]} accessibilityRole="button" accessibilityLabel={t('tasks.newList') || 'Nova lista'}>
            <IconPlus size={14} color={g.text} />
            <Text style={[s.chipText, { color: g.text, marginLeft: 4 }]}>{t('tasks.list') || 'Lista'}</Text>
          </Pressable>
        )}
      </ScrollView>

      {filter === '__newlist' && (
        <View style={[s.compose, { backgroundColor: g.cardBg }]}>
          <TextInput
            autoFocus
            value={listDraft}
            onChangeText={setListDraft}
            onSubmitEditing={async () => { const n = listDraft.trim(); setListDraft(''); if (n) { try { const l = await pim.createList(n); await load(); setFilter(l?.id ? 'list:' + l.id : 'all'); } catch { setFilter('all'); } } else setFilter('all'); }}
            placeholder={t('tasks.newListPlaceholder') || 'Nome da nova lista'}
            placeholderTextColor={g.secondary}
            style={[s.composeInput, { color: g.text, paddingLeft: 14 }]}
          />
        </View>
      )}

      {(filter === 'today' && (todayCount > 0 || overdueCount > 0)) && (
        <Text style={[s.summary, { color: g.secondary }]}>
          {(t('tasks.summaryToday') || '{n} para hoje').replace('{n}', String(todayCount))}
          {overdueCount > 0 ? ` · ${(t('tasks.summaryOverdue') || '{n} atrasada(s)').replace('{n}', String(overdueCount))}` : ''}
        </Text>
      )}

      {filter !== 'done' && filter !== '__newlist' && (
        <View style={[s.compose, { backgroundColor: g.cardBg }]}>
          <Pressable onPress={() => inputRef.current?.focus?.()} hitSlop={8} style={s.checkHit} importantForAccessibility="no">
            <View style={[s.dashed, { borderColor: g.tertiary }]} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <TextInput
              ref={inputRef}
              style={[s.composeInput, { color: g.text }]}
              placeholder={t('tasks.placeholderSmart') || 'Nova tarefa — ex.: "Pagar conta amanhã 10h"'}
              placeholderTextColor={g.secondary}
              value={newTitle}
              onChangeText={setNewTitle}
              onSubmitEditing={addTask}
              returnKeyType="done"
              blurOnSubmit={false}
              enablesReturnKeyAutomatically
              accessibilityLabel={t('tasks.placeholder') || 'Adicionar tarefa'}
            />
            {!!preview && (preview.due || preview.priority > 0) && (
              <View style={s.previewRow}>
                {!!preview.due && (
                  <View style={[s.previewChip, { backgroundColor: g.fill }]}>
                    <IconCalendar size={11} color={g.text} />
                    <Text style={[s.previewText, { color: g.text }]}>{dueLabel({ due_at: dueToServer(preview.due, !preview.hasTime), due_all_day: !preview.hasTime }, t, locale)}</Text>
                  </View>
                )}
                {v2 && preview.priority > 0 && (
                  <View style={[s.previewChip, { backgroundColor: g.fill }]}>
                    <Text style={[s.previewText, { color: g.text, fontWeight: '800' }]}>{PRIORITY_MARK[preview.priority]}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Pressable
            disabled={!newTitle.trim() || adding}
            onPress={addTask}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('tasks.add') || 'Adicionar tarefa'}
            style={({ pressed }) => [s.addBtn, { backgroundColor: newTitle.trim() ? g.ink : g.fill, opacity: pressed ? 0.7 : 1 }]}
          >
            {adding ? <ActivityIndicator color={g.onInk} size="small" /> : <IconPlus size={18} color={newTitle.trim() ? g.onInk : g.tertiary} strokeWidth={2.4} />}
          </Pressable>
        </View>
      )}
      {!!error && !tasks.length && (
        <TouchableOpacity onPress={load} style={s.errorRow}><Text style={{ color: g.secondary }}>{t('tasks.loadFailed') || 'Sem conexão. Toque para tentar de novo.'}</Text></TouchableOpacity>
      )}
    </View>
  );

  const emptySub = filter === 'done'
    ? (t('tasks.emptyDone') || 'As tarefas concluídas aparecem aqui.')
    : filter === 'today'
      ? (t('tasks.emptyToday') || 'Nada para hoje. Aproveite.')
      : (t('tasks.emptyPending') || 'Tudo em dia. Escreva uma tarefa acima ou transforme um email em tarefa.');

  return (
    <View style={[s.root, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark,
          title: t('tasks.title') || 'Tarefas',
          largeTitle: true,
          contentStyle: { backgroundColor: g.pageBg },
          headerRight: () => (
            <HeaderIconButton onPress={() => router.push('/calendar-sync')} accessibilityLabel={t('calSync.title') || 'Sincronizar com o celular'}>
              <IconRepeat size={21} color={colors.text} />
            </HeaderIconButton>
          ),
        })} />
      ) : (
        <View style={s.webHeader}>
          <TouchableOpacity onPress={() => router.back()} style={s.webBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
            <IconArrowLeft size={24} color={g.text} />
          </TouchableOpacity>
          <Text style={[s.webTitle, { color: g.text }]} accessibilityRole="header">{t('tasks.title') || 'Tarefas'}</Text>
          <TouchableOpacity onPress={() => router.push('/calendar-sync')} style={s.webBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('calSync.title') || 'Sincronizar com o celular'}>
            <IconRepeat size={21} color={g.text} />
          </TouchableOpacity>
        </View>
      )}
      <SectionList
        sections={loading ? [] : sections}
        keyExtractor={(item) => String(item.id)}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (section.title
          ? <Text style={[s.listHeader, { color: section.key === 'overdue' ? g.ink : g.header }]}>{section.title}</Text>
          : null)}
        renderItem={({ item, index, section }) => (
          <TaskRow
            item={item}
            subs={subsOf.get(item.id) || []}
            g={g} t={t} locale={locale} colors={colors}
            listName={(filter.startsWith('list:') ? '' : listName(item.list_id))}
            first={index === 0}
            last={index === section.data.length - 1}
            onToggle={toggleDone}
            onOpen={(x) => setOpenId(x.id)}
            onOpenEmail={openEmail}
            onDelete={removeTask}
          />
        )}
        renderSectionFooter={() => <View style={{ height: 18 }} />}
        ListHeaderComponent={header}
        ListEmptyComponent={loading
          ? ( // [2026-10-13 visual] grouped-row skeleton instead of a bare spinner
            <View style={[s.cellWrap, s.cellFirst, s.cellLast, { backgroundColor: g.cardBg }]}>
              {[0.62, 0.48, 0.7, 0.4].map((w, i) => (
                <View key={i} style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: g.fill }]}>
                  <View style={s.checkHit}><View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: g.fill }} /></View>
                  <View style={{ flex: 1, height: 12, borderRadius: 6, maxWidth: `${Math.round(w * 100)}%`, backgroundColor: g.fill }} />
                </View>
              ))}
            </View>
          )
          : (
            <ScreenEmptyState
              kind="tasks"
              accent={g.ink}
              style={{ paddingTop: 24, paddingBottom: 96 }}
              title={t('tasks.emptyTitle') || 'Nenhuma tarefa'}
              subtitle={emptySub}
            />
          )}
        contentContainerStyle={[{ paddingBottom: 40 + (IOS_NATIVE_INSET ? 0 : insets.bottom), width: '100%', maxWidth: 760, alignSelf: 'center' }, !loading && visibleCount === 0 ? { flexGrow: 1 } : null]}
        {...nativeScrollInsetProps()}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      />
      <TaskDetailSheet
        visible={!!openTask}
        task={openTask}
        subtasks={openTask ? (subsOf.get(openTask.id) || []) : []}
        lists={lists}
        v2={v2}
        g={g} t={t} locale={locale}
        onClose={() => setOpenId(null)}
        onSave={saveDetail}
        onDelete={(x) => { setOpenId(null); removeTask(x); }}
        onToggleSub={(st) => toggleDone(st, !st.done)}
        onAddSub={addSub}
        onDeleteSub={(st) => deleteNow(st)}
        onOpenEmail={openEmail}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
  webBack: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  webTitle: { flex: 1, fontSize: 30, fontWeight: '700', letterSpacing: -0.6, marginLeft: 6 },
  chipsRow: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', height: 34, paddingHorizontal: 14, borderRadius: 17 },
  chipText: { fontSize: 14, fontWeight: '600', maxWidth: 160 },
  chipCount: { fontSize: 13, fontWeight: '600', marginLeft: 6, fontVariant: ['tabular-nums'] },
  summary: { fontSize: 13, paddingHorizontal: 32, marginBottom: 8 },
  compose: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 20, borderRadius: 14, paddingRight: 8, minHeight: 52 },
  composeInput: { fontSize: 16, paddingVertical: 12, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  previewRow: { flexDirection: 'row', gap: 6, marginTop: -4, marginBottom: 8 },
  previewChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11 },
  previewText: { fontSize: 12, fontWeight: '600' },
  dashed: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, borderStyle: 'dashed' },
  addBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  listHeader: { fontSize: 13, fontWeight: '600', letterSpacing: 0.2, paddingHorizontal: 32, marginBottom: 7, textTransform: 'uppercase' },
  cellWrap: { marginHorizontal: 16, overflow: 'hidden' },
  // Radius.card (14) — same inset-grouped radius as Calls / Status / Calendar.
  cellFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  cellLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 12, minHeight: 54 },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: 11 },
  checkHit: { width: 52, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  title: { fontSize: 16, lineHeight: 21, letterSpacing: -0.2 },
  notes: { fontSize: 13, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
  metaInline: { flexDirection: 'row', alignItems: 'center', marginRight: 6, maxWidth: 220 },
  meta: { fontSize: 12.5, marginLeft: 4, flexShrink: 1 },
  flag: { paddingLeft: 8 },
  delBtn: { paddingHorizontal: 6, marginLeft: 6 },
  errorRow: { alignItems: 'center', padding: 16 },
});
