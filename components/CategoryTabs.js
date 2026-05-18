import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconInbox, IconUsers, IconTag, IconBell, IconMail, IconMailOpen, IconStarFilled } from './Icons';

const CATEGORIES = [
  { key: 'all', i18nKey: 'category.all', icon: IconMail, color: '#A78BFA' },
  { key: 'unread', i18nKey: 'category.unread', icon: IconMailOpen, color: '#f43f5e' },
  // "Importantes" — driven by the AI importance classifier (level === 'high')
  // OR a flagged message. Sits second so users see prioritized work first.
  { key: 'important', i18nKey: 'inbox.tabImportant', icon: IconStarFilled, color: '#f59e0b' },
  { key: 'primary', i18nKey: 'category.primary', icon: IconInbox, color: '#7C3AED' },
  { key: 'social', i18nKey: 'category.social', icon: IconUsers, color: '#8b5cf6' },
  { key: 'promotions', i18nKey: 'category.promotions', icon: IconTag, color: '#10b981' },
  { key: 'updates', i18nKey: 'category.updates', icon: IconBell, color: '#3b82f6' },
];

// Color/icon palette for backend-supplied bundles (Gmail-style category
// grouping — compras / viagens / financas / foruns / notificacoes / …).
const BUNDLE_COLORS = {
  compras: '#0ea5e9',
  viagens: '#06b6d4',
  financas: '#16a34a',
  foruns: '#a855f7',
  notificacoes: '#3b82f6',
};
function defaultBundleIcon() { return IconTag; }

export default function CategoryTabs({ activeCategory = 'all', onCategoryChange, counts = {}, bundles = [] }) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  // Merge in dynamic bundles supplied by the backend (email_bundles).
  // We dedupe against the static categories so primary/social/etc. don't
  // duplicate when the backend returns them too.
  const dedup = new Set(CATEGORIES.map(c => c.key));
  const extraBundles = (bundles || [])
    .filter(b => b && b.id && !dedup.has(b.id))
    .slice(0, 8) // soft cap so the scroll row stays usable
    .map(b => ({
      key: b.id,
      label: b.label || b.id,
      icon: defaultBundleIcon(),
      color: BUNDLE_COLORS[b.id] || '#94a3b8',
      isBundle: true,
      bundleCount: b.count || 0,
    }));
  const merged = [...CATEGORIES, ...extraBundles];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.container}
      style={s.scroll}
    >
      {merged.map((cat) => {
        const isActive = activeCategory === cat.key;
        const count = counts[cat.key] != null ? counts[cat.key] : (cat.isBundle ? cat.bundleCount : undefined);
        const Icon = cat.icon;
        const activeColor = cat.color;
        const labelText = cat.i18nKey ? t(cat.i18nKey) : (cat.label || cat.key);
        return (
          <TouchableOpacity
            key={cat.key}
            style={[
              s.tab,
              isActive
                ? {
                    backgroundColor: activeColor,
                    borderColor: activeColor,
                    ...Platform.select({
                      ios: { shadowColor: activeColor, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.32, shadowRadius: 10 },
                      android: { elevation: 4 },
                      web: { boxShadow: `0 6px 18px ${activeColor}40` },
                    }),
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
              {labelText}
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
