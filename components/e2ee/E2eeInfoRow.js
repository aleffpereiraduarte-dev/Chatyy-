// [e2ee5 WP-15 2026-10-21] Cadeado do cabeçalho e linha "Criptografia" das informações do contato/grupo.
//
// <E2eeHeaderLock />       — cadeado pequeno ao lado do nome/subtítulo no cabeçalho da conversa.
// <E2eeContactInfoRow />   — linha "Criptografia · As mensagens são protegidas com criptografia de
//                            ponta a ponta. Toque para verificar." (onPress → SafetyNumberScreen;
//                            em grupo, onPress → E2eeInfoSheet 'learn', porque não há código único).
// Plugar: cabeçalho (WP-08c, bloco [e2ee5]) e tela de informações do contato (ChatInfo JS; o
// ChatInfo nativo recebe o texto via props — pedir ao dono do nativo).
import React, { memo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, LockGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

export const E2eeHeaderLock = memo(function E2eeHeaderLock({ size = 11, color, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  if (!isE2eeUiEnabled()) return null;
  return (
    <View style={[{ marginRight: 4 }, style]} accessible accessibilityLabel={tx(t, 'e2ee5.lock.a11y', 'Criptografia de ponta a ponta')}>
      <LockGlyph size={size} color={color || colors.textSecondary} />
    </View>
  );
});

export const E2eeContactInfoRow = memo(function E2eeContactInfoRow({ isGroup = false, onPress, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!isE2eeUiEnabled()) return null;
  const title = tx(t, 'e2ee5.settings.row_title', 'Criptografia');
  const sub = isGroup
    ? tx(t, 'e2ee5.settings.row_sub_group', 'As mensagens são protegidas com criptografia de ponta a ponta.')
    : tx(t, 'e2ee5.settings.row_sub', 'As mensagens são protegidas com criptografia de ponta a ponta. Toque para verificar.');
  const go = () => { if (!isGroup && onPress) onPress(); else setOpen(true); };
  return (
    <>
      <Pressable onPress={go} style={({ pressed }) => [s.row, { opacity: pressed ? 0.7 : 1 }, style]} accessibilityRole="button" accessibilityLabel={`${title}. ${sub}`}>
        <View style={s.icon}><LockGlyph size={20} color={colors.textSecondary} filled={false} /></View>
        <View style={s.texts}>
          <Text style={[s.title, { color: colors.text }]}>{title}</Text>
          <Text style={[s.sub, { color: colors.textSecondary }]}>{sub}</Text>
        </View>
      </Pressable>
      {open ? <E2eeInfoSheet visible mode="learn" onClose={() => setOpen(false)} onVerify={!isGroup ? onPress : undefined} /> : null}
    </>
  );
});

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  icon: { width: 32, alignItems: 'center', marginRight: 12 },
  texts: { flex: 1 },
  title: { fontSize: 16 },
  sub: { fontSize: 13.5, lineHeight: 18, marginTop: 2 },
});
