import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, FlatList, Switch, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconPlus, IconTrash, IconFilter, IconEdit, IconCheck } from './Icons';
import { apiCall } from '../services/api';

// Multi-condition email rules engine. Each rule has:
//   - conditions: [{field, op, value}] chained via condition_op (AND|OR)
//   - actions: [{type, value}] chained, all execute on match
// Operators supported (server agrees): contains, equals, starts_with,
// ends_with, regex_match, greater_than (size in bytes/KB), older_than (days),
// not_contains. Actions: move_to_folder, apply_label, mark_read, forward_to,
// delete, star, reply_with_template.
const FIELDS = [
  { key: 'from',    label: 'De' },
  { key: 'to',      label: 'Para' },
  { key: 'subject', label: 'Assunto' },
  { key: 'body',    label: 'Corpo' },
  { key: 'size',    label: 'Tamanho' },
  { key: 'date',    label: 'Data' },
];
const OPS_TEXT = ['contains', 'equals', 'starts_with', 'ends_with', 'regex_match', 'not_contains'];
const OPS_NUM  = ['greater_than'];
const OPS_DATE = ['older_than'];

function opsForField(field) {
  if (field === 'size') return OPS_NUM;
  if (field === 'date') return OPS_DATE;
  return OPS_TEXT;
}

const ACTION_TYPES = [
  'move_to_folder', 'apply_label', 'mark_read', 'forward_to', 'delete', 'star', 'reply_with_template',
];

function emptyCondition() { return { field: 'from', op: 'contains', value: '' }; }
function emptyAction()    { return { type: 'move_to_folder', value: '' }; }

export default function FilterRuleEditor({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null = list, 'new' or filter object
  const [folders, setFolders] = useState([]);

  // Form state — multi-condition / multi-action
  const [name, setName] = useState('');
  const [conditionOp, setConditionOp] = useState('AND'); // AND | OR
  const [conditions, setConditions] = useState([emptyCondition()]);
  const [actions, setActions] = useState([emptyAction()]);
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [fr, fo] = await Promise.all([
        apiCall('filters_get'),
        apiCall('folders'),
      ]);
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
    setName('');
    setConditionOp('AND');
    setConditions([emptyCondition()]);
    setActions([emptyAction()]);
    setEnabled(true);
  };

  const startEdit = (f) => {
    setEditing(f);
    setName(f.name || '');
    // Hydrate conditions/actions, falling back to legacy single-row shape.
    let conds = Array.isArray(f.conditions) ? f.conditions.map(c => ({
      field: c.field || 'from',
      op:    c.op || c.operator || 'contains',
      value: String(c.value ?? ''),
    })) : [];
    if (conds.length === 0) {
      if (f.from)      conds.push({ field: 'from',    op: 'contains', value: f.from });
      if (f.to)        conds.push({ field: 'to',      op: 'contains', value: f.to });
      if (f.subject)   conds.push({ field: 'subject', op: 'contains', value: f.subject });
      if (f.has_words) conds.push({ field: 'body',    op: 'contains', value: f.has_words });
    }
    if (conds.length === 0) conds = [emptyCondition()];
    let acts = Array.isArray(f.actions) ? f.actions.map(a => ({
      type: a.type === 'move' ? 'move_to_folder' : (a.type === 'label' ? 'apply_label' : (a.type === 'forward' ? 'forward_to' : a.type)),
      value: String(a.value ?? ''),
    })) : [];
    if (acts.length === 0) {
      const legacyType = f.action || 'move';
      const legacyValue = legacyType === 'move' ? (f.destination || 'Archive') : (legacyType === 'label' ? (f.label || '') : '');
      const t2 = legacyType === 'move' ? 'move_to_folder' : (legacyType === 'label' ? 'apply_label' : (legacyType === 'forward' ? 'forward_to' : legacyType));
      acts = [{ type: t2, value: legacyValue }];
    }
    setConditions(conds);
    setActions(acts);
    setConditionOp((f.condition_op || (f.match_mode === 'any' ? 'OR' : 'AND')).toUpperCase());
    setEnabled(f.enabled !== false);
  };

  const handleSave = async () => {
    const validConds = conditions.filter(c => c.value && c.value.trim() !== '');
    const validActs  = actions.filter(a => {
      if (['mark_read', 'delete', 'star'].includes(a.type)) return true;
      return a.value && a.value.trim() !== '';
    });
    if (validConds.length === 0 || validActs.length === 0) return;

    const rule = {
      id: (editing && editing !== 'new') ? editing.id : 'f_' + Date.now(),
      name: name.trim() || (validConds[0]?.value || 'Filtro'),
      enabled,
      condition_op: conditionOp,
      match_mode: conditionOp === 'OR' ? 'any' : 'all',
      conditions: validConds,
      actions: validActs,
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

  // Test the current draft against backend filter_test using the first
  // condition row's values as the synthetic sample (legacy behaviour).
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const handleTest = useCallback(async () => {
    if (testing) return;
    const validConds = conditions.filter(c => c.value && c.value.trim() !== '')
      .map(c => ({ field: c.field, operator: c.op, value: c.value.trim() }));
    if (validConds.length === 0) return;
    setTesting(true);
    setTestResult(null);
    try {
      const sampleFrom    = (conditions.find(c => c.field === 'from')?.value)    || 'sample@example.com';
      const sampleTo      = (conditions.find(c => c.field === 'to')?.value)      || 'me@chatyy.com.br';
      const sampleSubject = (conditions.find(c => c.field === 'subject')?.value) || 'Sample subject';
      const sampleBody    = (conditions.find(c => c.field === 'body')?.value)    || 'Sample body';
      const r = await apiCall('filter_test', {
        conditions: validConds,
        match_mode: conditionOp === 'OR' ? 'any' : 'all',
        sample_from: sampleFrom,
        sample_to: sampleTo,
        sample_subject: sampleSubject,
        sample_body: sampleBody,
      }, 'POST');
      setTestResult(r?.data?.matches ? 'match' : 'no-match');
    } catch { setTestResult('no-match'); }
    setTesting(false);
  }, [conditions, conditionOp, testing]);

  const allFolders = ['Archive', 'Spam', 'Trash', ...folders.filter(f => !['Sent', 'Drafts', 'Junk', 'Archive', 'Spam', 'Trash'].includes(f))];

  const opLabel = (op) => {
    const map = {
      contains: t('op.contains') || 'contém',
      equals: t('op.equals') || 'igual a',
      starts_with: t('op.startsWith') || 'começa com',
      ends_with: t('op.endsWith') || 'termina com',
      regex_match: t('op.regex') || 'regex',
      greater_than: t('op.greaterThan') || 'maior que',
      older_than: t('op.olderThan') || 'mais velho que',
      not_contains: t('op.notContains') || 'não contém',
    };
    return map[op] || op;
  };

  const fieldLabel = (key) => {
    const f = FIELDS.find(x => x.key === key);
    return f ? f.label : key;
  };

  const actionLabel = (type) => {
    const map = {
      move_to_folder: t('filters.moveToFolder') || 'Mover para pasta',
      apply_label: t('filters.addLabel') || 'Adicionar etiqueta',
      mark_read: t('filters.markRead') || 'Marcar como lido',
      forward_to: t('filters.forward') || 'Encaminhar',
      delete: t('filters.delete') || 'Excluir',
      star: t('filters.star') || 'Estrela',
      reply_with_template: t('filters.replyTemplate') || 'Responder com template',
    };
    return map[type] || type;
  };

  // Cycle through chip rows for picking field/op/action type
  const cyclePicker = (current, list) => {
    const idx = list.indexOf(current);
    return list[(idx + 1) % list.length];
  };

  const updateCondition = (i, patch) => setConditions(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const updateAction    = (i, patch) => setActions(prev => prev.map((a, idx) => idx === i ? { ...a, ...patch } : a));

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

              <View style={[s.combineRow, { borderColor: colors.border }]}>
                <Text style={[s.combineLabel, { color: colors.textSecondary }]}>
                  {t('filters.combineWith') || 'Combinar com'}
                </Text>
                <View style={s.combineToggle}>
                  <TouchableOpacity
                    onPress={() => setConditionOp('AND')}
                    style={[s.combineBtn, conditionOp === 'AND' && { backgroundColor: colors.primary }]}
                  >
                    <Text style={[s.combineBtnText, { color: conditionOp === 'AND' ? '#fff' : colors.text }]}>
                      {t('filters.combineAnd') || 'E (todos)'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setConditionOp('OR')}
                    style={[s.combineBtn, conditionOp === 'OR' && { backgroundColor: colors.primary }]}
                  >
                    <Text style={[s.combineBtnText, { color: conditionOp === 'OR' ? '#fff' : colors.text }]}>
                      {t('filters.combineOr') || 'OU (qualquer)'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                {t('filters.conditions') || 'Condições'}
              </Text>
              {conditions.map((c, i) => {
                const ops = opsForField(c.field);
                const opOk = ops.includes(c.op) ? c.op : ops[0];
                return (
                  <View key={i} style={[s.condRow, { borderColor: colors.borderLight }]}>
                    <View style={s.condPickRow}>
                      <TouchableOpacity
                        style={[s.pickChip, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}
                        onPress={() => {
                          const newField = cyclePicker(c.field, FIELDS.map(f => f.key));
                          const newOps = opsForField(newField);
                          updateCondition(i, { field: newField, op: newOps.includes(c.op) ? c.op : newOps[0] });
                        }}
                      >
                        <Text style={[s.pickChipText, { color: colors.text }]}>{fieldLabel(c.field)}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[s.pickChip, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}
                        onPress={() => updateCondition(i, { op: cyclePicker(opOk, ops) })}
                      >
                        <Text style={[s.pickChipText, { color: colors.text }]}>{opLabel(opOk)}</Text>
                      </TouchableOpacity>
                      {conditions.length > 1 && (
                        <TouchableOpacity
                          style={s.removeRowBtn}
                          onPress={() => setConditions(prev => prev.filter((_, idx) => idx !== i))}
                        >
                          <IconTrash size={14} color={colors.error} />
                        </TouchableOpacity>
                      )}
                    </View>
                    <TextInput
                      style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant, marginTop: 6 }]}
                      value={c.value}
                      onChangeText={(v) => updateCondition(i, { value: v })}
                      placeholder={c.field === 'size' ? '5MB' : (c.field === 'date' ? '7' : (t('filters.value') || 'Valor'))}
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize={c.field === 'from' || c.field === 'to' ? 'none' : 'sentences'}
                      keyboardType={c.field === 'date' ? 'numeric' : 'default'}
                    />
                  </View>
                );
              })}
              <TouchableOpacity
                style={[s.addRowBtn, { borderColor: colors.primary }]}
                onPress={() => setConditions(prev => [...prev, emptyCondition()])}
              >
                <IconPlus size={14} color={colors.primary} />
                <Text style={[s.addRowText, { color: colors.primary }]}>
                  {t('filters.addCondition') || 'Adicionar condição'}
                </Text>
              </TouchableOpacity>

              <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                {t('filters.actions') || 'Ações'}
              </Text>
              {actions.map((a, i) => (
                <View key={i} style={[s.condRow, { borderColor: colors.borderLight }]}>
                  <View style={s.condPickRow}>
                    <TouchableOpacity
                      style={[s.pickChip, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}
                      onPress={() => updateAction(i, { type: cyclePicker(a.type, ACTION_TYPES), value: '' })}
                    >
                      <Text style={[s.pickChipText, { color: colors.text }]}>{actionLabel(a.type)}</Text>
                    </TouchableOpacity>
                    {actions.length > 1 && (
                      <TouchableOpacity
                        style={s.removeRowBtn}
                        onPress={() => setActions(prev => prev.filter((_, idx) => idx !== i))}
                      >
                        <IconTrash size={14} color={colors.error} />
                      </TouchableOpacity>
                    )}
                  </View>
                  {a.type === 'move_to_folder' && (
                    <View style={s.actionBtns}>
                      {allFolders.map(f => (
                        <TouchableOpacity key={f}
                          style={[s.actionChip, a.value === f
                            ? { backgroundColor: colors.primary }
                            : { backgroundColor: colors.surfaceVariant, borderWidth: 1, borderColor: colors.border }]}
                          onPress={() => updateAction(i, { value: f })}>
                          <Text style={[s.actionChipText, { color: a.value === f ? '#fff' : colors.text }]}>{f}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {(a.type === 'apply_label' || a.type === 'forward_to' || a.type === 'reply_with_template') && (
                    <TextInput
                      style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant, marginTop: 6 }]}
                      value={a.value}
                      onChangeText={(v) => updateAction(i, { value: v })}
                      placeholder={
                        a.type === 'apply_label' ? (t('filters.labelName') || 'Nome da etiqueta') :
                        a.type === 'forward_to' ? (t('filters.forwardEmail') || 'email@example.com') :
                        (t('filters.templateName') || 'Nome do template')
                      }
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize="none"
                    />
                  )}
                </View>
              ))}
              <TouchableOpacity
                style={[s.addRowBtn, { borderColor: colors.primary }]}
                onPress={() => setActions(prev => [...prev, emptyAction()])}
              >
                <IconPlus size={14} color={colors.primary} />
                <Text style={[s.addRowText, { color: colors.primary }]}>
                  {t('filters.addAction') || 'Adicionar ação'}
                </Text>
              </TouchableOpacity>

              <View style={[s.switchRow, { marginTop: Spacing.md }]}>
                <Text style={[s.switchLabel, { color: colors.text }]}>
                  {t('filters.enabled') || 'Filtro ativo'}
                </Text>
                <Switch value={enabled} onValueChange={setEnabled}
                  trackColor={{ true: colors.primary, false: colors.border }} />
              </View>

              <View style={{ flexDirection: 'row', gap: 8, marginTop: Spacing.lg }}>
                <TouchableOpacity
                  onPress={handleTest}
                  disabled={testing}
                  style={[s.saveBtn, { backgroundColor: colors.surfaceVariant, flex: 1, marginTop: 0, borderWidth: 1, borderColor: colors.border }]}
                >
                  {testing ? <ActivityIndicator size="small" color={colors.primary} /> : (
                    <Text style={[s.saveBtnText, { color: colors.text }]}>
                      {testResult === 'match' ? '✓ ' : testResult === 'no-match' ? '✗ ' : ''}
                      {t('filters.testRun') || 'Testar'}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={[s.saveBtn, { backgroundColor: colors.primary, flex: 2, marginTop: 0 }]} onPress={handleSave}>
                  <IconCheck size={18} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={s.saveBtnText}>{t('filters.saveRule') || 'Salvar filtro'}</Text>
                </TouchableOpacity>
              </View>
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
                  renderItem={({ item }) => {
                    const conds = Array.isArray(item.conditions) ? item.conditions : [];
                    const acts = Array.isArray(item.actions) ? item.actions : [];
                    const summaryConds = conds.length > 0
                      ? conds.slice(0, 2).map(c => `${fieldLabel(c.field)} ${opLabel(c.op || c.operator)} ${c.value}`).join(` ${(item.condition_op || (item.match_mode === 'any' ? 'OR' : 'AND')).toUpperCase()} `)
                      : `${item.from ? `De: ${item.from}` : ''}${item.subject ? ` Assunto: ${item.subject}` : ''}`;
                    const summaryActs = acts.length > 0
                      ? acts.map(a => actionLabel(a.type === 'move' ? 'move_to_folder' : a.type === 'label' ? 'apply_label' : a.type === 'forward' ? 'forward_to' : a.type) + (a.value ? ` (${a.value})` : '')).join(', ')
                      : (item.action === 'move' ? `→ ${item.destination}` : '');
                    return (
                      <View style={[s.item, { borderBottomColor: colors.borderLight }]}>
                        <TouchableOpacity style={s.itemToggle} onPress={() => handleToggle(item.id)}>
                          <View style={[s.itemDot, { backgroundColor: item.enabled !== false ? '#22c55e' : colors.textTertiary }]} />
                        </TouchableOpacity>
                        <TouchableOpacity style={s.itemContent} onPress={() => startEdit(item)}>
                          <Text style={[s.itemName, { color: colors.text }, item.enabled === false && { opacity: 0.5 }]}>
                            {item.name || (conds[0]?.value) || 'Filtro'}
                          </Text>
                          <Text style={[s.itemSub, { color: colors.textSecondary }]} numberOfLines={1}>
                            {summaryConds} {summaryActs ? `→ ${summaryActs}` : ''}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleDelete(item.id)} style={s.itemBtn}>
                          <IconTrash size={16} color={colors.error} />
                        </TouchableOpacity>
                      </View>
                    );
                  }}
                />
              )}
              <TouchableOpacity style={[s.addBtn, { borderTopColor: colors.borderLight }]} onPress={() => { setEditing('new'); setConditions([emptyCondition()]); setActions([emptyAction()]); }}>
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
  actionBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, marginTop: 6 },
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
  combineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: BorderRadius.md, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 },
  combineLabel: { fontSize: 13, fontWeight: '600' },
  combineToggle: { flexDirection: 'row', gap: 6 },
  combineBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  combineBtnText: { fontSize: 12, fontWeight: '700' },
  condRow: { borderWidth: 1, borderRadius: BorderRadius.md, padding: 10, marginBottom: 8 },
  condPickRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  pickChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1 },
  pickChipText: { fontSize: 12, fontWeight: '700' },
  removeRowBtn: { marginLeft: 'auto', padding: 6 },
  addRowBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: BorderRadius.md, borderWidth: 1, gap: 6, marginBottom: 6 },
  addRowText: { fontSize: 13, fontWeight: '700' },
});
