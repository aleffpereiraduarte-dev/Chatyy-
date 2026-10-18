// [2026-10-16 wave12-c] Atalhos "Comunidades" · "Canais" na home de Conversas.
//
// Antes os dois só existiam dentro da gaveta "Apps" (2 toques, ninguém achava —
// 0 criados). Agora ficam à vista no topo da home, como o WhatsApp deixa
// Comunidades/Canais a 1 toque. Nativo: no espaço livre do header (o título
// grande mora na lista) e somem quando o título compacto aparece. Web: linha
// fina logo abaixo do header. Preto e branco, sem emoji, i18n existente
// (community.title / channel.title).
import React from 'react';
import { ScrollView, Text, StyleSheet, Platform } from 'react-native';
import PressableScale from '../PressableScale';
import { PressScale } from '../../constants/motion';

function Pill({ label, onPress, isDark, color }) {
  return (
    // [2026-10-18 elegance] press = leve escala (Telegram) em vez de só opacidade;
    // fundo claro = mesmo cinza dos chips de filtro da lista (#f2f2f2).
    <PressableScale
      onPress={onPress}
      hitSlop={4}
      haptic={false}
      scaleTo={PressScale.chip}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      containerStyle={Platform.OS === 'web' ? st.webCursor : undefined}
      style={[st.pill, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f2' }]}
    >
      <Text style={[st.label, { color }]} numberOfLines={1}>{label}</Text>
    </PressableScale>
  );
}

export default function HomeDiscoverPills({ t, isDark, colors, onOpen, style, contentStyle }) {
  const fg = colors?.text || (isDark ? '#ffffff' : '#111111');
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[st.scroll, style]}
      contentContainerStyle={[st.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      <Pill label={t('community.title') || 'Comunidades'} onPress={() => onOpen?.('communities')} isDark={isDark} color={fg} />
      <Pill label={t('channel.title') || 'Canais'} onPress={() => onOpen?.('channels')} isDark={isDark} color={fg} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { height: 30, paddingHorizontal: 12, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13.5, fontWeight: '600', letterSpacing: -0.1 },
  webCursor: { cursor: 'pointer' },
});
