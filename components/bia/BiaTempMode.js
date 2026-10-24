// [bia-temp 2026-10-24] Conversa temporária da Bia: ícone (balão tracejado, estilo ChatGPT),
// botão do cabeçalho, aviso no início da conversa e faixa fina enquanto ativa. Sem emoji.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { HeaderIconButton } from '../nativeHeader';

export function IconTempChat({ size = 20, color = '#111', active = false }) {
  // balão de conversa com contorno tracejado; ativo = traço contínuo + "relógio" interno
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3.5c-4.7 0-8.5 3.4-8.5 7.6 0 2.2 1 4.1 2.7 5.5L5.5 20.5l4.1-2.1c.8.2 1.6.3 2.4.3 4.7 0 8.5-3.4 8.5-7.6S16.7 3.5 12 3.5z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={active ? undefined : '2.6 2.4'}
      />
      {active ? (
        <>
          <Circle cx={12} cy={11.1} r={3.4} stroke={color} strokeWidth={1.5} />
          <Path d="M12 9.4v1.9l1.2.8" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : null}
    </Svg>
  );
}

export function BiaTempButton({ active, onPress, color, activeBg, t, style }) {
  return (
    <HeaderIconButton
      onPress={onPress}
      style={[styles.btn, active ? { backgroundColor: activeBg } : null, style]}
      accessibilityLabel={active ? t('bia.temp.turnOff') : t('bia.temp.turnOn')}
      accessibilityState={{ selected: !!active }}
    >
      <IconTempChat size={20} color={color} active={!!active} />
    </HeaderIconButton>
  );
}

/** Aviso grande no início da conversa temporária (sem mensagens ainda). */
export function BiaTempBanner({ isDark, t }) {
  const fg = isDark ? '#F4F4F5' : '#18181B';
  const sub = isDark ? 'rgba(244,244,245,0.72)' : 'rgba(24,24,27,0.68)';
  const bg = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(24,24,27,0.05)';
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="summary">
      <View style={styles.bannerHead}>
        <IconTempChat size={22} color={fg} active />
        <Text style={[styles.bannerTitle, { color: fg }]} maxFontSizeMultiplier={1.5} accessibilityRole="header">{t('bia.temp.title')}</Text>
      </View>
      <Text style={[styles.bannerBody, { color: fg }]} maxFontSizeMultiplier={1.6}>{t('bia.temp.body')}</Text>
      <Text style={[styles.bannerNote, { color: sub }]} maxFontSizeMultiplier={1.6}>{t('bia.temp.actions')}</Text>
      <Text style={[styles.bannerNote, { color: sub }]} maxFontSizeMultiplier={1.6}>{t('bia.temp.providers')}</Text>
    </View>
  );
}

/** Faixa fina enquanto a conversa temporária tem mensagens. */
export function BiaTempPill({ isDark, t }) {
  const fg = isDark ? '#F4F4F5' : '#18181B';
  const bg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(24,24,27,0.07)';
  return (
    <View style={styles.pillWrap} accessibilityLiveRegion="polite">
      <View style={[styles.pill, { backgroundColor: bg }]}>
        <IconTempChat size={14} color={fg} active />
        <Text style={[styles.pillText, { color: fg }]} maxFontSizeMultiplier={1.4} numberOfLines={1}>{t('bia.temp.pill')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  banner: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  bannerTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  bannerBody: { fontSize: 14.5, lineHeight: 20 },
  bannerNote: { fontSize: 12.5, lineHeight: 17 },
  pillWrap: { alignItems: 'center', paddingTop: 6, paddingBottom: 2 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, maxWidth: '92%' },
  pillText: { fontSize: 12, fontWeight: '500' },
});
