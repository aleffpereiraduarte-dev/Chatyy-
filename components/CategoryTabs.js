import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconInbox, IconUsers, IconTag, IconBell, IconMail, IconMailOpen, IconStarFilled } from './Icons';

// [beauty 2026-10-01] Monochrome pills (one accent #111111 for every active
// tab) — the per-category rainbow (pink/amber/green/blue) fought the app's
// neutral palette and read dated. Each category still reads distinctly via its
// SVG icon; the active fill is the single brand accent, Gmail/WhatsApp-style.
const CATEGORIES = [
  { key: 'all', i18nKey: 'category.all', icon: IconMail, color: '#111111' },
  { key: 'unread', i18nKey: 'category.unread', icon: IconMailOpen, color: '#111111' },
  // "Importantes" — driven by the AI importance classifier (level === 'high')
  // OR a flagged message. Sits second so users see prioritized work first.
  { key: 'important', i18nKey: 'inbox.tabImportant', icon: IconStarFilled, color: '#111111' },
  { key: 'primary', i18nKey: 'category.primary', icon: IconInbox, color: '#111111' },
  { key: 'social', i18nKey: 'category.social', icon: IconUsers, color: '#111111' },
  { key: 'promotions', i18nKey: 'category.promotions', icon: IconTag, color: '#111111' },
  { key: 'updates', i18nKey: 'category.updates', icon: IconBell, color: '#111111' },
];

// Backend-supplied bundles (Gmail-style grouping) — also mono now.
const BUNDLE_COLORS = {
  compras: '#111111',
  viagens: '#111111',
  financas: '#111111',
  foruns: '#111111',
  notificacoes: '#111111',
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
      color: BUNDLE_COLORS[b.id] || '#111111',
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
                      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
                      android: { elevation: 2 },
                      web: { boxShadow: `0 1px 3px rgba(0,0,0,0.12)` },
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
  tabText: { fontSize: 13, fontWeight: '600', letterSpacing: -0.1 },
  tabTextActive: { fontWeight: '800' },
  badge: {
    minWidth: 20, height: 20, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 6, paddingHorizontal: 5,
  },
  badgeText: { fontSize: 10, fontWeight: '800' },
});
