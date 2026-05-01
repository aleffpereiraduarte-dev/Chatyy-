import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSparkles } from './Icons';

const DEBOUNCE_MS = 2000;
const MIN_CHARS = 30;

export default function AISmartCompose({ bodyText, subject, colors, onAccept, mode, replyContext }) {
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);
  const lastTextRef = useRef('');
  const abortRef = useRef(null);

  const fetchCompletion = useCallback(async (text) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const { aiAssist } = await import('../services/api');
      // Build context based on mode. For replies/forwards include the
      // original sender + a snippet of the original body so suggestions
      // are anchored to "responding to João's question" instead of a
      // generic professional template.
      const m = mode || 'compose';
      const ctxParts = [];
      if (subject) ctxParts.push(`Subject: ${subject}`);
      if (m !== 'compose' && replyContext) {
        if (replyContext.from) ctxParts.push(`Original sender: ${replyContext.from}`);
        if (replyContext.subject) ctxParts.push(`Original subject: ${replyContext.subject}`);
        if (replyContext.body) {
          const snippet = String(replyContext.body).replace(/\s+/g, ' ').trim().slice(0, 600);
          if (snippet) ctxParts.push(`Original body: ${snippet}`);
        }
        ctxParts.push(`Mode: ${m}`);
      }
      const r = await aiAssist('smart_compose', {
        partial_text: text.slice(-500),
        context: ctxParts.join('\n'),
        mode: m,
        tone: 'professional',
      });
      if (!controller.signal.aborted && r.success && r.data?.result) {
        setSuggestion(r.data.result);
      }
    } catch {} finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [subject, mode, replyContext]);

  useEffect(() => {
    if (!bodyText || bodyText.length < MIN_CHARS) {
      setSuggestion('');
      return;
    }

    if (bodyText === lastTextRef.current) return;
    lastTextRef.current = bodyText;
    setSuggestion('');

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchCompletion(bodyText), DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [bodyText, fetchCompletion]);

  // Web: Listen for Tab key to accept
  useEffect(() => {
    if (Platform.OS !== 'web' || !suggestion) return;
    const handleKey = (e) => {
      if (e.key === 'Tab' && suggestion) {
        e.preventDefault();
        onAccept?.(suggestion);
        setSuggestion('');
      } else if (e.key === 'Escape') {
        setSuggestion('');
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [suggestion, onAccept]);

  if (!suggestion && !loading) return null;

  return (
    <View style={[s.container, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}>
      {loading ? (
        <View style={s.row}>
          <IconSparkles size={12} color={colors.textTertiary} />
          <Text style={[s.loadingText, { color: colors.textTertiary }]}>Thinking...</Text>
        </View>
      ) : suggestion ? (
        <View style={s.row}>
          <IconSparkles size={12} color={colors.primary} style={{ marginRight: 4 }} />
          <Text style={[s.suggestion, { color: colors.textSecondary }]} numberOfLines={2}>{suggestion}</Text>
          <TouchableOpacity
            style={[s.acceptBtn, { backgroundColor: colors.primary + '18' }]}
            onPress={() => { onAccept?.(suggestion); setSuggestion(''); }}
          >
            <Text style={[s.acceptText, { color: colors.primary }]}>
              {Platform.OS === 'web' ? 'Tab' : 'Accept'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setSuggestion('')} style={s.dismiss}>
            <Text style={[s.dismissText, { color: colors.textTertiary }]}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingVertical: 6,
    paddingHorizontal: Spacing.sm,
    marginTop: 4,
    marginBottom: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  loadingText: {
    fontSize: FontSize.xs,
    marginLeft: 4,
    fontStyle: 'italic',
  },
  suggestion: {
    flex: 1,
    fontSize: FontSize.sm,
    fontStyle: 'italic',
  },
  acceptBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
    marginLeft: 6,
  },
  acceptText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  dismiss: {
    marginLeft: 6,
  },
  dismissText: {
    fontSize: FontSize.xs,
  },
});
