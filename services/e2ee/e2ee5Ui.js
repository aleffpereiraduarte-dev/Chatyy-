// [e2ee5 WP-08c 2026-10-21] Cola de UI do E2EE v5 na conversa (o visual é do WP-15, components/e2ee).
//
// Os componentes do WP-15 devolvem null com a flag desligada; aqui garantimos que, mesmo assim,
// NUNCA aparece JSON cru: sem a UI nova, cai num texto simples (pílula de sistema / itálico).
import React, { memo } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, E2eeDivider, E2eeMessageState, LockGlyph } from '../../components/e2ee';
import { sysKind, sysObj, sysText, stateText, myUidSync } from './e2ee5';

/** Linha de sistema `{"sys":"e2ee_on"|"e2ee_off"}`: divisor do WP-15 ou pílula de texto. */
function E2ee5SystemRowImpl({ content, senderName }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const kind = sysKind(content);
  if (!kind) return null;
  const o = sysObj(content) || {};
  if ((kind === 'on' || kind === 'off') && isE2eeUiEnabled()) {
    const mine = o.by_uid != null && String(o.by_uid) === myUidSync();
    const name = kind === 'off' ? (mine ? (t('common.you') !== 'common.you' ? t('common.you') : 'Você') : (senderName || '')) : '';
    return <E2eeDivider kind={kind} name={name} reason={o.reason || 'user'} />;
  }
  const txt = sysText(t, content);
  if (!txt) return null;
  return (
    <View style={s.wrap}>
      <View style={s.pill}>
        <Text style={[s.text, { color: colors.textTertiary || colors.textSecondary }]}>{txt}</Text>
      </View>
    </View>
  );
}
export const E2ee5SystemRow = memo(E2ee5SystemRowImpl);

/** Corpo do balão quando a mensagem v5 não pôde ser exibida (aguardando / não deu / atualize). */
function E2ee5MessageBodyImpl({ state, color }) {
  const { t } = useLanguage();
  if (state === 'decrypting') return null; // [2026-10-21] nunca "...": a linha nem entra na lista
  if (isE2eeUiEnabled()) return <E2eeMessageState state={state} color={color} />;
  return (
    <View style={s.row} accessible accessibilityLabel={stateText(t, state)}>
      <LockGlyph size={13} color={color} />
      <Text style={[s.italic, { color, flexShrink: 1 }]}>{stateText(t, state)}</Text>
    </View>
  );
}
export const E2ee5MessageBody = memo(E2ee5MessageBodyImpl);

const s = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: 8, paddingHorizontal: 16 },
  pill: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(128,128,128,0.16)', maxWidth: '88%' },
  text: { fontSize: 12, textAlign: 'center', fontWeight: '500', lineHeight: 17 },
  italic: { fontSize: 15, lineHeight: 20, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
