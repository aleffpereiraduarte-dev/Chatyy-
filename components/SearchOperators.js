import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform,
  Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import {
  IconMail, IconStar, IconPaperclip, IconClock, IconX,
  IconSearch, IconUser, IconFilter,
} from './Icons';

const RECENT_SEARCHES_KEY = '@onemundo_recent_searches';
const MAX_RECENT = 5;

// --- Search operator definitions ---
const OPERATORS = [
  { key: 'from:', labelKey: 'search.opFromLabel', desc: 'search.opFrom', icon: IconUser, hasValue: true },
  { key: 'to:', labelKey: 'search.opToLabel', desc: 'search.opTo', icon: IconUser, hasValue: true },
  { key: 'subject:', labelKey: 'search.opSubjectLabel', desc: 'search.opSubject', icon: IconMail, hasValue: true },
  { key: 'has:attachment', labelKey: 'search.opAttachmentLabel', desc: 'search.opAttachment', icon: IconPaperclip, hasValue: false },
  { key: 'is:unread', labelKey: 'search.opUnreadLabel', desc: 'search.opUnread', icon: IconMail, hasValue: false },
  { key: 'is:read', labelKey: 'search.opReadLabel', desc: 'search.opRead', icon: IconMail, hasValue: false },
  { key: 'is:starred', labelKey: 'search.opStarredLabel', desc: 'search.opStarred', icon: IconStar, hasValue: false },
  { key: 'before:', labelKey: 'search.opBeforeLabel', desc: 'search.opBefore', icon: IconClock, hasValue: true },
  { key: 'after:', labelKey: 'search.opAfterLabel', desc: 'search.opAfter', icon: IconClock, hasValue: true },
  { key: 'larger:', labelKey: 'search.opLargerLabel', desc: 'search.opLarger', icon: IconFilter, hasValue: true },
  { key: 'smaller:', labelKey: 'search.opSmallerLabel', desc: 'search.opSmaller', icon: IconFilter, hasValue: true },
  { key: 'in:', labelKey: 'search.opInLabel', desc: 'search.opIn', icon: IconMail, hasValue: true },
  { key: 'label:', labelKey: 'search.opLabelLabel', desc: 'search.opLabel', icon: IconStar, hasValue: true },
];

// --- Quick filter presets ---
const QUICK_FILTERS = [
  { key: 'unread', label: 'search.unread', query: 'is:unread', icon: IconMail },
  { key: 'starred', label: 'search.starred', query: 'is:starred', icon: IconStar },
  { key: 'attachments', label: 'search.attachment', query: 'has:attachment', icon: IconPaperclip },
];

// --- Operator help descriptions (fallback if translation missing) ---
// OPERATOR_HELP removed — descriptions come from i18n keys (search.opFrom, etc.)

// --- Persist recent searches via AsyncStorage ---
async function loadRecentSearches() {
  try {
    const raw = await AsyncStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveRecentSearch(query) {
  if (!query || !query.trim()) return;
  try {
    const existing = await loadRecentSearches();
    const updated = [query.trim(), ...existing.filter(s => s !== query.trim())].slice(0, MAX_RECENT);
    await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

async function clearAllRecentSearches() {
  try {
    await AsyncStorage.removeItem(RECENT_SEARCHES_KEY);
  } catch {}
}

/**
 * SearchOperators - A dropdown panel showing search operator suggestions,
 * quick filters, and recent searches below the search bar.
 *
 * Props:
 *   visible    - Whether the panel is shown
 *   searchText - Current search input text
 *   onInsertOperator(op) - Called when user taps an operator chip to append to search
 *   onQuickFilter(query) - Called when user taps a quick filter preset
 *   onRecentSearch(query) - Called when user taps a recent search
 *   onClearRecent() - Called after recent searches are cleared
 */
export default function SearchOperators({
  visible,
  searchText = '',
  onInsertOperator,
  onQuickFilter,
  onRecentSearch,
  onClearRecent,
}) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [recentSearches, setRecentSearches] = useState([]);
  const [fadeAnim] = useState(() => new Animated.Value(0));

  // Load recent searches when panel becomes visible
  useEffect(() => {
    if (visible) {
      loadRecentSearches().then(setRecentSearches);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 100,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  // Detect which operator the user is currently typing (partial match)
  const activeOperatorHint = useMemo(() => {
    if (!searchText) return null;
    const parts = searchText.split(/\s+/);
    const lastWord = (parts[parts.length - 1] || '').toLowerCase();
    if (!lastWord) return null;

    // Check if user typed a complete operator key (show help text)
    for (const op of OPERATORS) {
      if (lastWord === op.key.toLowerCase() || lastWord === op.key.toLowerCase().replace(':', '')) {
        return op;
      }
    }

    // Check if user is mid-typing an operator (partial match)
    for (const op of OPERATORS) {
      const opLower = op.key.toLowerCase();
      if (opLower.startsWith(lastWord) && opLower !== lastWord && lastWord.length >= 2) {
        return op;
      }
    }
    return null;
  }, [searchText]);

  // Filter operators to show: exclude ones already in the search text
  const availableOperators = useMemo(() => {
    const lowerText = (searchText || '').toLowerCase();
    return OPERATORS.filter(op => {
      // Don't show no-value operators already in search
      if (!op.hasValue && lowerText.includes(op.key)) return false;
      return true;
    });
  }, [searchText]);

  const handleClearRecent = useCallback(async () => {
    await clearAllRecentSearches();
    setRecentSearches([]);
    onClearRecent?.();
  }, [onClearRecent]);

  const handleRemoveRecent = useCallback(async (query) => {
    try {
      const existing = await loadRecentSearches();
      const updated = existing.filter(s => s !== query);
      await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      setRecentSearches(updated);
    } catch {}
  }, []);

  const handleInsertOp = useCallback((op) => {
    onInsertOperator?.(op.key);
  }, [onInsertOperator]);

  const handleQuickFilter = useCallback((query) => {
    onQuickFilter?.(query);
  }, [onQuickFilter]);

  const handleRecentTap = useCallback(async (query) => {
    const updated = await saveRecentSearch(query);
    setRecentSearches(updated);
    onRecentSearch?.(query);
  }, [onRecentSearch]);

  if (!visible) return null;

  return (
    <Animated.View style={[
      styles.container,
      {
        backgroundColor: colors.surface,
        borderColor: isDark ? colors.border : 'rgba(0,0,0,0.08)',
        opacity: fadeAnim,
      },
      Platform.OS === 'web' && {
        boxShadow: isDark
          ? '0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3)'
          : '0 8px 32px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
      },
    ]}>
      {/* Active operator hint */}
      {activeOperatorHint && (
        <View style={[styles.hintBar, { backgroundColor: isDark ? 'rgba(37,99,235,0.08)' : 'rgba(37,99,235,0.05)', borderBottomColor: colors.borderLight }]}>
          <View style={[styles.hintIconWrap, { backgroundColor: colors.primaryLight }]}>
            <activeOperatorHint.icon size={14} color={colors.primary} />
          </View>
          <View style={styles.hintTextWrap}>
            <Text style={[styles.hintOperator, { color: colors.primary }]}>{activeOperatorHint.key}</Text>
            <Text style={[styles.hintDesc, { color: colors.textSecondary }]}>
              {t(activeOperatorHint.desc) || ''}
            </Text>
          </View>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* Quick Filters */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>
            {t('search.quickFilters')}
          </Text>
          <View style={styles.chipRow}>
            {QUICK_FILTERS.map(f => {
              const Icon = f.icon;
              const isActive = (searchText || '').toLowerCase().includes(f.query);
              return (
                <TouchableOpacity
                  key={f.key}
                  onPress={() => handleQuickFilter(f.query)}
                  style={[
                    styles.quickChip,
                    {
                      backgroundColor: isActive
                        ? (isDark ? 'rgba(37,99,235,0.15)' : 'rgba(37,99,235,0.08)')
                        : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)'),
                      borderColor: isActive ? colors.primary + '40' : 'transparent',
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Icon size={14} color={isActive ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.quickChipText, { color: isActive ? colors.primary : colors.textSecondary }]}>
                    {t(f.label) || f.key}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Operator Chips */}
        <View style={[styles.section, { borderTopWidth: 1, borderTopColor: colors.borderLight }]}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>
            {t('search.operators')}
          </Text>
          <View style={styles.chipRow}>
            {availableOperators.map(op => {
              const Icon = op.icon;
              return (
                <TouchableOpacity
                  key={op.key}
                  onPress={() => handleInsertOp(op)}
                  style={[
                    styles.operatorChip,
                    {
                      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)',
                      borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Icon size={12} color={colors.textTertiary} />
                  <Text style={[styles.operatorKey, { color: colors.primary }]}>{op.key}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Recent Searches */}
        {recentSearches.length > 0 && (
          <View style={[styles.section, { borderTopWidth: 1, borderTopColor: colors.borderLight }]}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>
                {t('search.recent')}
              </Text>
              <TouchableOpacity onPress={handleClearRecent} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[styles.clearLink, { color: colors.textTertiary }]}>
                  {t('search.clearHistory')}
                </Text>
              </TouchableOpacity>
            </View>
            {recentSearches.map((query, i) => (
              <TouchableOpacity
                key={`${query}-${i}`}
                onPress={() => handleRecentTap(query)}
                style={[
                  styles.recentRow,
                  Platform.OS === 'web' && { cursor: 'pointer', transition: 'background-color 0.1s' },
                ]}
                activeOpacity={0.7}
              >
                <IconClock size={14} color={colors.textTertiary} />
                <Text style={[styles.recentText, { color: colors.text }]} numberOfLines={1}>
                  {query}
                </Text>
                <TouchableOpacity
                  onPress={() => handleRemoveRecent(query)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.recentRemoveBtn}
                >
                  <IconX size={12} color={colors.textTertiary} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </Animated.View>
  );
}

/**
 * Save a search query to the recent searches list.
 * Call this from the parent when a search is executed.
 */
export { saveRecentSearch, loadRecentSearches, clearAllRecentSearches };

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 100,
    borderWidth: 1,
    borderTopWidth: 0,
    borderBottomLeftRadius: BorderRadius.lg,
    borderBottomRightRadius: BorderRadius.lg,
    overflow: 'hidden',
    maxHeight: 340,
  },
  scroll: {
    maxHeight: 340,
  },

  // Hint bar
  hintBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    gap: 10,
  },
  hintIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hintOperator: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  hintDesc: {
    fontSize: FontSize.sm,
    flex: 1,
  },

  // Sections
  section: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.xs,
  },
  clearLink: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },

  // Chip rows
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },

  // Quick filter chips
  quickChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'all 0.15s ease' },
      default: {},
    }),
  },
  quickChipText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },

  // Operator chips
  operatorChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'all 0.12s ease' },
      default: {},
    }),
  },
  operatorKey: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },

  // Recent searches
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: BorderRadius.sm,
  },
  recentText: {
    flex: 1,
    fontSize: FontSize.base,
  },
  recentRemoveBtn: {
    padding: 4,
  },
});
