import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconInbox, IconUsers, IconTag, IconBell, IconMail, IconMailOpen, IconStarFilled } from './Icons';

const CATEGORIES = [
  { key: 'all', i18nKey: 'category.all', icon: IconMail, color: '#A78BFA' },
  { key: 'unread', i18nKey: 'category.unread', icon: IconMailOpen, color: '#ef4444' },
  // "Importantes" — driven by the AI importance classifier (level === 'high')
  // OR a flagged message. Sits second so users see prioritized work first.
  { key: 'important', i18nKey: 'inbox.tabImportant', icon: IconStarFilled, color: '#f59e0b' },
  { key: 'primary', i18nKey: 'category.primary', icon: IconInbox, color: '#7C3AED' },
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
              isActive
                ? {
                    backgroundColor: activeColor,
                    borderColor: activeColor,
                    ...(Platform.OS === 'web' ? { boxShadow: `0 6px 18px ${activeColor}40` } : {}),
                  }
                : {
                    backgroundColor: colors.surface,
                    borderColor: colors.borderLight,
                  },
            ]}
            onPress={() => onCategoryChange?.(cat.key)}
            activeOpacity={0.75}
          >
            <Icon
              size={15}
              color={isActive ? '#fff' : colors.textTertiary}
              style={{ marginRight: 6 }}
            />
            <Text
              style={[
                s.tabText,
                { color: isActive ? '#fff' : colors.textSecondary },
                isActive && s.tabTextActive,
              ]}
            >
              {t(cat.i18nKey)}
            </Text>
            {count > 0 && (
              <View style={[
                s.badge,
                { backgroundColor: isActive ? 'rgba(255,255,255,0.28)' : (colors.textTertiary + '22') },
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
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
    gap: 8,
  },
  tab: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 22, borderWidth: 1,
    ...Platform.select({
      web: {
        transition: 'background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease',
        cursor: 'pointer',
      },
      default: {},
    }),
  },
  tabText: { fontSize: 13.5, fontWeight: '700', letterSpacing: -0.1 },
  tabTextActive: { fontWeight: '800' },
  badge: {
    minWidth: 20, height: 20, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 6, paddingHorizontal: 5,
  },
  badgeText: { fontSize: 10, fontWeight: '800' },
});
