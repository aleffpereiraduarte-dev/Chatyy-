import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconInbox, IconUsers, IconTag, IconBell, IconMail } from './Icons';

const CATEGORIES = [
  { key: 'all', i18nKey: 'category.all', icon: IconMail, color: '#6366f1' },
  { key: 'primary', i18nKey: 'category.primary', icon: IconInbox, color: '#2563eb' },
  { key: 'social', i18nKey: 'category.social', icon: IconUsers, color: '#8b5cf6' },
  { key: 'promotions', i18nKey: 'category.promotions', icon: IconTag, color: '#10b981' },
  { key: 'updates', i18nKey: 'category.updates', icon: IconBell, color: '#f59e0b' },
];

export default function CategoryTabs({ activeCategory = 'all', onCategoryChange, counts = {} }) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.container}
      style={[s.scroll, { borderBottomColor: colors.borderLight, borderBottomWidth: StyleSheet.hairlineWidth }]}
    >
      {CATEGORIES.map((cat) => {
        const isActive = activeCategory === cat.key;
        const count = counts[cat.key];
        const Icon = cat.icon;
        const activeColor = cat.color;
        return (
          <TouchableOpacity
            key={cat.key}
            style={[
              s.tab,
              {
                backgroundColor: isActive ? activeColor + '14' : 'transparent',
                borderColor: isActive ? activeColor + '30' : 'transparent',
              },
            ]}
            onPress={() => onCategoryChange?.(cat.key)}
            activeOpacity={0.7}
          >
            <Icon
              size={15}
              color={isActive ? activeColor : colors.textTertiary}
              style={{ marginRight: 5 }}
            />
            <Text
              style={[
                s.tabText,
                { color: isActive ? activeColor : colors.textSecondary },
                isActive && s.tabTextActive,
              ]}
            >
              {t(cat.i18nKey)}
            </Text>
            {count > 0 && (
              <View style={[
                s.badge,
                { backgroundColor: isActive ? activeColor : colors.textTertiary + '30' },
              ]}>
                <Text style={[
                  s.badgeText,
                  { color: isActive ? '#fff' : colors.textSecondary },
                ]}>
                  {count > 99 ? '99+' : count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 0 },
  container: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    gap: 6,
  },
  tab: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1,
    ...Platform.select({
      web: { transition: 'all 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  tabText: { fontSize: FontSize.md, fontWeight: '500' },
  tabTextActive: { fontWeight: '600' },
  badge: {
    minWidth: 18, height: 18, borderRadius: 9,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 6, paddingHorizontal: 5,
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
});
