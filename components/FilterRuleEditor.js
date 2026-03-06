import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, FlatList, Switch, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconPlus, IconTrash, IconFilter } from './Icons';
import * as api from '../services/api';

const ACTION_KEYS = [
  { key: 'move_to', labelKey: 'filters.moveToFolder', type: 'folder' },
  { key: 'add_label', labelKey: 'filters.addLabel', type: 'label' },
  { key: 'mark_read', labelKey: 'filters.markRead', type: 'toggle' },
  { key: 'archive', labelKey: 'filters.archive', type: 'toggle' },
  { key: 'delete', labelKey: 'filters.delete', type: 'toggle' },
];

const FOLDERS = ['Archive', 'Spam', 'Trash'];
const LABELS = ['work', 'personal', 'important', 'finance', 'social', 'travel'];

export default function FilterRuleEditor({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [fromContains, setFromContains] = useState('');
  const [subjectContains, setSubjectContains] = useState('');
  const [hasAttachment, setHasAttachment] = useState(false);
  const [selectedAction, setSelectedAction] = useState('move_to');
  const [actionValue, setActionValue] = useState('Archive');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.apiCall('filter_list');
    if (r.success) setFilters(r.data?.filters || []);
    setLoading(false);
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const handleSave = async () => {
    if (!name.trim()) return;
    const conditions = {};
    if (fromContains.trim()) conditions.from = fromContains.trim();
    if (subjectContains.trim()) conditions.subject_contains = subjectContains.trim();
    if (hasAttachment) conditions.has_attachment = true;
    const actions = { [selectedAction]: selectedAction === 'mark_read' || selectedAction === 'archive' || selectedAction === 'delete' ? true : actionValue };
    const params = { name: name.trim(), conditions, actions };
    if (editing && editing !== 'new') params.id = editing;
    const r = await api.apiCall('filter_save', params, 'POST');
    if (r.success) { resetForm(); load(); }
  };

  const handleDelete = async (id) => {
    await api.apiCall('filter_delete', { id }, 'POST');
    load();
  };

  const resetForm = () => {
    setEditing(null); setName(''); setFromContains('');
    setSubjectContains(''); setHasAttachment(false);
    setSelectedAction('move_to'); setActionValue('Archive');
  };

  const startEdit = (f) => {
    setEditing(f.id); setName(f.name);
    setFromContains(f.conditions?.from || '');
    setSubjectContains(f.conditions?.subject_contains || '');
    setHasAttachment(f.conditions?.has_attachment || false);
    const actKey = Object.keys(f.actions || {})[0] || 'move_to';
    setSelectedAction(actKey);
    setActionValue(typeof f.actions?.[actKey] === 'string' ? f.actions[actKey] : 'Archive');
  };

  const ACTIONS = ACTION_KEYS.map(a => ({ ...a, label: t(a.labelKey) }));
  const actionDef = ACTIONS.find(a => a.key === selectedAction);

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconFilter size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>
              {editing ? t('filters.editFilter') : t('filters.title')}
            </Text>
            <TouchableOpacity onPress={() => editing ? resetForm() : onClose()} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {editing ? (
            <View style={s.editForm}>
              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('filters.ruleName')}</Text>
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={name} onChangeText={setName} placeholder={t('filters.ruleNamePlaceholder')} placeholderTextColor={colors.textTertiary} />

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('filters.conditions')}</Text>
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={fromContains} onChangeText={setFromContains} placeholder={t('filters.fromContains')} placeholderTextColor={colors.textTertiary} />
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={subjectContains} onChangeText={setSubjectContains} placeholder={t('filters.subjectContains')} placeholderTextColor={colors.textTertiary} />
              <View style={s.switchRow}>
                <Text style={[s.switchLabel, { color: colors.text }]}>{t('filters.hasAttachment')}</Text>
                <Switch value={hasAttachment} onValueChange={setHasAttachment} trackColor={{ true: colors.primary }} />
              </View>

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('filters.action')}</Text>
              <View style={s.actionBtns}>
                {ACTIONS.map(a => (
                  <TouchableOpacity key={a.key}
                    style={[s.actionChip, selectedAction === a.key ? { backgroundColor: colors.primary } : { backgroundColor: colors.surfaceVariant }]}
                    onPress={() => setSelectedAction(a.key)}>
                    <Text style={[s.actionChipText, { color: selectedAction === a.key ? '#fff' : colors.text }]}>{a.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {actionDef?.type === 'folder' && (
                <View style={s.actionBtns}>
                  {FOLDERS.map(f => (
                    <TouchableOpacity key={f}
                      style={[s.actionChip, actionValue === f ? { backgroundColor: colors.primary } : { backgroundColor: colors.surfaceVariant }]}
                      onPress={() => setActionValue(f)}>
                      <Text style={[s.actionChipText, { color: actionValue === f ? '#fff' : colors.text }]}>{f}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {actionDef?.type === 'label' && (
                <View style={s.actionBtns}>
                  {LABELS.map(l => (
                    <TouchableOpacity key={l}
                      style={[s.actionChip, actionValue === l ? { backgroundColor: colors.primary } : { backgroundColor: colors.surfaceVariant }]}
                      onPress={() => setActionValue(l)}>
                      <Text style={[s.actionChipText, { color: actionValue === l ? '#fff' : colors.text }]}>{l}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <TouchableOpacity style={[s.saveBtn, { backgroundColor: colors.primary }]} onPress={handleSave}>
                <Text style={s.saveBtnText}>{t('filters.saveRule')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {loading ? <ActivityIndicator style={{ padding: 40 }} color={colors.primary} /> : (
                <FlatList data={filters} keyExtractor={f => f.id} style={{ maxHeight: 300 }}
                  ListEmptyComponent={<Text style={[s.empty, { color: colors.textTertiary }]}>{t('filters.noFilters')}</Text>}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={[s.item, { borderBottomColor: colors.borderLight }]} onPress={() => startEdit(item)}>
                      <View style={s.itemContent}>
                        <Text style={[s.itemName, { color: colors.text }]}>{item.name}</Text>
                        <Text style={[s.itemSub, { color: colors.textSecondary }]}>
                          {item.conditions?.from ? `${t('filters.from')}: ${item.conditions.from}` : ''}
                          {item.conditions?.subject_contains ? ` ${t('filters.subject')}: ${item.conditions.subject_contains}` : ''}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => handleDelete(item.id)} style={s.itemBtn}>
                        <IconTrash size={16} color={colors.error} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  )}
                />
              )}
              <TouchableOpacity style={[s.addBtn, { borderTopColor: colors.borderLight }]} onPress={() => setEditing('new')}>
                <IconPlus size={18} color={colors.primary} />
                <Text style={[s.addText, { color: colors.primary }]}>{t('filters.createFilter')}</Text>
              </TouchableOpacity>
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 500, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: 1 },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  editForm: { padding: Spacing.xl, gap: Spacing.sm },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'uppercase', marginTop: Spacing.sm },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.md, fontSize: FontSize.base },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.sm },
  switchLabel: { fontSize: FontSize.base },
  actionBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  actionChip: { paddingHorizontal: Spacing.md, paddingVertical: 6, borderRadius: BorderRadius.xxl },
  actionChipText: { fontSize: FontSize.sm, fontWeight: '500' },
  saveBtn: { borderRadius: BorderRadius.md, paddingVertical: 12, alignItems: 'center', marginTop: Spacing.md },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  itemContent: { flex: 1 },
  itemName: { fontSize: FontSize.lg, fontWeight: '500' },
  itemSub: { fontSize: FontSize.sm, marginTop: 2 },
  itemBtn: { padding: Spacing.sm },
  empty: { textAlign: 'center', padding: 40, fontSize: FontSize.base },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.lg, borderTopWidth: 1, gap: Spacing.sm },
  addText: { fontSize: FontSize.lg, fontWeight: '600' },
});
