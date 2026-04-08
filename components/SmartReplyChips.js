import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Animated, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconSparkles } from './Icons';

export default function SmartReplyChips({ email, onSelectReply }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const fadeAnims = useRef([]).current;

  // Staggered fade-in for chips
  useEffect(() => {
    if (replies?.length) {
      while (fadeAnims.length < replies.length) fadeAnims.push(new Animated.Value(0));
      fadeAnims.forEach((anim, i) => {
        anim.setValue(0);
        Animated.timing(anim, {
          toValue: 1, duration: 250, delay: i * 60,
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

  if (error || (!loading && replies.length === 0)) return null;

  return (
    <View style={[s.container, { borderTopColor: colors.borderLight }]}>
      <View style={s.labelRow}>
        <IconSparkles size={14} color={colors.primary} style={{ marginRight: 6 }} />
        <Text style={[s.label, { color: colors.textTertiary }]}>{t('smartReply.suggested')}</Text>
      </View>
      {loading ? (
        <View style={s.loadingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[s.loadingText, { color: colors.textTertiary }]}>{t('smartReply.generating')}</Text>
        </View>
      ) : (
        <View style={s.chipsRow}>
          {replies.map((reply, i) => {
            while (fadeAnims.length < replies.length) fadeAnims.push(new Animated.Value(0));
            return (
              <Animated.View key={i} style={{ opacity: fadeAnims[i] }}>
                <TouchableOpacity
                  style={[s.chip, { borderColor: colors.primary, backgroundColor: colors.primaryLight + '20' }]}
                  onPress={() => onSelectReply?.({ ...email, smartReply: reply })}
                  activeOpacity={0.7}
                >
                  <Text style={[s.chipText, { color: colors.primary }]} numberOfLines={2}>
                    {reply}
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    marginTop: Spacing.xl, paddingTop: Spacing.lg, borderTopWidth: 1,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  label: { fontSize: FontSize.md, fontWeight: '500' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm },
  loadingText: { fontSize: FontSize.md, marginLeft: Spacing.sm },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    borderWidth: 1, borderRadius: BorderRadius.xxl,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    maxWidth: '100%',
  },
  chipText: { fontSize: FontSize.md, fontWeight: '500' },
});
