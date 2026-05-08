import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Animated, Easing, ScrollView } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconSparkles } from './Icons';

const BRAND = '#7C3AED';

export default function SmartReplyChips({ email, onSelectReply, onSendReply }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [sendingIdx, setSendingIdx] = useState(-1);
  const fadeAnims = useRef([]).current;

  // Staggered fade-in for chips
  useEffect(() => {
    if (replies?.length) {
      while (fadeAnims.length < replies.length) fadeAnims.push(new Animated.Value(0));
      fadeAnims.forEach((anim, i) => {
        anim.setValue(0);
        Animated.timing(anim, {
          toValue: 1, duration: 280, delay: i * 70,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
    }
  }, [replies]);

  useEffect(() => {
    if (email?.body_text || email?.body) {
      generateReplies();
    }
  }, [email?.uid]);

  const generateReplies = async () => {
    setLoading(true);
    setError(false);
    try {
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('smart_reply', {
        subject: email.subject,
        from: email.from,
        body: (email.body_text || email.body || '').slice(0, 2000),
      });
      if (r.success && r.data?.replies) {
        setReplies(r.data.replies.slice(0, 3));
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleInsert = (reply) => {
    onSelectReply?.({ ...email, smartReply: reply });
  };

  const handleQuickSend = async (reply, i) => {
    if (sendingIdx >= 0) return;
    if (onSendReply) {
      setSendingIdx(i);
      try {
        await onSendReply({ ...email, smartReply: reply });
      } finally {
        setSendingIdx(-1);
      }
    } else {
      // Fallback: just insert into composer
      handleInsert(reply);
    }
  };

  if (error || (!loading && replies.length === 0)) return null;

  return (
    <View style={[s.container, { borderTopColor: colors.borderLight }]}>
      <View style={s.labelRow}>
        <IconSparkles size={14} color={BRAND} style={{ marginRight: 6 }} />
        <Text style={[s.label, { color: colors.textSecondary }]}>
          {t('smartReply.suggested') || 'Sugestões de resposta'}
        </Text>
      </View>
      {loading ? (
        <View style={s.loadingRow}>
          <ActivityIndicator size="small" color={BRAND} />
          <Text style={[s.loadingText, { color: colors.textTertiary }]}>
            {t('smartReply.generating') || 'Gerando sugestões...'}
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chipsScroll}
          style={s.chipsRow}
        >
          {replies.map((reply, i) => {
            while (fadeAnims.length < replies.length) fadeAnims.push(new Animated.Value(0));
            const sending = sendingIdx === i;
            return (
              <Animated.View
                key={i}
                style={{
                  opacity: fadeAnims[i],
                  transform: [{
                    translateY: fadeAnims[i].interpolate({
                      inputRange: [0, 1], outputRange: [8, 0],
                    }),
                  }],
                }}
              >
                <View style={[s.chipGroup, { borderColor: BRAND, backgroundColor: BRAND + '08' }]}>
                  {/* Tap pill = insert into composer */}
                  <TouchableOpacity
                    style={s.chipBody}
                    onPress={() => handleInsert(reply)}
                    activeOpacity={0.65}
                  >
                    <Text style={[s.chipText, { color: BRAND }]} numberOfLines={2}>
                      {reply}
                    </Text>
                  </TouchableOpacity>
                  {/* Quick-send arrow — sends directly */}
                  <TouchableOpacity
                    style={[s.sendBtn, { backgroundColor: BRAND }]}
                    onPress={() => handleQuickSend(reply, i)}
                    activeOpacity={0.8}
                    disabled={sending}
                    accessibilityLabel={t('smartReply.quickSend') || 'Enviar resposta'}
                  >
                    {sending ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={s.sendArrow}>↑</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </Animated.View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  label: { fontSize: FontSize.sm, fontWeight: '600', letterSpacing: 0.3 },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  loadingText: { fontSize: FontSize.md, marginLeft: Spacing.sm },
  chipsRow: { marginHorizontal: 0 },
  chipsScroll: {
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
    paddingVertical: 4,
  },
  chipGroup: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1.5,
    borderRadius: BorderRadius.xxl,
    overflow: 'hidden',
    maxWidth: 280,
  },
  chipBody: {
    paddingLeft: Spacing.md,
    paddingRight: Spacing.sm,
    paddingVertical: 9,
    justifyContent: 'center',
    flexShrink: 1,
  },
  chipText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  sendBtn: {
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
  },
  sendArrow: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 18,
  },
});
