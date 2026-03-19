import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
  Modal, Animated, Pressable, ScrollView, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import {
  IconSearch, IconX, IconFilter, IconCheckbox, IconCheckboxChecked,
  IconClock, IconArrowRight, IconMail, IconStar, IconPaperclip,
} from './Icons';

// --- Search operator definitions for inline suggestions ---
const SEARCH_OPERATORS = [
  { label: 'from:', key: 'op.from', example: 'from:john@example.com', hasValue: true },
  { label: 'to:', key: 'op.to', example: 'to:me@example.com', hasValue: true },
  { label: 'cc:', key: 'op.cc', example: 'cc:team@example.com', hasValue: true },
  { label: 'subject:', key: 'op.subject', example: 'subject:meeting', hasValue: true },
  { label: 'has:attachment', key: 'op.hasAttachment', hasValue: false },
  { label: 'is:unread', key: 'op.isUnread', hasValue: false },
  { label: 'is:read', key: 'op.isRead', hasValue: false },
  { label: 'is:starred', key: 'op.isStarred', hasValue: false },
  { label: 'is:important', key: 'op.isImportant', hasValue: false },
  { label: 'before:', key: 'op.before', example: 'before:2026-01-01', hasValue: true },
  { label: 'after:', key: 'op.after', example: 'after:2026-01-01', hasValue: true },
  { label: 'label:', key: 'op.label', example: 'label:work', hasValue: true },
  { label: 'in:', key: 'op.in', example: 'in:sent', hasValue: true },
  { label: 'larger:', key: 'op.larger', example: 'larger:5M', hasValue: true },
  { label: 'smaller:', key: 'op.smaller', example: 'smaller:10M', hasValue: true },
];

// --- Recent searches persistence ---
function getRecentSearches() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const s = localStorage.getItem('recent_searches');
      return s ? JSON.parse(s) : [];
    }
  } catch {}
  return [];
}

function saveRecentSearch(query) {
  if (!query.trim()) return;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      let searches = getRecentSearches();
      searches = [query.trim(), ...searches.filter(s => s !== query.trim())].slice(0, 8);
      localStorage.setItem('recent_searches', JSON.stringify(searches));
    }
  } catch {}
}

function clearRecentSearches() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.removeItem('recent_searches');
    }
  } catch {}
}

// --- Quick filter chips ---
const QUICK_FILTERS = [
  { key: 'unread', icon: IconMail, query: 'is:unread' },
  { key: 'starred', icon: IconStar, query: 'is:starred' },
  { key: 'attachment', icon: IconPaperclip, query: 'has:attachment' },
  { key: 'important', icon: IconStar, query: 'is:important' },
];

export default function SearchBar({ value, onChange, onSubmit, onClear, onFocus }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value || '');
  const [recentSearches, setRecentSearches] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filters, setFilters] = useState({ from: '', to: '', subject: '', dateAfter: '', dateBefore: '', larger: '', smaller: '' });
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.97)).current;
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => { setLocalValue(value || ''); }, [value]);
  useEffect(() => { setRecentSearches(getRecentSearches()); }, []);
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const openSearch = useCallback(() => {
    setOpen(true);
    setRecentSearches(getRecentSearches());
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }),
      Animated.spring(scaleAnim, { toValue: 1, tension: 120, friction: 14, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
    setTimeout(() => inputRef.current?.focus(), 100);
    onFocus?.();
  }, [onFocus]);

  const closeSearch = useCallback(() => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: Platform.OS !== 'web' }).start(() => {
      setOpen(false);
      setShowAdvanced(false);
      scaleAnim.setValue(0.97);
    });
  }, []);

  const executeSearch = useCallback((query) => {
    const q = (query ?? localValue).trim();
    if (!q) return;
    saveRecentSearch(q);
    setRecentSearches(getRecentSearches());
    onChange(q);
    closeSearch();
    setTimeout(() => onSubmit(), 50);
  }, [localValue, onChange, onSubmit, closeSearch]);

  const handleClear = useCallback(() => {
    setLocalValue('');
    onChange('');
    onClear();
    closeSearch();
  }, [onChange, onClear, closeSearch]);

  const handleQuickFilter = useCallback((query) => {
    setLocalValue(prev => {
      const next = prev.includes(query) ? prev.replace(query, '').trim() : `${prev} ${query}`.trim();
      setTimeout(() => executeSearch(next), 0);
      return next;
    });
  }, [executeSearch]);

  const applyAdvancedFilters = useCallback(() => {
    let q = localValue.replace(/\b(from|to|cc|subject|after|before|larger|smaller|label|in):\S+\s*/g, '').replace(/\b(has:attachment|is:unread|is:read|is:starred|is:important)\s*/g, '').trim();
    if (filters.from) q = `from:${filters.from} ${q}`.trim();
    if (filters.to) q = `to:${filters.to} ${q}`.trim();
    if (filters.subject) q = `subject:${filters.subject} ${q}`.trim();
    if (filters.dateAfter) q = `after:${filters.dateAfter} ${q}`.trim();
    if (filters.dateBefore) q = `before:${filters.dateBefore} ${q}`.trim();
    if (filters.larger) q = `larger:${filters.larger} ${q}`.trim();
    if (filters.smaller) q = `smaller:${filters.smaller} ${q}`.trim();
    setLocalValue(q);
    setShowAdvanced(false);
    executeSearch(q);
  }, [localValue, filters, executeSearch]);

  const handleRemoveRecent = useCallback((query) => {
    try {
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        let searches = getRecentSearches().filter(s => s !== query);
        localStorage.setItem('recent_searches', JSON.stringify(searches));
        setRecentSearches(searches);
      }
    } catch {}
  }, []);

  // --- Operator suggestions: match the last word being typed ---
  const operatorSuggestions = useMemo(() => {
    if (!localValue) return [];
    // Get the last "word" the user is typing (after last space)
    const lastWord = localValue.split(/\s+/).pop().toLowerCase();
    if (!lastWord || lastWord.length < 1) return [];
    // Don't show suggestions if the last word already has a complete operator with value
    if (/^(from|to|cc|subject|before|after|label|in|larger|smaller):.+/.test(lastWord)) return [];
    // Don't show if it matches a complete no-value operator
    if (/^(has:attachment|is:unread|is:read|is:starred|is:important)$/.test(lastWord)) return [];
    // Filter operators that match the partial input
    return SEARCH_OPERATORS.filter(op => {
      const opLower = op.label.toLowerCase();
      // Match if user is typing part of the operator
      return opLower.startsWith(lastWord) && opLower !== lastWord;
    }).slice(0, 6);
  }, [localValue]);

  const handleInsertOperator = useCallback((opLabel) => {
    setLocalValue(prev => {
      const parts = prev.split(/\s+/);
      parts[parts.length - 1] = opLabel;
      return parts.join(' ');
    });
    // Keep focus on input
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const isWide = screenWidth >= 600;

  // --- Trigger bar (always visible) ---
  const triggerBar = (
    <TouchableOpacity onPress={openSearch} activeOpacity={0.8} style={[
      st.trigger,
      {
        backgroundColor: isDark ? colors.surfaceVariant : colors.surfaceVariant,
        borderColor: value ? colors.primary + '40' : 'transparent',
        borderWidth: value ? 1.5 : 0,
      },
      Platform.OS === 'web' && st.triggerWeb,
    ]}>
      <IconSearch size={16} color={value ? colors.primary : colors.textTertiary} />
      <Text style={[st.triggerText, { color: value ? colors.text : colors.textTertiary }]} numberOfLines={1}>
        {value || t('search.placeholder')}
      </Text>
      {value ? (
        <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); handleClear(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <IconX size={14} color={colors.textTertiary} />
        </TouchableOpacity>
      ) : (
        <View style={[st.triggerKbd, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]}>
          <Text style={[st.triggerKbdText, { color: colors.textTertiary }]}>/</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  if (!open) return triggerBar;

  // --- Full search overlay ---
  return (
    <>
      {triggerBar}
      <Modal transparent visible={open} animationType="none" onRequestClose={closeSearch}>
        <Animated.View style={[st.overlay, { opacity: fadeAnim, paddingTop: Math.max(insets.top + 16, 60) }]}>
          <Pressable style={st.overlayBg} onPress={closeSearch} />
          <Animated.View style={[
            st.panel,
            {
              backgroundColor: colors.surface,
              borderColor: isDark ? colors.border : 'rgba(0,0,0,0.08)',
              maxWidth: isWide ? 600 : screenWidth - 32,
              transform: [{ scale: scaleAnim }],
            },
            Platform.OS === 'web' && {
              boxShadow: isDark
                ? '0 24px 80px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.4)'
                : '0 24px 80px rgba(0,0,0,0.15), 0 8px 24px rgba(0,0,0,0.08)',
            },
          ]}>
            {/* Search input */}
            <View style={[st.inputRow, { borderBottomColor: colors.borderLight }]}>
              <IconSearch size={20} color={colors.primary} />
              <TextInput
                ref={inputRef}
                style={[st.input, { color: colors.text }]}
                placeholder={t('search.placeholder')}
                placeholderTextColor={colors.textTertiary}
                value={localValue}
                onChangeText={(text) => {
                  setLocalValue(text);
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  if (text.trim().length >= 2) {
                    debounceRef.current = setTimeout(() => {
                      onChange(text.trim());
                      onSubmit();
                    }, 500);
                  }
                }}
                onSubmitEditing={() => executeSearch()}
                returnKeyType="search"
                autoFocus
              />
              {localValue ? (
                <TouchableOpacity onPress={() => setLocalValue('')} style={st.inputClear}>
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={closeSearch} style={[st.escBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                <Text style={[st.escText, { color: colors.textTertiary }]}>ESC</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={st.body} keyboardShouldPersistTaps="handled" bounces={false}>
              {/* Operator suggestions — shown when typing partial operator */}
              {operatorSuggestions.length > 0 && (
                <View style={[st.opSuggestSection, { borderBottomColor: colors.borderLight }]}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={st.opSuggestScroll}>
                    {operatorSuggestions.map(op => (
                      <TouchableOpacity
                        key={op.label}
                        onPress={() => handleInsertOperator(op.label)}
                        style={[
                          st.opSuggestChip,
                          { backgroundColor: isDark ? 'rgba(99,102,241,0.12)' : 'rgba(99,102,241,0.08)' },
                        ]}
                        activeOpacity={0.7}
                      >
                        <Text style={[st.opSuggestLabel, { color: colors.primary }]}>{op.label}</Text>
                        <Text style={[st.opSuggestDesc, { color: colors.textTertiary }]}>
                          {t(`search.${op.key}`) || op.example || ''}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* Quick filters */}
              <View style={st.section}>
                <Text style={[st.sectionLabel, { color: colors.textTertiary }]}>{t('search.quickFilters')}</Text>
                <View style={st.quickFilters}>
                  {QUICK_FILTERS.map(f => {
                    const Icon = f.icon;
                    const isActive = localValue.includes(f.query);
                    return (
                      <TouchableOpacity
                        key={f.key}
                        onPress={() => handleQuickFilter(f.query)}
                        style={[
                          st.quickChip,
                          {
                            backgroundColor: isActive ? colors.primary + '12' : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'),
                            borderColor: isActive ? colors.primary + '30' : 'transparent',
                          },
                        ]}
                        activeOpacity={0.7}
                      >
                        <Icon size={14} color={isActive ? colors.primary : colors.textSecondary} />
                        <Text style={[st.quickChipText, { color: isActive ? colors.primary : colors.textSecondary }]}>
                          {t(`search.${f.key}`)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  <TouchableOpacity
                    onPress={() => setShowAdvanced(!showAdvanced)}
                    style={[
                      st.quickChip,
                      {
                        backgroundColor: showAdvanced ? colors.primary + '12' : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'),
                        borderColor: showAdvanced ? colors.primary + '30' : 'transparent',
                      },
                    ]}
                    activeOpacity={0.7}
                  >
                    <IconFilter size={14} color={showAdvanced ? colors.primary : colors.textSecondary} />
                    <Text style={[st.quickChipText, { color: showAdvanced ? colors.primary : colors.textSecondary }]}>
                      {t('search.advanced')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Advanced filters */}
              {showAdvanced && (
                <View style={[st.advancedSection, { borderTopColor: colors.borderLight }]}>
                  {['from', 'to', 'subject'].map(field => (
                    <View key={field} style={st.advField}>
                      <Text style={[st.advLabel, { color: colors.textSecondary }]}>{t(`search.${field}`)}</Text>
                      <TextInput
                        style={[st.advInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: colors.border }]}
                        value={filters[field]}
                        onChangeText={v => setFilters(p => ({ ...p, [field]: v }))}
                        placeholder={`${t(`search.${field}`)}...`}
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                  ))}
                  <View style={st.advRow}>
                    <View style={[st.advField, { flex: 1 }]}>
                      <Text style={[st.advLabel, { color: colors.textSecondary }]}>{t('search.dateAfter')}</Text>
                      <TextInput
                        style={[st.advInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: colors.border }]}
                        value={filters.dateAfter}
                        onChangeText={v => setFilters(p => ({ ...p, dateAfter: v }))}
                        placeholder="AAAA-MM-DD"
                        placeholderTextColor={colors.textTertiary}
                        {...(Platform.OS === 'web' ? { type: 'date' } : {})}
                      />
                    </View>
                    <View style={[st.advField, { flex: 1 }]}>
                      <Text style={[st.advLabel, { color: colors.textSecondary }]}>{t('search.dateBefore')}</Text>
                      <TextInput
                        style={[st.advInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: colors.border }]}
                        value={filters.dateBefore}
                        onChangeText={v => setFilters(p => ({ ...p, dateBefore: v }))}
                        placeholder="AAAA-MM-DD"
                        placeholderTextColor={colors.textTertiary}
                        {...(Platform.OS === 'web' ? { type: 'date' } : {})}
                      />
                    </View>
                  </View>
                  <View style={st.advRow}>
                    <View style={[st.advField, { flex: 1 }]}>
                      <Text style={[st.advLabel, { color: colors.textSecondary }]}>{t('search.larger')}</Text>
                      <TextInput
                        style={[st.advInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: colors.border }]}
                        value={filters.larger}
                        onChangeText={v => setFilters(p => ({ ...p, larger: v }))}
                        placeholder="ex: 5M"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                    <View style={[st.advField, { flex: 1 }]}>
                      <Text style={[st.advLabel, { color: colors.textSecondary }]}>{t('search.smaller')}</Text>
                      <TextInput
                        style={[st.advInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: colors.border }]}
                        value={filters.smaller}
                        onChangeText={v => setFilters(p => ({ ...p, smaller: v }))}
                        placeholder="ex: 10M"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                  </View>
                  <TouchableOpacity onPress={applyAdvancedFilters} style={[st.applyBtn, { backgroundColor: colors.primary }]} activeOpacity={0.8}>
                    <Text style={st.applyBtnText}>{t('search.apply')}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Recent searches */}
              {recentSearches.length > 0 && !showAdvanced && (
                <View style={[st.section, { borderTopColor: colors.borderLight, borderTopWidth: 1 }]}>
                  <View style={st.sectionHeader}>
                    <Text style={[st.sectionLabel, { color: colors.textTertiary }]}>{t('search.recent')}</Text>
                    <TouchableOpacity onPress={() => { clearRecentSearches(); setRecentSearches([]); }}>
                      <Text style={[st.clearBtn, { color: colors.textTertiary }]}>{t('search.clearHistory')}</Text>
                    </TouchableOpacity>
                  </View>
                  {recentSearches.map((q, i) => (
                    <TouchableOpacity
                      key={i}
                      onPress={() => { setLocalValue(q); executeSearch(q); }}
                      style={[st.recentRow, Platform.OS === 'web' && { transition: 'background-color 0.1s' }]}
                      activeOpacity={0.7}
                    >
                      <IconClock size={14} color={colors.textTertiary} />
                      <Text style={[st.recentQuery, { color: colors.text }]} numberOfLines={1}>{q}</Text>
                      <TouchableOpacity onPress={() => handleRemoveRecent(q)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={st.recentRemove}>
                        <IconX size={12} color={colors.textTertiary} />
                      </TouchableOpacity>
                      <IconArrowRight size={14} color={colors.textTertiary} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Keyboard hint (web only) */}
              {Platform.OS === 'web' && (
                <View style={[st.kbdHint, { borderTopColor: colors.borderLight }]}>
                  <View style={st.kbdRow}>
                    <View style={[st.kbdKey, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                      <Text style={[st.kbdKeyText, { color: colors.textTertiary }]}>Enter</Text>
                    </View>
                    <Text style={[st.kbdLabel, { color: colors.textTertiary }]}>{t('search.toSearch')}</Text>
                  </View>
                  <View style={st.kbdRow}>
                    <View style={[st.kbdKey, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                      <Text style={[st.kbdKeyText, { color: colors.textTertiary }]}>Esc</Text>
                    </View>
                    <Text style={[st.kbdLabel, { color: colors.textTertiary }]}>{t('search.toClose')}</Text>
                  </View>
                </View>
              )}
            </ScrollView>
          </Animated.View>
        </Animated.View>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  // --- Trigger ---
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 14, paddingHorizontal: 16, height: 42,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  triggerWeb: Platform.OS === 'web' ? {
    transition: 'all 0.2s ease, box-shadow 0.2s ease',
  } : {},
  triggerText: { flex: 1, fontSize: 14, fontWeight: '400' },
  triggerKbd: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
  },
  triggerKbdText: { fontSize: 12, fontWeight: '600', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },

  // --- Overlay ---
  overlay: {
    flex: 1, justifyContent: 'flex-start', alignItems: 'center',
  },
  overlayBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    ...Platform.select({
      web: { backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' },
      default: {},
    }),
  },

  // --- Panel ---
  panel: {
    width: '100%', borderRadius: 20, borderWidth: 1,
    overflow: 'hidden', maxHeight: 520,
    zIndex: 10,
  },

  // --- Input row ---
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1,
  },
  input: {
    flex: 1, fontSize: 17, fontWeight: '400',
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  inputClear: { padding: 4 },
  escBtn: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
  },
  escText: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },

  // --- Body ---
  body: { maxHeight: 400 },

  // --- Operator suggestions ---
  opSuggestSection: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1,
  },
  opSuggestScroll: {
    flexDirection: 'row', gap: 6, alignItems: 'center',
  },
  opSuggestChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'all 0.12s ease' },
      default: {},
    }),
  },
  opSuggestLabel: {
    fontSize: 13, fontWeight: '600',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  opSuggestDesc: { fontSize: 11 },

  // --- Section ---
  section: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  clearBtn: { fontSize: 12, fontWeight: '500' },

  // --- Quick filters ---
  quickFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  quickChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1.5,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'all 0.15s ease' },
      default: {},
    }),
  },
  quickChipText: { fontSize: 13, fontWeight: '500' },

  // --- Advanced ---
  advancedSection: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, borderTopWidth: 1 },
  advRow: { flexDirection: 'row', gap: 10 },
  advField: { marginBottom: 10 },
  advLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  advInput: {
    borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  applyBtn: {
    borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 4,
  },
  applyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // --- Recent rows ---
  recentRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 4,
    borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  recentQuery: { flex: 1, fontSize: 14 },
  recentRemove: { padding: 4 },

  // --- Keyboard hint ---
  kbdHint: {
    flexDirection: 'row', justifyContent: 'center', gap: 20,
    paddingVertical: 12, borderTopWidth: 1,
  },
  kbdRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kbdKey: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    minWidth: 24, alignItems: 'center',
  },
  kbdKeyText: { fontSize: 11, fontWeight: '600' },
  kbdLabel: { fontSize: 12 },
});
