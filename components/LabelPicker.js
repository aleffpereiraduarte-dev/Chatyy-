import { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconTag, IconCheck, IconPlus } from './Icons';
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
  const style = LABEL_COLORS[label] || { bg: '#e8eaf6', text: '#3949ab', border: '#3949ab' };
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
            {/* Color grid preview */}
            <View style={s.colorGrid}>
              {allLabels.map((name) => {
                const isActive = currentLabels.includes(name);
                const labelStyle = LABEL_COLORS[name] || { text: colors.primary, bg: colors.primaryLight };
                return (
                  <TouchableOpacity
                    key={name}
                    style={[
                      s.colorCircle,
                      { backgroundColor: labelStyle.text, borderColor: isActive ? colors.text : 'transparent' },
                      isActive && s.colorCircleActive,
                    ]}
                    onPress={() => onToggleLabel(name)}
                    accessibilityLabel={name}
                  >
                    {isActive && <IconCheck size={12} color="#fff" />}
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Label list with names */}
            {allLabels.filter(name => currentLabels.includes(name)).map((name) => {
              const labelStyle = LABEL_COLORS[name] || { text: colors.primary, bg: colors.primaryLight };
              return (
                <View key={name} style={[s.activeLabel, { borderBottomColor: colors.borderLight }]}>
                  <View style={[s.dot, { backgroundColor: labelStyle.text }]} />
                  <Text style={[s.labelName, { color: colors.text, flex: 1 }]}>
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </Text>
                  <TouchableOpacity onPress={() => onToggleLabel(name)}>
                    <IconX size={14} color={colors.textTertiary} />
                  </TouchableOpacity>
                </View>
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
