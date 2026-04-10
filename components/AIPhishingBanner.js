import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconShield, IconChevronDown, IconChevronUp, IconX } from './Icons';
import { useLanguage } from '../context/LanguageContext';

export default function AIPhishingBanner({ email, colors, autoCheck = false }) {
  const { t } = useLanguage();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const runCheck = async () => {
    setChecking(true);
    try {
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('phishing_check', {
        subject: email.subject,
        from: email.from,
        body: email.body_text || email.body || '',
        headers: email.headers || '',
      });
      if (r.success && r.data?.score !== undefined) {
        setResult(r.data);
      }
    } catch {} finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (autoCheck && email && !result && !checking) {
      runCheck();
    }
  }, [email?.uid]);

  if (dismissed) return null;
  if (!result && !checking) return null;

  if (checking) return null; // silent check — only appear if risk found

  if (!result?.is_suspicious) return null;

  const isHigh = result.score >= 80;
  const bgColor = isHigh ? '#fef2f2' : '#fffbeb';
  const borderColor = isHigh ? '#dc2626' : '#f59e0b';
  const textColor = isHigh ? '#991b1b' : '#92400e';
  const iconColor = isHigh ? '#dc2626' : '#f59e0b';

  return (
    <View style={[s.banner, { backgroundColor: bgColor, borderColor }]}>
      <View style={s.row}>
        <IconShield size={18} color={iconColor} style={{ marginRight: 8 }} />
        <View style={s.content}>
          <Text style={[s.title, { color: textColor }]}>
            {isHigh ? t('phishing.highRisk') : t('phishing.suspicious')}
          </Text>
          <Text style={[s.score, { color: textColor }]}>{t('phishing.riskLevel')}: {result.score}/100</Text>
        </View>
        <TouchableOpacity onPress={() => setExpanded(!expanded)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {expanded ? <IconChevronUp size={16} color={textColor} /> : <IconChevronDown size={16} color={textColor} />}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginLeft: 8 }}>
          <IconX size={14} color={textColor} />
        </TouchableOpacity>
      </View>
      {expanded && result.reasons?.length > 0 && (
        <View style={s.reasons}>
          {result.reasons.map((reason, i) => (
            <Text key={i} style={[s.reason, { color: textColor }]}>{'\u2022'} {reason}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  bannerChecking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 0,
  },
  checkingText: {
    fontSize: FontSize.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  score: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  reasons: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  reason: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginBottom: 2,
  },
});
