// [2026-10-07 app-feel-webview] /legal?doc=terms|privacy — native legal pages.
//
// Before: "Termos de Uso" / "Política de Privacidade" / "Suporte" rows did
// Linking.openURL('https://chatyy.com.br/terms.html' | '/termos' | '/support')
// → threw the user OUT to Safari/Chrome, and terms.html / termos / support
// are not deployed: nginx's SPA fallback served the whole web app. Now the
// text (already translated in i18n: terms.* / privacy.*) renders as a native
// scroll view with large title, section cards and tappable e-mail addresses.
// Privacy also offers the full official policy (privacy.html, which IS
// deployed) in the in-app browser sheet.
import { useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, IOS_NATIVE_INSET } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconShield, IconFileText } from '../components/Icons';
import { openInApp } from '../utils/inAppBrowser';

const TERMS = ['acceptance', 'services', 'accounts', 'conduct', 'content', 'aiAssistant', 'communications', 'storage', 'privacy', 'intellectualProperty', 'limitation', 'termination', 'disputes', 'changes'];
const PRIVACY = ['dataCollection', 'dataUsage', 'dataSecurity', 'dataEncryption', 'aiProcessing', 'chatPrivacy', 'meetingsPrivacy', 'pushNotifications', 'cookies', 'thirdParties', 'dataRetention', 'internationalData', 'childrenPrivacy', 'breachNotification', 'rights', 'openSource', 'contact'];

const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function Body({ text, color, linkColor }) {
  const parts = String(text || '').split(EMAIL_RE);
  return (
    <Text style={[st.body, { color }]} selectable>
      {parts.map((p, i) => (i % 2 === 1
        ? <Text key={i} style={{ color: linkColor, fontWeight: '600' }} onPress={() => Linking.openURL('mailto:' + p).catch(() => {})}>{p}</Text>
        : p))}
    </Text>
  );
}

export default function LegalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const doc = String((Array.isArray(params.doc) ? params.doc[0] : params.doc) || 'terms') === 'privacy' ? 'privacy' : 'terms';
  const keys = doc === 'privacy' ? PRIVACY : TERMS;

  const sections = useMemo(() => keys
    .map((k) => {
      const title = t(`${doc}.${k}.title`);
      const body = t(`${doc}.${k}.body`);
      // t() returns the key itself when missing → skip untranslated sections.
      if (!title || title === `${doc}.${k}.title` || !body || body === `${doc}.${k}.body`) return null;
      return { k, title, body };
    })
    .filter(Boolean), [doc, keys, t]);

  const title = doc === 'privacy' ? (t('privacy.title') || 'Política de Privacidade') : (t('terms.title') || 'Termos de Serviço');
  const subtitle = t(`${doc}.subtitle`);
  const updated = t(`${doc}.lastUpdated`);
  const Icon = doc === 'privacy' ? IconShield : IconFileText;

  return (
    <View style={[st.container, { backgroundColor: colors.background }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title })} />
      ) : (
      <View style={[st.header, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        <TouchableOpacity onPress={() => (router.canGoBack?.() ? router.back() : router.replace('/settings'))} style={st.headerBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[st.headerTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      </View>
      )}
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: IOS_NATIVE_INSET ? 32 : insets.bottom + 32 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={st.hero}>
          <View style={[st.heroIcon, { backgroundColor: (colors.primary || '#7c3aed') + '1f' }]}>
            <Icon size={28} color={colors.primary} />
          </View>
          <Text style={[st.heroTitle, { color: colors.text }]}>{title}</Text>
          {!!subtitle && subtitle !== `${doc}.subtitle` && <Text style={[st.heroSub, { color: colors.textSecondary }]}>{subtitle}</Text>}
          {!!updated && updated !== `${doc}.lastUpdated` && <Text style={[st.updated, { color: colors.textTertiary || colors.textSecondary }]}>{updated}</Text>}
        </View>
        {sections.map((sct, i) => (
          <View key={sct.k} style={[st.card, { backgroundColor: colors.surface, borderColor: isDark ? 'transparent' : (colors.border || '#e5e7eb') }]}>
            <Text style={[st.cardTitle, { color: colors.text }]}>{`${i + 1}. ${sct.title}`}</Text>
            <Body text={sct.body} color={colors.textSecondary} linkColor={colors.primary} />
          </View>
        ))}
        {doc === 'privacy' && (
          <TouchableOpacity
            style={[st.linkBtn, { borderColor: colors.border || '#e5e7eb' }]}
            onPress={() => openInApp('https://chatyy.com.br/privacy.html', { colors, isDark })}
            accessibilityRole="link"
          >
            <Text style={[st.linkText, { color: colors.primary }]}>{t('legal.fullPolicy') !== 'legal.fullPolicy' ? t('legal.fullPolicy') : 'Ver política completa'}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[st.linkBtn, { borderColor: colors.border || '#e5e7eb' }]}
          onPress={() => router.push({ pathname: '/legal', params: { doc: doc === 'privacy' ? 'terms' : 'privacy' } })}
          accessibilityRole="link"
        >
          <Text style={[st.linkText, { color: colors.primary }]}>
            {doc === 'privacy' ? (t('plans.termsOfUse') || 'Termos de Uso') : (t('plans.privacyPolicy') || 'Política de Privacidade')}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 6 },
  headerBtn: { padding: 10 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', marginLeft: 2 },
  hero: { alignItems: 'center', paddingTop: 12, paddingBottom: 20 },
  heroIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heroTitle: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  heroSub: { fontSize: 15, marginTop: 6, textAlign: 'center' },
  updated: { fontSize: 13, marginTop: 6 },
  card: { borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 22 },
  linkBtn: { marginTop: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center' },
  linkText: { fontSize: 15, fontWeight: '600' },
});
