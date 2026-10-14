// [2026-10-14 not-found] Substitui a tela padrão do expo-router ("Unmatched
// Route" + "Sitemap", em inglês, com o caminho cru) — nunca aparece em produção.
//  • Caminho que é um e-mail (ex.: onemundomail://support@chatyy.com.br,
//    "/support@chatyy.com.br") → abre o compose para esse endereço.
//  • Resto → tela P&B, pt-BR (i18n), com "Voltar ao início" e "Voltar".
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Stack, usePathname, useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';
import { useLanguage } from '../context/LanguageContext';
import { useSurface, PressableScale, FadeSlideIn, Type, Space, Layout } from '../components/ui';
import { IconHome, IconArrowLeft } from '../components/Icons';
import { emailFromSystemPath } from '../utils/emailPath';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

// Ilustração traço fino P&B: "mapa" com rota tracejada que não chega ao pino.
function LostGlyph({ color, muted, size = 112 }) {
  const s = { stroke: color, strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 112 112" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Rect x={14} y={22} width={84} height={68} rx={14} stroke={muted} strokeWidth={2} fill="none" />
      <Path d="M28 74 C40 60 46 70 56 58 S70 44 76 50" {...s} strokeDasharray="2 7" />
      <Circle cx={28} cy={74} r={4} fill={color} />
      <Path d="M82 34 a9 9 0 0 1 9 9 c0 7 -9 15 -9 15 s-9 -8 -9 -15 a9 9 0 0 1 9 -9 z" {...s} />
      <Circle cx={82} cy={43} r={2.5} fill={color} />
      <Line x1={36} y1={36} x2={56} y2={36} stroke={muted} strokeWidth={2} strokeLinecap="round" />
      <Line x1={36} y1={44} x2={48} y2={44} stroke={muted} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export default function NotFoundScreen() {
  const s = useSurface();
  const { t } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const addr = emailFromSystemPath(pathname);

  useEffect(() => {
    if (__DEV__) console.warn('[not-found]', pathname);
  }, [pathname]);

  if (addr) return <Redirect href={'/compose?mailto=' + encodeURIComponent('mailto:' + addr)} />;

  const goHome = () => { try { router.replace('/'); } catch {} };
  const goBack = () => {
    try { if (router.canGoBack()) { router.back(); return; } } catch {}
    goHome();
  };

  return (
    <View style={[styles.root, { backgroundColor: s.bg, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, Space.lg) }]}>
      <Stack.Screen options={{ headerShown: false, title: tr(t, 'notFound.title', 'Página não encontrada') }} />
      <FadeSlideIn style={[styles.center, { flex: 0 }]}>
        <View style={[styles.glyphWrap, { backgroundColor: s.surfaceMuted, borderColor: s.border }]}>
          <LostGlyph color={s.text} muted={s.textTertiary} />
        </View>
        <Text style={[Type.sectionCaps, styles.code, { color: s.textSecondary }]}>404</Text>
        <Text accessibilityRole="header" style={[Type.title1, styles.title, { color: s.text }]}>
          {tr(t, 'notFound.title', 'Página não encontrada')}
        </Text>
        <Text style={[Type.callout, styles.sub, { color: s.textSecondary }]}>
          {tr(t, 'notFound.subtitle', 'Esse link não existe mais ou foi digitado errado.')}
        </Text>
        <View style={styles.actions}>
          <PressableScale haptic="medium" onPress={goHome} accessibilityRole="button"
            style={[styles.primary, { backgroundColor: s.ink }]}>
            <IconHome size={18} color={s.onInk} />
            <Text style={[styles.primaryText, { color: s.onInk }]}>{tr(t, 'notFound.home', 'Voltar ao início')}</Text>
          </PressableScale>
          <PressableScale onPress={goBack} accessibilityRole="button"
            style={[styles.secondary, { borderColor: s.separator }]}>
            <IconArrowLeft size={18} color={s.text} />
            <Text style={[styles.secondaryText, { color: s.text }]}>{tr(t, 'notFound.back', 'Voltar')}</Text>
          </PressableScale>
        </View>
      </FadeSlideIn>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: Layout.gutter, alignItems: 'center', justifyContent: 'center' },
  center: { width: '100%', maxWidth: 420, alignItems: 'center' },
  glyphWrap: { width: 152, height: 152, borderRadius: 76, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, marginBottom: Space.xxl },
  code: { letterSpacing: 2, marginBottom: Space.sm, fontVariant: ['tabular-nums'] },
  title: { textAlign: 'center', letterSpacing: -0.5 },
  sub: { textAlign: 'center', marginTop: Space.sm, maxWidth: 320 },
  actions: { width: '100%', gap: Space.sm, marginTop: Space.xxl },
  primary: { height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  primaryText: { fontSize: 16, fontWeight: '700' },
  secondary: { height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm, borderWidth: 1 },
  secondaryText: { fontSize: 16, fontWeight: '600' },
  ...Platform.select({ web: {}, default: {} }),
});
