import { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import { cssPulseScale, IS_WEB } from '../utils/webCssLoop';
import { IllustrationSearch, IllustrationEmptyInbox, IconSend, IconTrash, IconArchive, IconAlertTriangle, IconClock, IconFileText, IconCompose, IconRefresh, IconMail } from './Icons';
import { wrapRetryPress } from '../utils/userRetry'; // [2026-10-18 breaker-ux]
import { Springs, motionEnabled } from '../constants/motion'; // [2026-10-16 motion] entrada de estado vazio

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

export default function EmptyState({ search, message, folder, onRefresh, title, sub }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();

  // Entrance animations
  const still = useRef(!motionEnabled('empty_state')).current;
  const fadeAnim = useRef(new Animated.Value(still ? 1 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(still ? 1 : 0.8)).current;
  const slideAnim = useRef(new Animated.Value(still ? 0 : 20)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (still) return undefined; // Reduzir Movimento: sem entrada nem pulso
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, ...Springs.gentle, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    // Gentle pulse for the icon circle
    if (IS_WEB) return undefined; // [2026-10-15 web-idle] CSS (webRingPulse)
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  if (search) {
    return (
      <Animated.View style={[s.container, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
        <View style={[s.searchIconWrap, { backgroundColor: isDark ? 'rgba(148,163,184,0.08)' : 'rgba(148,163,184,0.06)' }]}>
          <IllustrationSearch size={80} color={colors.textTertiary} />
        </View>
        <Text style={[s.text, { color: colors.textSecondary }]}>{t('empty.search.title')}</Text>
        <Text style={[s.sub, { color: colors.textTertiary }]}>{t('empty.search.sub')}</Text>
      </Animated.View>
    );
  }

  const config = FOLDER_EMPTY[folder] || { titleKey: 'empty.inbox.title', subKey: 'empty.inbox.sub', icon: 'inbox' };

  return (
    <Animated.View style={[s.container, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      {/* Decorative rings behind icon */}
      <View style={s.iconContainer}>
        <Animated.View style={[s.outerRing, {
          borderColor: colors.primary + '08',
          transform: [{ scale: pulseAnim }],
        }, IS_WEB ? cssPulseScale(1.06, 2000) : null]} />
        <Animated.View style={[s.middleRing, {
          borderColor: colors.primary + '12',
          transform: [{ scale: pulseAnim }],
        }, IS_WEB ? cssPulseScale(1.06, 2000) : null]} />
        <Animated.View style={[s.iconCircle, {
          backgroundColor: colors.primary + '10',
          transform: [{ scale: scaleAnim }],
        }]}>
          <FolderIcon type={config.icon} size={44} color={colors.primary} style={{ opacity: 0.8 }} />
        </Animated.View>
      </View>
      <Text style={[s.text, { color: colors.text }]}>{title || t(config.titleKey)}</Text>
      <Text style={[s.sub, { color: colors.textTertiary }]}>{sub || t(config.subKey)}</Text>

      <View style={s.ctaRow}>
        {config.cta === 'compose' && (
          <TouchableOpacity
            style={[s.ctaBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/compose')}
            activeOpacity={0.8}
          >
            <IconCompose size={16} color={colors.onPrimary || '#fff'} style={{ marginRight: 8 }} />
            <Text style={[s.ctaBtnText, { color: colors.onPrimary }]}>{t('empty.compose')}</Text>
          </TouchableOpacity>
        )}
        {onRefresh && (
          <TouchableOpacity
            style={[s.ctaBtnOutline, { borderColor: colors.border }]}
            onPress={wrapRetryPress(onRefresh, '', true)}
            activeOpacity={0.7}
          >
            <IconRefresh size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.ctaBtnOutlineText, { color: colors.textSecondary }]}>{t('empty.refresh')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60, paddingBottom: 40, paddingHorizontal: 32 },
  iconContainer: {
    width: 160, height: 160,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  outerRing: {
    position: 'absolute', width: 160, height: 160, borderRadius: 80,
    borderWidth: 1.5,
  },
  middleRing: {
    position: 'absolute', width: 130, height: 130, borderRadius: 65,
    borderWidth: 1.5,
  },
  iconCircle: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  searchIconWrap: {
    width: 120, height: 120, borderRadius: 60,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  text: { fontSize: 20, fontWeight: '700', textAlign: 'center', letterSpacing: -0.3 },
  sub: { fontSize: 15, marginTop: 8, textAlign: 'center', lineHeight: 22, maxWidth: 300 },
  ctaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 28,
  },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, paddingVertical: 13, borderRadius: 14,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease',
        boxShadow: '0 2px 12px rgba(17, 17, 17, 0.18)',
      },
      default: {},
    }),
  },
  ctaBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  ctaBtnOutline: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14,
    borderWidth: 1.5,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'transform 0.15s ease, opacity 0.15s ease' },
      default: {},
    }),
  },
  ctaBtnOutlineText: { fontSize: 15, fontWeight: '500' },
});
