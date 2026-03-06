import { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconTag, IconCheck, IconPlus } from './Icons';
import * as api from '../services/api';

export const LABEL_COLORS = {
  trabalho:    { bg: '#e8f0fe', text: '#1a73e8', border: '#1a73e8' },
  pessoal:     { bg: '#e6f4ea', text: '#34a853', border: '#34a853' },
  importante:  { bg: '#fce8e6', text: '#c5221f', border: '#c5221f' },
  financeiro:  { bg: '#fef7e0', text: '#ea8600', border: '#ea8600' },
  social:      { bg: '#f3e8fd', text: '#a142f4', border: '#a142f4' },
  viagem:      { bg: '#e0f7f5', text: '#1a9988', border: '#1a9988' },
};

export const LABEL_NAMES = Object.keys(LABEL_COLORS);

export function LabelChip({ label, small }) {
  const style = LABEL_COLORS[label];
  if (!style) return null;
  return (
    <View style={[s.chip, small && s.chipSmall, { backgroundColor: style.bg, borderColor: style.border }]}>
      <Text style={[s.chipText, small && s.chipTextSmall, { color: style.text }]}>
        {label.charAt(0).toUpperCase() + label.slice(1)}
      </Text>
    </View>
  );
}

export default function LabelPicker({ visible, onClose, currentLabels = [], onToggleLabel, customLabels = [] }) {
  const { colors } = useTheme();
  const [showCreate, setShowCreate] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');

  const allLabels = [...LABEL_NAMES, ...customLabels.filter(l => !LABEL_NAMES.includes(l))];

  const handleCreateLabel = async () => {
    const name = newLabelName.trim().toLowerCase();
    if (!name) return;
    const r = await api.createLabel(name);
    if (r.success) {
      setNewLabelName('');
      setShowCreate(false);
    }
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
            {allLabels.map((name) => {
              const isActive = currentLabels.includes(name);
              const labelStyle = LABEL_COLORS[name] || { text: colors.primary, bg: colors.primaryLight };
              return (
                <TouchableOpacity
                  key={name}
                  style={[s.row, { borderBottomColor: colors.borderLight }]}
                  onPress={() => onToggleLabel(name)}
                >
                  <View style={[s.dot, { backgroundColor: labelStyle.text }]} />
                  <Text style={[s.labelName, { color: colors.text }]}>
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </Text>
                  {isActive && <IconCheck size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}

            {/* Create new label */}
            {showCreate ? (
              <View style={[s.createRow, { borderBottomColor: colors.borderLight }]}>
                <TextInput
                  style={[s.createInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
                  value={newLabelName}
                  onChangeText={setNewLabelName}
                  placeholder="Nome da label"
                  placeholderTextColor={colors.textTertiary}
                  autoFocus
                  onSubmitEditing={handleCreateLabel}
                />
                <TouchableOpacity onPress={handleCreateLabel} style={s.createBtn}>
                  <IconCheck size={16} color={colors.primary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setShowCreate(false); setNewLabelName(''); }} style={s.createBtn}>
                  <IconX size={16} color={colors.textSecondary} />
                </TouchableOpacity>
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
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { paddingVertical: Spacing.xs },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: Spacing.md },
  labelName: { flex: 1, fontSize: FontSize.lg },
  // Chip
  chip: {
    borderWidth: 1, borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 1,
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
