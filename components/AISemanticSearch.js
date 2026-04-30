import { useState, useRef, useEffect } from 'react';
import { Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSparkles } from './Icons';
import { useLanguage } from '../context/LanguageContext';

export default function AISemanticSearch({ query, emails, onReranked, colors }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const handleRerank = async () => {
    if (!query || !emails?.length) return;
    setLoading(true);
    try {
      const summaries = emails.slice(0, 50).map(e => ({
        uid: e.uid,
        from: e.from,
        subject: e.subject,
        snippet: (e.snippet || e.body_text || '').slice(0, 100),
      }));
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('semantic_search', {
        query,
        email_summaries: summaries,
      });
      if (mounted.current && r.success && r.data?.ranked_uids) {
        onReranked?.(r.data.ranked_uids);
        setActive(true);
      }
    } catch {} finally {
      if (mounted.current) setLoading(false);
    }
  };

  const handleClear = () => {
    setActive(false);
    onReranked?.(null);
  };

  return (
    <TouchableOpacity
      style={[
        s.chip,
        { backgroundColor: active ? colors.primary + '20' : colors.surfaceVariant, borderColor: active ? colors.primary : colors.border },
      ]}
      onPress={active ? handleClear : handleRerank}
      disabled={loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 4 }} />
      ) : (
        <IconSparkles size={12} color={active ? colors.primary : colors.textSecondary} style={{ marginRight: 4 }} />
      )}
      <Text style={[s.chipText, { color: active ? colors.primary : colors.textSecondary }]}>
        {active ? t('search.aiSorted') : t('search.aiSort')}
      </Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.full || 20,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  chipText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
});
