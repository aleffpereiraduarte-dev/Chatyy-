import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSparkles } from './Icons';

const BRAND = '#7C3AED';
const DEBOUNCE_MS = 1500;
const MIN_CHARS = 25;

/**
 * AISmartCompose — Gmail-style inline ghost-text autocomplete.
 *
 * Renders a faint gray suggestion appended to the user's text.
 * On web: press Tab to accept, Esc to dismiss.
 * On native: tap the suggestion to accept.
 */
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
        // Strip leading whitespace overlap so ghost text picks up cleanly.
        let s = String(r.data.result).replace(/^\s+/, '');
        // If model echoed last few chars of body, trim them.
        const tail = text.slice(-40).toLowerCase();
        const head = s.slice(0, 40).toLowerCase();
        for (let len = Math.min(tail.length, head.length); len > 4; len--) {
          if (tail.endsWith(head.slice(0, len))) {
            s = s.slice(len);
            break;
          }
        }
        setSuggestion(s);
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

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [bodyText, fetchCompletion]);

  // Web: Tab accepts, Esc dismisses
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
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [suggestion, onAccept]);

  if (!suggestion && !loading) return null;

  // Inline ghost-text style: faint gray, italic, with Tab hint badge.
  const ghostColor = colors.textTertiary || '#9CA3AF';

  return (
    <View style={s.ghostWrap} pointerEvents="box-none">
      {loading ? (
        <View style={s.thinkingRow} pointerEvents="none">
          <IconSparkles size={11} color={ghostColor} />
          <Text style={[s.thinkingDot, { color: ghostColor }]}>•</Text>
          <Text style={[s.thinkingDot, { color: ghostColor }]}>•</Text>
          <Text style={[s.thinkingDot, { color: ghostColor }]}>•</Text>
        </View>
      ) : suggestion ? (
        <TouchableOpacity
          style={s.ghostInline}
          onPress={() => { onAccept?.(suggestion); setSuggestion(''); }}
          activeOpacity={0.7}
        >
          <Text style={[s.ghostText, { color: ghostColor }]} numberOfLines={3}>
            {suggestion}
          </Text>
          <View style={[s.tabBadge, { backgroundColor: BRAND + '15', borderColor: BRAND + '40' }]}>
            <Text style={[s.tabBadgeText, { color: BRAND }]}>
              {Platform.OS === 'web' ? 'Tab ↹' : 'Toque'}
            </Text>
          </View>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  ghostWrap: {
    marginTop: 2,
    marginBottom: 4,
  },
  ghostInline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  ghostText: {
    flex: 1,
    fontSize: FontSize.base,
    lineHeight: 22,
    fontStyle: 'italic',
    opacity: 0.75,
  },
  tabBadge: {
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 2,
  },
  tabBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  thinkingDot: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    marginHorizontal: 1,
  },
});
