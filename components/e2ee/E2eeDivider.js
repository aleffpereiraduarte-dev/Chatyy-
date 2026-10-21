// [e2ee5 WP-15 2026-10-21] Divisor de ativação/rebaixamento na posição da mensagem de sistema
// `{"sys":"e2ee_on","since_pts":…}` / `{"sys":"e2ee_off","by_uid","reason"}` (CONTRATO §2.7, §8.6).
//
//   on  → "A partir daqui, as mensagens são protegidas com criptografia de ponta a ponta. Toque para saber mais."
//   off → "{name} desativou a criptografia de ponta a ponta. As mensagens novas não são mais protegidas."
//         (sem name / reason=admin|kill → texto genérico)
//
// Helper e2eeSysKind(content) diz se uma linha de sistema é deste divisor (para o renderer de
// mensagens de sistema do WP-08c decidir em 1 linha). Mensagens ANTES do divisor continuam em
// texto e legíveis como hoje.
import React, { memo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, noticePalette, LockGlyph, LockOffGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

// 'on' | 'off' | null para o `content` de uma mensagem type='system'.
export function e2eeSysKind(content) {
  try {
    const o = typeof content === 'string' ? (content.charAt(0) === '{' ? JSON.parse(content) : null) : content;
    if (!o || typeof o !== 'object') return null;
    if (o.sys === 'e2ee_on') return 'on';
    if (o.sys === 'e2ee_off') return 'off';
  } catch {}
  return null;
}

function E2eeDivider({ kind = 'on', name = '', reason = 'user', calls = false, onPress, onVerify, style }) {
  const { isDark, colors } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!isE2eeUiEnabled()) return null;
  const pal = noticePalette(isDark);
  let text;
  if (kind === 'off') {
    text = name && reason === 'user'
      ? tx(t, 'e2ee5.divider.off', '{name} desativou a criptografia de ponta a ponta. As mensagens novas não são mais protegidas.', { name })
      : tx(t, 'e2ee5.divider.off_generic', 'A criptografia de ponta a ponta foi desativada nesta conversa. As mensagens novas não são mais protegidas.');
  } else {
    text = calls
      ? tx(t, 'e2ee5.divider.on_calls', 'As mensagens e ligações agora são protegidas com criptografia de ponta a ponta.')
      : tx(t, 'e2ee5.divider.on', 'A partir daqui, as mensagens são protegidas com criptografia de ponta a ponta.');
  }
  const more = tx(t, 'e2ee5.msg.learn_more_tap', 'Toque para saber mais.');
  const off = kind === 'off';
  const fg = off ? colors.textSecondary : pal.fg;
  return (
    <View style={[s.row, style]} accessibilityRole="text">
      <View style={[s.line, { backgroundColor: colors.divider || colors.border }]} />
      <Pressable
        onPress={() => (onPress ? onPress() : setOpen(true))}
        style={({ pressed }) => [s.pill, { backgroundColor: off ? (colors.surfaceVariant || colors.background) : pal.bg, opacity: pressed ? 0.75 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`${text} ${more}`}
      >
        <Text style={[s.text, { color: fg }]} maxFontSizeMultiplier={1.4}>
          {off ? <LockOffGlyph size={11} color={fg} /> : <LockGlyph size={11} color={fg} />}{'  '}{text} <Text style={s.more}>{more}</Text>
        </Text>
      </Pressable>
      <View style={[s.line, { backgroundColor: colors.divider || colors.border }]} />
      {open ? <E2eeInfoSheet visible mode="learn" onClose={() => setOpen(false)} onVerify={onVerify} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, minWidth: 8 },
  pill: { maxWidth: '82%', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, marginHorizontal: 8 },
  text: { fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  more: { fontWeight: '600' },
});

export default memo(E2eeDivider);
