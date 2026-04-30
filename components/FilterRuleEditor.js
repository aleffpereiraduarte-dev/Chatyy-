import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, FlatList, Switch, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconPlus, IconTrash, IconFilter, IconEdit, IconCheck } from './Icons';
import { apiCall } from '../services/api';

export default function FilterRuleEditor({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null = list, 'new' or filter object
  const [folders, setFolders] = useState([]);

  // Form state
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [hasWords, setHasWords] = useState('');
  const [action, setAction] = useState('move');
  const [destination, setDestination] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [fr, fo] = await Promise.all([
        apiCall('filters_get'),
        apiCall('folders'),
      ]);
      // Garante que todo filtro tenha id estável — antes filtros sem id
      // causavam delete/toggle em vários itens e remontes do FlatList.
      if (fr.success) setFilters((Array.isArray(fr.data) ? fr.data : []).map((f, i) => ({ ...f, id: f.id ?? `f_${i}_${Date.now()}` })));
      if (fo.success && Array.isArray(fo.data)) {
        setFolders(fo.data.map(f => f.name || f).filter(n => n !== 'INBOX'));
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const resetForm = () => {
    setEditing(null);
    setName(''); setFrom(''); setTo(''); setSubject('');
    setHasWords(''); setAction('move'); setDestination('');
    setLabel(''); setEnabled(true);
  };

  const startEdit = (f) => {
    setEditing(f);
    setName(f.name || '');
    setFrom(f.from || '');
    setTo(f.to || '');
    setSubject(f.subject || '');
    setHasWords(f.has_words || '');
    setAction(f.action || 'move');
    setDestination(f.destination || '');
    setLabel(f.label || '');
    setEnabled(f.enabled !== false);
  };

  const handleSave = async () => {
    if (!from && !to && !subject && !hasWords) return;

    const rule = {
      id: (editing && editing !== 'new') ? editing.id : 'f_' + Date.now(),
      name: name.trim() || (from || subject || to || hasWords),
      enabled,
      from: from.trim(),
      to: to.trim(),
      subject: subject.trim(),
      has_words: hasWords.trim(),
      action,
      destination: destination || (action === 'move' ? 'Archive' : ''),
      label: label.trim(),
    };

    let updated;
    if (editing && editing !== 'new') {
      updated = filters.map(f => f.id === editing.id ? rule : f);
    } else {
      updated = [...filters, rule];
    }

    const r = await apiCall('filters_save', { filters: updated }, 'POST');
    if (r.success) {
      setFilters(Array.isArray(r.data) ? r.data : updated);
      resetForm();
    }
  };

  const handleDelete = async (id) => {
    if (id == null) return;
    const updated = filters.filter(f => f.id !== id);
    const r = await apiCall('filters_save', { filters: updated }, 'POST');
    if (r.success) setFilters(Array.isArray(r.data) ? r.data : updated);
  };

  const handleToggle = async (id) => {
    const updated = filters.map(f => f.id === id ? { ...f, enabled: !f.enabled } : f);
    const r = await apiCall('filters_save', { filters: updated }, 'POST');
    if (r.success) setFilters(Array.isArray(r.data) ? r.data : updated);
  };

  const ACTIONS = [
    { key: 'move', label: t('filters.moveToFolder') || 'Mover para pasta' },
    { key: 'label', label: t('filters.addLabel') || 'Adicionar etiqueta' },
    { key: 'star', label: t('filters.star') || 'Marcar com estrela' },
    { key: 'mark_read', label: t('filters.markRead') || 'Marcar como lido' },
    { key: 'delete', label: t('filters.delete') || 'Excluir' },
  ];

  const allFolders = ['Archive', 'Spam', 'Trash', ...folders.filter(f => !['Sent', 'Drafts', 'Junk', 'Archive', 'Spam', 'Trash'].includes(f))];

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, { backgroundColor: colors.surface },
          Platform.OS === 'web' && { boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconFilter size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>
              {editing ? (editing === 'new' ? (t('filters.createFilter') || 'Criar filtro') : (t('filters.editFilter') || 'Editar filtro'))
                : (t('filters.title') || 'Filtros de email')}
            </Text>
            <TouchableOpacity onPress={() => editing ? resetForm() : onClose()} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {editing ? (
            <ScrollView style={s.editForm} contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                {t('filters.ruleName') || 'Nome do filtro'}
              </Text>
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={name} onChangeText={setName}
                placeholder={t('filters.ruleNamePlaceholder') || 'Ex: Emails do trabalho'}
                placeholderTextColor={colors.textTertiary} />

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                {t('filters.conditions') || 'Condições'}
              </Text>
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={from} onChangeText={setFrom}
                placeholder={t('filters.fromContains') || 'De contém (ex: @empresa.com)'}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none" keyboardType="email-address" />
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={to} onChangeText={setTo}
                placeholder={t('filters.toContains') || 'Para contém'}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none" keyboardType="email-address" />
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={subject} onChangeText={setSubject}
                placeholder={t('filters.subjectContains') || 'Assunto contém'}
                placeholderTextColor={colors.textTertiary} />
              <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                value={hasWords} onChangeText={setHasWords}
                placeholder={t('filters.hasWords') || 'Contém as palavras'}
                placeholderTextColor={colors.textTertiary} />

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                {t('filters.action') || 'Ação'}
              </Text>
              <View style={s.actionBtns}>
                {ACTIONS.map(a => (
                  <TouchableOpacity key={a.key}
                    style={[s.actionChip, action === a.key
                      ? { backgroundColor: colors.primary }
                      : { backgroundColor: colors.surfaceVariant, borderWidth: 1, borderColor: colors.border }]}
                    onPress={() => setAction(a.key)}>
                    <Text style={[s.actionChipText, { color: action === a.key ? '#fff' : colors.text }]}>
                      {a.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {action === 'move' && (
                <>
                  <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                    {t('filters.selectFolder') || 'Selecionar pasta'}
                  </Text>
                  <View style={s.actionBtns}>
                    {allFolders.map(f => (
                      <TouchableOpacity key={f}
                        style={[s.actionChip, destination === f
                          ? { backgroundColor: colors.primary }
                          : { backgroundColor: colors.surfaceVariant, borderWidth: 1, borderColor: colors.border }]}
                        onPress={() => setDestination(f)}>
                        <Text style={[s.actionChipText, { color: destination === f ? '#fff' : colors.text }]}>{f}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                    value={destination} onChangeText={setDestination}
                    placeholder={t('filters.customFolder') || 'Ou digite nome da pasta'}
                    placeholderTextColor={colors.textTertiary} />
                </>
              )}

              {action === 'label' && (
                <TextInput style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                  value={label} onChangeText={setLabel}
                  placeholder={t('filters.labelName') || 'Nome da etiqueta'}
                  placeholderTextColor={colors.textTertiary} />
              )}

              <View style={[s.switchRow, { marginTop: Spacing.md }]}>
                <Text style={[s.switchLabel, { color: colors.text }]}>
                  {t('filters.enabled') || 'Filtro ativo'}
                </Text>
                <Switch value={enabled} onValueChange={setEnabled}
                  trackColor={{ true: colors.primary, false: colors.border }} />
              </View>

              <TouchableOpacity style={[s.saveBtn, { backgroundColor: colors.primary }]} onPress={handleSave}>
                <IconCheck size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.saveBtnText}>{t('filters.saveRule') || 'Salvar filtro'}</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <>
              {loading ? <ActivityIndicator style={{ padding: 40 }} color={colors.primary} /> : (
                <FlatList data={filters} keyExtractor={(f, i) => String(f.id ?? i)}
                  style={{ maxHeight: 400 }}
                  ListEmptyComponent={
                    <View style={s.emptyBox}>
                      <IconFilter size={36} color={colors.textTertiary} />
                      <Text style={[s.empty, { color: colors.textTertiary }]}>
                        {t('filters.noFilters') || 'Nenhum filtro criado'}
                      </Text>
                      <Text style={[s.emptyHint, { color: colors.textTertiary }]}>
                        {t('filters.hint') || 'Crie filtros para organizar seus emails automaticamente'}
                      </Text>
                    </View>
                  }
                  renderItem={({ item }) => (
                    <View style={[s.item, { borderBottomColor: colors.borderLight }]}>
                      <TouchableOpacity style={s.itemToggle} onPress={() => handleToggle(item.id)}>
                        <View style={[s.itemDot, { backgroundColor: item.enabled !== false ? '#22c55e' : colors.textTertiary }]} />
                      </TouchableOpacity>
                      <TouchableOpacity style={s.itemContent} onPress={() => startEdit(item)}>
                        <Text style={[s.itemName, { color: colors.text }, item.enabled === false && { opacity: 0.5 }]}>
                          {item.name || item.from || item.subject}
                        </Text>
                        <Text style={[s.itemSub, { color: colors.textSecondary }]} numberOfLines={1}>
                          {item.from ? `De: ${item.from}` : ''}
                          {item.subject ? ` Assunto: ${item.subject}` : ''}
                          {item.action === 'move' ? ` → ${item.destination}` : ''}
                          {item.action === 'delete' ? ' → Excluir' : ''}
                          {item.action === 'star' ? ' → Estrela' : ''}
                          {item.action === 'mark_read' ? ' → Lido' : ''}
                          {item.action === 'label' ? ` → Etiqueta: ${item.label}` : ''}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => handleDelete(item.id)} style={s.itemBtn}>
                        <IconTrash size={16} color={colors.error} />
                      </TouchableOpacity>
                    </View>
                  )}
                />
              )}
              <TouchableOpacity style={[s.addBtn, { borderTopColor: colors.borderLight }]} onPress={() => setEditing('new')}>
                <IconPlus size={18} color={colors.primary} />
                <Text style={[s.addText, { color: colors.primary }]}>
                  {t('filters.createFilter') || 'Criar filtro'}
                </Text>
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
  modal: { borderRadius: BorderRadius.xl, width: '92%', maxWidth: 520, maxHeight: '85%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: 1 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  closeBtn: { padding: Spacing.sm },
  editForm: { padding: Spacing.lg },
  sectionLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: Spacing.md, marginBottom: 4, letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.sm },
  switchLabel: { fontSize: 15, fontWeight: '500' },
  actionBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  actionChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  actionChipText: { fontSize: 13, fontWeight: '600' },
  saveBtn: { borderRadius: BorderRadius.md, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.lg, flexDirection: 'row', justifyContent: 'center' },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  itemToggle: { padding: 8 },
  itemDot: { width: 10, height: 10, borderRadius: 5 },
  itemContent: { flex: 1, marginLeft: 4 },
  itemName: { fontSize: 15, fontWeight: '600' },
  itemSub: { fontSize: 12, marginTop: 2 },
  itemBtn: { padding: Spacing.sm },
  emptyBox: { alignItems: 'center', padding: 40, gap: 8 },
  empty: { fontSize: 15, fontWeight: '600' },
  emptyHint: { fontSize: 13, textAlign: 'center' },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.lg, borderTopWidth: 1, gap: Spacing.sm },
  addText: { fontSize: 15, fontWeight: '700' },
});
