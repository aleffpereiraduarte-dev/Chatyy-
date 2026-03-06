import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX } from './Icons';

const SHORTCUT_DEFS = [
  { categoryKey: 'shortcuts.navigation', items: [
    { key: 'j', descKey: 'shortcuts.nextEmail' },
    { key: 'k', descKey: 'shortcuts.prevEmail' },
    { key: '/', descKey: 'shortcuts.focusSearch' },
    { key: 'Esc', descKey: 'shortcuts.close' },
  ]},
  { categoryKey: 'shortcuts.actions', items: [
    { key: 'c', descKey: 'shortcuts.compose' },
    { key: 'r', descKey: 'shortcuts.reply' },
    { key: 'e', descKey: 'shortcuts.archive' },
    { key: '#', descKey: 'shortcuts.delete' },
    { key: 's', descKey: 'shortcuts.star' },
    { key: 'z', descKey: 'shortcuts.undo' },
  ]},
  { categoryKey: 'shortcuts.selection', items: [
    { key: 'x', descKey: 'shortcuts.select' },
    { key: '?', descKey: 'shortcuts.show' },
  ]},
];

export default function KeyboardShortcutsModal({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  if (Platform.OS !== 'web') return null;

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <Text style={[s.title, { color: colors.text }]}>{t('shortcuts.title')}</Text>
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
            {SHORTCUT_DEFS.map((section) => (
              <View key={section.categoryKey} style={s.section}>
                <Text style={[s.sectionTitle, { color: colors.primary }]}>{t(section.categoryKey)}</Text>
                {section.items.map((item) => (
                  <View key={item.key} style={s.row}>
                    <View style={[s.keyBadge, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}>
                      <Text style={[s.keyText, { color: colors.text }]}>{item.key}</Text>
                    </View>
                    <Text style={[s.desc, { color: colors.textSecondary }]}>{t(item.descKey)}</Text>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modal: {
    borderRadius: BorderRadius.xl, width: '90%', maxWidth: 480, maxHeight: '80%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '700' },
  closeBtn: { padding: Spacing.sm },
  body: { flex: 1 },
  bodyContent: { padding: Spacing.xl },
  section: { marginBottom: Spacing.xl },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  keyBadge: {
    minWidth: 36, height: 30, borderRadius: 6, borderWidth: 1,
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: Spacing.sm, marginRight: Spacing.lg,
  },
  keyText: { fontSize: FontSize.base, fontWeight: '600', fontFamily: 'monospace' },
  desc: { fontSize: FontSize.base, flex: 1 },
});
