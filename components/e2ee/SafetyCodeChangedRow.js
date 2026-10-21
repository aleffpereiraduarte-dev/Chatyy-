// [e2ee5 WP-15 2026-10-21] Linha LOCAL "O código de segurança de {name} mudou. Toque para saber mais."
// e "{name} entrou em um aparelho novo." (CONTRATO §2.7: são geradas pelo cliente a partir de
// SyncResult.identity_changed_uids — nunca vão ao servidor).
//
// Props: name, kind 'changed' | 'new_device', onVerify (abre SafetyNumberScreen), onPress (opcional,
// substitui a folha). Toque sem onPress → E2eeInfoSheet 'changed'. Comportamento WhatsApp: avisa,
// não bloqueia. O bloqueio (contato verificado) usa E2eeInfoSheet mode='blocked' + onAccept.
import React, { memo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, ShieldGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

function SafetyCodeChangedRow({ name = '', kind = 'changed', onVerify, onPress, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!isE2eeUiEnabled()) return null;
  const who = name || tx(t, 'e2ee5.common.contact', 'o contato');
  const text = kind === 'new_device'
    ? tx(t, 'e2ee5.safety.new_device', '{name} entrou em um aparelho novo.', { name: who })
    : tx(t, 'e2ee5.safety.changed', 'O código de segurança de {name} mudou.', { name: who });
  const more = tx(t, 'e2ee5.msg.learn_more_tap', 'Toque para saber mais.');
  return (
    <View style={[s.row, style]}>
      <Pressable
        onPress={() => (onPress ? onPress() : setOpen(true))}
        style={({ pressed }) => [s.pill, { backgroundColor: colors.surfaceVariant || colors.background, opacity: pressed ? 0.75 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`${text} ${more}`}
      >
        <Text style={[s.text, { color: colors.textSecondary }]} maxFontSizeMultiplier={1.4}>
          <ShieldGlyph size={12} color={colors.textSecondary} />{'  '}{text} <Text style={[s.more, { color: colors.text }]}>{more}</Text>
        </Text>
      </Pressable>
      {open ? <E2eeInfoSheet visible mode="changed" name={who} onClose={() => setOpen(false)} onVerify={onVerify} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { alignItems: 'center', paddingHorizontal: 28, paddingVertical: 6 },
  pill: { maxWidth: 520, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  text: { fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  more: { fontWeight: '600' },
});

export default memo(SafetyCodeChangedRow);
