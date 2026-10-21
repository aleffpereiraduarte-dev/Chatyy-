// [e2ee5 WP-15 2026-10-21] Conteúdo do balão quando a mensagem cifrada NÃO pode ser mostrada.
//
// state:
//   'waiting'        — UTD retentável (missing_session, unknown_index, store, untrusted_device;
//                      CONTRATO §6.5): "Aguardando esta mensagem. Isso pode levar um tempo." + Saiba mais
//   'cannot_decrypt' — UTD não retentável: "Não foi possível exibir esta mensagem."
//   'update_to_read' — envelope {"e2e":N} desconhecido / núcleo ausente: "Mensagem protegida.
//                      Atualize o Chatyy para ler." (onUpdate opcional → loja)
// Plugar (WP-08c): no renderer do balão, no lugar do texto, quando o estado de decifragem não é ok.
// e2eeMessageStateFor(err) traduz o erro do núcleo para o estado. Prévia da lista: e2eePreviewText().
import React, { memo, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, ClockGlyph, LockGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

const RETRYABLE = new Set(['missing_session', 'unknown_index', 'store', 'untrusted_device']);

// Erro do núcleo ({Utd:{reason}} / {reason} / string) ou envelope → estado de UI.
export function e2eeMessageStateFor(errOrReason, envelopeVersion) {
  if (envelopeVersion != null && Number(envelopeVersion) !== 5) return 'update_to_read';
  let r = errOrReason;
  try {
    if (r && typeof r === 'object') r = r.reason || (r.Utd && r.Utd.reason) || (r.utd && r.utd.reason) || r.code || '';
  } catch { r = ''; }
  r = String(r || '');
  if (r === 'no_core' || r === 'unsupported') return 'update_to_read';
  return RETRYABLE.has(r) ? 'waiting' : 'cannot_decrypt';
}

// Texto curto para prévia da lista / notificação local.
export function e2eePreviewText(t, state) {
  if (state === 'update_to_read') return tx(t, 'e2ee5.msg.update_to_read', 'Mensagem protegida. Atualize o Chatyy para ler.');
  if (state === 'cannot_decrypt') return tx(t, 'e2ee5.msg.cannot_decrypt', 'Não foi possível exibir esta mensagem.');
  return tx(t, 'e2ee5.msg.waiting_short', 'Aguardando mensagem…');
}

function E2eeMessageState({ state = 'waiting', color, onUpdate, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!isE2eeUiEnabled()) return null;
  const fg = color || colors.textSecondary;
  const accent = colors.accent || colors.primary;
  let text; let action = null;
  if (state === 'update_to_read') {
    text = tx(t, 'e2ee5.msg.update_to_read', 'Mensagem protegida. Atualize o Chatyy para ler.');
    if (onUpdate) action = { label: tx(t, 'e2ee5.msg.update_action', 'Atualizar'), fn: onUpdate };
  } else if (state === 'cannot_decrypt') {
    text = tx(t, 'e2ee5.msg.cannot_decrypt', 'Não foi possível exibir esta mensagem.');
    action = { label: tx(t, 'e2ee5.msg.learn_more', 'Saiba mais'), fn: () => setOpen(true) };
  } else {
    text = tx(t, 'e2ee5.msg.waiting', 'Aguardando esta mensagem. Isso pode levar um tempo.');
    action = { label: tx(t, 'e2ee5.msg.learn_more', 'Saiba mais'), fn: () => setOpen(true) };
  }
  const Icon = state === 'waiting' ? ClockGlyph : LockGlyph;
  return (
    <View style={[s.wrap, style]} accessible accessibilityLabel={text}>
      <Text style={[s.text, { color: fg }]} maxFontSizeMultiplier={1.6}>
        <Icon size={13} color={fg} filled={false} />{'  '}{text}
        {action ? <Text> </Text> : null}
        {action ? (
          <Text style={[s.link, { color: accent }]} onPress={action.fn} accessibilityRole="link" suppressHighlighting>
            {action.label}
          </Text>
        ) : null}
      </Text>
      {open ? <E2eeInfoSheet visible mode={state === 'waiting' ? 'waiting' : 'learn'} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingVertical: 2 },
  text: { fontSize: 15, lineHeight: 20, fontStyle: 'italic' },
  link: { fontStyle: 'normal', fontWeight: '600' },
});

export default memo(E2eeMessageState);
