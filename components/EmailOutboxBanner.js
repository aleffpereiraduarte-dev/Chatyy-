// [2026-10-08 email-outbox] "Caixa de saída" entry point. Renders nothing
// while the active account's outbox is empty. variant='banner' (inbox list
// header) | 'sidebar' (folder-style row).
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconSend, IconAlertTriangle } from './Icons';
import { subscribeEmailOutbox, getEmailOutbox } from '../services/emailOutbox';

export default function EmailOutboxBanner({ variant = 'banner', onPress }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  // [2026-10-17 email-send-gmail] every Send now passes through the outbox for
  // ~0,1–0,5 s; hide that in-flight first attempt (the global bar already says
  // "Enviando…") so the banner doesn't flash + shift the list on each send.
  const _visible = (list) => (list || []).filter((e) => !(e && e.reason === 'send' && !e.attempts
    && (e.status === 'queued' || e.status === 'sending') && Date.now() - (e.createdAt || 0) < 15000));
  const [items, setItems] = useState(() => _visible(getEmailOutbox()));
  // [2026-10-17 p2] the 15 s rule is time-based: an entry stuck in its first
  // attempt (no outbox event fires while it waits) must appear once it ages
  // past 15 s, so re-evaluate on a timer while anything is being hidden.
  const [hiddenCount, setHiddenCount] = useState(0);
  useEffect(() => subscribeEmailOutbox((list) => {
    const v = _visible(list);
    setItems(v);
    setHiddenCount(Math.max(0, (list || []).length - v.length));
  }), []);
  useEffect(() => {
    if (!hiddenCount) return undefined;
    const id = setInterval(() => {
      const list = getEmailOutbox();
      const v = _visible(list);
      setItems(v);
      setHiddenCount(Math.max(0, (list || []).length - v.length));
    }, 2000);
    return () => clearInterval(id);
  }, [hiddenCount]);
  if (!items.length) return null;
  const failed = items.some((e) => e.status === 'failed');
  const go = () => {
    if (onPress) onPress('/email-outbox');
    else { try { router.push('/email-outbox'); } catch {} }
  };
  const tint = failed ? colors.error : colors.primary;
  const Icon = failed ? IconAlertTriangle : IconSend;

  if (variant === 'sidebar') {
    return (
      <TouchableOpacity onPress={go} style={st.sideRow} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={t('emailOutbox.title')}>
        <View style={st.sideIcon}><Icon size={18} color={tint} /></View>
        <Text style={[st.sideLabel, { color: colors.text }]} numberOfLines={1}>{t('emailOutbox.title')}</Text>
        <View style={[st.badge, { backgroundColor: tint }]}>
          <Text style={[st.badgeText, !failed && colors.onPrimary ? { color: colors.onPrimary } : null]}>{items.length}</Text>
        </View>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity onPress={go} activeOpacity={0.7} accessibilityRole="button"
      style={[st.banner, { backgroundColor: failed ? colors.errorBg : colors.primaryLight }]}>
      <Icon size={16} color={tint} />
      <Text style={[st.bannerText, { color: tint }]} numberOfLines={1}>
        {t('emailOutbox.banner', { n: items.length })}
      </Text>
      <Text style={[st.bannerCta, { color: tint }]}>{t('emailOutbox.view')}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm, marginBottom: Spacing.xs,
    paddingHorizontal: Spacing.md, paddingVertical: 10, borderRadius: BorderRadius.md,
  },
  bannerText: { flex: 1, fontSize: FontSize.sm, fontWeight: '600' },
  bannerCta: { fontSize: FontSize.sm, fontWeight: '700' },
  sideRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  sideIcon: { width: 24, alignItems: 'center' },
  sideLabel: { flex: 1, fontSize: FontSize.base, fontWeight: '500' },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
});
