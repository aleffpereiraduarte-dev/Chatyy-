/**
 * /tasks — User task list (chat_user_tasks).
 *
 * Lists pending + done tasks, supports creating ad-hoc tasks, marking
 * complete, deleting. Tasks created via "Adicionar como tarefa" from
 * EmailReader carry email_uid/email_folder/email_from so we can deep-link
 * back to the email when the user taps the task row.
 *
 * [2026-10-08 settings-redesign] iOS Reminders-style: native header with
 * large title (web: own header with safe-area — the old ModalHeader drew
 * under the status bar), segmented filter, inline "Nova tarefa" row whose
 * "+" turns ink when there is text, grouped list with circular checkboxes,
 * swipe-left to delete, ScreenEmptyState illustration.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, FlatList, Alert, Platform, Pressable,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canNavigateNow } from '../services/navGuard';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconCheck, IconPlus, IconTrash, IconMail, IconChevronLeft } from '../components/Icons';
import { taskList, taskCreate, taskUpdate, taskDelete } from '../services/api';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import SettingsSegmented from '../components/SettingsSegmented';
import ScreenEmptyState from '../components/ScreenEmptyState';
import SwipeableRow from '../components/SwipeableRow';
import { useGroupedColors } from '../components/settings/SettingsKit';

const FILTERS = [
  { key: 'pending', label: 'Pendentes' },
  { key: 'done', label: 'Concluídas' },
  { key: 'all', label: 'Todas' },
];

// Circular checkbox (Reminders): empty ring → filled ink disc with a check.
function TaskCheck({ done, g }) {
  return (
    <View style={[s.check, done
      ? { backgroundColor: g.ink, borderColor: g.ink }
      : { borderColor: g.tertiary }]}
    >
      {done && <IconCheck size={14} color={g.onInk} strokeWidth={3} />}
    </View>
  );
}

export default function TasksScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const inputRef = useRef(null);
  const [filter, setFilter] = useState('pending');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await taskList(filter);
      if (r?.success) setTasks(r.data?.tasks || []);
    } catch {}
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const addTask = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const r = await taskCreate({ title });
      if (r?.success) {
        setNewTitle('');
        load();
      }
    } finally { setAdding(false); }
  }, [newTitle, load]);

  const toggleDone = useCallback(async (task) => {
    try {
      await taskUpdate(task.id, { done: !task.done });
      setTasks(prev => prev.map(x => x.id === task.id ? { ...x, done: !x.done } : x));
    } catch {}
  }, []);

  const deleteNow = useCallback(async (task) => {
    setTasks(prev => prev.filter(x => x.id !== task.id));
    try { await taskDelete(task.id); } catch { load(); }
  }, [load]);

  const removeTask = useCallback((task) => {
    if (Platform.OS === 'web') {
      // RN-web Alert has no buttons → window.confirm.
      const ok = typeof window !== 'undefined' && window.confirm(`${t('tasks.deleteConfirm') || 'Apagar tarefa?'}\n${task.title}`);
      if (ok) deleteNow(task);
      return;
    }
    Alert.alert(
      t('tasks.deleteConfirm') || 'Apagar tarefa?',
      task.title,
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: () => deleteNow(task) },
      ],
    );
  }, [t, deleteNow]);

  const openEmail = useCallback((task) => {
    if (task.email_uid && task.email_folder) {
      if (!canNavigateNow()) return; // [2026-06-04] anti-empilhamento de telas
      router.push({
        pathname: '/read',
        params: { uid: String(task.email_uid), folder: task.email_folder },
      });
    }
  }, [router]);

  const canAdd = !!newTitle.trim() && !adding;

  const renderItem = ({ item, index }) => {
    const first = index === 0;
    const last = index === tasks.length - 1;
    const row = (
      <View style={[s.row, { backgroundColor: g.cardBg }]}>
        <Pressable
          onPress={() => toggleDone(item)}
          hitSlop={12}
          style={s.checkHit}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!item.done }}
          accessibilityLabel={item.done ? (t('tasks.markUndone') || 'Marcar como pendente') : (t('tasks.markDone') || 'Marcar como concluída')}
        >
          <TaskCheck done={!!item.done} g={g} />
        </Pressable>
        <Pressable
          style={{ flex: 1, minWidth: 0, paddingVertical: 12 }}
          onLongPress={() => removeTask(item)}
          delayLongPress={350}
        >
          <Text
            style={[s.title, { color: item.done ? g.secondary : g.text, textDecorationLine: item.done ? 'line-through' : 'none' }]}
            numberOfLines={3}
          >
            {item.title}
          </Text>
          {!!item.email_from && (
            <TouchableOpacity onPress={() => openEmail(item)} style={s.metaRow} hitSlop={6} accessibilityRole="link">
              <IconMail size={13} color={g.secondary} />
              <Text style={[s.meta, { color: g.secondary }]} numberOfLines={1}>{item.email_from}</Text>
            </TouchableOpacity>
          )}
        </Pressable>
        {Platform.OS === 'web' && (
          <TouchableOpacity
            onPress={() => removeTask(item)}
            style={s.delBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.delete') || 'Excluir'}
          >
            <IconTrash size={17} color={g.tertiary} />
          </TouchableOpacity>
        )}
      </View>
    );
    return (
      <View style={[s.cellWrap, first && s.cellFirst, last && s.cellLast, { backgroundColor: g.cardBg }]}>
        {!first && <View style={[s.sep, { backgroundColor: g.separator }]} />}
        {Platform.OS === 'web' ? row : (
          <SwipeableRow onDelete={() => deleteNow(item)} colors={colors}>{row}</SwipeableRow>
        )}
      </View>
    );
  };

  const emptySub = filter === 'done'
    ? (t('tasks.emptyDone') || 'As tarefas concluídas aparecem aqui.')
    : filter === 'pending'
      ? (t('tasks.emptyPending') || 'Tudo em dia. Escreva uma tarefa acima ou transforme um email em tarefa.')
      : (t('tasks.empty') || 'Nenhuma tarefa por aqui. Cria uma acima ou converte um email em tarefa.');

  const header = (
    <View>
      <View style={s.segWrap}>
        <SettingsSegmented
          colors={colors}
          isDark={isDark}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map(f => ({ value: f.key, label: t('tasks.filter.' + f.key) || f.label }))}
        />
      </View>
      <View style={[s.compose, { backgroundColor: g.cardBg }]}>
        <Pressable onPress={() => inputRef.current?.focus?.()} hitSlop={8} style={s.checkHit} accessibilityElementsHidden importantForAccessibility="no">
          <View style={[s.check, { borderColor: g.tertiary, borderStyle: 'dashed' }]} />
        </Pressable>
        <TextInput
          ref={inputRef}
          style={[s.composeInput, { color: g.text }]}
          placeholder={t('tasks.placeholder') || 'Adicionar tarefa…'}
          placeholderTextColor={g.secondary}
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={addTask}
          returnKeyType="done"
          blurOnSubmit={false}
          enablesReturnKeyAutomatically
          accessibilityLabel={t('tasks.placeholder') || 'Adicionar tarefa'}
        />
        <Pressable
          disabled={!canAdd}
          onPress={addTask}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('tasks.add') || 'Adicionar tarefa'}
          accessibilityState={{ disabled: !canAdd }}
          style={({ pressed }) => [s.addBtn, {
            backgroundColor: canAdd ? g.ink : g.fill,
            opacity: pressed ? 0.7 : 1,
          }]}
        >
          {adding
            ? <ActivityIndicator color={g.onInk} size="small" />
            : <IconPlus size={18} color={canAdd ? g.onInk : g.tertiary} strokeWidth={2.4} />}
        </Pressable>
      </View>
      {!loading && tasks.length > 0 && (
        <Text style={[s.listHeader, { color: g.header }]}>
          {tasks.length === 1
            ? (t('tasks.countOne') || '1 tarefa')
            : (t('tasks.count') || '{n} tarefas').replace('{n}', String(tasks.length))}
        </Text>
      )}
    </View>
  );

  return (
    <View style={[s.root, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: t('tasks.title') || 'Tarefas',
          largeTitle: true,
          contentStyle: { backgroundColor: g.pageBg },
        })} />
      ) : (
        <View style={s.webHeader}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={s.webBack}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.back') || 'Voltar'}
          >
            <IconChevronLeft size={26} color={g.text} />
          </TouchableOpacity>
          <Text style={[s.webTitle, { color: g.text }]} accessibilityRole="header">{t('tasks.title') || 'Tarefas'}</Text>
        </View>
      )}
      <FlatList
        data={loading ? [] : tasks}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={loading
          ? <View style={{ padding: 30 }}><ActivityIndicator color={g.text} /></View>
          : (
            // flex:1 + flexGrow container → centered in the free space.
            // (compact = flex:0, which RN-web turns into flex-basis 0 and
            // collapses the illustration over the header.)
            <ScreenEmptyState
              kind="tasks"
              accent={g.ink}
              style={{ paddingTop: 24, paddingBottom: 96 }}
              title={t('tasks.emptyTitle') || 'Nenhuma tarefa'}
              subtitle={emptySub}
            />
          )}
        contentContainerStyle={[{ paddingBottom: 40 + insets.bottom }, !loading && tasks.length === 0 ? { flexGrow: 1 } : null]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
  webBack: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  webTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -0.6, marginLeft: 6 },
  segWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 },
  compose: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 22, borderRadius: 12,
    paddingLeft: 4, paddingRight: 8, minHeight: 52,
  },
  composeInput: {
    flex: 1, fontSize: 16, paddingVertical: 12,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  addBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  listHeader: { fontSize: 13, fontWeight: '500', letterSpacing: 0.2, paddingHorizontal: 32, marginBottom: 7, textTransform: 'uppercase' },
  cellWrap: { marginHorizontal: 16, overflow: 'hidden' },
  cellFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  cellLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 12, minHeight: 52 },
  checkHit: { width: 48, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, lineHeight: 21, letterSpacing: -0.2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3, alignSelf: 'flex-start' },
  meta: { fontSize: 13, marginLeft: 5, flexShrink: 1 },
  delBtn: { paddingHorizontal: 6, marginLeft: 6 },
});
