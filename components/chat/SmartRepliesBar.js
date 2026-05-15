// SmartRepliesBar — Gmail/iMessage-style chip row above the chat composer.
//
// Renders 3 OpenAI-generated reply suggestions. Tap inserts into composer
// (does NOT auto-send) so the user keeps editorial control. Shows only
// when:
//   - the LAST message is from the peer (incoming)
//   - the conversation is direct or group (any type but channel)
//   - the user hasn't typed anything yet (parent gates via inputText)
//   - last message was text (no replies suggested for stickers/voice etc.)
//
// Network: backend caches suggestions per (conversation, last_msg_id) for
// 60s server-side, so re-renders triggered by typing-indicator WS events
// won't burn API tokens.
//
// Props:
//   conversationId number
//   lastIncomingId number  — change of this id triggers a refetch
//   onPick(text)   — fired when user taps a chip
//   colors         theme
//   t              i18n function

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
} from 'react-native';
import { IconSparkles } from '../Icons';

const BRAND = '#7C3AED';

export default function SmartRepliesBar({ conversationId, lastIncomingId, onPick, colors, t }) {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const fades = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  const lastFetchedIdRef = useRef(null);

  useEffect(() => {
    if (!conversationId || !lastIncomingId) {
      setReplies([]);
      return;
    }
    if (lastFetchedIdRef.current === lastIncomingId) return;
    lastFetchedIdRef.current = lastIncomingId;

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const api = require('../../services/api');
        const r = await api.chatAiSuggestReplies(conversationId);
        if (cancelled) return;
        const list = Array.isArray(r?.data?.suggestions) ? r.data.suggestions : [];
        setReplies(list.slice(0, 3));
      } catch {
        if (!cancelled) setReplies([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, lastIncomingId]);

  // Staggered fade-in for chips
  useEffect(() => {
    if (replies.length === 0) return;
    fades.forEach((a, i) => {
      a.setValue(0);
      Animated.timing(a, {
        toValue: 1,
        duration: 240,
        delay: i * 60,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  }, [replies]);

  // Hide entirely when no replies and not loading — avoids reserving space
  // above the composer for a blank bar.
  if (!loading && replies.length === 0) return null;

  return (
    <View style={[s.wrap, { backgroundColor: colors?.background || '#fff' }]}>
      <View style={s.label}>
        <IconSparkles size={11} color={BRAND} />
        <Text style={[s.labelText, { color: colors?.textTertiary || '#888' }]}>
          {t?.('chatConv.smartReplies') || 'Sugestões'}
        </Text>
      </View>
      {loading ? (
        <View style={s.loadingRow}>
          <ActivityIndicator size="small" color={BRAND} />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.scroll}
        >
          {replies.map((r, i) => (
            <Animated.View
              key={`${i}-${r}`}
              style={{
                opacity: fades[i] || 1,
                transform: [{
                  translateY: (fades[i] || new Animated.Value(1)).interpolate({
                    inputRange: [0, 1], outputRange: [8, 0],
                  }),
                }],
              }}
            >
              <TouchableOpacity
                onPress={() => onPick?.(r)}
                activeOpacity={0.7}
                style={[s.chip, {
                  borderColor: BRAND,
                  backgroundColor: (colors?.background === '#0B141A' || colors?.background?.startsWith?.('#0')) ? 'rgba(124,58,237,0.18)' : BRAND + '14',
                }]}
              >
                <Text style={[s.chipText, { color: BRAND }]} numberOfLines={2}>{r}</Text>
              </TouchableOpacity>
            </Animated.View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingBottom: 4,
  },
  labelText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  loadingRow: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  scroll: {
    paddingHorizontal: 4,
    gap: 8,
    paddingVertical: 2,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    maxWidth: 240,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
