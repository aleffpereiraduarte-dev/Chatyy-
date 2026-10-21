import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSparkles, IconX } from './Icons';
import useIsMounted from '../hooks/useIsMounted';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
import BiaIcon from './bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

export default function AIEmailSummary({ email, colors, t }) {
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const mountedRef = useIsMounted();

  const handleSummarize = async () => {
    setSummarizing(true);
    setError('');
    try {
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('summarize', {
        subject: email?.subject,
        from: email?.from,
        body: email?.body_text || email?.body || '',
      });
      if (!mountedRef.current) return;
      if (r.success && r.data?.result) {
        setSummary(r.data.result);
      } else {
        setError(t?.('reader.summaryError') || 'Could not generate summary');
      }
    } catch {
      if (mountedRef.current) setError(t?.('reader.summaryError') || 'Could not generate summary');
    } finally {
      if (mountedRef.current) setSummarizing(false);
    }
  };

  if (summary) {
    return (
      <View style={[s.box, { backgroundColor: colors.primaryLight + '30', borderColor: colors.primaryLight }]}>
        <View style={s.header}>
          <BiaIcon size={14} color={colors.primary} style={{ marginRight: 6 }} />
          <Text style={[s.label, { color: colors.primary }]}>{t?.('reader.summaryLabel') || 'AI Summary'}</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setSummary('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={14} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
        <Text style={[s.text, { color: colors.text }]}>{summary}</Text>
      </View>
    );
  }

  return (
    <View>
      <TouchableOpacity
        style={[s.btn, { backgroundColor: colors.surfaceVariant }]}
        onPress={handleSummarize}
        disabled={summarizing}
      >
        {summarizing ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <>
            <BiaIcon size={14} color={colors.primary} style={{ marginRight: 6 }} />
            <Text style={[s.btnText, { color: colors.primary }]}>{t?.('reader.summarize') || 'Summarize with AI'}</Text>
          </>
        )}
      </TouchableOpacity>
      {error ? <Text style={[s.error, { color: colors.error || '#dc2626' }]}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  text: {
    fontSize: FontSize.base,
    lineHeight: 22,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.md,
    minHeight: 44, // [2026-10-16 polish] alvo de toque (era ~30pt)
  },
  btnText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  error: {
    fontSize: FontSize.xs,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
});
