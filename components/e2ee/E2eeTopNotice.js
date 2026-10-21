// [e2ee5 WP-15 2026-10-21] Aviso no topo da conversa (primeiro item da lista, como no WhatsApp):
// "As mensagens são protegidas com criptografia de ponta a ponta…  Toque para saber mais."
//
// Props: calls (bool) = texto inclui ligações (só depois da F5, flag e2ee5_calls);
//        onPress (opcional) = o host abre a própria folha; sem onPress abre E2eeInfoSheet 'learn';
//        onVerify (opcional) = botão "Verificar código" na folha.
// Plugar (WP-08c): como cabeçalho da lista quando a conversa tem e2ee_mode=1 e o histórico
// carregado chega ao início (ou sempre no topo, se for mais simples). Ver PLUGAR.md.
import React, { memo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, noticePalette, LockGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

function E2eeTopNotice({ calls = false, onPress, onVerify, style }) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!isE2eeUiEnabled()) return null;
  const pal = noticePalette(isDark);
  const text = calls
    ? tx(t, 'e2ee5.notice.top_calls', 'As mensagens e ligações são protegidas com criptografia de ponta a ponta. Só quem está nesta conversa pode ler, ouvir ou compartilhar. Nem o Chatyy tem acesso.')
    : tx(t, 'e2ee5.notice.top', 'As mensagens são protegidas com criptografia de ponta a ponta. Só quem está nesta conversa pode ler ou compartilhar. Nem o Chatyy tem acesso.');
  const more = tx(t, 'e2ee5.msg.learn_more_tap', 'Toque para saber mais.');
  return (
    <View style={[s.row, style]}>
      <Pressable
        onPress={() => (onPress ? onPress() : setOpen(true))}
        style={({ pressed }) => [s.pill, { backgroundColor: pal.bg, borderColor: pal.border, opacity: pressed ? 0.75 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`${text} ${more}`}
      >
        <Text style={[s.text, { color: pal.fg }]} maxFontSizeMultiplier={1.4}>
          <LockGlyph size={11} color={pal.icon} style={s.lock} />{'  '}{text} <Text style={s.more}>{more}</Text>
        </Text>
      </Pressable>
      {open ? <E2eeInfoSheet visible mode="learn" onClose={() => setOpen(false)} onVerify={onVerify} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 10, paddingBottom: 6 },
  pill: { maxWidth: 520, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 8 },
  text: { fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  more: { fontWeight: '600' },
  lock: { marginBottom: -1 },
});

export default memo(E2eeTopNotice);
