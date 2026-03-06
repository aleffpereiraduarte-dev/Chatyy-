import { View, Text, TouchableOpacity, StyleSheet, Platform, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, DENSITY_CONFIG } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconSun, IconMoon, IconSettings } from './Icons';

export default function QuickSettingsPanel({ visible, onClose }) {
  const { colors, isDark, toggle, density, setDensity, inboxType, setInboxType } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();

  if (!visible) return null;

  return (
    <>
      {/* Backdrop */}
      <TouchableOpacity
        style={s.backdrop}
        onPress={onClose}
        activeOpacity={1}
      />
      <View style={[
        s.panel, Shadow.lg,
        { backgroundColor: colors.surface, borderLeftColor: colors.border },
        Platform.OS === 'web' && s.panelGlass,
      ]}>
        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
          <Text style={[s.title, { color: colors.text }]}>{t('quickSettings.title')}</Text>
          <TouchableOpacity onPress={onClose} style={s.closeBtn}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Theme */}
        <View style={s.section}>
          <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('quickSettings.theme')}</Text>
          <View style={s.optionRow}>
            <TouchableOpacity
              style={[s.optionBtn, { borderColor: colors.divider }, !isDark && { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
              onPress={() => { if (isDark) toggle(); }}
            >
              <IconSun size={18} color={!isDark ? colors.primary : colors.textSecondary} />
              <Text style={[s.optionText, { color: !isDark ? colors.primary : colors.text }]}>Light</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.optionBtn, { borderColor: colors.divider }, isDark && { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
              onPress={() => { if (!isDark) toggle(); }}
            >
              <IconMoon size={18} color={isDark ? colors.primary : colors.textSecondary} />
              <Text style={[s.optionText, { color: isDark ? colors.primary : colors.text }]}>Dark</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Density */}
        <View style={s.section}>
          <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('quickSettings.density')}</Text>
          <View style={s.optionRow}>
            {['compact', 'comfortable', 'spacious'].map(d => (
              <TouchableOpacity
                key={d}
                style={[s.densityBtn, { borderColor: colors.divider }, density === d && { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
                onPress={() => setDensity(d)}
              >
                <View style={s.densityPreview}>
                  {[0, 1, 2].map(i => (
                    <View key={i} style={[
                      s.densityLine,
                      { backgroundColor: colors.textTertiary },
                      d === 'compact' && { height: 2, marginVertical: 1 },
                      d === 'comfortable' && { height: 3, marginVertical: 2 },
                      d === 'spacious' && { height: 4, marginVertical: 3 },
                    ]} />
                  ))}
                </View>
                <Text style={[s.densityLabel, { color: density === d ? colors.primary : colors.text }]}>
                  {d === 'compact' ? t('settings.densityCompact') : d === 'comfortable' ? t('settings.densityComfortable') : t('settings.densitySpacious')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Inbox Type */}
        <View style={s.section}>
          <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('quickSettings.inboxType')}</Text>
          <View style={s.optionCol}>
            {[
              { val: 'default', label: t('quickSettings.default') },
              { val: 'important_first', label: t('quickSettings.importantFirst') },
            ].map(opt => (
              <TouchableOpacity
                key={opt.val}
                style={[s.radioRow, { borderColor: colors.divider }, inboxType === opt.val && { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
                onPress={() => setInboxType(opt.val)}
              >
                <View style={[s.radio, { borderColor: inboxType === opt.val ? colors.primary : colors.divider }]}>
                  {inboxType === opt.val && <View style={[s.radioDot, { backgroundColor: colors.primary }]} />}
                </View>
                <Text style={[s.radioText, { color: inboxType === opt.val ? colors.primary : colors.text }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* See all settings */}
        <TouchableOpacity
          style={[s.seeAllBtn, { borderTopColor: colors.borderLight }]}
          onPress={() => { onClose(); router.push('/settings'); }}
        >
          <IconSettings size={16} color={colors.primary} style={{ marginRight: 8 }} />
          <Text style={[s.seeAllText, { color: colors.primary }]}>{t('quickSettings.seeAll')}</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 90,
    ...(Platform.OS === 'web' ? { position: 'fixed' } : {}),
  },
  panel: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: 280,
    zIndex: 100, borderLeftWidth: 1,
    ...(Platform.OS === 'web' ? { position: 'fixed' } : {}),
  },
  panelGlass: Platform.OS === 'web' ? {
    animation: 'slideInRight 0.2s ease-out',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.1)',
  } : {},
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { fontSize: FontSize.xl, fontWeight: '600' },
  closeBtn: { padding: 4 },
  section: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: Spacing.sm },
  optionRow: { flexDirection: 'row', gap: Spacing.sm },
  optionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, borderRadius: BorderRadius.md, borderWidth: 1, gap: 6,
  },
  optionText: { fontSize: FontSize.sm, fontWeight: '500' },
  densityBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  densityPreview: { marginBottom: 6, width: 28 },
  densityLine: { width: '100%', borderRadius: 1 },
  densityLabel: { fontSize: FontSize.xs, fontWeight: '500' },
  optionCol: { gap: Spacing.sm },
  radioRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  radio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2,
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  radioText: { fontSize: FontSize.base, fontWeight: '500' },
  seeAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.lg, borderTopWidth: 1, marginTop: 'auto',
    position: 'absolute', bottom: 0, left: 0, right: 0,
  },
  seeAllText: { fontSize: FontSize.base, fontWeight: '600' },
});
