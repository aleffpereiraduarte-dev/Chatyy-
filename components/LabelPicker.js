import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Platform, ScrollView } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconTag, IconCheck, IconPlus, IconChevronDown, IconChevronRight } from './Icons';
import * as api from '../services/api';

// Gmail-style: 12 clean colors (compact, no clutter)
export const LABEL_COLORS = {
  trabalho:    { bg: '#e8f0fe', text: '#1a73e8', border: '#1a73e8' },
  pessoal:     { bg: '#e6f4ea', text: '#34a853', border: '#34a853' },
  importante:  { bg: '#fce8e6', text: '#c5221f', border: '#c5221f' },
  financeiro:  { bg: '#fef7e0', text: '#ea8600', border: '#ea8600' },
  social:      { bg: '#f3e8fd', text: '#a142f4', border: '#a142f4' },
  viagem:      { bg: '#e0f7f5', text: '#1a9988', border: '#1a9988' },
  roxo:        { bg: '#f3e5f5', text: '#7b1fa2', border: '#7b1fa2' },
  rosa:        { bg: '#fce4ec', text: '#c2185b', border: '#c2185b' },
  azul:        { bg: '#e3f2fd', text: '#1565c0', border: '#1565c0' },
  laranja:     { bg: '#fff3e0', text: '#e65100', border: '#e65100' },
  cinza:       { bg: '#f5f5f5', text: '#616161', border: '#616161' },
  marrom:      { bg: '#efebe9', text: '#4e342e', border: '#4e342e' },
};

export const LABEL_NAMES = Object.keys(LABEL_COLORS);

export function LabelChip({ label, small }) {
  // Normalize: label can be string or {name, color} object
  const name = (typeof label === 'object' && label !== null) ? (label.name || '') : String(label || '');
  if (!name) return null;
  const style = LABEL_COLORS[name] || LABEL_COLORS[label] || { bg: '#e8eaf6', text: '#3949ab', border: '#3949ab' };
  const display = name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <View style={[s.chip, small && s.chipSmall, { backgroundColor: style.bg, borderColor: style.border }]}>
      <Text numberOfLines={1} style={[s.chipText, small && s.chipTextSmall, { color: style.text }]}>
        {display}
      </Text>
    </View>
  );
}

export default function LabelPicker({ visible, onClose, currentLabels = [], onToggleLabel, customLabels = [] }) {
  const { colors } = useTheme();
  const [showCreate, setShowCreate] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  // Nested-label support (2026-05-17): pull labels (with parent_label) from
  // PG via label_list. Falls back to the flat builtins + customLabels if the
  // endpoint fails so existing users still see their labels.
  const [pgLabels, setPgLabels] = useState([]);
  const [parentDraft, setParentDraft] = useState('');
  const [collapsed, setCollapsed] = useState({}); // { parentName: true } when collapsed
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    api.labelList?.().then(r => {
      if (cancelled || !r?.success) return;
      const list = Array.isArray(r.data?.labels) ? r.data.labels : [];
      setPgLabels(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible]);

  // Build a tree of labels: roots + children grouped under parent name.
  // Falls back to the legacy flat structure when nothing has parent_label.
  const tree = useMemo(() => {
    const allNames = new Set([
      ...LABEL_NAMES,
      ...customLabels.filter(l => !LABEL_NAMES.includes(l)),
      ...pgLabels.map(l => l.name),
    ]);
    // Map: name → metadata (parent, color, etc)
    const metaByName = {};
    pgLabels.forEach(l => { metaByName[l.name] = { parent: l.parent_label || null, color: l.color }; });
    LABEL_NAMES.forEach(n => { if (!metaByName[n]) metaByName[n] = { parent: null, color: LABEL_COLORS[n]?.text }; });
    customLabels.forEach(n => { if (!metaByName[n]) metaByName[n] = { parent: null }; });

    const roots = [];
    const childrenOf = {}; // { parentName: [child1, child2] }
    allNames.forEach(n => {
      const p = metaByName[n]?.parent;
      if (p && allNames.has(p)) {
        (childrenOf[p] = childrenOf[p] || []).push(n);
      } else {
        roots.push(n);
      }
    });
    Object.values(childrenOf).forEach(arr => arr.sort());
    roots.sort();
    return { roots, childrenOf, metaByName };
  }, [pgLabels, customLabels]);

  const handleCreateLabel = async () => {
    const name = newLabelName.trim().toLowerCase();
    if (!name) return;
    // When the user provided a parent draft, persist nested via the new
    // label_create_nested endpoint; otherwise fall back to legacy create.
    const parent = parentDraft.trim().toLowerCase();
    try {
      if (parent) {
        await api.labelCreateNested?.(name, '#1a73e8', parent);
      } else {
        await api.createLabel(name);
      }
    } catch {}
    setNewLabelName('');
    setParentDraft('');
    setShowCreate(false);
    // Refresh PG list so the new (nested) label appears immediately.
    try {
      const r = await api.labelList?.();
      if (r?.success) setPgLabels(Array.isArray(r.data?.labels) ? r.data.labels : []);
    } catch {}
  };

  // Recursively render a label row + its children (one level deep typically,
  // but the function self-recurses so deeper nests still work).
  const renderLabelRow = (name, depth = 0) => {
    const isActive = currentLabels.includes(name);
    const labelStyle = LABEL_COLORS[name] || { text: tree.metaByName[name]?.color || colors.primary, bg: colors.primaryLight };
    const kids = tree.childrenOf[name] || [];
    const isCollapsed = !!collapsed[name];
    return (
      <View key={name}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, paddingLeft: 16 + depth * 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }}>
          {kids.length > 0 ? (
            <TouchableOpacity onPress={() => setCollapsed(prev => ({ ...prev, [name]: !prev[name] }))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {isCollapsed
                ? <IconChevronRight size={12} color={colors.textSecondary} />
                : <IconChevronDown size={12} color={colors.textSecondary} />}
            </TouchableOpacity>
          ) : (
            <View style={{ width: 12 }} />
          )}
          <View style={[s.dot, { backgroundColor: labelStyle.text, marginLeft: 6 }]} />
          <TouchableOpacity style={{ flex: 1 }} onPress={() => onToggleLabel(name)}>
            <Text style={[s.labelName, { color: colors.text, fontWeight: isActive ? '700' : '400' }]}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </Text>
          </TouchableOpacity>
          {isActive && <IconCheck size={14} color={colors.primary} />}
        </View>
        {!isCollapsed && kids.map(k => renderLabelRow(k, depth + 1))}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconTag size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>Labels</Text>
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={s.body}>
            {/* Tree view — roots + children indented one level per depth. */}
            <ScrollView style={{ maxHeight: 360 }}>
              {tree.roots.map(name => renderLabelRow(name, 0))}
            </ScrollView>

            {/* Create new label — supports optional parent for nesting. */}
            {showCreate ? (
              <View style={{ paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm, gap: 6 }}>
                <TextInput
                  style={[s.createInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                  value={newLabelName}
                  onChangeText={setNewLabelName}
                  placeholder="Nome da label"
                  placeholderTextColor={colors.textTertiary}
                  autoFocus
                  onSubmitEditing={handleCreateLabel}
                />
                <TextInput
                  style={[s.createInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                  value={parentDraft}
                  onChangeText={setParentDraft}
                  placeholder="Pai (opcional, ex.: trabalho)"
                  placeholderTextColor={colors.textTertiary}
                  onSubmitEditing={handleCreateLabel}
                />
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                  <TouchableOpacity onPress={() => { setShowCreate(false); setNewLabelName(''); setParentDraft(''); }} style={s.createBtn}>
                    <IconX size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCreateLabel} style={s.createBtn}>
                    <IconCheck size={16} color={colors.primary} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[s.row, { borderBottomColor: colors.borderLight }]}
                onPress={() => setShowCreate(true)}
              >
                <IconPlus size={14} color={colors.primary} style={{ marginRight: Spacing.md }} />
                <Text style={[s.labelName, { color: colors.primary }]}>Criar nova label</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 340 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  closeBtn: { padding: 6 },
  body: { paddingVertical: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colorGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 14, paddingVertical: 10,
    justifyContent: 'flex-start',
  },
  colorCircle: {
    width: 26, height: 26, borderRadius: 13,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2,
  },
  colorCircleActive: { borderWidth: 2.5 },
  activeLabel: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  labelName: { flex: 1, fontSize: 13 },
  // Chip
  chip: {
    borderWidth: 1, borderRadius: 4,
    paddingHorizontal: 8, paddingVertical: 2,
    flexShrink: 0,
  },
  chipSmall: { paddingHorizontal: 5, paddingVertical: 0 },
  chipText: { fontSize: FontSize.xs, fontWeight: '600' },
  chipTextSmall: { fontSize: 10 },
  // Create label
  createRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm, gap: 4,
  },
  createInput: {
    flex: 1, fontSize: FontSize.sm, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  createBtn: { padding: 6 },
});
