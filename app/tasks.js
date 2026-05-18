/**
 * /tasks — User task list (chat_user_tasks).
 *
 * Lists pending + done tasks, supports creating ad-hoc tasks, marking
 * complete, deleting. Tasks created via "Adicionar como tarefa" from
 * EmailReader carry email_uid/email_folder/email_from so we can deep-link
 * back to the email when the user taps the task row.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  ActivityIndicator, FlatList, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconCheck, IconCheckbox, IconCheckboxChecked, IconPlus, IconTrash, IconMail } from '../components/Icons';
import { taskList, taskCreate, taskUpdate, taskDelete } from '../services/api';
import ModalHeader from '../components/ModalHeader';

const FILTERS = [
  { key: 'pending', label: 'Pendentes' },
  { key: 'done', label: 'Concluídas' },
  { key: 'all', label: 'Todas' },
];

export default function TasksScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
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

  const removeTask = useCallback((task) => {
    Alert.alert(
      t('tasks.deleteConfirm') || 'Apagar tarefa?',
      task.title,
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: async () => {
          try {
            await taskDelete(task.id);
            setTasks(prev => prev.filter(x => x.id !== task.id));
          } catch {}
        }},
      ],
    );
  }, [t]);

  const openEmail = useCallback((task) => {
    if (task.email_uid && task.email_folder) {
      router.push({
        pathname: '/read',
        params: { uid: String(task.email_uid), folder: task.email_folder },
      });
    }
  }, [router]);

  const renderItem = ({ item }) => {
    const Tick = item.done ? IconCheckboxChecked : IconCheckbox;
    return (
      <View style={[s.row, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => toggleDone(item)} style={s.tickBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Tick size={20} color={item.done ? '#10b981' : colors.textTertiary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: colors.text, textDecorationLine: item.done ? 'line-through' : 'none', opacity: item.done ? 0.6 : 1 }]}>
            {item.title}
          </Text>
          {!!item.email_from && (
            <TouchableOpacity onPress={() => openEmail(item)} style={s.metaRow}>
              <IconMail size={12} color={colors.textTertiary} />
              <Text style={[s.meta, { color: colors.textTertiary }]}>
                {item.email_from}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={() => removeTask(item)} style={s.delBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconTrash size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <ModalHeader title={t('tasks.title') || 'Tarefas'} onClose={() => router.back()} />

      <View style={s.filters}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[s.filterPill, active
                ? { backgroundColor: colors.primary, borderColor: colors.primary }
                : { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            >
              <Text style={[s.filterText, { color: active ? '#fff' : colors.textSecondary }]}>{t('tasks.filter.' + f.key) || f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={[s.composeRow, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
        <TextInput
          style={[s.composeInput, { color: colors.text }]}
          placeholder={t('tasks.placeholder') || 'Adicionar tarefa…'}
          placeholderTextColor={colors.textTertiary}
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={addTask}
          returnKeyType="done"
        />
        <TouchableOpacity
          disabled={adding || !newTitle.trim()}
          onPress={addTask}
          style={[s.addBtn, { backgroundColor: colors.primary, opacity: adding || !newTitle.trim() ? 0.4 : 1 }]}
        >
          {adding ? <ActivityIndicator color="#fff" size="small" /> : <IconPlus size={18} color="#fff" />}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ padding: 30 }}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ListEmptyComponent={
            <Text style={[s.empty, { color: colors.textTertiary }]}>
              {t('tasks.empty') || 'Nenhuma tarefa por aqui. Cria uma acima ou converte um email em tarefa.'}
            </Text>
          }
          contentContainerStyle={{ paddingBottom: 60 }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  filters: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: 4,
  },
  filterPill: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1,
  },
  filterText: { fontSize: FontSize.xs, fontWeight: '700' },
  composeRow: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.lg, marginVertical: Spacing.sm,
    paddingHorizontal: 12, borderRadius: BorderRadius.md, borderWidth: 1,
  },
  composeInput: { flex: 1, paddingVertical: 10, fontSize: FontSize.sm },
  addBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: 12,
    borderBottomWidth: 1,
  },
  tickBtn: { marginRight: 10 },
  title: { fontSize: FontSize.sm, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  meta: { fontSize: FontSize.xs, marginLeft: 4 },
  delBtn: { paddingHorizontal: 4, marginLeft: 8 },
  empty: { textAlign: 'center', padding: 40, fontSize: FontSize.sm },
});
