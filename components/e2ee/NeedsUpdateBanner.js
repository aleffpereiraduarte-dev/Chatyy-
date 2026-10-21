// [e2ee5 WP-15 2026-10-21] Faixa "Fulano precisa atualizar o Chatyy para ativar a criptografia".
// Fonte: e2ee5_conversation_state → blocked_reason='member_needs_update' + membros com
// capable=false (CONTRATO §4.2.19). names = nomes de exibição desses membros (o host resolve).
// Plugar (WP-08c): acima do composer ou logo abaixo do cabeçalho, só em conversa elegível
// ainda em texto. Some sozinha quando a conversa liga (evento WS conv_e2ee).
import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, LockGlyph, tx } from './e2eeUi';

function NeedsUpdateBanner({ names = [], onPress, onDismiss, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  if (!isE2eeUiEnabled()) return null;
  const list = (names || []).filter(Boolean);
  if (!list.length) return null;
  const text = list.length === 1
    ? tx(t, 'e2ee5.banner.needs_update', '{name} precisa atualizar o Chatyy para ativar a criptografia de ponta a ponta nesta conversa.', { name: list[0] })
    : tx(t, 'e2ee5.banner.needs_update_many', '{count} pessoas precisam atualizar o Chatyy para ativar a criptografia de ponta a ponta nesta conversa.', { count: list.length });
  return (
    <View style={[s.bar, { backgroundColor: colors.surfaceVariant || colors.background, borderBottomColor: colors.divider || colors.border }, style]}>
      <Pressable onPress={onPress} disabled={!onPress} style={s.main} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={text}>
        <LockGlyph size={13} color={colors.textSecondary} filled={false} />
        <Text style={[s.text, { color: colors.textSecondary }]} maxFontSizeMultiplier={1.4}>{text}</Text>
      </Pressable>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel={tx(t, 'e2ee5.common.close', 'Fechar')}>
          <Text style={[s.x, { color: colors.textTertiary || colors.textSecondary }]}>{'×'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, fontSize: 13, lineHeight: 18, marginLeft: 8 },
  x: { fontSize: 20, lineHeight: 20, paddingLeft: 10 },
});

export default memo(NeedsUpdateBanner);
