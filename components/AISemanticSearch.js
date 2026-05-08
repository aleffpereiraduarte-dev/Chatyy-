import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSparkles, IconX } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import useIsMounted from '../hooks/useIsMounted';

const BRAND = '#7C3AED';
// Secondary gradient stop — pairs with brand for the "AI gradient" header.
const BRAND_2 = '#EC4899';

/**
 * Spotlight-grade AI search header banner.
 * Shows "Buscar com IA ✨" gradient title + an explanation line summarizing
 * what the rerank actually surfaced. Web uses a real CSS gradient on text;
 * native falls back to brand-tinted text (no MaskedView dependency).
 *
 * Usage: <AISemanticSearchHeader query={...} explanation={...} colors={...} />
 */
export function AISemanticSearchHeader({ query, explanation, colors, onDismiss }) {
  const { t } = useLanguage();
  const titleStyle = Platform.OS === 'web'
    ? {
        backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, ${BRAND_2} 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        color: 'transparent',
      }
    : { color: BRAND };

  return (
    <View style={[s.header, { backgroundColor: (colors?.surface || '#fff'), borderColor: colors?.border || 'rgba(0,0,0,0.06)' }]}>
      <View style={s.headerRow}>
        <View style={s.sparkBadge}>
          <IconSparkles size={14} color={BRAND} />
        </View>
        <Text style={[s.headerTitle, titleStyle]}>
          {t?.('search.aiTitle') || 'Buscar com IA'} ✨
        </Text>
        {!!onDismiss && (
          <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={14} color={colors?.textTertiary || '#999'} />
          </TouchableOpacity>
        )}
      </View>
      {!!explanation && (
        <Text style={[s.headerExplain, { color: colors?.textSecondary || '#666' }]} numberOfLines={3}>
          {explanation}
        </Text>
      )}
    </View>
  );
}

export default function AISemanticSearch({ query, emails, onReranked, colors }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  // Server-returned explanation ("Encontrei mensagens onde Aleff mencionou X..."),
  // surfaced via AISemanticSearchHeader once the rerank lands.
  const [explanation, setExplanation] = useState('');
  const mounted = useIsMounted();

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
        // Best-effort explanation. Backend may return `explanation`, `reasoning`,
        // or omit entirely; synthesize a sensible fallback so the banner is
        // never empty when AI is active.
        const expl = r.data?.explanation
          || r.data?.reasoning
          || (t?.('search.aiExplainFallback')
              || `Encontrei mensagens onde os resultados mais relacionam com "${query}".`);
        onReranked?.(r.data.ranked_uids, expl);
        setExplanation(expl);
        setActive(true);
      }
    } catch {} finally {
      if (mounted.current) setLoading(false);
    }
  };

  const handleClear = () => {
    setActive(false);
    setExplanation('');
    onReranked?.(null, null);
  };

  return (
    <TouchableOpacity
      style={[
        s.chip,
        active && s.chipActive,
        { backgroundColor: active ? BRAND + '18' : colors.surfaceVariant, borderColor: active ? BRAND : colors.border },
      ]}
      onPress={active ? handleClear : handleRerank}
      disabled={loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator size="small" color={BRAND} style={{ marginRight: 4 }} />
      ) : (
        <IconSparkles size={12} color={active ? BRAND : colors.textSecondary} style={{ marginRight: 4 }} />
      )}
      <Text style={[s.chipText, { color: active ? BRAND : colors.textSecondary }]}>
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
  chipActive: {
    // Subtle elevation when AI rerank is active so the toggle feels live.
    ...Platform.select({
      web: { boxShadow: '0 0 0 3px rgba(124,58,237,0.12)' },
      default: { shadowColor: BRAND, shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    }),
  },
  chipText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },

  // --- AI header banner ---
  header: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md || 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginVertical: 6,
    marginHorizontal: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sparkBadge: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124,58,237,0.12)',
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  headerExplain: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
  },
});
