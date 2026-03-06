import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, FlatList, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconPlus, IconTrash, IconEdit } from './Icons';
import * as api from '../services/api';

export default function TemplatePickerModal({ visible, onClose, onSelect }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null = list, 'new' = create, {id} = edit
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.apiCall('template_list');
    if (r.success) setTemplates(r.data?.templates || []);
    setLoading(false);
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const handleSave = async () => {
    if (!name.trim()) return;
    const params = { name: name.trim(), subject: subject.trim(), body: body.trim() };
    if (editing && editing !== 'new') params.id = editing;
    const r = await api.apiCall('template_save', params, 'POST');
    if (r.success) { setEditing(null); setName(''); setSubject(''); setBody(''); load(); }
  };

  const handleDelete = async (id) => {
    await api.apiCall('template_delete', { id }, 'POST');
    load();
  };

  const startEdit = (t) => {
    setEditing(t.id);
    setName(t.name);
    setSubject(t.subject || '');
    setBody(t.body || '');
  };

  const startNew = () => {
    setEditing('new');
    setName('');
    setSubject('');
    setBody('');
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <Text style={[s.title, { color: colors.text }]}>
              {editing ? (editing === 'new' ? t('template.new') : t('template.edit')) : t('template.title')}
            </Text>
            <TouchableOpacity onPress={() => editing ? setEditing(null) : onClose()} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {editing ? (
            <View style={s.editForm}>
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={name} onChangeText={setName} placeholder={t('template.namePlaceholder')} placeholderTextColor={colors.textTertiary} />
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={subject} onChangeText={setSubject} placeholder={t('compose.subject')} placeholderTextColor={colors.textTertiary} />
              <TextInput style={[s.input, s.bodyInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={body} onChangeText={setBody} placeholder={t('template.bodyPlaceholder')} placeholderTextColor={colors.textTertiary} multiline textAlignVertical="top" />
              <TouchableOpacity style={[s.saveBtn, { backgroundColor: colors.primary }]} onPress={handleSave}>
                <Text style={s.saveBtnText}>{t('template.save')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {loading ? (
                <ActivityIndicator style={{ padding: 40 }} color={colors.primary} />
              ) : (
                <FlatList
                  data={templates}
                  keyExtractor={(t) => t.id}
                  style={{ maxHeight: 300 }}
                  ListEmptyComponent={<Text style={[s.empty, { color: colors.textTertiary }]}>{t('template.empty')}</Text>}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={[s.item, { borderBottomColor: colors.borderLight }]}
                      onPress={() => { onSelect(item); onClose(); }}>
                      <View style={s.itemContent}>
                        <Text style={[s.itemName, { color: colors.text }]}>{item.name}</Text>
                        {item.subject ? <Text style={[s.itemSub, { color: colors.textSecondary }]}>{item.subject}</Text> : null}
                      </View>
                      <TouchableOpacity onPress={() => startEdit(item)} style={s.itemBtn}>
                        <IconEdit size={16} color={colors.textTertiary} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => handleDelete(item.id)} style={s.itemBtn}>
                        <IconTrash size={16} color={colors.error} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  )}
                />
              )}
              <TouchableOpacity style={[s.addBtn, { borderTopColor: colors.borderLight }]} onPress={startNew}>
                <IconPlus size={18} color={colors.primary} />
                <Text style={[s.addText, { color: colors.primary }]}>{t('template.create')}</Text>
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
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 450, maxHeight: '80%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, borderBottomWidth: 1 },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  itemContent: { flex: 1 },
  itemName: { fontSize: FontSize.lg, fontWeight: '500' },
  itemSub: { fontSize: FontSize.sm, marginTop: 2 },
  itemBtn: { padding: Spacing.sm },
  empty: { textAlign: 'center', padding: 40, fontSize: FontSize.base },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.lg, borderTopWidth: 1, gap: Spacing.sm },
  addText: { fontSize: FontSize.lg, fontWeight: '600' },
  editForm: { padding: Spacing.xl, gap: Spacing.md },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.md, fontSize: FontSize.lg },
  bodyInput: { minHeight: 120 },
  saveBtn: { borderRadius: BorderRadius.md, paddingVertical: 12, alignItems: 'center', marginTop: Spacing.sm },
  saveBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
});
