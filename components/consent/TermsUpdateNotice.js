// [2026-10-13 consent-lgpd] Aviso ÚNICO p/ quem já tinha conta: "Atualizamos nossos
// Termos e a Política de Privacidade" + resumo das mudanças + as duas opções
// opcionais (DESMARCADAS). Não bloqueia: fechar (X / toque fora / voltar) só
// registra a ciência; "Continuar" registra o aceite da versão nova. Cada escolha
// vai p/ o servidor com versão/canal/plataforma (services/consents.js).
//
// Overlay absoluto (não <Modal>) — não briga com outro Modal do iOS (WhatsNew etc.):
// se algo estiver por cima, o aviso aparece quando aquilo fechar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform, BackHandler } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconShield } from '../Icons';
import ConsentOptions from './ConsentOptions';
import { shouldShowTermsUpdate, recordTermsUpdate, loadConsents, TERMS_VERSION } from '../../services/consents';

// Telas onde o aviso NÃO aparece (fluxos de entrada, chamadas, câmera, lives).
const SKIP_RE = /^\/(login|signup|forgot|verify|call|group-call|meet|live|reels-recorder|reels-compose|video-studio|native-sheet|legal)/;

export default function TermsUpdateGate() {
  const auth = useAuth();
  const pathname = usePathname() || '';
  const [show, setShow] = useState(false);
  const probedForRef = useRef(null);
  const email = auth?.user?.email || '';

  useEffect(() => {
    if (!email) { probedForRef.current = null; setShow(false); return undefined; }
    if (auth?.loading || probedForRef.current === email) return undefined;
    probedForRef.current = email;
    // Hidrata JÁ (disco + servidor): Reels lê isPersonalizationEnabled() de forma síncrona.
    loadConsents().catch(() => {});
    // Depois do boot (e do WhatsNew, que abre em ~1.2 s): não compete com o 1º frame.
    const timer = setTimeout(async () => {
      try { if (await shouldShowTermsUpdate()) setShow(true); } catch {}
    }, 6000);
    return () => clearTimeout(timer);
  }, [email, auth?.loading]);

  if (!show || SKIP_RE.test(pathname)) return null;
  return <TermsUpdateNotice onDone={() => setShow(false)} />;
}

export function TermsUpdateNotice({ onDone }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [choices, setChoices] = useState({ chat_interests: false, marketing: false });
  const doneRef = useRef(false);

  const finish = useCallback((accepted) => {
    if (doneRef.current) return;
    doneRef.current = true;
    recordTermsUpdate({ accepted, choices }).catch(() => {});
    onDone && onDone();
  }, [choices, onDone]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { finish(false); return true; });
    return () => sub.remove();
  }, [finish]);

  const openDoc = (doc) => { try { router.push({ pathname: '/legal', params: { doc } }); } catch {} };
  const points = [t('consents.updatePoint1'), t('consents.updatePoint2'), t('consents.updatePoint3')];
  const linkStyle = { color: colors.text, fontWeight: '600', textDecorationLine: 'underline' };

  return (
    <View style={[StyleSheet.absoluteFill, st.backdrop]} accessibilityViewIsModal>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => finish(false)} accessibilityLabel={t('common.close')} />
      <View style={[st.card, {
        backgroundColor: colors.surface || colors.background,
        marginBottom: Math.max(insets.bottom, 16),
        marginTop: insets.top + 24,
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'transparent',
      }]}>
        <Pressable onPress={() => finish(false)} style={st.close} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <IconX size={20} color={colors.textSecondary} />
        </Pressable>
        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 22 }} bounces={false}>
          <View style={[st.icon, { backgroundColor: (colors.text || '#000') + '14' }]}>
            <IconShield size={24} color={colors.text} />
          </View>
          <Text style={[st.title, { color: colors.text }]} accessibilityRole="header">{t('consents.updateTitle')}</Text>
          <Text style={[st.version, { color: colors.textTertiary || colors.textSecondary }]}>{`${t('legal.version')} ${TERMS_VERSION}`}</Text>
          <Text style={[st.intro, { color: colors.textSecondary }]}>{t('consents.updateIntro')}</Text>
          {points.map((p, i) => (
            <View key={i} style={st.point}>
              <View style={[st.dot, { backgroundColor: colors.text }]} />
              <Text style={[st.pointText, { color: colors.text }]}>{p}</Text>
            </View>
          ))}
          <Text style={[st.links, { color: colors.textSecondary }]}>
            <Text style={linkStyle} accessibilityRole="link" onPress={() => openDoc('terms')}>{t('plans.termsOfUse')}</Text>
            {'  ·  '}
            <Text style={linkStyle} accessibilityRole="link" onPress={() => openDoc('privacy')}>{t('plans.privacyPolicy')}</Text>
          </Text>
          <View style={[st.sep, { backgroundColor: colors.border || '#e5e7eb' }]} />
          <ConsentOptions value={choices} onChange={setChoices} colors={colors} />
          <Text style={[st.agree, { color: colors.textTertiary || colors.textSecondary }]}>{t('consents.updateAgree')}</Text>
          <Pressable
            onPress={() => finish(true)}
            style={({ pressed }) => [st.cta, { backgroundColor: colors.text, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
            testID="terms-update-continue"
          >
            <Text style={[st.ctaText, { color: colors.background }]}>{t('consents.updateContinue')}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  backdrop: { zIndex: 9000, elevation: 30, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12 },
  card: { width: '100%', maxWidth: 480, maxHeight: '88%', borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  close: { position: 'absolute', top: 12, right: 12, zIndex: 2, padding: 4 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: 19, fontWeight: '700', lineHeight: 25, paddingRight: 24 },
  version: { fontSize: 12, marginTop: 4 },
  intro: { fontSize: 14, lineHeight: 20, marginTop: 12, marginBottom: 6 },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 8 },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8 },
  pointText: { flex: 1, fontSize: 14, lineHeight: 20 },
  links: { fontSize: 13, marginTop: 14 },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 16 },
  agree: { fontSize: 12, lineHeight: 17, marginTop: 14 },
  cta: { marginTop: 12, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  ctaText: { fontSize: 16, fontWeight: '700' },
});
