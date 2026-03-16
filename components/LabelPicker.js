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
  // Extended palette (20+ colors)
  vermelho:    { bg: '#ffebee', text: '#c62828', border: '#c62828' },
  rosa:        { bg: '#fce4ec', text: '#ad1457', border: '#ad1457' },
  roxo:        { bg: '#f3e5f5', text: '#6a1b9a', border: '#6a1b9a' },
  'roxo escuro': { bg: '#ede7f6', text: '#4527a0', border: '#4527a0' },
  indigo:      { bg: '#e8eaf6', text: '#283593', border: '#283593' },
  azul:        { bg: '#e3f2fd', text: '#1565c0', border: '#1565c0' },
  'azul claro': { bg: '#e1f5fe', text: '#0277bd', border: '#0277bd' },
  ciano:       { bg: '#e0f7fa', text: '#00838f', border: '#00838f' },
  teal:        { bg: '#e0f2f1', text: '#00695c', border: '#00695c' },
  verde:       { bg: '#e8f5e9', text: '#2e7d32', border: '#2e7d32' },
  'verde claro': { bg: '#f1f8e9', text: '#558b2f', border: '#558b2f' },
  lima:        { bg: '#f9fbe7', text: '#9e9d24', border: '#9e9d24' },
  amarelo:     { bg: '#fffde7', text: '#f9a825', border: '#f9a825' },
  ambar:       { bg: '#fff8e1', text: '#ff8f00', border: '#ff8f00' },
  laranja:     { bg: '#fff3e0', text: '#ef6c00', border: '#ef6c00' },
  'laranja escuro': { bg: '#fbe9e7', text: '#d84315', border: '#d84315' },
  marrom:      { bg: '#efebe9', text: '#4e342e', border: '#4e342e' },
  cinza:       { bg: '#f5f5f5', text: '#616161', border: '#616161' },
  'cinza azul': { bg: '#eceff1', text: '#37474f', border: '#37474f' },
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
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { paddingVertical: Spacing.xs },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colorGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    justifyContent: 'flex-start',
  },
  colorCircle: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2,
  },
  colorCircleActive: { borderWidth: 2.5 },
  activeLabel: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm,
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
