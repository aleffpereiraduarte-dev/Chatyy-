import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import { IllustrationSearch, IllustrationEmptyInbox, IconSend, IconTrash, IconArchive, IconAlertTriangle, IconClock, IconFileText, IconCompose, IconRefresh } from './Icons';

const FOLDER_EMPTY = {
  INBOX: { titleKey: 'empty.inbox.title', subKey: 'empty.inbox.sub', icon: 'inbox', cta: 'compose' },
  Sent: { titleKey: 'empty.sent.title', subKey: 'empty.sent.sub', icon: 'send', cta: 'compose' },
  Drafts: { titleKey: 'empty.drafts.title', subKey: 'empty.drafts.sub', icon: 'file', cta: 'compose' },
  Trash: { titleKey: 'empty.trash.title', subKey: 'empty.trash.sub', icon: 'trash' },
  Junk: { titleKey: 'empty.spam.title', subKey: 'empty.spam.sub', icon: 'alert' },
  Spam: { titleKey: 'empty.spam.title', subKey: 'empty.spam.sub', icon: 'alert' },
  Archive: { titleKey: 'empty.archive.title', subKey: 'empty.archive.sub', icon: 'archive' },
  Snoozed: { titleKey: 'empty.snoozed.title', subKey: 'empty.snoozed.sub', icon: 'clock' },
};

function FolderIcon({ type, size, color }) {
  switch (type) {
    case 'send': return <IconSend size={size} color={color} />;
    case 'trash': return <IconTrash size={size} color={color} />;
    case 'archive': return <IconArchive size={size} color={color} />;
    case 'alert': return <IconAlertTriangle size={size} color={color} />;
    case 'clock': return <IconClock size={size} color={color} />;
    case 'file': return <IconFileText size={size} color={color} />;
    default: return <IllustrationEmptyInbox size={size} color={color} />;
  }
}

export default function EmptyState({ search, message, folder, onRefresh }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();

  if (search) {
    return (
      <View style={s.container}>
        <IllustrationSearch size={120} color={colors.textTertiary} />
        <Text style={[s.text, { color: colors.textSecondary }]}>{t('empty.search.title')}</Text>
        <Text style={[s.sub, { color: colors.textTertiary }]}>{t('empty.search.sub')}</Text>
      </View>
    );
  }

  const config = FOLDER_EMPTY[folder] || { titleKey: 'empty.inbox.title', subKey: 'empty.inbox.sub', icon: 'inbox' };

  return (
    <View style={s.container}>
      <View style={[s.iconCircle, { backgroundColor: colors.primary + '12' }]}>
        <FolderIcon type={config.icon} size={48} color={colors.primary} style={{ opacity: 0.7 }} />
      </View>
      <Text style={[s.text, { color: colors.text }]}>{t(config.titleKey)}</Text>
      <Text style={[s.sub, { color: colors.textTertiary }]}>{t(config.subKey)}</Text>

      <View style={s.ctaRow}>
        {config.cta === 'compose' && (
          <TouchableOpacity
            style={[s.ctaBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/compose')}
            activeOpacity={0.8}
          >
            <IconCompose size={16} color="#fff" style={{ marginRight: 6 }} />
            <Text style={s.ctaBtnText}>{t('empty.compose')}</Text>
          </TouchableOpacity>
        )}
        {onRefresh && (
          <TouchableOpacity
            style={[s.ctaBtnOutline, { borderColor: colors.borderLight }]}
            onPress={onRefresh}
            activeOpacity={0.7}
          >
            <IconRefresh size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.ctaBtnOutlineText, { color: colors.textSecondary }]}>{t('empty.refresh')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { alignItems: 'center', marginTop: 80, padding: 24 },
  iconCircle: {
    width: 110, height: 110, borderRadius: 55,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  text: { fontSize: FontSize.xl, fontWeight: '600', textAlign: 'center', marginTop: 8 },
  sub: { fontSize: FontSize.base, marginTop: 8, textAlign: 'center', lineHeight: 22, maxWidth: 280 },
  ctaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24,
  },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'transform 0.15s ease, opacity 0.15s ease' },
      default: {},
    }),
  },
  ctaBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '600' },
  ctaBtnOutline: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12,
    borderWidth: 1.5,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'transform 0.15s ease, opacity 0.15s ease' },
      default: {},
    }),
  },
  ctaBtnOutlineText: { fontSize: FontSize.base, fontWeight: '500' },
});
