// SubscribeInAppCard — [2026-10-18 stripe-off] Founder: assinatura NOVA do Chatyy Plus
// só pelas lojas (App Store / Google Play). Na web não há checkout: este cartão
// explica e leva para a loja. Selos em SVG (sem emoji).
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

export const APP_STORE_URL = 'https://apps.apple.com/app/id6759975575';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.onemundo.mail';

const APPLE_PATH = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';
const PLAY_PATH = 'M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z';

function openUrl(url) {
  try {
    if (typeof window !== 'undefined' && window.open) { window.open(url, '_blank', 'noopener'); return; }
  } catch {}
  Linking.openURL(url).catch(() => {});
}

export function StoreBadge({ kind }) {
  const { t } = useLanguage();
  const apple = kind === 'apple';
  return (
    <TouchableOpacity
      onPress={() => openUrl(apple ? APP_STORE_URL : PLAY_STORE_URL)}
      activeOpacity={0.85}
      accessibilityRole="link"
      accessibilityLabel={apple ? `${t('storeOnly.appStore')} ${t('storeOnly.appStoreName')}` : `${t('storeOnly.playStore')} ${t('storeOnly.playStoreName')}`}
      style={styles.badge}
    >
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path d={apple ? APPLE_PATH : PLAY_PATH} fill="#FFFFFF" />
      </Svg>
      <View style={{ marginLeft: 8 }}>
        <Text style={styles.badgeSmall}>{apple ? t('storeOnly.appStore') : t('storeOnly.playStore')}</Text>
        <Text style={styles.badgeBig}>{apple ? t('storeOnly.appStoreName') : t('storeOnly.playStoreName')}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function SubscribeInAppCard({ style, onClose, title, body }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>
      <Text style={[styles.title, { color: colors.text }]}>{title || t('storeOnly.title')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{body || t('storeOnly.body')}</Text>
      <View style={styles.row}>
        <StoreBadge kind="apple" />
        <StoreBadge kind="google" />
      </View>
      {onClose ? (
        <TouchableOpacity onPress={onClose} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 8, marginTop: 6 }}>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{t('storeOnly.close')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', maxWidth: 560, alignSelf: 'center', borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 20 },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 16 },
  badge: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#000000',
    borderRadius: 10, borderWidth: 1, borderColor: '#A6A6A6',
    paddingHorizontal: 14, paddingVertical: 7, minWidth: 150,
  },
  badgeSmall: { color: '#FFFFFF', fontSize: 10, fontWeight: '500', lineHeight: 12 },
  badgeBig: { color: '#FFFFFF', fontSize: 17, fontWeight: '600', lineHeight: 20, letterSpacing: -0.2 },
});
